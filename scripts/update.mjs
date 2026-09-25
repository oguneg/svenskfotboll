// Daily data refresh: fetch the coming week of matches from svenskfotboll.se, place every
// venue on the map and write public/data/matches.json for the static site.
//
//   node scripts/update.mjs               # normal run
//   DAYS=14 NOMINATIM_BUDGET=150 node scripts/update.mjs

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fetchAll } from './lib/svff.mjs';
import { loadGazetteer } from './lib/osm.mjs';
import { VenueResolver } from './lib/geocode.mjs';
import { fold } from './lib/names.mjs';
import { syncCrests } from './lib/crests.mjs';
import { clubRows, updateClubs } from './lib/clubs.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'data', 'matches.json');
const GAZETTEER = join(ROOT, 'cache', 'osm-gazetteer.json');
const VENUE_CACHE = join(ROOT, 'cache', 'venues.json');
const OVERRIDES = join(ROOT, 'cache', 'venue-overrides.json');
const CRESTS = join(ROOT, 'public', 'crests');
const CRESTS_MISSING = join(ROOT, 'cache', 'crests-missing.json');
const CLUBS_OUT = join(ROOT, 'public', 'data', 'clubs.json');
const CLUB_CACHE = join(ROOT, 'cache', 'clubs.json');

// Today plus 13 days: this week and next. District and youth games are rarely scheduled further
// ahead, and 25 associations × 14 days = 350 small requests a day is as far as we want to go.
const DAYS = Number(process.env.DAYS || 14);
const NOMINATIM_BUDGET = Number(process.env.NOMINATIM_BUDGET ?? 150);
const TZ = 'Europe/Stockholm';

const log = (...a) => console.log(...a);
const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : fallback);

export function stockholmDate(d = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d); // YYYY-MM-DD
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// "2026-09-26T16:00:00" in Stockholm local time -> unix seconds.
function stockholmToEpoch(local) {
  const [date, time = '00:00:00'] = local.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi);
  const offsetAt = (ms) => {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit',
      }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
    );
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute) - ms;
  };
  let ms = asUtc - offsetAt(asUtc);
  ms = asUtc - offsetAt(ms); // second pass settles DST edges
  return Math.round(ms / 1000);
}

// Age from competition names like "P16 Div.1", "F 15-16 regional", "Pojkar 13", "P-2012".
export function ageOf(name, ageCategoryId, seasonYear) {
  if (ageCategoryId === 4) return null;
  const n = fold(name);
  // "Pojk 7 mot 7" / "Flickor 9-manna" describe the format, not the age.
  let m = n.match(/(?:^|[^a-z])(?:p|f|u|pojkar|flickor|pojk|flick)\s*-?\s*(\d{1,2})(?!\d)(?!\s*(?:mot|m\d|-?\s*manna))/);
  if (m && +m[1] >= 5 && +m[1] <= 21) return +m[1];
  m = n.match(/(?:^|[^a-z])(?:p|f|pojkar|flickor|pojk|flick)\s*-?\s*(20\d\d)(?!\d)/);
  if (m) return seasonYear - +m[1];
  m = n.match(/(?:^|[^0-9])(\d{1,2})\s*ar(?![a-z])/);
  if (m && +m[1] >= 5 && +m[1] <= 21) return +m[1];
  return null;
}

// Age categories: 2 kids, 3 youth, 4 senior, 5 veterans & recreational. The federation labels
// some competitions "senior" that aren't (F15/16, Junior P18, walking football), so the name
// decides where they belong.
export function categoryOf(name, apiCategory) {
  if (apiCategory !== 4) return apiCategory;
  const n = fold(name);
  if (/\b[pf] ?\d{1,2}\b|junior|\bu ?(1\d|2[01])\b|pojk|flick/.test(n)) return 3;
  if (/\bvet(eran(er)?)?\b|old ?(boys|girls)|motion|gafotboll|med malvakt/.test(n)) return 5;
  if (/\b\d+ ?(m|mot) ?\d+\b|sjuan|\d-manna/.test(n)) return 5; // 7-a-side adult leagues
  return 4;
}

// Level in the senior league pyramid, 1 = Allsvenskan/Damallsvenskan. Men and women share the
// numbering: Ettan and women's Division 1 are both tier 3, and Division N is tier N + 2.
// "C" = Svenska Cupen, "R" = reserve, B-team and development
// leagues. Friendlies, qualifiers and national-team games have no tier.
export function tierOf(name, category) {
  const n = fold(name);
  if (/svenska ?cupen/.test(n)) return 'C';
  // Other cups and district championships (DM, Ligacupen, local cups) have no tier, even when
  // their name mentions a division.
  if (/cup|\bdm\b/.test(n)) return null;
  if (category !== 4) return null;
  // "Herr B Skåne" is a B-team league; "B-slutspel" is a playoff. SSH/SSD (Stockholm) and
  // Nivå (Halland) are the districts' reserve-team systems.
  if (/reserv|utveckling|\butv\b|\b(herr|herrar|dam|damer) b\b(?!-)|^ss[hd]\b|^niva\b/.test(n)) return 'R';
  if (/kval|traningsmatch|^tr\.|nations league|landskamp|futsal/.test(n)) return null; // "Tr." = friendlies
  if (/allsvenskan/.test(n)) return 1; // also matches Damallsvenskan
  if (/superettan|elitettan/.test(n)) return 2;
  if (/\bettan\b/.test(n)) return 3;
  // "Div 4", "Div.4", "Division 5A", "Herr div 5"; Stockholm writes "Herrar 4 Norra" / "Damer 3 A".
  const m = n.match(/\bdiv(?:ision)?\s*\.?\s*(\d)(?!\d)/) || n.match(/^(?:herrar|damer|herr|dam)\s+(\d)(?!\d)/);
  return m && +m[1] >= 1 ? +m[1] + 2 : null;
}

