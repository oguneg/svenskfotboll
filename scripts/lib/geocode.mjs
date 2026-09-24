// Resolves federation venue names ("Hagby IP 3", "Norrvalla IP 2, Lammhult") to coordinates.
//
// 1. Offline match against the OSM gazetteer, restricted to the home club's district and
//    disambiguated by the club's town (taken from the team name) or a town in the venue name.
// 2. Nominatim search, rate limited and budgeted per run.
// 3. Town-level approximation, flagged so the map can show it as approximate.

import {
  GENERIC, cleanName, keyOf, meaningful, segments, subsequences, teamPlaceTokens, withoutGenitive, tokens,
} from './names.mjs';

const UA = 'fotbollskartan/1.0 (+https://github.com/oguneg/svenskfotboll)';

// Rough bounding boxes [south, west, north, east] per district association.
export const DISTRICT_BBOX = {
  1: [55.0, 10.5, 69.5, 24.5],
  2: [55.95, 14.35, 56.6, 16.0],
  4: [59.8, 12.1, 62.3, 16.8],
  5: [56.85, 17.9, 58.0, 19.4],
  6: [60.15, 15.9, 61.1, 17.7],
  7: [57.3, 11.4, 58.1, 12.7],
  8: [56.3, 11.8, 57.6, 13.7],
  9: [61.0, 14.6, 62.4, 17.6],
  10: [61.5, 11.9, 65.2, 17.2],
  11: [62.0, 14.5, 62.9, 17.8],
  12: [65.2, 15.4, 69.1, 24.2],
  13: [58.6, 14.1, 60.2, 15.9],
  14: [55.3, 12.4, 56.55, 14.6],
  15: [56.4, 13.0, 58.2, 17.2],
  16: [58.7, 17.2, 60.3, 19.4],
  17: [58.6, 15.8, 59.5, 17.8],
  18: [59.4, 16.6, 60.8, 18.9],
  19: [58.9, 11.8, 61.1, 14.6],
  20: [63.4, 14.3, 66.2, 21.6],
  21: [57.3, 11.8, 59.0, 14.9],
  22: [59.2, 15.4, 60.2, 17.0],
  23: [62.6, 15.9, 64.3, 19.4],
  24: [57.7, 14.4, 58.95, 17.1],
  26: [59.8, 19.2, 60.6, 21.2],
  28: [57.8, 11.0, 59.3, 12.9],
};

const MARGIN = 0.15;
const VENUE_KINDS = 'sfpcrthek';
const PLACE_KINDS = 'Xxy';
const PITCH_KINDS = 'sfu'; // football grounds, named or not, for snapping
// How far from a town's centre node its football pitches can be.
const SNAP_RADIUS_KM = { X: 3, x: 2.5, y: 2 };
// Kind preference inside a cluster: real pitches and stadiums over schools and parks.
const KIND_RANK = { s: 0, f: 0, p: 1, c: 1, r: 2, t: 2, h: 3, e: 4, k: 5 };

function inBox([lat, lon], id) {
  const [s, w, n, e] = DISTRICT_BBOX[id] || DISTRICT_BBOX[1];
  return lat >= s - MARGIN && lat <= n + MARGIN && lon >= w - MARGIN && lon <= e + MARGIN;
}

export function distanceKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLon = ((b[1] - a[1]) * Math.PI) / 180;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Groups features lying close together (pitches of the same complex).
function cluster(features, km = 1.5) {
  const groups = [];
  for (const f of features) {
    const g = groups.find((g) => distanceKm(g.anchor, [f.lat, f.lon]) < km);
    if (g) g.items.push(f);
    else groups.push({ anchor: [f.lat, f.lon], items: [f] });
  }
  return groups.map((g) => {
    const best = Math.min(...g.items.map((f) => KIND_RANK[f.kind] ?? 9));
    const top = g.items.filter((f) => (KIND_RANK[f.kind] ?? 9) === best);
    const lat = top.reduce((s, f) => s + f.lat, 0) / top.length;
    const lon = top.reduce((s, f) => s + f.lon, 0) / top.length;
    return { pos: [+lat.toFixed(5), +lon.toFixed(5)], rank: best, size: g.items.length };
  });
}

// Spatial grid of football pitches (~5 km cells).
const cellOf = (lat, lon) => `${Math.floor(lat / 0.05)},${Math.floor(lon / 0.1)}`;

