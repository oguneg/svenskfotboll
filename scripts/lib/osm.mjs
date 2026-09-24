// Builds a compact gazetteer of named sports venues, schools, parks and settlements in
// Sweden (plus Åland) from OpenStreetMap via the Overpass API. Venue names from the
// federation are matched against it offline, so Nominatim is only a last resort.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const UA = 'fotbollskartan/1.0 (+https://github.com/oguneg/svenskfotboll)';

// overpass-api.de sometimes refuses whole-country queries under load, so we query
// Sweden in tiles and rotate between mirrors.
const ENDPOINTS = [
  'https://z.overpass-api.de/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// [south, west, north, east], roughly following Sweden's outline plus Åland.
const TILES = [
  [55.3, 12.4, 56.6, 16.7],
  [56.6, 11.8, 58.0, 17.2],
  [56.9, 17.2, 58.0, 19.4],
  [58.0, 10.9, 59.3, 17.0],
  [58.0, 17.0, 59.3, 19.5],
  [59.3, 11.6, 60.3, 17.0],
  [59.3, 17.0, 60.5, 21.2],
  [60.3, 12.0, 62.0, 17.8],
  [62.0, 11.9, 64.0, 19.6],
  [64.0, 13.5, 66.0, 22.0],
  [66.0, 15.5, 69.1, 24.2],
];

// Kind codes kept in the gazetteer (lower number = better match for a football venue).
export const KIND = {
  stadium: 's',
  soccer: 'f', // leisure=pitch with sport=soccer
  pitch: 'p',
  unnamed: 'u', // unnamed football pitch, used to snap town-level guesses onto a real pitch
  sports_centre: 'c',
  recreation_ground: 'r',
  track: 't',
  sports_hall: 'h',
  school: 'e',
  park: 'k',
  // Settlements, used to locate a club's town: X city/town, x village/suburb, y smaller.
  town: 'X',
  village: 'x',
  hamlet: 'y',
};

const PLACE_KIND = {
  city: KIND.town,
  town: KIND.town,
  village: KIND.village,
  suburb: KIND.village,
  quarter: KIND.village,
  neighbourhood: KIND.hamlet,
  hamlet: KIND.hamlet,
};

// Two lighter queries per tile rather than one heavy one: busy Overpass servers reject big ones.
const PARTS = {
  named: `(
  nwr["leisure"~"^(pitch|stadium|sports_centre|sports_hall|track|recreation_ground|park)$"]["name"];
  nwr["landuse"="recreation_ground"]["name"];
  nwr["building"~"^(stadium|sports_hall|sports_centre|grandstand)$"]["name"];
  nwr["amenity"="school"]["name"];
  node["place"~"^(city|town|village|suburb|quarter|neighbourhood|hamlet)$"]["name"];
);`,
  pitches: `(
  nwr["leisure"="pitch"]["sport"~"soccer|football"][!"name"];
  nwr["leisure"="pitch"]["surface"="artificial_turf"][!"sport"][!"name"];
);`,
};

function query([s, w, n, e], part) {
  return `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
${PARTS[part]}
out center tags qt;`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runQuery(q, log, deadline) {
  let lastErr;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (Date.now() > deadline) throw new Error(`overpass time budget used up (${lastErr?.message})`);
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(300_000),
      });
      const text = await res.text();
      if (!res.ok || !text.startsWith('{')) throw new Error(`HTTP ${res.status} from ${endpoint}`);
      const json = JSON.parse(text);
      if (json.remark && /error/i.test(json.remark)) throw new Error(json.remark);
      return json.elements;
    } catch (err) {
      lastErr = err;
      log(`    overpass attempt ${attempt + 1} failed: ${err.message}`);
      await sleep(10_000 * Math.min(attempt + 1, 6));
    }
  }
  throw lastErr;
}

function kindOf(tags) {
  if (tags.place) return PLACE_KIND[tags.place] || null;
  if (tags.amenity === 'school') return KIND.school;
  if (tags.leisure === 'pitch') {
    if (!tags.name) return KIND.unnamed;
    return /soccer|football/.test(tags.sport || '') ? KIND.soccer : KIND.pitch;
  }
  if (tags.leisure) return KIND[tags.leisure] || null;
  if (tags.landuse === 'recreation_ground') return KIND.recreation_ground;
  if (tags.building === 'stadium' || tags.building === 'grandstand') return KIND.stadium;
  if (tags.building) return KIND.sports_hall;
  return null;
}

function parseElements(elements) {
  const rows = [];
  for (const el of elements) {
    const t = el.tags || {};
    const kind = kindOf(t);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!kind || lat == null) continue;
    const names = new Set(
      [t.name, t.alt_name, t.official_name, t.short_name, t.old_name, t['name:sv']]
        .filter(Boolean)
        .flatMap((n) => n.split(';')),
    );
    if (kind === KIND.unnamed) names.add('');
    for (const name of names) rows.push([el.type[0] + el.id, name.trim(), +lat.toFixed(5), +lon.toFixed(5), kind]);
  }
  return rows;
}

// Tiles are saved as they finish, so an interrupted build resumes where it stopped.
export async function buildGazetteer(file, { log = console.log, budgetMinutes = 25, parts = Object.keys(PARTS) } = {}) {
  const deadline = Date.now() + budgetMinutes * 60_000;
  const partDir = join(dirname(file), 'osm-tiles');
  mkdirSync(partDir, { recursive: true });
  const seen = new Set();
  const rows = [];
  const jobs = TILES.flatMap((tile, i) => parts.map((part) => ({ tile, i, part })));
  for (const { tile, i, part } of jobs) {
    const partFile = join(partDir, `${i}-${part}.json`);
    let tileRows;
    if (existsSync(partFile) && Date.now() - statSync(partFile).mtimeMs < 3 * 86_400_000) {
      tileRows = JSON.parse(readFileSync(partFile, 'utf8'));
    } else {
      log(`  overpass tile ${i + 1}/${TILES.length} (${part}) ${tile.join(',')}`);
      tileRows = parseElements(await runQuery(query(tile, part), log, deadline));
      writeFileSync(partFile, JSON.stringify(tileRows));
    }
    for (const [id, ...row] of tileRows) {
      if (seen.has(id + row[0])) continue; // tiles overlap
      seen.add(id + row[0]);
      rows.push(row);
    }
  }
  writeFileSync(file, JSON.stringify({ built: new Date().toISOString(), rows }));
  rmSync(partDir, { recursive: true, force: true });
  log(`  gazetteer: ${rows.length} names`);
  return rows;
}

// Returns the cached gazetteer, rebuilding it when missing or older than maxAgeDays.
export async function loadGazetteer(file, { maxAgeDays = 30, log = console.log } = {}) {
  if (existsSync(file)) {
    const { built, rows } = JSON.parse(readFileSync(file, 'utf8'));
    const ageDays = (Date.now() - Date.parse(built)) / 86_400_000;
    if (ageDays < maxAgeDays) return rows;
    log(`  gazetteer is ${ageDays.toFixed(0)} days old, rebuilding`);
  }
  try {
    return await buildGazetteer(file, { log });
  } catch (err) {
    // A stale gazetteer is far better than none.
    if (existsSync(file)) {
      log(`  gazetteer rebuild failed (${err.message}); using the stale copy`);
      return JSON.parse(readFileSync(file, 'utf8')).rows;
    }
    throw err;
  }
}
