// Client for the public JSON endpoint behind svenskfotboll.se/serier-cuper/matcher-idag/.
// The match detail pages sit behind a Cloudflare challenge, so we only use this API.

const BASE = 'https://www.svenskfotboll.se/api/matches-today/games/';
const UA = 'fotbollskartan/1.0 (+https://github.com/oguneg/svenskfotboll)';

// 1 = SvFF (national series), the rest are the district associations.
// 26 is Åland, whose clubs play in the Swedish district system.
export const ASSOCIATIONS = {
  1: 'SvFF',
  2: 'Blekinge',
  4: 'Dalarna',
  5: 'Gotland',
  6: 'Gestrikland',
  7: 'Göteborg',
  8: 'Halland',
  9: 'Hälsingland',
  10: 'Jämtland-Härjedalen',
  11: 'Medelpad',
  12: 'Norrbotten',
  13: 'Örebro',
  14: 'Skåne',
  15: 'Småland',
  16: 'Stockholm',
  17: 'Södermanland',
  18: 'Uppland',
  19: 'Värmland',
  20: 'Västerbotten',
  21: 'Västergötland',
  22: 'Västmanland',
  23: 'Ångermanland',
  24: 'Östergötland',
  26: 'Åland',
  28: 'Bohuslän-Dalsland',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const type = res.headers.get('content-type') || '';
      if (!type.includes('json')) throw new Error(`unexpected content-type ${type} (Cloudflare challenge?)`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** i);
    }
  }
  throw new Error(`${url}: ${lastErr.message}`);
}

export async function fetchDay(associationId, date) {
  const url = `${BASE}?associationId=${associationId}&date=${date}`;
  const data = await getJson(url);
  return data.competitions || [];
}

// Runs `jobs` (functions returning promises) with limited concurrency.
export async function pool(jobs, concurrency, delayMs = 0) {
  const results = new Array(jobs.length);
  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const i = next++;
      results[i] = await jobs[i]();
      if (delayMs) await sleep(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return results;
}

// Fetches every association for every date and flattens to one list of games,
// deduplicated by gameId (a game can show up under more than one association).
export async function fetchAll(dates, { log = console.log } = {}) {
  const jobs = [];
  for (const date of dates) {
    for (const id of Object.keys(ASSOCIATIONS)) {
      jobs.push(async () => {
        const comps = await fetchDay(id, date);
        return { associationId: Number(id), date, comps };
      });
    }
  }
  const failures = [];
  const settled = await pool(
    jobs.map((job) => () => job().catch((err) => (failures.push(err.message), null))),
    4,
    150,
  );
  if (failures.length) log(`  ${failures.length} request(s) failed:\n    ${failures.join('\n    ')}`);
  if (failures.length === jobs.length) throw new Error('every request failed; aborting');

  const games = new Map();
  for (const r of settled) {
    if (!r) continue;
    for (const c of r.comps) {
      for (const g of c.games || []) {
        if (games.has(g.gameId)) continue;
        games.set(g.gameId, {
          id: g.gameId,
          date: g.date,
          status: g.status,
          home: (g.homeTeam?.name || '').trim(),
          away: (g.awayTeam?.name || '').trim(),
          homeLogo: g.homeTeam?.teamImageUrl || '',
          awayLogo: g.awayTeam?.teamImageUrl || '',
          location: (g.location || '').trim(),
          note: (g.note || '').trim(),
          homeAssociationId: g.homeTeamClubAssociationId || r.associationId,
          competition: {
            id: c.competitionId,
            name: (c.name || '').trim(),
            genderId: c.genderId,
            ageCategoryId: c.ageCategoryId,
            associationId: r.associationId,
          },
        });
      }
    }
  }
  return { games: [...games.values()], failures: failures.length, requests: jobs.length };
}
