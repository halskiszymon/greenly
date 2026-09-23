# Installation and configuration

greenLy is one Node.js process that serves the static app from `public/` and a JSON API under `/api/`, stores
everything in SQLite under `data/`, and sends push reminders from a daily cron job.

For Plesk, follow [DEPLOY-PLESK.md](DEPLOY-PLESK.md) and come back here for the configuration reference.

## Requirements

- Node.js **22.13 or newer** (`node:sqlite` is built in from 22.13; tested on 22.x and 23.x).
- HTTPS in production. Service workers and web push do not work over plain HTTP (localhost is the exception).
- Optional: a [Pl@ntNet](https://my.plantnet.org) API key for photo identification, VAPID keys for push, and Anthropic
  API keys for the Claude features.

Node prints an `ExperimentalWarning` for `node:sqlite` on 22.x/23.x. It is harmless;
`NODE_OPTIONS=--no-warnings=ExperimentalWarning` silences it.

## Local setup

```bash
npm install
cp config.example.js config.js
npm start          # http://localhost:8080
npm test
```

Useful environment variables:

| variable | effect |
|---|---|
| `PORT` | listen port; overrides `config.port` (`0` = any free port) |
| `GREENLY_CONFIG` | path to another config file |
| `GREENLY_DATA` | move the `data/` directory (the tests use a temp dir) |
| `GREENLY_FAKE_AI=1` | canned Claude answers for every user, no network; `GREENLY_FAKE_AI=4000` also waits 4 s |

## config.js

All secrets live in `config.js` (gitignored). It is read once at start, so restart after editing.

| key | what |
|---|---|
| `password` | password of the first account, which becomes the admin on the first start. Change it later in the app. |
| `adminLogin` | login of that first account (default `admin`). |
| `inviteCode` | optional permanent invite code with unlimited uses. Leave empty to use only codes made in the admin panel. |
| `secretKey` | optional secret that encrypts users' Anthropic keys and signs photo tokens. Empty = a random one is written to `data/secret.key` on first start. Back it up with the database: without it, stored Anthropic keys cannot be decrypted. |
| `plantnetApiKey` | Pl@ntNet key. Empty disables photo identification; typing the name still works. |
| `plantnetLang` | language for common names from Pl@ntNet, e.g. `pl` or `en` (falls back to `en`). |
| `anthropicApiKey` | copied to the admin account on its first start only; afterwards keys are managed in the app. |
| `anthropicModel` / `anthropicEffort` | defaults for new accounts: `claude-opus-5` or `claude-sonnet-5`; `low`, `medium` or `high`. |
| `vapid.subject` / `vapid.publicKey` / `vapid.privateKey` | web push keys, see below. |
| `cronSecret` | long random string; only needed for the HTTP cron endpoint. |
| `appUrl` | public URL with a trailing slash, opened when a notification is tapped. |
| `timezone` | IANA zone used for "today" in the watering math, e.g. `Europe/Warsaw`. |
| `port` | local port when `PORT` is not set (default 8080). |

`node genkeys.js` prints a fresh VAPID pair plus a random `inviteCode` and `secretKey` to paste in.

## Keys

**Pl@ntNet.** Create an account at <https://my.plantnet.org>, open *Settings → API key*. The free tier allows 500
identifications a day; greenLy makes one request per photo. The key never reaches the browser.

**VAPID (web push).** Run `node genkeys.js` and paste the `vapid` block into `config.js`. Keep the private key private.
Changing the pair later invalidates every subscription, so users have to enable notifications again.

**Anthropic (Claude).** Optional and per user. Each person creates a key in the
[Claude Console](https://platform.claude.com/settings/keys) and pastes it in *Account*; the app verifies it with
Anthropic before storing it encrypted. The account screen has a step-by-step guide, including buying credits.
The admin can also store one global key in the admin panel and assign it to chosen users, who then cannot set their
own. Without any key the AI buttons explain how to add one; everything else works.

## First start, users and invites

On the first start with an empty database greenLy creates the `adminLogin` account with `password` (and
`anthropicApiKey`, if set) and makes it admin. Plants and push subscriptions that existed before the user system are
assigned to it, so upgrading an old single-password install loses nothing.

Registration needs an invite code. The admin panel (*Account → Open the admin panel*) creates single- or multi-use
codes with a note, lists users with their plant count and last activity, resets passwords, grants or revokes admin,
assigns the global Claude key and deletes accounts with all their data. There is always at least one admin.

## Running in production

Any host that runs a long-lived Node process works. Put it behind a reverse proxy that terminates HTTPS and forwards
`X-Forwarded-For` and `X-Forwarded-Proto` (used for rate limiting and HSTS).

A minimal systemd unit:

```ini
[Unit]
Description=greenLy
After=network.target

[Service]
WorkingDirectory=/srv/greenly
ExecStart=/usr/bin/node server.js
Environment=PORT=8080 NODE_OPTIONS=--no-warnings=ExperimentalWarning
User=greenly
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Keep `config.js` and `data/` outside the web root (the Node static handler only serves `public/`), make `data/`
writable by the service user, and back up `data/` together with `config.js`.

When the proxy serves `public/` directly instead of passing it through Node, add the security headers there too; the
snippet is in [SECURITY.md](../SECURITY.md#hardening-checklist).

## Daily reminder (cron)

Run once a day, e.g. at 08:00:

```bash
node /srv/greenly/cron.js
```

It prints one line, `cron: due=N sent=N removed=N failed=N`. When you cannot run commands, call the HTTP endpoint
instead and prefer the header, because query strings end up in access logs:

```bash
curl -fsS -H "X-Cron-Secret: <cronSecret>" https://your.host/api/cron
```

`GET /api/cron?secret=<cronSecret>` also works for schedulers that can only fetch a URL.

## Installing on a phone

Reminders only reach the installed app, and on iPhone (iOS 16.4+) only the Home Screen version can receive push at
all. greenLy shows platform-specific install steps after registration and in the menu.

On iPhone: open the site in Safari, *Share → Add to Home Screen*, launch greenLy **from the icon**, then turn on
notifications from the menu.

## When notifications don't arrive

1. **Is anything due?** Run the cron by hand. `due=0` means nothing is due today, everything was already notified
   today, or no plant has a watering date. Water a plant with a date weeks back to force a test.
2. **`sent=0` with `due>0`**: VAPID keys are missing, or nobody has enabled notifications from the installed app.
3. **`removed>0`**: the subscription expired or the app was removed from the Home Screen; enable notifications again.
4. **`failed>0`**: read the error in the cron output. `401`/`403` from the push service usually means the VAPID pair
   changed since the browser subscribed.
5. **HTTPS**: an invalid certificate or mixed content stops the service worker entirely.
6. **iOS**: open the app from the icon at least once after subscribing. Deleting it from the Home Screen drops the
   subscription; Low Power Mode and Focus can delay delivery.
7. **Time zone**: the cron runs on server time, but `days_left` uses `config.timezone`. A wrong server clock shifts
   reminders by a day.

## Updating

Pull the new code, run `npm install` if `package.json` changed, restart. `config.js` and `data/` are untouched by
updates; schema changes are applied automatically on start. Open apps notice the new version and ask for a refresh.

### Upgrading from the single-password version

1. Back up `data/`.
2. Add `adminLogin` to `config.js`; optionally `inviteCode` and `secretKey`. Keep `password` and `anthropicApiKey`.
3. Restart. The log shows `created user "<adminLogin>" from config.password and assigned existing plants to it`.
4. Log in with that login and your old password. `anthropicApiKey` can now be removed from `config.js`.
