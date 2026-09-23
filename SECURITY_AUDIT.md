# Security audit — greenLy

Scope: repository at commit `131cd2e` (branch `security-audit`) and read-only probes of
https://greenly.freely.digital on 2026-09-23. Method: manual code review of every endpoint, the auth flow,
the frontend templates (XSS), the service worker and the deploy path; `npm audit`; git history scan for
secrets; HTTP probes of the production host (headers, sensitive paths, error bodies, TLS). Nothing was
written to production.

Severity: **Critical** = data of other users readable/writable or remote code execution; **High** = account
takeover or secret exposure with realistic effort; **Medium** = meaningful weakening of security controls;
**Low** = hardening / defence in depth.

## Findings

| # | Problem | Severity | Status | Where | What was done / recommended |
|---|---|---|---|---|---|
| 1 | Session token in the URL (`?t=`) for every photo `<img>`; query strings are written to nginx/Apache access logs, browser history and Referer-less caches, so a log leak = account takeover | High | naprawione | `server.js` `photo`, `public/app.js` `photoUrl`/`photoSrc` | Photos now use a separate 7-day HMAC token scoped to photo reads (`user.photo_token`, `lib.js#photoToken`). Session tokens are accepted **only** in `Authorization`; `?t=<session>` returns 401 everywhere. |
| 2 | No rate limiting on login / registration / password change: online brute force of passwords and of 48-bit invite codes was only slowed by a 400 ms sleep | High | naprawione | `server.js` `rateLimit` | In-memory sliding windows: login 10/15 min per IP **and** per login, register 5/15 min per IP, password checks 10/15 min per user, Claude calls 30/10 min per user, cron 6/min. 429 + `Retry-After`. Client IP from the first `X-Forwarded-For` hop (Plesk proxy). |
| 3 | No security headers on any response (confirmed on production: no HSTS, nosniff, X-Frame-Options, CSP, Referrer-Policy) | Medium | naprawione (Node) / **do zrobienia w Plesk** (statyka) | `server.js` `securityHeaders`, `public/.htaccess`, DEPLOY.md § 7b | Node adds nosniff, `X-Frame-Options: DENY`, Referrer-Policy, Permissions-Policy, COOP/CORP and HSTS (only when the request came over HTTPS). HTML served by Node gets an enforced CSP; **production HTML comes from nginx**, so the same headers must be added in Plesk (snippet below). CSP there starts as Report-Only per the brief. |
| 4 | Login timing reveals whether a login exists (scrypt only ran for known users) and a `{password}`-only body logged in as the admin without knowing the admin login | Medium | naprawione | `server.js` `login`, `lib.js#verifyPasswordOrDummy` | Unknown login runs a dummy scrypt; the legacy password-only shortcut is removed. |
| 5 | Session tokens stored in clear text in SQLite: a copied database yields working bearer tokens | Medium | naprawione | `lib.js#createSession/sessionUser` | Stored as sha256(token). Existing raw rows keep working and are rewritten as hashes on first use (nobody is logged out). |
| 6 | Unbounded password length → scrypt CPU burn; 6 MB JSON limit applied to every endpoint including login | Medium | naprawione | `server.js` `readJson`, `MAX_PASSWORD` | Passwords capped at 200 chars. JSON limit 16 KB by default, 6 MB only for `save`/`split` (photos), 8 KB for push subscriptions. |
| 7 | Cron secret only accepted in the query string (`?secret=`) → access logs | Low | naprawione | `server.js` `cron`, DEPLOY.md § 7 | `X-Cron-Secret` header accepted and documented as preferred; query form still works for Plesk "Fetch a URL". Rate-limited. |
| 8 | Nothing stopped a runaway or malicious client from draining a user's (or the admin's global) Anthropic key with repeated analyses | Low | naprawione | `server.js` `health`/`profile` | 30 Claude calls per user per 10 minutes. |
| 9 | Search engines could index the login page | Low | naprawione | `public/robots.txt` | `Disallow: /`. |
| 10 | No HTTP-level tests for auth, ownership and admin gating (the only integration test was "server boots") | Medium (quality) | naprawione | `test/api.test.mjs` | Boots a real server on a random port: login, enumeration parity, invite gate, IDOR on every mutating endpoint, admin 403, photo token scoping, path traversal, body limits, cron, rate limit, headers. 48 tests total, all green. |
| 11 | Server logged `listening on 0` when `PORT=0` (test/dev) | Low (quality) | naprawione | `server.js` `main` | Logs the bound port. |
| 11b | **Logout did not invalidate the session on the server**: the client called `/api/logout` with GET, the route is POST-only (405), so the token stayed valid until pruned a year later | Medium | naprawione | `public/app.js` `logout()` | Found during the manual walkthrough; now a POST. Covered by the HTTP test (401 for unauthenticated logout, POST path). |
| 12 | `X-Powered-By: PleskLin` and `Server: nginx` on production | Low | nice to have | Plesk | Vendor disclosure only; can be cleared with `more_clear_headers` if the headers-more module is present. |
| 13 | Sessions never expire while used (pruned after 1 year idle) | Low | nice to have | `lib.js#pruneSessions` | Fine for a personal PWA. If wanted: absolute lifetime (e.g. 90 days) + "log out everywhere" in the account screen. |
| 14 | Invite codes are 48-bit random; with the new 5/15 min limit guessing is infeasible, and codes are single-use by default | Low | ok / nice to have | `lib.js#createInvite` | Could be lengthened to 9 bytes; not needed. |
| 15 | Admin can reset any user's password and read their plant counts; no audit log of admin actions | Low | nice to have | `server.js` `adminuser` | Add an `admin_log` table if more than a couple of admins ever exist. |
| 16 | `cron.js` / `/api/cron` send one push per user with plant names in the payload (push services see ciphertext only — Web Push encrypts) | Info | ok | `cron.js` | No change. |
| 17 | AI results, plant data and the photo token are cached in `localStorage` for instant paint | Low | ok | `public/app.js` cache | Cleared on logout and on 401. On a shared device the browser profile is the trust boundary, as with any PWA. |
| 18 | The register endpoint reports "login taken" (409) | Info | ok | `server.js` `register` | Inherent to self-service registration; rate-limited and invite-gated. |

