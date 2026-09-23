# Architecture

How greenLy works inside. For setup see [INSTALL.md](INSTALL.md); for the security model see [SECURITY.md](../SECURITY.md).

## Layout

```
server.js            HTTP server: static files from public/ + JSON API under /api/*
lib.js               DB, care profile matching, interval algorithm (source of truth)
ai.js                Claude: health check-ups, doctor diagnosis with follow-ups, species profiles
messages.js          English versions of server messages (X-Lang: en)
cron.js              daily reminder: node cron.js  (or GET /api/cron with X-Cron-Secret)
genkeys.js           prints a VAPID key pair, an invite code and a secret
care.json            care profiles: groups / species / genus / family
config.example.js    → copy to config.js (gitignored); all secrets live there
docs/                installation, Plesk deployment, this file
public/              index.html, app.js, i18n.js, styles.css, sw.js, manifest.webmanifest, img/
scripts/make-icons.sh  SVG → PNG
test/                node --test
data/                greenly.sqlite + photos/ (created on first run, gitignored)
```

- **Backend:** Node.js ≥ 22.13, `node:http` only, SQLite via the built-in `node:sqlite`. No ORM and no migration tool:
  `CREATE TABLE IF NOT EXISTS` plus `ensureColumn()` on start.
- **Frontend:** plain HTML, CSS and ES modules in `public/`. No bundler, no npm at runtime.
- **Identification:** Pl@ntNet `/v2/identify/all`, proxied by `/api/identify` so the key stays on the server.
- **Push:** `web-push` with VAPID, sent by the daily cron.

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
A "still wet" snooze (`plants.snoozed_until`) overrides `next_due` when it is later; the API marks such plants `snoozed`.

`water_ml` is a hint per watering (`lib.js#wateringMl`): the pot volume (cylinder with height = diameter) × the care
group's `ml` share from `care.json` (5 % cacti … 13 % ferns) × how fast the pot dries (terracotta 1.15, cachepot 0.8;
full sun 1.15, dark corner 0.8; dry air 1.05) × the plant's learned `ml_adjust`, rounded to 10 ml. Groups with
`ml_mode: "soak"` (orchids) get "dunk the pot" instead of a number (`water_mode`).

**Learning from "still wet"** (`learnFromSnooze` / `learnFromWatering`): a second snooze in the same watering cycle, or
one in each of two consecutive cycles, multiplies `ml_adjust` by 0.85 (floor 0.5) and `interval_adjust` by 1.1 (cap
1.6) — once per cycle, and the triggering snooze event is marked `adjusted`. Three completed cycles without a snooze
relax both by one step. `interval_adjust` is part of the interval formula on both server and client.

## Care profiles (care.json)

```json
{
  "groups":  { "aroid": { "label": "…", "summer": 8, "winter": 13, "note": "one practical tip", "ml": 0.11 } },
  "species": { "Monstera deliciosa": { "group": "aroid", "summer": 9, "winter": 14 } },
  "genus":   { "Monstera": "aroid" },
  "family":  { "Araceae": "aroid" }
}
```

Groups: aroid 8/13, succulent 16/35, cactus 18/45, fern 4/6, marantaceae 5/8, ficus 9/15, palm 8/14,
orchid 7/12, compact 18/35, citrus 5/10, herb 3/5, flowering 5/9, begonia 6/10, universal 8/13.
Species names are normalized before matching (lower-case, hybrid sign and cultivar/author stripped).

`ml` is the share of the pot volume used for the portion hint; `ml_mode: "soak"` switches a group to soaking.

## HTTP API

All endpoints are under `/api/` and return JSON. Everything except `login`, `register`, `version` and `cron` requires
`Authorization: Bearer <token>`. `photo/<file>` alternatively takes `?t=<photo_token>` (from `user.photo_token`) for
`<img>` loads. Missing/invalid token → 401.
Every plant, watering, event, check, photo and subscription is scoped to the session's user; foreign ids → 404.

