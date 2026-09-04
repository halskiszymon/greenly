# Deploying greenLy on Plesk (Node.js)

Target: Plesk Obsidian with the **Node.js** extension, Node 23.x, HTTPS enabled for the (sub)domain.
Web push requires HTTPS — use a Let's Encrypt certificate from Plesk.

## 1. Get the code onto the server

### Option A — Plesk Git integration (recommended)

1. *Websites & Domains → your domain → Git → Add Repository*.
2. Choose **Remote Git hosting**, paste the SSH URL `git@github.com:<you>/greenly.git`.
3. Plesk shows a public SSH key — add it on GitHub as a **Deploy key** on the `greenly` repo (read-only is enough).
4. Deployment mode: *Automatic* (or *Manual* if you prefer to press "Pull updates").
5. Deploy to a folder, e.g. `/greenly` (so the app root is `/var/www/vhosts/<domain>/greenly`).
6. Under *Enable additional deploy actions* add:
   ```
   /opt/plesk/node/23/bin/npm install --omit=dev --prefix /var/www/vhosts/<domain>/greenly
   ```
   (Or skip this and use the **NPM install** button in the Node.js panel after each pull.)

### Option B — File Manager

Upload the repository contents (without `node_modules/`, `config.js`, `data/`) into `/greenly`,
then run **NPM install** from the Node.js panel.

## 2. Configure the Node.js app

*Websites & Domains → your domain → Node.js*:

| setting | value |
|---|---|
| Node.js version | 23.x |
| Package manager | npm |
| Document root | `/greenly/public` |
| Application mode | `production` |
| Application root | `/greenly` |
| Application startup file | `server.js` |

Click **NPM install**, then **Enable Node.js** / **Restart App**.

Passenger serves the files in `public/` directly and forwards everything else (i.e. `/api/*`) to `server.js`.
Passenger sets `PORT`; nothing to configure. The app root (`/greenly`) is *not* web-accessible, so
`config.js`, `data/` and the SQLite file are never served.

Optional environment variable (Node.js panel → *Custom environment variables*):
`NODE_OPTIONS=--no-warnings=ExperimentalWarning` — silences the `node:sqlite` notice in the log.

## 3. config.js — all secrets in one file

In the app root:

```sh
cp config.example.js config.js
```

Fill in:

| key | what |
|---|---|
| `password` | the single app password (login screen). Long and random. |
| `plantnetApiKey` | Pl@ntNet key — see step 4. Leave empty to disable photo identification (manual name entry still works). |
| `plantnetLang` | `pl` for Polish common names (falls back to `en` automatically). |
| `vapid.subject` | `mailto:your@email` |
| `vapid.publicKey` / `vapid.privateKey` | from step 5 |
| `cronSecret` | long random string; only needed for the HTTP cron fallback |
| `appUrl` | public URL with trailing slash, e.g. `https://plants.example.com/` — opened when a notification is tapped |
| `timezone` | `Europe/Warsaw` — used for "today" in watering math |

Restart the app after editing `config.js` (it is read once at start).

## 4. Pl@ntNet API key

1. Create an account at <https://my.plantnet.org>.
2. *Settings → API key* (an app is created automatically; the key is shown there).
3. Free tier: **500 identification requests per day**. greenLy makes one request per photo.

## 5. VAPID keys for web push

From the app root, using Plesk's Node binary (SSH, or Plesk *Scheduled Tasks → Run a command* once):

```sh
/opt/plesk/node/23/bin/node /var/www/vhosts/<domain>/greenly/genkeys.js
```

Paste the printed `vapid: {…}` block into `config.js`. Keep the private key private. Changing the keys later
invalidates every existing subscription (users must re-enable notifications).

## 6. Permissions

The app writes `data/greenly.sqlite` (plus `-wal`/`-shm`) and `data/photos/`. `data/` must be writable by the
system user the app runs as (the subscription's user):

```sh
chmod 770 /var/www/vhosts/<domain>/greenly/data
```

If files are owned by `root` after a Git deploy, fix ownership with `chown -R <sysuser>:psacln greenly`.

## 7. Daily cron

*Websites & Domains → Scheduled Tasks → Add Task*:

- Task type: **Run a command**
- Command:
  ```
  /opt/plesk/node/23/bin/node /var/www/vhosts/<domain>/greenly/cron.js
  ```
- Run: **Daily**, e.g. `08:00` (server time — the app itself uses `config.timezone`)
- Notify: on errors only

Check the exact Node path with `ls /opt/plesk/node/` — it must match the version selected in the Node.js panel,
because `node:sqlite` needs ≥ 22.13.

**Fallback when "Run a command" is not allowed:** task type **Fetch a URL** with
`https://<domain>/api/cron?secret=<cronSecret>`. Same effect.

The script logs one line: `cron: due=N sent=N removed=N failed=N`.

## 8. iPhone: add to Home Screen

Web push on iOS (16.4+) works **only** for a PWA installed on the Home Screen — not in a Safari tab.

1. Open `https://<domain>/` in Safari, log in.
2. Share → **Add to Home Screen** → Add.
3. Launch **greenLy from the icon** (not from Safari).
4. Tap **Powiadomienia** in the top bar and allow notifications.
5. Settings → Notifications → greenLy: make sure alerts are enabled; consider disabling Focus for it.

Repeat step 4 after re-installing the app or clearing website data.

## 9. When notifications don't arrive

Check in this order:

1. **Is anything due?** Run the cron manually (SSH or "Run now" on the scheduled task) and read the line:
   `due=0` means no plant has `days_left <= 0` today, or all were notified today already, or none has a
   `last_watered` date. Water a plant with a date 60 days back to force a test.
2. **`sent=0` but `due>0`** → VAPID keys missing in `config.js`, or no subscriptions in the `subs` table
   (the "Powiadomienia" button was never confirmed from the installed app).
3. **`removed>0`** → the subscription expired or the app was removed from the Home Screen; enable notifications again.
4. **`failed>0`** → see the error in the cron output / *Node.js → Logs*. `401`/`403` from the push service
   usually means the VAPID key pair in `config.js` does not match the one the browser subscribed with — regenerate
   keys, restart, re-subscribe.
5. **HTTPS**: mixed content or an invalid certificate blocks the service worker entirely. Open the site in Safari
   and confirm the padlock.
6. **iOS specifics**: the app must be launched from the Home Screen icon at least once after subscribing;
   iOS drops the subscription if the app is deleted from the Home Screen. Low Power Mode and Focus can delay delivery.
7. **Service worker stuck on an old version**: the app uses `skipWaiting`, but on iOS force-quit the PWA and reopen it.
8. **Time zone**: the cron runs at server time; `days_left` is computed with `config.timezone`. If the server clock is
   off, plants are due a day early/late.

## 10. Updating

Git integration: push to `main` → Plesk pulls → **NPM install** (only if `package.json` changed) → **Restart App**.
`config.js` and `data/` are untouched by deploys because they are gitignored.