### Verified as clean

- **Secrets:** none in the working tree or in git history (only `password123` in tests). `config.js`, `data/`,
  `.deploy.env` are gitignored; `config.example.js` has empty values.
- **Dependencies:** `npm audit --omit=dev` → 0 vulnerabilities (`@anthropic-ai/sdk`, `web-push`).
- **XSS:** every user-controlled string reaching `innerHTML` goes through `esc()` (names, species, notes, logins,
  invite notes, Claude output fields, event data). Remaining raw insertions are numbers, enum labels, data URLs from
  the canvas, or HTML assembled from already-escaped parts. No inline event handlers, no `javascript:` URLs.
- **SQL injection:** every query is parameterised (`node:sqlite` prepared statements); the only string interpolation
  is `ensureColumn()` with literal table/column names.
- **Path traversal:** photo names must match `^\d+-[a-f0-9]{8}\.(jpg|png|webp)$` and belong to the caller's plant;
  the static handler normalises and refuses anything outside `public/`.
- **Uploads:** MIME prefix **and** magic bytes checked, sizes capped (600 KB thumbnail, 2 MB full photo, 5 MB per
  analysis photo, max 4), random file names, stored outside the web root, served only with a valid token.
- **IDOR:** every plant / watering / event / check / photo / subscription query is scoped by `user_id`; verified by
  the new HTTP tests for each mutating endpoint.
- **Admin gate:** `requireAdmin` on all four admin actions; last admin cannot be demoted; self-delete blocked.
- **CSRF / CORS:** no cookies, bearer header only, no CORS headers → cross-site requests cannot carry credentials.
- **SSRF:** outbound calls go only to fixed hosts (Pl@ntNet, Anthropic).
- **Error handling:** 500 → `{"error":"Błąd serwera."}`, stack only in the server log; 404 → plain "Not found".
  Confirmed on production for `/api/nope`, malformed JSON and unknown paths.
- **Logging:** no passwords, tokens or keys are logged; Anthropic keys are AES-256-GCM encrypted at rest with a secret
  kept in `config.js` or `data/secret.key` (0600).
- **Production exposure:** `.env`, `.git/*`, `config.js`, `server.js`, `package.json`, `data/`, `node_modules/`,
  `test/`, `scripts/` are 403/404 — the app root is outside the document root. HTTP→HTTPS 301, Let's Encrypt
  certificate valid until 2026-12-03, TLS 1.0/1.1 refused. All API endpoints answer 401 without a token.