function pitchesNear(index, pos, radiusKm) {
  const [ci, cj] = cellOf(pos[0], pos[1]).split(',').map(Number);
  const out = [];
  for (let di = -1; di <= 1; di++) {
    for (let dj = -1; dj <= 1; dj++) {
      for (const f of index.pitches.get(`${ci + di},${cj + dj}`) || []) {
        if (distanceKm(pos, [f.lat, f.lon]) <= radiusKm) out.push(f);
      }
    }
  }
  return out;
}

// Football pitch clusters around a town, nearest first.
function snap(index, anchor) {
  const near = pitchesNear(index, anchor.pos, SNAP_RADIUS_KM[anchor.kind] || 2);
  return cluster(near, 0.6)
    .map((g) => ({ ...g, d: distanceKm(anchor.pos, g.pos) }))
    .sort((a, b) => a.d - b.d);
}

// Anchors can name the same town several times (e.g. two "Berga" in a district).
function distinctAnchors(anchors) {
  const out = [];
  for (const a of anchors) if (!out.some((o) => distanceKm(o.pos, a.pos) < 3)) out.push(a);
  return out;
}

export function buildIndex(rows) {
  const venues = new Map();
  const places = new Map();
  const pitches = new Map();
  for (const [name, lat, lon, kind] of rows) {
    if (PITCH_KINDS.includes(kind)) {
      const cell = cellOf(lat, lon);
      if (!pitches.has(cell)) pitches.set(cell, []);
      pitches.get(cell).push({ lat, lon, kind });
    }
    const toks = PLACE_KINDS.includes(kind) ? tokens(name) : meaningful(name);
    const key = keyOf(toks);
    if (key.length < 3) continue;
    const map = PLACE_KINDS.includes(kind) ? places : VENUE_KINDS.includes(kind) ? venues : null;
    if (!map) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ lat, lon, kind });
  }
  return { venues, places, pitches };
}

// Places in `district` whose name equals one of the token runs. Returns [{pos, kind, key}].
function findPlaces(index, toks, district, { allowGenitive = true } = {}) {
  const found = [];
  for (const run of subsequences(toks, 3)) {
    const key = keyOf(run);
    if (key.length < 3 || (run.length === 1 && GENERIC.has(run[0]))) continue;
    for (const k of [key, allowGenitive && withoutGenitive(key)].filter(Boolean)) {
      for (const p of index.places.get(k) || []) {
        if (inBox([p.lat, p.lon], district)) found.push({ pos: [p.lat, p.lon], kind: p.kind, key: k, len: run.length });
      }
    }
    if (found.length) break; // longest matching run wins
  }
  const order = { X: 0, x: 1, y: 2 };
  return found.sort((a, b) => order[a.kind] - order[b.kind]);
}

function isSpecific(run) {
  return run.some((t) => !GENERIC.has(t)) && keyOf(run).length >= 4;
}

// Offline OSM match. Returns { pos, how } or null.
function matchOsm(index, raw, district, anchors) {
  const { main, extras } = segments(raw);
  const parts = [main, ...extras].map(meaningful).filter((t) => t.length);
  for (const [pi, toks] of parts.entries()) {
    for (const run of subsequences(toks)) {
      // Lone generic words ("IP", "Arena") never identify a venue on their own.
      if (run.length === 1 && GENERIC.has(run[0])) continue;
      const key = keyOf(run);
      if (key.length < 4) continue;
      const features = (index.venues.get(key) || []).filter((f) => inBox([f.lat, f.lon], district));
      if (!features.length) continue;
      const groups = cluster(features);
      const specific = isSpecific(run);
      if (anchors.length) {
        const scored = groups
          .map((g) => ({ g, d: Math.min(...anchors.map((a) => distanceKm(a.pos, g.pos))) }))
          .sort((a, b) => a.d - b.d || a.g.rank - b.g.rank);
        const best = scored[0];
        if (best.d <= 20 || (groups.length === 1 && specific && best.d <= 80)) {
          // With several same-named venues in the district, the pick depends on the club.
          return { pos: best.g.pos, how: `osm:${run.join(' ')}${pi ? ' (alt)' : ''}`, perTeam: groups.length > 1 };
        }
      } else if (groups.length === 1 && specific) {
        return { pos: groups[0].pos, how: `osm:${run.join(' ')}${pi ? ' (alt)' : ''}` };
      }
    }
  }
  return null;
}