| method | action | body / notes |
|---|---|---|
| POST | `login` | `{login, password, lang?}` → `{token, user}`; scrypt verify (dummy hash for unknown logins), 400 ms delay on failure, rate-limited |
| POST | `register` | `{login, password, invite}` → `{token, user}`; login `[a-z0-9][a-z0-9._-]{2,31}`, password ≥ 8; `invite` = a panel code with uses left or `config.inviteCode` |
| POST | `logout` | deletes the session on the server |
| GET | `version` | `{version}` — `APP_VERSION` of the `app.js` on disk; the client compares it with its own to offer a reload |
| POST | `account` | `{anthropic_key?, model?, effort?, password?, current_password?, lang?}` → `{user}`; a key is verified against Anthropic (`models.list`) before it is stored encrypted, `null` removes it; a password change logs out other devices. AI fields are rejected (400) for users on the global key |
| GET | `admin` | admin only: `{users:[{id, login, is_admin, plants, subs, has_key, last_seen, invite_code}], invites:[…], config_invite}` |
| POST | `adminuser` | admin only: `{id, action: delete\|password\|admin\|unadmin\|global\|unglobal, password?}`; deleting a user removes their plants and photos; the last admin cannot be demoted; `global` puts the user on the admin's key |
| POST | `adminglobal` | admin only: `{anthropic_key?: string\|null, model?, effort?}` → `{global}`; the server-wide Claude key (verified, encrypted in `settings`) used by every user with `use_global_key` |
| POST | `admininvite` | admin only: `{action: create\|disable\|enable\|delete, code?, note?, max_uses?}` → `{invites, code}` |
| GET | `plants` | `{plants:[…], today, ai, user}`; each plant carries `interval`, `next_due`, `days_left`, `group_label`, `group_note`, `match_level`; `ai` = this user has a key |
| POST | `identify` | multipart, field `image` (jpeg/png/webp, ≤ 8 MB) → top 5 `{score, species, genus, family, common[], profile}`; 404 = not recognized, 429 = daily quota, 503 = no key configured |
| POST | `lookup` | `{species}` → `{species, profile}` for a manually typed name |
| POST | `save` | create (`id` null) or update; optional `photo` (thumbnail data URL, ≤ 600 KB) plus `photo_full` (≤ 2 MB, shown in the lightbox), both jpeg/png/webp with magic bytes checked, stored in `data/photos/`; `photo: null` removes both |
| POST | `water` | `{id, date?}` → sets `last_watered`, appends to `waterings`, clears `last_notified`; returns `{plant, watering_id}` (the UI offers a 5 s undo) |
| POST | `unwater` | `{watering_id}` → deletes that history row and recomputes `last_watered` from the remaining ones (undo, or removing a wrong entry) |
| POST | `postpone` | `{id, days (1–7), note?}` — "still wet": sets `snoozed_until` to today (or the due date, if later) + days and logs a `snooze` event → `{plant, until, learned}` (`learned` = new `{ml_adjust, interval_adjust}` when the plan was tightened). Watering clears the snooze and may relax the factors (`relaxed`) |
| POST | `delete` | `{id}` → removes plant, its history and photo |
| GET | `vapid` | `{publicKey}` |
| POST | `subscribe` / `unsubscribe` | PushSubscription JSON / `{endpoint}` |
| GET | `photo/<file>` | stored photo; session header or `?t=<photo_token>`, only the owner's photos |
| GET | `plant/<id>` | profile view data: `{plant, care, waterings, checks, ai}` |
| POST | `health` | multipart: `id`, `mode` (`checkup`\|`doctor`), `text`, 1–4 `image` fields — or `parent_id` + `text` to answer the doctor's questions (the root photos are re-sent); → `{check}`; 503 when the user has no Anthropic key |
| POST | `event` | `{plant_id, type, date?, note?, data?}` — care event (`repot`, `move`, `fertilize`, `prune`, `treat`, `shower`, `bloom`, `growth`, `note`); `repot` updates `pot_cm`/`pot_material` and `move` updates `light`/`dry_air` (the interval follows), `data.watered` also logs a watering → `{event, plant}` |
| POST | `unevent` | `{event_id}` → deletes the event (condition changes are not reverted) |
| POST | `split` | `{id, name, pot_cm?, pot_material?, photo?, watered?, date?, note?}` — division: creates a second plant with the same species/profile/conditions, logs a `split` event on both → `{plant, original}` |
| POST | `profile` | `{id, refresh?}` → species care profile written by Claude, cached in `plants.profile` |
| GET | `cron` | runs the reminder; `cronSecret` in the `X-Cron-Secret` header or `?secret=`; not the login token |