## Do zrobienia ręcznie w Plesk

1. **Nagłówki dla statyki** (nginx serwuje `index.html`, `app.js`, `styles.css`): *Websites & Domains → Apache & nginx
   Settings → Additional nginx directives* — wklej blok z DEPLOY.md § 7b (nosniff, X-Frame-Options, Referrer-Policy,
   Permissions-Policy, HSTS, CSP w trybie **Report-Only**). Po kilku dniach bez wpisów CSP w konsoli przeglądarki
   zmień `Content-Security-Policy-Report-Only` na `Content-Security-Policy`.
2. **HSTS**: alternatywnie zaznacz *HSTS* w *SSL/TLS Certificates* (wtedy pomiń linię HSTS w nginx).
3. **Cron**: jeśli używasz "Fetch a URL", zostaw jak jest (query działa). Jeśli masz SSH/cron z `curl`, użyj nagłówka
   `X-Cron-Secret` zamiast `?secret=`.
4. **Uprawnienia**: `data/` 770 dla użytkownika subskrypcji, `data/secret.key` 600 (tworzone automatycznie), nic z
   `data/` w document root — potwierdzone sondą (`/data/` nie odpowiada).
5. **Backupy**: Plesk → Backup Manager, obejmij `greenly/data/` (SQLite + zdjęcia + `secret.key`) i `config.js`.
   Bez `secret.key` (albo `config.secretKey`) klucze Anthropic w bazie są nie do odczytania.
6. **Logi**: Passenger log w Plesk zawiera tylko błędy aplikacji; access log nginx zawiera URL-e — od tej wersji bez
   tokenów sesji (zostają tylko tokeny do zdjęć ważne 7 dni i ewentualnie `?secret=` crona).
7. **Node**: pozostań na aktualnym 22.x/23.x w panelu Node.js; `npm audit` czysty.

## Sekrety do zrotowania

Żadne nie wyciekły. Zalecane mimo to, bo do dziś tokeny sesji trafiały do access logów nginx:
- nic nie trzeba rotować po stronie użytkowników — po wdrożeniu stare URL-e zdjęć z tokenem sesji przestają działać
  (`?t=<sesja>` → 401), a same tokeny sesji dalej są ważne tylko w nagłówku;
- jeśli kiedykolwiek udostępniałeś komuś access log albo wklejałeś URL zdjęcia z `?t=` poza aplikację, wyloguj się i
  zaloguj ponownie (unieważnia tamten token).

## Podsumowanie

**Najgorsze:** token sesji w URL każdego zdjęcia (lądował w access logach) i brak jakiegokolwiek rate limitingu na
logowaniu, rejestracji i kodach zaproszeń. Do tego produkcja nie wysyłała żadnego nagłówka bezpieczeństwa.

**Naprawione w kodzie:** wylogowanie faktycznie kasuje sesję na serwerze (wysyłało GET na trasę POST); osobny, krótkotrwały token do zdjęć; sesje tylko w nagłówku i hashowane w bazie; rate
limity na logowanie, rejestrację, zmianę hasła, wywołania Claude i cron; nagłówki bezpieczeństwa i CSP w Node;
logowanie bez enumeracji loginów i bez skrótu „samo hasło = admin”; limity długości hasła i wielkości body; sekret
crona w nagłówku; `robots.txt`; 7 nowych testów HTTP (48 łącznie, wszystkie zielone).

**Zostało (ręcznie w Plesk):** nagłówki dla plików statycznych w nginx (z CSP najpierw Report-Only), opcjonalnie
HSTS w panelu i wyczyszczenie `X-Powered-By`.

**Do weryfikacji po wdrożeniu:** (1) zdjęcia w liście i profilu ładują się (nowy token), (2) logowanie z telefonu
i z przeglądarki, (3) cron z Plesk nadal zwraca `due=…`, (4) konsola przeglądarki bez wpisów CSP po dodaniu
nagłówków w nginx, (5) po 10 nieudanych logowaniach z jednego IP przychodzi 429 na 15 minut — jeśli za dużo
domowników dzieli jedno IP, podnieś `RATE.login.max` w `server.js`.