// "Hjärnarpsvallen" -> "hjarnarp": Swedish venue names glue the village onto the ground type.
const COMPOUND = /^(.{4,}?)s?(vallen|valla|planen|plan|parken|park|arenan|arena|hallen|garden|skolan|skola|ang|angen|faltet|falt|backen|lund|lunden|stadion|borg)$/;

function unglue(toks) {
  return toks.map((t) => t.match(COMPOUND)?.[1]).filter((t) => t && !GENERIC.has(t));
}

// Where the venue probably is, from towns named in the venue string or the home team name.
function findAnchors(index, raw, homeTeam, district) {
  const { main, extras } = segments(raw);
  let fromVenue = [...extras, main].flatMap((s) => findPlaces(index, meaningful(s), district, { allowGenitive: true }));
  if (!fromVenue.length) {
    // Only villages and towns: hamlets named "Björk" or "Berg" are everywhere.
    fromVenue = unglue(meaningful(main))
      .flatMap((t) => findPlaces(index, [t], district, { allowGenitive: false }))
      .filter((a) => a.kind !== 'y');
  }
  const fromTeam = homeTeam ? findPlaces(index, teamPlaceTokens(homeTeam), district) : [];
  return { fromVenue, fromTeam };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatim = 0;

async function nominatim(q, district) {
  const wait = lastNominatim + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatim = Date.now();
  const [s, w, n, e] = DISTRICT_BBOX[district] || DISTRICT_BBOX[1];
  const url =
    'https://nominatim.openstreetmap.org/search?' +
    new URLSearchParams({
      q,
      format: 'jsonv2',
      limit: '3',
      countrycodes: 'se,ax,fi',
      viewbox: `${w - MARGIN},${n + MARGIN},${e + MARGIN},${s - MARGIN}`,
      bounded: '1',
      'accept-language': 'sv',
    });
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 429 || res.status === 403) throw new Error(`nominatim refused (${res.status})`);
  if (!res.ok) return [];
  return res.json();
}

// Nominatim is a fuzzy text search: "Bro IP" happily returns a retail park in Bro. Only
// accept results that are actually sports grounds.
export const NOMINATIM_TYPES = new Set([
  'leisure=pitch', 'leisure=stadium', 'leisure=sports_centre', 'leisure=sports_hall', 'leisure=track',
  'leisure=recreation_ground', 'leisure=park', 'landuse=recreation_ground', 'building=stadium',
  'building=sports_hall', 'building=sports_centre', 'building=grandstand', 'amenity=school', 'club=sport',
]);

export class VenueResolver {
  constructor(rows, cache, { overrides = {}, nominatimBudget = 0, log = console.log, today }) {
    this.index = buildIndex(rows);
    this.hasGazetteer = rows.length > 0;
    this.cache = cache;
    this.overrides = overrides;
    this.budget = nominatimBudget;
    this.log = log;
    this.today = today;
    this.nominatimDisabled = false;
    this.memo = new Map(); // per-run results, keyed like the cache's per-team keys
  }

  // Cache keys: "<district>|<venue>" normally, "<district>|<venue>|@<home team>" when the answer
  // depends on which club is playing, and "<district>|@<home team>" when no venue is given.
  static keys(district, location, homeTeam) {
    const base = location ? `${district}|${location}` : `${district}|@${homeTeam}`;
    return { base, team: location ? `${base}|@${homeTeam}` : base };
  }

  async resolve({ district, location, homeTeam }) {
    const { base, team } = VenueResolver.keys(district, location, homeTeam);
    if (this.memo.has(team)) return this.memo.get(team);
    const entry = await this.#resolve(district, location, homeTeam, base, team);
    this.memo.set(team, entry);
    return entry;
  }

  // Resolves everything offline first, then spends the Nominatim budget on venues with
  // no position at all before improving approximate ones.
  async resolveAll(venues) {
    const budget = this.budget;
    this.budget = 0;
    for (const v of venues) await this.resolve(v);
    this.budget = budget;
    const keyOf = (v) => VenueResolver.keys(v.district, v.location, v.homeTeam).team;
    const retry = [
      ...venues.filter((v) => v.location && !this.memo.get(keyOf(v)).p),
      ...venues.filter((v) => v.location && this.memo.get(keyOf(v)).p === 'approx'),
    ];
    for (const v of retry) {
      if (this.budget <= 0 || this.nominatimDisabled) break;
      this.memo.delete(keyOf(v));
      await this.resolve(v);
    }
    const stats = { exact: 0, approx: 0, unresolved: 0, nominatim: 0 };
    for (const e of this.memo.values()) {
      stats[e.p || 'unresolved']++;
      if (e.how?.startsWith('nominatim')) stats.nominatim++;
    }
    stats.nominatimQueries = budget - this.budget;
    return stats;
  }