const logoId = (url) => Number(url.match(/\/(\d+)\.png/)?.[1]) || 0;

// Sweden's national teams ("Sverige", "Sverige U21", ...) and the SvFF competitions they play in.
const SWEDEN_TEAM = /^(sverige|sweden)\b/i;
const NATIONAL_COMP = /landskamp|nations league|em-kval|vm-kval|em-playoff|vm-playoff|\d-nations|elite round|em-slutspel|vm-slutspel|olympi/i;

async function main() {
  const today = stockholmDate();
  const dates = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
  log(`Fetching ${dates[0]} .. ${dates.at(-1)}`);
  const { games, failures, requests } = await fetchAll(dates, { log });
  log(`  ${games.length} matches from ${requests - failures}/${requests} requests`);
  if (!games.length) throw new Error('no matches returned; refusing to overwrite data');

  log('Loading OSM gazetteer');
  let rows = [];
  try {
    rows = await loadGazetteer(GAZETTEER, { log });
  } catch (err) {
    log(`  WARNING: no gazetteer (${err.message}); only cached venues will be placed`);
  }

  const cache = readJson(VENUE_CACHE, {});
  const overrides = readJson(OVERRIDES, {});
  const resolver = new VenueResolver(rows, cache, { overrides, nominatimBudget: NOMINATIM_BUDGET, log, today });

  log('Resolving venues');
  const district = (g) => g.homeAssociationId || g.competition.associationId;
  const stats = await resolver.resolveAll(
    games.map((g) => ({ district: district(g), location: g.location, homeTeam: g.home })),
  );
  log(`  ${JSON.stringify(stats)}`);

  const comps = new Map();
  const venues = new Map();
  const matches = [];
  const seasonYear = Number(today.slice(0, 4));
  for (const g of games.sort((a, b) => a.date.localeCompare(b.date))) {
    const c = g.competition;
    const sweden = SWEDEN_TEAM.test(g.home) || SWEDEN_TEAM.test(g.away);
    // Other countries' games in Sweden's qualifying group are played abroad: not ours to map.
    if (c.associationId === 1 && NATIONAL_COMP.test(c.name) && !sweden) continue;
    if (!comps.has(c.id)) {
      const category = categoryOf(c.name, c.ageCategoryId);
      comps.set(c.id, {
        i: comps.size,
        row: [
          c.name, c.genderId, category, c.associationId === 1 ? 1 : 0,
          category === 2 || category === 3 ? ageOf(c.name, category, seasonYear) : null,
          c.associationId, tierOf(c.name, category),
        ],
      });
    }
    let r = await resolver.resolve({ district: district(g), location: g.location, homeTeam: g.home });
    // National-team games are often abroad; a town-level guess from "Sverige" would be nonsense.
    if (sweden && r.p === 'approx') r = { p: null };
    // Same name + same spot = one venue row; same name in two places stays two rows.
    const vKey = `${g.location}|${r.lat}|${r.lon}`;
    if (!venues.has(vKey)) {
      venues.set(vKey, {
        i: venues.size,
        row: [g.location, r.p ? r.lat : null, r.p ? r.lon : null, r.p === 'approx' ? 1 : 0],
      });
    }
    const tbd = /T00:00(:00)?$/.test(g.date) ? 1 : 0;
    matches.push([
      g.id, stockholmToEpoch(g.date), g.status, tbd, g.home, g.away,
      comps.get(c.id).i, venues.get(vKey).i, logoId(g.homeLogo), logoId(g.awayLogo), sweden ? 1 : 0,
    ]);
  }

  log('Syncing club crests');
  // Crests for this fortnight's teams and for every club the club map remembers.
  const clubs = readJson(CLUB_CACHE, {});
  const crestIds = new Set([...matches.flatMap((m) => [m[8], m[9]]), ...Object.keys(clubs).map(Number)]);
  let available = new Set();
  try {
    available = await syncCrests(crestIds, CRESTS, CRESTS_MISSING, { today, log });
    for (const m of matches) {
      if (!available.has(m[8])) m[8] = 0;
      if (!available.has(m[9])) m[9] = 0;
    }
  } catch (err) {
    log(`  WARNING: crests unavailable (${err.message}); showing none`);
    for (const m of matches) m[8] = m[9] = 0;
  }

  const venueRows = [...venues.values()].map((v) => v.row);
  const placed = matches.filter((m) => venueRows[m[7]][1] != null).length;
  log(`  ${placed}/${matches.length} matches on the map`);

  const out = {
    generated: new Date().toISOString(),
    days: dates,
    comps: [...comps.values()].map((c) => c.row),
    venues: venueRows,
    matches,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));

  log('Updating club registry');
  updateClubs(clubs, { matches, comps: out.comps, venues: venueRows, today });
  const clubList = clubRows(clubs, (id) => available.has(id));
  writeFileSync(CLUBS_OUT, JSON.stringify({ generated: out.generated, clubs: clubList }));
  log(`  ${Object.keys(clubs).length} clubs known, ${clubList.length} on the club map`);

  writeSorted(VENUE_CACHE, cache);
  writeSorted(CLUB_CACHE, clubs);
  log(`Wrote ${OUT}`);
}

// One entry per line, sorted, so the committed caches diff cleanly.
function writeSorted(file, obj) {
  const lines = Object.entries(obj)
    .sort(([a], [b]) => a.localeCompare(b, 'sv'))
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`);
  writeFileSync(file, `{\n${lines.join(',\n')}\n}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
