# greenLy

Self-hosted PWA for watering houseplants. Add a plant from a photo (Pl@ntNet identification), get a
watering interval computed for that species **and** the conditions it lives in, see a moisture bar per plant,
tap "Podlej" when you water, and receive a web push reminder when a plant is due.

Optional Claude integration (each user brings their own pay-per-use Anthropic API key): a **check-up** of a plant
from a photo with recommendations, a **doctor** mode that diagnoses a described problem and can ask follow-up
questions, and a generated **species care profile** — all stored per plant in its history.

Multi-user: accounts with their own plants, push subscriptions and Claude key. Registration needs an invite code
made in the admin panel (the first account, created from `config.js`, is the admin). After registering — and on every
browser visit until the user agrees to use a plain tab — a modal explains how to add greenLy to the Home Screen.

UI language: Polish. Code, comments and docs: English.

## Stack

- **Backend:** Node.js ≥ 22.13 (tested on 22.20, targets 23.x), `node:http` only, SQLite via the built-in
  `node:sqlite`. No ORM, no migrations — `CREATE TABLE IF NOT EXISTS` on start.
- **Frontend:** plain HTML/CSS/ES modules in `public/`. No bundler, no npm at runtime.
- **Push:** [`web-push`](https://github.com/web-push-libs/web-push) (the only dependency), VAPID, daily cron.
- **Identification:** Pl@ntNet API (`/v2/identify/all`, free tier 500 req/day). The key lives only in
  `config.js`; `/api/identify` proxies the request so the browser never sees it.
- **Plant health / profiles (optional):** Claude via `@anthropic-ai/sdk` — one Messages request per analysis
  (image + plant context → JSON via structured outputs). Keys are per user, AES-GCM encrypted in SQLite; `ai.js` builds the prompts.
- **Auth:** scrypt password hashes, random 32-byte session tokens (`Authorization: Bearer`), no cookies.

## Layout

```
server.js            HTTP server: static files from public/ + JSON API under /api/*
lib.js               DB, care profile matching, interval algorithm (source of truth)
ai.js                Claude: health check-ups, doctor diagnosis with follow-ups, species profiles
cron.js              daily reminder: node cron.js  (or GET /api/cron?secret=…)
genkeys.js           prints a VAPID key pair
care.json            care profiles: groups / species / genus / family
config.example.js    → copy to config.js (gitignored); all secrets live there
public/              index.html, app.js, styles.css, sw.js, manifest.webmanifest, img/
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

All endpoints are under `/api/` and return JSON. Everything except `login`, `register` and `cron` requires
`Authorization: Bearer <token>` (fallback: `?t=<token>`, used for `<img>` photo URLs). Missing/invalid token → 401.
Every plant, watering, event, check, photo and subscription is scoped to the session's user; foreign ids → 404.

| method | action | body / notes |
|---|---|---|
| POST | `login` | `{login, password}` → `{token, user}`; scrypt verify, 400 ms delay on failure. `{password}` alone means `config.adminLogin` (old cached clients) |
| POST | `register` | `{login, password, invite}` → `{token, user}`; login `[a-z0-9][a-z0-9._-]{2,31}`, password ≥ 8; `invite` = a panel code with uses left or `config.inviteCode` |
| POST | `logout` | drops the session |
| POST | `account` | `{anthropic_key?, model?, effort?, password?, current_password?}` → `{user}`; a key is verified against Anthropic (`models.list`) before it is stored encrypted, `null` removes it; a password change logs out other devices |
| GET | `admin` | admin only: `{users:[{id, login, is_admin, plants, subs, has_key, last_seen, invite_code}], invites:[…], config_invite}` |
| POST | `adminuser` | admin only: `{id, action: delete\|password\|admin\|unadmin, password?}`; deleting a user removes their plants and photos; the last admin cannot be demoted |
| POST | `admininvite` | admin only: `{action: create\|disable\|enable\|delete, code?, note?, max_uses?}` → `{invites, code}` |
| GET | `plants` | `{plants:[…], today, ai, user}`; each plant carries `interval`, `next_due`, `days_left`, `group_label`, `group_note`, `match_level`; `ai` = this user has a key |
| POST | `identify` | multipart, field `image` (jpeg/png/webp, ≤ 8 MB) → top 5 `{score, species, genus, family, common[], profile}`; 404 = not recognized, 429 = daily quota, 503 = no key configured |
| POST | `lookup` | `{species}` → `{species, profile}` for a manually typed name |
| POST | `save` | create (`id` null) or update; optional `photo` as data URL (jpeg/png/webp, ≤ 600 KB, magic bytes checked) stored in `data/photos/`; `photo: null` removes it |
| POST | `water` | `{id, date?}` → sets `last_watered`, appends to `waterings`, clears `last_notified`; returns `{plant, watering_id}` (the UI offers a 5 s undo) |
| POST | `unwater` | `{watering_id}` → deletes that history row and recomputes `last_watered` from the remaining ones (undo, or removing a wrong entry) |
| POST | `delete` | `{id}` → removes plant, its history and photo |
| GET | `vapid` | `{publicKey}` |
| POST | `subscribe` / `unsubscribe` | PushSubscription JSON / `{endpoint}` |
| GET | `photo/<file>` | stored photo, auth required |
| GET | `plant/<id>` | profile view data: `{plant, care, waterings, checks, ai}` |
| POST | `health` | multipart: `id`, `mode` (`checkup`\|`doctor`), `text`, 1–4 `image` fields — or `parent_id` + `text` to answer the doctor's questions (the root photos are re-sent); → `{check}`; 503 when the user has no Anthropic key |
| POST | `event` | `{plant_id, type, date?, note?, data?}` — care event (`repot`, `move`, `fertilize`, `prune`, `treat`, `shower`, `bloom`, `growth`, `note`); `repot` updates `pot_cm`/`pot_material` and `move` updates `light`/`dry_air` (the interval follows), `data.watered` also logs a watering → `{event, plant}` |
| POST | `unevent` | `{event_id}` → deletes the event (condition changes are not reverted) |
| POST | `split` | `{id, name, pot_cm?, pot_material?, photo?, watered?, date?, note?}` — division: creates a second plant with the same species/profile/conditions, logs a `split` event on both → `{plant, original}` |
| POST | `profile` | `{id, refresh?}` → species care profile written by Claude, cached in `plants.profile` |
| GET | `cron?secret=…` | runs the reminder; protected by `cronSecret`, not the login token |

## Database (SQLite, `data/greenly.sqlite`)

- `users` — id, login (unique), pass_hash (`scrypt$salt$hash`), anthropic_key (AES-256-GCM blob or NULL), anthropic_model,
  anthropic_effort, is_admin, invite_code, created_at
- `sessions` — token (PK, 64 hex), user_id, created_at, last_seen (bumped hourly; rows idle for a year are pruned on start)
- `invites` — code (PK), note, max_uses, uses, disabled, created_by, created_at
- `plants` — id, user_id, name, species, common, genus, family, group_key, base_summer, base_winter, pot_cm,
  pot_material, light, dry_air, photo, note, last_watered, last_notified, created_at
- `waterings` — id, plant_id, ts. Every `last_watered` has a matching row: `save` adds one for a manually entered date, and `openDb()` backfills legacy plants without history.
- `subs` — endpoint (PK), p256dh, auth, user_id, created_at. Re-subscribing from the same browser moves the endpoint to the current user.
- `events` — id, plant_id, type, ts, note, data (JSON: before/after values for repot/move, sibling for split, `watered`), created_at. The profile's timeline merges events, waterings, health checks and `created_at`.
- `health_checks` — id, plant_id, parent_id (follow-up chain), mode, ts, photo, photos (JSON array), user_text, result (JSON), model, input_tokens, output_tokens
- `plants.profile` — cached species profile JSON (added via `ensureColumn()` on start for databases created before it existed)

**First start after the user system** (`ensureAdmin()` in `lib.js`): when `users` is empty the app creates
`config.adminLogin` with `config.password` (and `config.anthropicApiKey`, encrypted) as admin, then gives every plant and
subscription without an owner to the oldest account. Nothing is deleted or renamed; the old data simply belongs to the admin.
The encryption secret is `config.secretKey` or, when empty, a random one written to `data/secret.key` on first run.

## PWA / push

- `sw.js` caches the shell on install (`skipWaiting` + `clients.claim`), serves it cache-first with background
  refresh, and **never caches `/api/`**. It handles `push` and `notificationclick` (focuses an open window or opens `appUrl`).
- The subscription is created only from a user gesture ("Powiadomienia" button) after `Notification.requestPermission()`.
- **iPhone:** web push works only in the version added to the Home Screen (iOS 16.4+). Open Safari → Share →
  "Add to Home Screen", launch from the icon, then tap "Powiadomienia" there.
- **Install prompt:** outside standalone mode the app shows a modal with platform-specific steps (iOS share sheet,
  Android/desktop `beforeinstallprompt` button or menu) after registration and on every visit until the user ticks
  "I know I won't get reminders" and chooses to stay in the browser (`localStorage` `greenly.webok`). "Konto → Jak zainstalować" reopens it.
- **Instant paint:** the last `plants` response and each opened plant view are cached in `localStorage`
  (`greenly.cache.*`); views render from the cache first and re-render only when the fresh response differs, so
  reopening the app or returning from a sheet does not flash skeletons or jump the scroll position.

## Claude analyses

`ai.js` sends one request per analysis with the user's own key and model/effort (from account settings; defaults come
from `config.anthropicModel` / `anthropicEffort`), adaptive thinking at the chosen effort, `output_config.format` = JSON schema (`HEALTH_SCHEMA` / `PROFILE_SCHEMA`) and
server-side refusal fallbacks (`fallbacks: "default"`). The user message carries the photo (base64, ≤ 1200 px from the
client) plus a plain-text context block: species, care group and its tip, pot, light, dry air, computed interval,
days since watering, owner's note, the last six care events, date. Doctor follow-ups replay the chain (root photo + context, assistant JSON,
answers) so the model updates its verdict; `questions` is empty when nothing is missing.

Token usage is stored per check and the UI shows an approximate cost from a small per-model price table in `app.js`.
Typical check-up on Opus 5: ~2–3k input + ~1–3k output tokens (thinking included) ≈ $0.02–0.08.

`GREENLY_FAKE_AI=1 node server.js` swaps in a canned client (no network) for every user, for UI work without a key.

## Updates in the installed PWA

`sw.js` fetches the shell (`index.html`, `app.js`, `styles.css`, manifest) **network-first** with a 4 s timeout and
falls back to the cache, so every fresh open of the installed app runs the latest deploy and still works offline.
An app that stays open (iOS resumes PWAs from memory) compares the `ETag`/`Last-Modified` of `app.js` on every
return to the foreground and every 30 min; a change shows the "Jest nowa wersja" banner whose button clears all
caches and reloads. The "Odśwież aplikację" link at the bottom of the list does the same on demand.

## Cron

`node cron.js` once a day. Picks plants with `days_left <= 0`, skips those never watered and those already
notified today, groups them by owner, builds one notification per user (single plant: "Czas podlać: {name}" + the
group's tip; several: count + names), sends it to that user's subscriptions, deletes expired ones (404/410), then sets `last_notified`.
HTTP fallback: `GET /api/cron?secret=<cronSecret>`.

## Local development

```sh
npm install
cp config.example.js config.js   # set at least "password" (+ inviteCode to try registration)
npm start                        # http://localhost:8080 — log in as adminLogin / password
npm test
```

`GREENLY_DATA=/some/dir` moves `data/` (the tests use a temp dir); `GREENLY_CONFIG` points at another config file.

`node genkeys.js` prints VAPID keys. `npm run icons` regenerates PNG icons from the SVGs.
Node prints an `ExperimentalWarning` for `node:sqlite` on 22.x/23.x; it is harmless
(`NODE_OPTIONS=--no-warnings=ExperimentalWarning` silences it).

## Security notes

- `config.js` is gitignored and lives outside `public/`, as do `data/` and the SQLite file; the static
  handler refuses paths outside `public/`.
- Passwords are scrypt-hashed; session tokens are 32 random bytes; Anthropic keys are encrypted at rest and never
  returned to the client (only the last 4 characters as a hint). Login and registration failures are delayed by 400 ms.
- Photos are validated by MIME prefix **and** magic bytes, size-capped, and served only with a valid token.
- All inputs are length-limited and enum-checked server-side; profiles are re-resolved on save, the client
  cannot set base values.

Deployment on Plesk: see [DEPLOY.md](DEPLOY.md).