  async #resolve(district, location, homeTeam, base, team) {
    const override = this.overrides[team] || this.overrides[base] || (location && this.overrides[location]);
    if (override) {
      return { lat: override[0], lon: override[1], p: 'exact', how: 'override' };
    }
    // Exact hits are final. Approximate or missing ones are retried, but Nominatim at most monthly.
    for (const k of [team, base]) {
      if (this.cache[k]?.p === 'exact') {
        return this.cache[k];
      }
    }
    // Without OSM data we can't do better than last time, so don't overwrite it with worse.
    if (!this.hasGazetteer) return this.cache[team] || this.cache[base] || { p: null, t: this.today };

    const { fromVenue, fromTeam } = findAnchors(this.index, location || '', homeTeam, district);
    let result = null;
    let perTeam = false;

    if (location) {
      const osm = matchOsm(this.index, location, district, [...fromVenue, ...fromTeam]);
      if (osm) {
        result = { lat: osm.pos[0], lon: osm.pos[1], p: 'exact', how: osm.how };
        perTeam = osm.perTeam;
      }
    }

    // "Snogeröds IP": the venue names its village. If that village has one football
    // ground, that's the venue even though OSM doesn't name it.
    const venueTowns = distinctAnchors(fromVenue);
    const venueSnap = venueTowns.length === 1 ? snap(this.index, venueTowns[0]) : [];
    if (!result && venueSnap.length === 1) {
      result = { lat: venueSnap[0].pos[0], lon: venueSnap[0].pos[1], p: 'exact', how: `snap:${venueTowns[0].key}` };
    }

    const baseEntry = this.cache[base] || { p: null, t: this.today };
    const triedRecently = baseEntry.nom && (Date.parse(this.today) - Date.parse(baseEntry.nom)) / 86_400_000 < 30;
    if (!result && location && !triedRecently && this.budget > 0 && !this.nominatimDisabled) {
      baseEntry.nom = this.today;
      try {
        result = await this.searchNominatim(location, district, fromVenue, fromTeam);
      } catch (err) {
        this.log(`  ${err.message}; skipping Nominatim for the rest of this run`);
        this.nominatimDisabled = true;
      }
    }

    // Last resort: somewhere in the right town, on its nearest football ground if it has one.
    if (!result) {
      const anchor = fromVenue[0] || fromTeam[0];
      if (anchor) {
        const near = anchor === fromVenue[0] ? venueSnap : snap(this.index, anchor);
        const pos = near.length ? near[0].pos : anchor.pos;
        result = { lat: pos[0], lon: pos[1], p: 'approx', how: `${near.length ? 'near' : 'town'}:${anchor.key}` };
        perTeam = !fromVenue.length;
      }
    }

    const entry = result ? { ...result, t: this.today } : { p: null, t: this.today };
    if (perTeam && team !== base) {
      this.cache[team] = entry;
      if (baseEntry.nom) this.cache[base] = baseEntry; // remembers when Nominatim was last asked
    } else {
      if (baseEntry.nom) entry.nom = baseEntry.nom;
      this.cache[base] = entry;
      if (team !== base && entry.p === 'exact') delete this.cache[team]; // superseded
    }
    return entry;
  }

  async searchNominatim(location, district, fromVenue, fromTeam) {
    const { main, extras } = segments(location);
    if (!isSpecific(meaningful(main))) return null;
    const name = cleanName(main);
    const town = extras.map(cleanName).find(Boolean) || '';
    this.budget--;
    const results = await nominatim(town ? `${name}, ${town}` : name, district);
    const anchors = fromVenue.length ? fromVenue : fromTeam;
    for (const r of results) {
      if (!NOMINATIM_TYPES.has(`${r.category}=${r.type}`)) continue;
      const pos = [+(+r.lat).toFixed(5), +(+r.lon).toFixed(5)];
      if (anchors.length && Math.min(...anchors.map((a) => distanceKm(a.pos, pos))) > 40) continue;
      return { lat: pos[0], lon: pos[1], p: 'exact', how: `nominatim:${r.category}=${r.type}` };
    }
    return null;
  }
}
