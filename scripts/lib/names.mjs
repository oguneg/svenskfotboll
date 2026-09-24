// Name normalisation shared by the venue matcher. Federation venue names look like
// "Tolvans IP A-plan 11-manna" or "Norrvalla IP 2, Lammhult"; OSM names look like
// "Tolvans idrottsplats". Both are reduced to the same folded token lists.

const FOLD = { å: 'a', ä: 'a', ö: 'o', é: 'e', è: 'e', ü: 'u', ø: 'o', æ: 'a' };

const SYNONYMS = {
  idrottsplats: 'ip',
  idrottsplatsen: 'ip',
  idrottsplan: 'ip',
  idrottsplanen: 'ip',
  bollplan: 'bp',
  bollplanen: 'bp',
  sportfalt: 'sf',
  sportfaltet: 'sf',
  sportcentrum: 'sportcenter',
  idrottspark: 'idrottsparken',
  idrottscentrum: 'idrottscenter',
  fotbollsstadion: 'stadion',
};

// Tokens that describe a pitch inside a venue rather than the venue itself.
const QUALIFIERS = new Set([
  'plan', 'planen', 'konstgras', 'konstgrasplan', 'konstgrasplanen', 'gras', 'grasplan',
  'grasplanen', 'naturgras', 'naturgrasplan', 'grus', 'grusplan', 'grusplanen', 'kg', 'kgp',
  'konst', 'manna', 'mannaplan', 'mot', 'halvplan', 'helplan', 'stor', 'liten', 'hybridgras',
  'uppvarmningsplan', 'traningsplan', 'fullstor', 'plan1', 'plan2', 'isyta',
]);

// Words that say nothing about *which* venue it is.
export const GENERIC = new Set([
  'ip', 'bp', 'sf', 'arena', 'vallen', 'valla', 'park', 'parken', 'skola', 'skolan',
  'sportcenter', 'idrottsparken', 'idrottscenter', 'stadion', 'hall', 'hallen', 'sporthall',
  'sporthallen', 'idrottshall', 'idrottshallen', 'fotbollsplan', 'fotbollsplanen',
  'centrum', 'nya', 'gamla', 'norra', 'sodra', 'ostra', 'vastra', 'stora', 'lilla', 'ovre',
  'nedre', 'mellersta', 'fotboll', 'fotbollsarena', 'the', 'och', 'vid', 'i', 'pa',
]);

export function fold(s) {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[åäöéèüøæ]/g, (c) => FOLD[c]);
}

function isQualifier(t) {
  return (
    QUALIFIERS.has(t) ||
    /^\d+[a-z]?$/.test(t) || // 1, 11, 125, 1a
    /^[a-z]\d*$/.test(t) || // a, b, b1, c1
    /^\d+(m|mot|v|vs)\d+$/.test(t) || // 7m7, 11mot11
    /^\d+(manna|mannaplan|spel)$/.test(t)
  );
}

export function tokens(s) {
  return fold(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((t) => SYNONYMS[t] || t);
}

export function meaningful(s) {
  return tokens(s).filter((t) => !isQualifier(t));
}

export const keyOf = (toks) => toks.join('');

// The name as written, minus pitch qualifiers: "Gröndals IP 22 konstgräs" -> "Gröndals IP".
export function cleanName(s) {
  return s
    .split(/[\s,/()]+/)
    .filter((w) => w && tokens(w).some((t) => !isQualifier(t)))
    .join(' ');
}

// Splits "Brovallen, Bunkeflostrand konstgräs 7-manna 1" or "Backavallen 2 (GRATTS Arena)"
// into its main part and any extra parts (town hints, sponsor names, alternatives).
export function segments(raw) {
  const extras = [];
  const main = raw.replace(/\(([^)]*)\)/g, (_, inner) => (extras.push(inner), ' '));
  const [first, ...rest] = main.split(/[,/;]| - /);
  return { main: first, extras: [...rest, ...extras].filter((s) => s.trim()) };
}

// Contiguous token runs, longest (most specific) first.
export function subsequences(toks, maxLen = 5) {
  const out = [];
  for (let len = Math.min(toks.length, maxLen); len >= 1; len--) {
    for (let i = 0; i + len <= toks.length; i++) out.push(toks.slice(i, i + len));
  }
  return out;
}

// Words in team names that are not the club's place name.
const TEAM_NOISE = new Set([
  'if', 'fk', 'bk', 'ik', 'sk', 'fc', 'aik', 'gif', 'goif', 'gik', 'bois', 'bols', 'is', 'ff',
  'ifk', 'kfum', 'bik', 'sif', 'fif', 'hif', 'ois', 'ais', 'ssk', 'if', 'fbk', 'sff', 'bif', 'dif',
  'afc', 'cf', 'sc', 'ac', 'as', 'bp', 'ifa', 'united', 'utd', 'city', 'club', 'sport', 'sports',
  'idrottsforening', 'idrottsklubb', 'fotbollsklubb', 'fotbollsforening', 'bollklubb',
  'bollforening', 'sportklubb', 'idrottsallskap', 'och', 'i', 'af', 'u', 'ungdom', 'dam',
  'damer', 'herr', 'herrar', 'akademi', 'academy', 'utv', 'utveckling', 'team', 'lag', 'vit',
  'vita', 'svart', 'svarta', 'rod', 'roda', 'bla', 'gul', 'gula', 'gron', 'grona', 'orange',
  'rosa', 'lila', 'gra', 'guld', 'silver', 'turkos', 'fotboll', 'football', 'soccer', 'fotbolls',
  'ungdomsklubb', 'ungdomsforening', 'flickor', 'pojkar', 'flick', 'pojk', 'real', 'inter',
  'sporting', 'athletic', 'ff', 'ik', 'the', 'fotbollforening', 'bollsallskap', 'kultur',
  'tjejer', 'killar', 'junior', 'juniors', 'senior', 'ungdoms', 'veteran', 'veteraner', 'elit',
]);

export function teamPlaceTokens(team) {
  return tokens(team).filter(
    (t) => !TEAM_NOISE.has(t) && !isQualifier(t) && !/^[pfu]\d+$/.test(t) && !/^(19|20)\d\d$/.test(t) && t.length > 1,
  );
}

// Swedish genitive: "Kristinebergs IP" is at Kristineberg.
export function withoutGenitive(key) {
  return key.length > 4 && key.endsWith('s') ? key.slice(0, -1) : null;
}
