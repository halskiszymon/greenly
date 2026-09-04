# greenLy

Self-hosted PWA for watering houseplants. Add a plant from a photo (Pl@ntNet identification), get a
watering interval computed for that species **and** the conditions it lives in, see a moisture bar per plant,
tap "Podlej" when you water, and receive a web push reminder when a plant is due.

UI language: Polish. Code, comments and docs: English.

## Stack

- **Backend:** Node.js ≥ 22.13 (tested on 22.20, targets 23.x), `node:http` only, SQLite via the built-in
  `node:sqlite`. No ORM, no migrations — `CREATE TABLE IF NOT EXISTS` on start.
- **Frontend:** plain HTML/CSS/ES modules in `public/`. No bundler, no npm at runtime.
- **Push:** [`web-push`](https://github.com/web-push-libs/web-push) (the only dependency), VAPID, daily cron.
- **Identification:** Pl@ntNet API (`/v2/identify/all`, free tier 500 req/day). The key lives only in
  `config.js`; `/api/identify` proxies the request so the browser never sees it.

## Layout

```
server.js            HTTP server: static files from public/ + JSON API under /api/*
lib.js               DB, care profile matching, interval algorithm (source of truth)
cron.js              daily reminder: node cron.js  (or GET /api/cron?secret=…)
genkeys.js           prints a VAPID key pair
care.json            care profiles: groups / species / genus / family
config.example.js    → copy to config.js (gitignored); all secrets live there
public/              index.html, app.js, styles.css, sw.js, manifest.webmanifest, icons/
scripts/make-icons.sh  SVG → PNG
test/                node --test
data/                greenly.sqlite + photos/ (created on first run, gitignored)
```

## Watering interval

```
days = speciesBase(season) × pot × material × light × air     → rounded, clamped to 2–60
```

- **speciesBase** comes from `care.json` with separate summer/winter values, resolved by cascade:
  `species` → `genus` → `family` → `universal`. The match level is returned to the UI.
- **season** is a smooth curve, not a step:
  ```js
  seasonal = (1 - cos(2π · dayOfYear / 365)) / 2   // 0 = mid-winter, 1 = peak summer
  base = winter + (summer - winter) * seasonal
  ```
- Multipliers:

  | factor | values |
  |---|---|
  | pot diameter | ≤10 cm 0.72 · ≤15 0.88 · ≤22 1.00 · ≤30 1.18 · >30 1.35 |
  | material | terracotta 0.80 · ceramic 1.00 · plastic 1.08 · cachepot without drainage 1.20 |
  | light | full sun 0.82 · bright 1.00 · partial shade 1.22 · dark corner 1.45 |
  | dry air / radiator | 0.85, otherwise 1.00 |

`lib.js#intervalDays()` is the source of truth. The same formula is duplicated in `public/app.js#estimate()`
for the live preview in the form; `test/estimate-sync.test.mjs` fails if the two drift apart.

Dates are handled at day granularity in the configured timezone: `days_left = interval − daysSince(last_watered)`.

## care.json

```json
{
  "groups":  { "aroid": { "label": "…", "summer": 8, "winter": 13, "note": "one practical tip" } },
  "species": { "Monstera deliciosa": { "group": "aroid", "summer": 9, "winter": 14 } },
  "genus":   { "Monstera": "aroid" },
  "family":  { "Araceae": "aroid" }
}
```

Groups: aroid 8/13, succulent 16/35, cactus 18/45, fern 4/6, marantaceae 5/8, ficus 9/15, palm 8/14,
orchid 7/12, compact 18/35, citrus 5/10, herb 3/5, flowering 5/9, begonia 6/10, universal 8/13.
Species names are normalized before matching (lower-case, hybrid sign and cultivar/author stripped).

## API

All endpoints are under `/api/` and return JSON. Everything except `login` and `cron` requires
`Authorization: Bearer <token>` (fallback: `?t=<token>`, used for `<img>` photo URLs). Missing/invalid token → 401.

| method | action | body / notes |
|---|---|---|
| POST | `login` | `{password}` → `{token}`; token = `sha256("greenly\|" + password)`, constant-time compare, 400 ms delay on failure |
| GET | `plants` | `{plants:[…], today}`; each plant carries `interval`, `next_due`, `days_left`, `group_label`, `group_note`, `match_level` |
| POST | `identify` | multipart, field `image` (jpeg/png/webp, ≤ 8 MB) → top 5 `{score, species, genus, family, common[], profile}`; 404 = not recognized, 429 = daily quota, 503 = no key configured |
| POST | `lookup` | `{species}` → `{species, profile}` for a manually typed name |
| POST | `save` | create (`id` null) or update; optional `photo` as data URL (jpeg/png/webp, ≤ 600 KB, magic bytes checked) stored in `data/photos/`; `photo: null` removes it |
| POST | `water` | `{id, date?}` → sets `last_watered`, appends to `waterings`, clears `last_notified` |
| POST | `delete` | `{id}` → removes plant, its history and photo |
| GET | `vapid` | `{publicKey}` |
| POST | `subscribe` / `unsubscribe` | PushSubscription JSON / `{endpoint}` |
| GET | `photo/<file>` | stored photo, auth required |
| GET | `cron?secret=…` | runs the reminder; protected by `cronSecret`, not the login token |

## Database (SQLite, `data/greenly.sqlite`)

- `plants` — id, name, species, common, genus, family, group_key, base_summer, base_winter, pot_cm,
  pot_material, light, dry_air, photo, note, last_watered, last_notified, created_at
- `waterings` — id, plant_id, ts
- `subs` — endpoint (PK), p256dh, auth, created_at

## PWA / push

- `sw.js` caches the shell on install (`skipWaiting` + `clients.claim`), serves it cache-first with background
  refresh, and **never caches `/api/`**. It handles `push` and `notificationclick` (focuses an open window or opens `appUrl`).
- The subscription is created only from a user gesture ("Powiadomienia" button) after `Notification.requestPermission()`.
- **iPhone:** web push works only in the version added to the Home Screen (iOS 16.4+). Open Safari → Share →
  "Add to Home Screen", launch from the icon, then tap "Powiadomienia" there.

## Cron

`node cron.js` once a day. Picks plants with `days_left <= 0`, skips those never watered and those already
notified today, builds one notification (single plant: "Czas podlać: {name}" + the group's tip; several:
count + names), sends to every subscription, deletes expired ones (404/410), then sets `last_notified`.
HTTP fallback: `GET /api/cron?secret=<cronSecret>`.

## Local development

```sh
npm install
cp config.example.js config.js   # set at least "password"
npm start                        # http://localhost:8080
npm test
```

`node genkeys.js` prints VAPID keys. `npm run icons` regenerates PNG icons from the SVGs.
Node prints an `ExperimentalWarning` for `node:sqlite` on 22.x/23.x; it is harmless
(`NODE_OPTIONS=--no-warnings=ExperimentalWarning` silences it).

## Security notes

- `config.js` is gitignored and lives outside `public/`, as do `data/` and the SQLite file; the static
  handler refuses paths outside `public/`.
- Photos are validated by MIME prefix **and** magic bytes, size-capped, and served only with a valid token.
- All inputs are length-limited and enum-checked server-side; profiles are re-resolved on save, the client
  cannot set base values.

Deployment on Plesk: see [DEPLOY.md](DEPLOY.md).
