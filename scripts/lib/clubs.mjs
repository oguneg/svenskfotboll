// Club registry for the club map. Clubs are keyed by crest id (one per club, shared by all its
// teams). Each daily run adds what the fixtures show: the club's senior league teams and tiers,
// and where it plays home games. Observations are kept for months, so a club keeps its tier and
// ground even when its first team has no fixture in the current 14-day window.

const DAY = 86_400_000;
const TEAM_TTL_DAYS = 240; // about a season; next season's tiers replace these
const HOME_TTL_DAYS = 400;
const MEN = 2;
const WOMEN = 3;

const age = (today, date) => (Date.parse(today) - Date.parse(date)) / DAY;

// "Allsvenskan 2026" -> "Allsvenskan", "Div 2 Norra Svealand, herr 2026" -> "Div 2 Norra Svealand, herr".
const cleanLeague = (name) => name.replace(/[\s,]*\b20\d\d(\/\d{2,4})?\s*$/, '').trim();

// matches/comps/venues are the rows written to public/data/matches.json.
export function updateClubs(registry, { matches, comps, venues, today }) {
  const club = (id) => (registry[id] ||= { name: '', rank: 99, g: 0, teams: {}, homes: {} });

  for (const m of matches) {
    const [, , , , home, away, ci, vi, homeCrest, awayCrest, national] = m;
    if (national) continue; // "Sverige" is not a club
    const [league, gender, category, , , , tier] = comps[ci];
    const senior = category === 4 && typeof tier === 'number';

    for (const [name, id, isHome] of [[home, homeCrest, true], [away, awayCrest, false]]) {
      if (!id) continue;
      const c = club(id);
      if (gender === MEN) c.g |= 1;
      if (gender === WOMEN) c.g |= 2;
      // Display name: the best senior team's name ("Hammarby IF"), else the shortest team name.
      const rank = senior ? tier : 50;
      if (rank < c.rank || (rank === c.rank && name.length < c.name.length)) {
        c.name = name;
        c.rank = rank;
      }
      // Keyed by gender too: a club's men's and women's teams usually share the name ("AIK").
      if (senior) c.teams[`${gender}|${name}`] = [gender, tier, cleanLeague(league), today];

      if (!isHome) continue;
      const [venue, lat, lon, approx] = venues[vi];
      if (lat == null) continue;
      // [lat, lon, approx, match-days seen, last seen, best men's tier here, best women's tier here]
      const h = (c.homes[venue] ||= [lat, lon, approx, 0, today, 99, 99]);
      h[0] = lat;
      h[1] = lon;
      h[2] = approx;
      h[3] = Math.min(h[3] + 1, 9999);
      h[4] = today;
      if (senior && gender === MEN) h[5] = Math.min(h[5], tier);
      if (senior && gender === WOMEN) h[6] = Math.min(h[6], tier);
    }
  }

  // Forget last season's teams and grounds nobody plays at any more.
  for (const [id, c] of Object.entries(registry)) {
    for (const [name, t] of Object.entries(c.teams)) if (age(today, t[3]) > TEAM_TTL_DAYS) delete c.teams[name];
    for (const [venue, h] of Object.entries(c.homes)) if (age(today, h[4]) > HOME_TTL_DAYS) delete c.homes[venue];
    if (!Object.keys(c.homes).length && !Object.keys(c.teams).length) delete registry[id];
  }
  return registry;
}

// Best tier and league for one gender, and the ground to show the club at in that mode.
function side(c, gender) {
  const teams = Object.values(c.teams).filter((t) => t[0] === gender).sort((a, b) => a[1] - b[1]);
  const best = teams[0];
  const homes = Object.entries(c.homes);
  const tierAt = (h) => (gender === MEN ? h[5] : h[6]);
  // The ground where the best team plays, else the club's busiest ground; exact before approximate.
  homes.sort(([, a], [, b]) => tierAt(a) - tierAt(b) || a[2] - b[2] || b[3] - a[3]);
  const home = homes[0];
  if (!home) return null;
  return { tier: best ? best[1] : null, league: best ? best[2] : '', venue: home[0], lat: home[1][0], lon: home[1][1], approx: home[1][2] };
}

// Rows for public/data/clubs.json:
// [crestId, name, men|null, women|null] with men/women = [tier|null, league, lat, lon, approx, venue]
export function clubRows(registry, hasCrest) {
  const rows = [];
  for (const [id, c] of Object.entries(registry)) {
    if (!hasCrest(Number(id))) continue;
    const pack = (s) => (s ? [s.tier, s.league, s.lat, s.lon, s.approx, s.venue] : null);
    const men = c.g & 1 ? pack(side(c, MEN)) : null;
    const women = c.g & 2 ? pack(side(c, WOMEN)) : null;
    if (men || women) rows.push([Number(id), c.name, men, women]);
  }
  return rows;
}
