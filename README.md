# Fotbollskartan

Every football match in Sweden for the coming week on one map, from Allsvenskan down to a Tuesday-night P12 game on the local turf. Filter by men/women, senior/youth/kids, national or district series, senior tier and age group, then hit **Near me** to see what's being played around you.

Senior leagues carry a colour-coded tier badge. Men and women share the numbering:

| Tier | Men | Women |
|---|---|---|
| 1 | Allsvenskan | Damallsvenskan |
| 2 | Superettan | Elitettan |
| 3 | Ettan | Division 1 |
| 4–8 | Division 2–6 | Division 2–6 |

Reserve, development, cup and 7-a-side competitions have no tier. Map markers show the highest tier being played at each venue.

## How it works

```
svenskfotboll.se  ──►  scripts/update.mjs  ──►  public/data/matches.json  ──►  static site (GitHub Pages)
 matches-today API       │
                         ├─ OSM gazetteer (Overpass)   venue name → coordinates
                         ├─ Nominatim (budgeted)       fallback for names OSM doesn't have
                         └─ cache/venues.json          resolved venues, committed
```

- **Fixtures** come from the JSON endpoint behind [Matcher idag](https://www.svenskfotboll.se/serier-cuper/matcher-idag/) (`/api/matches-today/games/?associationId=…&date=…`). The script queries SvFF plus all 24 district associations for today and the next 7 days (`DAYS=8`), which comes to about 10,000 matches a week. The match detail pages sit behind a Cloudflare challenge, so only this API is used.
- **Venues** only come as names ("Hagby IP 3", "Norrvalla IP 2, Lammhult"), so `scripts/lib/geocode.mjs` places them in this order:
  1. **Name match.** Strip pitch qualifiers (numbers, "A-plan", "konstgräs 7-manna"), then look up what's left among OpenStreetMap's named pitches, stadiums, sports centres, schools and parks. Only the home club's district is searched. When a name like "Björkvallen" occurs several times there, the one closest to the club's town wins (the town is read from the team name, e.g. "Lammhults IF").
  2. **Pitch snap.** "Snogeröds IP" names its village. If OSM has exactly one football pitch there, named or not, that's the venue.
  3. **Nominatim**, at most 150 lookups a run at one per second. Venues with no position at all come before approximate ones.
  4. **Approximate.** Otherwise the venue goes on the nearest football pitch in the club's town (or the town centre) and gets a dashed marker.
- **Resolved venues** are cached in `cache/venues.json`, so each daily run only has to geocode venues it hasn't seen before.

## Daily update

`.github/workflows/update.yml` runs every day at 11:00 Stockholm time. GitHub cron only understands UTC, so the workflow is triggered at 09:00 and 10:00 UTC (plus 11:30 UTC as a fallback). A gate step then lets through only the first run at or after 11:00 local time, so the update keeps to 11:00 across summer and winter time. It also deploys on every push to `main`.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

## Local development

Requires Node 20+. There are no dependencies.

```bash
npm run update     # fetch matches, build/refresh the OSM gazetteer, write public/data/matches.json
npm run serve      # http://localhost:8080
```

The first run downloads the OSM gazetteer (22 Overpass queries, ~3 MB). That takes a few minutes, or longer when Overpass is busy. After that it's reused for 30 days.

## Fixing a misplaced venue

Add it to `cache/venue-overrides.json` using the venue name exactly as svenskfotboll.se writes it. You can key it by the name alone, or by `"<districtId>|<name>"` if the same name exists in several districts:

```json
{
  "Hagby IP 3": [59.4312, 17.9885],
  "16|Björkvallen": [59.4401, 17.8123]
}
```

To force a venue to be looked up again, delete its line from `cache/venues.json`.

## Notes

- This is an unofficial site and isn't affiliated with Svenska Fotbollförbundet. It relies on an undocumented endpoint that may change without notice. If a run returns no matches, the job fails and the previous deploy stays online.
- Map tiles © OpenStreetMap contributors, used under the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/). If traffic grows, switch the tile URL in `public/app.js` to a commercial provider.
