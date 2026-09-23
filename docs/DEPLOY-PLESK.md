# Deploying greenLy on Plesk

Target: Plesk Obsidian with the **Node.js** extension, Node 22.13+ (23.x works), and HTTPS on the (sub)domain. Web push
needs HTTPS, so issue a Let's Encrypt certificate from Plesk first.

The configuration keys, API keys, users and cron are explained in [INSTALL.md](INSTALL.md); this page covers the Plesk
side only.

## 1. Get the code onto the server

**Git integration (recommended).**

1. *Websites & Domains → your domain → Git → Add Repository*, choose **Remote Git hosting** and paste
   `https://github.com/halskiszymon/greenly.git` (or your fork's SSH URL; for a private fork add the SSH key Plesk shows
   as a read-only deploy key on GitHub).
2. Deployment mode *Automatic*, deploy to a folder such as `/greenly`, so the app root is
   `/var/www/vhosts/<domain>/greenly`.
3. Under *Enable additional deploy actions* add:
   ```
   /opt/plesk/node/23/bin/npm install --omit=dev --prefix /var/www/vhosts/<domain>/greenly
   ```
   or press **NPM install** in the Node.js panel after each pull.

**FTPS upload script.** `cp .deploy.env.example .deploy.env`, fill in host and credentials, then
`python3 scripts/deploy.py --dry-run` and `python3 scripts/deploy.py`. It uploads only tracked files (never `config.js`,
`data/` or `node_modules/`). Run **NPM install** afterwards.

**File Manager.** Upload the repository without `node_modules/`, `config.js` and `data/`, then **NPM install**.

## 2. Node.js settings

*Websites & Domains → your domain → Node.js*:

| setting | value |
|---|---|
| Node.js version | 23.x (at least 22.13) |
| Package manager | npm |
| Document root | `/greenly/public` |
| Application mode | `production` |
| Application root | `/greenly` |
| Application startup file | `server.js` |

Press **NPM install**, then **Enable Node.js** / **Restart App**. Passenger sets `PORT`. nginx serves `public/`
directly and forwards `/api/*` to Node; the app root itself is not web-accessible, so `config.js` and `data/` are never
served. Optionally add the custom environment variable `NODE_OPTIONS=--no-warnings=ExperimentalWarning`.

## 3. config.js and keys

In the app root run `cp config.example.js config.js` and fill it in as described in
[INSTALL.md](INSTALL.md#configjs). To generate VAPID keys with Plesk's Node binary (SSH, or *Scheduled Tasks → Run a
command* once):

```bash
/opt/plesk/node/23/bin/node /var/www/vhosts/<domain>/greenly/genkeys.js
```

Restart the app after every change to `config.js`.

## 4. Permissions

The app writes `data/greenly.sqlite` (plus `-wal`/`-shm`), `data/photos/` and `data/secret.key`. `data/` must be
writable by the subscription's system user:

```bash
chmod 770 /var/www/vhosts/<domain>/greenly/data
```

If a Git deploy left files owned by `root`, fix it with `chown -R <sysuser>:psacln greenly`.

## 5. Daily cron

*Websites & Domains → Scheduled Tasks → Add Task*, type **Run a command**, daily (e.g. 08:00 server time), notify on
errors only:

```
/opt/plesk/node/23/bin/node /var/www/vhosts/<domain>/greenly/cron.js
```

The Node path must match the version selected in the Node.js panel (`ls /opt/plesk/node/`).

If *Run a command* is not available, use **Fetch a URL** with `https://<domain>/api/cron?secret=<cronSecret>`. When you
can send headers, `X-Cron-Secret` is better, because query strings are written to the access log.

## 6. Security headers for static files

Node adds security headers to everything it serves, but on Plesk nginx serves `index.html`, `app.js` and `styles.css`
itself. Add the directives from [SECURITY.md](../SECURITY.md#hardening-checklist) under *Websites & Domains → Apache &
nginx Settings → Additional nginx directives*. Start the CSP in report-only mode, check the browser console for a few
days, then switch it to enforcing. `public/.htaccess` covers setups where Apache serves the static files.

## 7. Updating

With Git integration a push to `main` is pulled automatically. Run **NPM install** only when `package.json` changed,
then **Restart App**. `config.js` and `data/` are gitignored and survive deploys. Installed apps show a "new version"
dialog on their next check.

## Plesk-specific problems

- **Static files 404 under `/icons/`.** Plesk's Apache aliases `/icons/` to its own directory; this app keeps images in
  `img/` for that reason.
- **"Web application could not be started"** on `/api/*` while `/` loads: the Node app crashes on boot. Switch
  *Application mode* to `development`, open `/api/plants` to see the stack trace, then switch back. Usual causes: Node
  older than 22.13, NPM install not run, a broken `config.js`, or `ERR_REQUIRE_ASYNC_MODULE` (Passenger `require()`s the
  startup file, so no top-level `await` anywhere in the module graph; `npm test` checks this).
- **Everyone behind one home IP gets 429 at login.** The login limit is 10 attempts per 15 minutes per IP; raise
  `RATE.login.max` in `server.js` if needed.

Notification troubleshooting is in [INSTALL.md](INSTALL.md#when-notifications-dont-arrive).
