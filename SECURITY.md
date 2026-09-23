# Security

## Reporting a vulnerability

Please do not open a public issue. Email [greenly@freely.digital](mailto:greenly@freely.digital) with a description,
steps to reproduce and the affected version or commit. You will get a reply within a few days, and a fix is released on
`main` before the details are made public. Only the latest `main` is supported.

## Security model

greenLy is a multi-user app where each account sees only its own data, the admin manages accounts, and third-party API
keys are stored on the server.

**Accounts and sessions**
- Passwords are hashed with scrypt (random salt) and limited to 8–200 characters. Unknown logins cost the same scrypt
  work as wrong passwords, so login timing does not reveal which accounts exist.
- Sessions are 32 random bytes sent only in the `Authorization: Bearer` header. The database stores `sha256(token)`, so
  a copied database does not contain usable tokens. Logging out deletes the session; changing the password ends all
  other sessions. There are no cookies, so cross-site requests cannot carry credentials.
- Photos load through `<img>` tags and cannot send headers. They use a separate HMAC-signed photo token that is valid
  for 7 days and only for reading photos, never the session token.
- Registration requires an invite code. Codes are random, single-use by default, and can be disabled.

**Authorisation**
- Every plant, watering, event, analysis, photo and push subscription is scoped to the owning user; foreign ids answer
  404. Admin endpoints require the admin role, the last admin cannot be demoted, and admins cannot delete themselves.

**Secrets**
- Anthropic keys (per user and the global one) are verified with Anthropic, then stored AES-256-GCM encrypted with a
  server secret from `config.js` or `data/secret.key` (mode 0600). Only the last four characters are ever shown.
- The Pl@ntNet key and VAPID private key stay in `config.js`; the browser never sees them.
- `config.js`, `data/` and `.deploy.env` are gitignored. The repository contains no secrets.

**Abuse limits** (in memory, answered with 429 and `Retry-After`)

| action | limit |
|---|---|
| login | 10 per 15 min per IP and per login |
| registration | 5 per 15 min per IP |
| current-password checks | 10 per 15 min per user |
| Claude analyses | 30 per 10 min per user |
| cron endpoint | 6 per minute |

**Input and output**
- All SQL uses prepared statements. Every user-controlled string rendered as HTML is escaped; there are no inline
  scripts or event handlers.
- Uploads are checked by MIME type **and** magic bytes, size-capped (thumbnail 600 KB, full photo 2 MB, analysis photo
  5 MB, at most 4), stored under random names outside the web root, and served only to their owner.
- Photo file names must match a strict pattern; the static handler refuses paths outside `public/`.
- JSON bodies are capped at 16 KB, except plant saves with photos (6 MB).
- Outbound requests go only to fixed hosts (Pl@ntNet and Anthropic).
- Errors return a generic message; stack traces go only to the server log. Passwords, tokens and keys are never logged.

**Headers.** Everything served by Node carries `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`,
`Permissions-Policy`, COOP/CORP and, over HTTPS, HSTS. HTML served by Node gets a strict CSP (`script-src 'self'`).
`robots.txt` keeps the app out of search engines.

## Hardening checklist

For whoever hosts an instance:

1. **Serve over HTTPS only** and redirect HTTP.
2. **Security headers for static files.** When nginx or Apache serves `public/` directly (Plesk does), add the headers
   there. For nginx:

   ```nginx
   add_header X-Content-Type-Options "nosniff" always;
   add_header X-Frame-Options "DENY" always;
   add_header Referrer-Policy "strict-origin-when-cross-origin" always;
   add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=(), usb=()" always;
   add_header Strict-Transport-Security "max-age=15552000; includeSubDomains" always;
   # Report-only first; once the browser console stays clean, rename to Content-Security-Policy.
   add_header Content-Security-Policy-Report-Only "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" always;
   ```

   `public/.htaccess` carries the same headers for Apache.
3. **Keep `config.js` and `data/` outside the web root**, `data/` writable only by the app user.
4. **Back up `data/` together with `config.js`.** Without `data/secret.key` (or `config.secretKey`) stored Anthropic
   keys cannot be decrypted.
5. **Call the cron endpoint with the `X-Cron-Secret` header** rather than `?secret=` where possible; query strings are
   written to access logs.
6. **Forward the client IP** (`X-Forwarded-For`) from the proxy, or rate limits will treat all users as one address.
7. **Keep Node.js and dependencies current** (`npm audit --omit=dev`).

## Audit history

### September 2026

A full review of the code (every endpoint, the auth flow, frontend rendering, service worker, deploy path), a secrets
scan of the git history, `npm audit` and read-only probes of a production deployment. All findings below are fixed in
`main`; the HTTP test suite (`test/api.test.mjs`) covers them.

| severity | finding | fix |
|---|---|---|
| High | The session token was passed in the URL (`?t=`) for every photo, so it could end up in access logs and history. | Separate 7-day photo token scoped to photo reads; session tokens accepted only in the `Authorization` header. |
| High | No rate limiting on login, registration and password checks; passwords and invite codes could be brute-forced online. | Per-IP and per-account sliding-window limits (table above). |
| Medium | No security headers on responses. | Headers and CSP from Node; nginx/Apache snippet for static files. |
| Medium | Login timing revealed whether an account existed; a password-only request logged in as the admin. | Dummy scrypt for unknown logins; the password-only shortcut was removed. |
| Medium | Session tokens stored in clear text in SQLite. | Stored as SHA-256; existing sessions are migrated on first use without logging anyone out. |
| Medium | Unbounded password length and a large body limit on every endpoint allowed CPU and memory abuse. | Passwords capped at 200 characters; per-endpoint body limits. |
| Medium | Logout did not end the session on the server (the client used the wrong HTTP method). | Logout is a POST and deletes the session; covered by tests. |
| Low | The cron secret was accepted only in the query string. | `X-Cron-Secret` header supported and documented. |
| Low | A runaway client could drain a user's or the shared Anthropic key. | 30 Claude calls per user per 10 minutes. |
| Low | The login page could be indexed by search engines. | `robots.txt` disallows everything. |

Verified without changes: no secrets in the repository or its history, no vulnerable dependencies, no SQL injection,
XSS, path traversal, IDOR, CSRF or SSRF paths found, and error responses do not leak internals.

Known limitations, accepted for a small self-hosted app:
- Sessions do not expire while in use; idle sessions are removed after a year.
- Rate limits live in memory and reset on restart.
- There is no audit log of admin actions.
- Cached plant data and analyses are kept in the browser's `localStorage` for instant loading; they are cleared on
  logout.