Rate limits and body limits are listed in [SECURITY.md](../SECURITY.md#security-model).

## Database (SQLite, `data/greenly.sqlite`)

- `users` — id, login (unique), pass_hash (`scrypt$salt$hash`), anthropic_key (AES-256-GCM blob or NULL), anthropic_model,
  anthropic_effort, is_admin, invite_code, use_global_key, lang, created_at
- `sessions` — token (PK, sha256 of the bearer token), user_id, created_at, last_seen (bumped hourly; rows idle for a year are pruned on start)
- `invites` — code (PK), note, max_uses, uses, disabled, created_by, created_at
- `settings` — key (PK), value: `global_anthropic_key` (encrypted), `global_model`, `global_effort`
- `users.use_global_key` — 1 = analyses run on the global key with its model/effort; the user's own key settings are locked and the account screen says so
- `plants` — id, user_id, name, species, common, genus, family, group_key, base_summer, base_winter, pot_cm,
  pot_material, light, dry_air, photo, photo_full, note, last_watered, last_notified, snoozed_until, ml_adjust, interval_adjust, created_at
- `waterings` — id, plant_id, ts. Every `last_watered` has a matching row: `save` adds one for a manually entered date, and `openDb()` backfills legacy plants without history.
- `subs` — endpoint (PK), p256dh, auth, user_id, created_at. Re-subscribing from the same browser moves the endpoint to the current user.
- `events` — id, plant_id, type, ts, note, data (JSON: before/after values for repot/move, sibling for split, `watered`), created_at. The profile's timeline merges events, waterings, health checks and `created_at`.
- `health_checks` — id, plant_id, parent_id (follow-up chain), mode, ts, photo, photos (JSON array), user_text, result (JSON), model, input_tokens, output_tokens
- `plants.profile` — cached species profile JSON (added via `ensureColumn()` on start for databases created before it existed)

**First start after the user system** (`ensureAdmin()` in `lib.js`): when `users` is empty the app creates
`config.adminLogin` with `config.password` (and `config.anthropicApiKey`, encrypted) as admin, then gives every plant and
subscription without an owner to the oldest account. Nothing is deleted or renamed; the old data simply belongs to the admin.
The encryption secret is `config.secretKey` or, when empty, a random one written to `data/secret.key` on first run.

## PWA, languages and UI

- `sw.js` caches the shell on install (`skipWaiting` + `clients.claim`) and **never caches `/api/`**. It handles `push`
  and `notificationclick` (focuses an open window or opens `appUrl`).
- The subscription is created only from a user gesture (*Notifications* in the menu) after `Notification.requestPermission()`.
- **iPhone:** web push works only in the version added to the Home Screen (iOS 16.4+).
- **Install prompt:** outside standalone mode the app shows a modal with platform-specific steps (iOS share sheet,
  Android/desktop `beforeinstallprompt` button or menu) after registration and on every visit until the user ticks
  "I know I won't get reminders" and chooses to stay in the browser (`localStorage` `greenly.webok`). *Account → How to install* and the menu reopen it.
- **No key yet:** the AI buttons stay enabled; without a usable key they open a popup that explains the
  bring-your-own-key model, typical cost per analysis and what $5 buys, and jumps to the account screen, which has a
  step-by-step guide (Console → Settings → Billing → Buy credits, Settings → API keys → Create key) kept in sync
  with platform.claude.com/docs/en/get-api-key.
- **Languages:** Polish and English. `public/i18n.js` holds `t()` and the English dictionary keyed by the Polish
  source strings (missing keys fall back to Polish; `test/i18n.test.mjs` fails on any key without a translation).
  The language comes from `localStorage` (`greenly.lang`), else from the browser (`pl*` → Polish, anything else →
  English). A flag dropdown on the auth screens and a menu entry switch it (reload). The client sends `X-Lang` on
  every request, so server error messages come back translated (`messages.js`), Claude answers in that language,
  and the user's language is stored (`users.lang`) for the cron's push notifications.
- **Menu:** a hamburger in the top bar opens a panel with the account, notifications toggle (with state), admin panel,
  install help, refresh and logout. The bottom sheet can be swiped down to dismiss (from the handle/header, or from
  the body when it is scrolled to the top). Tapping a plant or check-up photo opens a full-screen lightbox
  (double-tap zooms). A new deploy shows a blocking dialog with a single "refresh" button.
- **Instant paint:** the last `plants` response and each opened plant view are cached in `localStorage`
  (`greenly.cache.*`); views render from the cache first and re-render only when the fresh response differs, so
  reopening the app or returning from a sheet does not flash skeletons or jump the scroll position.

## Updates in the installed app

`sw.js` fetches the shell (`index.html`, `app.js`, `i18n.js`, `styles.css`, manifest) **network-first** with a 4 s
timeout and falls back to the cache, so a fresh open runs the latest deploy and still works offline. Assets are
referenced with `?v=<APP_VERSION>`, which defeats web-server caches after a deploy. A running app asks `/api/version`
on every return to the foreground and every 30 minutes; a different version shows a blocking "new version" dialog
that clears all caches and reloads. `APP_VERSION` in `app.js`, the `?v=` query in `index.html` and `CACHE` in `sw.js`
must match; `test/version.test.mjs` checks it.

## Claude analyses

`ai.js` sends one request per analysis with the user's own key and model/effort (from account settings; defaults come
from `config.anthropicModel` / `anthropicEffort`, or the admin's global key and settings), in the user's language, adaptive thinking at the chosen effort, `output_config.format` = JSON schema (`HEALTH_SCHEMA` / `PROFILE_SCHEMA`) and
server-side refusal fallbacks (`fallbacks: "default"`). The user message carries the photo (base64, ≤ 1200 px from the
client) plus a plain-text context block: species, care group and its tip, pot, light, dry air, computed interval,
days since watering, owner's note, the last six care events, date. Doctor follow-ups replay the chain (root photo + context, assistant JSON,
answers) so the model updates its verdict; `questions` is empty when nothing is missing.

Token usage is stored per check and the UI shows an approximate cost from a small per-model price table in `app.js`.
Typical check-up on Opus 5: ~2–3k input + ~1–3k output tokens (thinking included) ≈ $0.02–0.08.

`GREENLY_FAKE_AI=1 node server.js` swaps in a canned client (no network) for every user, for UI work without a key.

## Cron

`node cron.js` once a day. Picks plants with `days_left <= 0`, skips those never watered and those already
notified today, groups them by owner, builds one notification per user in their language (single plant: the name + the
group's tip; several: count + names), sends it to that user's subscriptions, deletes expired ones (404/410), then sets `last_notified`.
HTTP fallback: `GET /api/cron` with `X-Cron-Secret: <cronSecret>` (or `?secret=`).
