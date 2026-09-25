// Club crests, downloaded once and published with the site so visitors never load images from
// svenskfotboll.se. Crest ids are per club (every Brommapojkarna team shares one). Clubs without
// a crest get a 1×1 placeholder from the CDN; those are remembered and skipped for a while.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pool } from './svff.mjs';

const UA = 'fotbollskartan/1.0 (+https://github.com/oguneg/svenskfotboll)';
const crestUrl = (id) => `https://staticcdn.svenskfotboll.se/img/teamssm/${id}.png`;
const DAY = 86_400_000;
const REFRESH_DAYS = 60; // clubs occasionally redesign their crest
const MISSING_RETRY_DAYS = 14;

// Makes sure `dir` holds a crest for every id it can. Returns the ids that have one.
export async function syncCrests(ids, dir, missingFile, { today, log = console.log } = {}) {
  mkdirSync(dir, { recursive: true });
  const missing = existsSync(missingFile) ? JSON.parse(readFileSync(missingFile, 'utf8')) : {};
  const now = Date.now();
  const isFresh = (id) => {
    const file = join(dir, `${id}.png`);
    return existsSync(file) && now - statSync(file).mtimeMs < REFRESH_DAYS * DAY;
  };
  const knownMissing = (id) => missing[id] && now - Date.parse(missing[id]) < MISSING_RETRY_DAYS * DAY;
  const todo = [...ids].filter((id) => id > 0 && !isFresh(id) && !knownMissing(id));

  let fetched = 0;
  let failed = 0;
  await pool(
    todo.map((id) => async () => {
      try {
        const res = await fetch(crestUrl(id), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) });
        const buf = Buffer.from(await res.arrayBuffer());
        if (!res.ok || buf.length < 200) {
          missing[id] = today; // 1×1 placeholder: the club has no crest
          return;
        }
        writeFileSync(join(dir, `${id}.png`), buf);
        delete missing[id];
        fetched++;
      } catch {
        failed++; // network hiccup; tried again next run
      }
    }),
    4,
    50,
  );

  const sorted = Object.fromEntries(Object.entries(missing).sort(([a], [b]) => a - b));
  writeFileSync(missingFile, JSON.stringify(sorted, null, 0) + '\n');
  const available = new Set(
    readdirSync(dir).filter((f) => /^\d+\.png$/.test(f)).map((f) => Number(f.slice(0, -4))),
  );
  log(`  crests: ${fetched} downloaded, ${failed} failed, ${Object.keys(missing).length} clubs without a crest, ${available.size} on disk`);
  return available;
}
