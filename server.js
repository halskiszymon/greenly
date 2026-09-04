// server.js — static files from public/ + JSON API under /api/*.
// No framework: node:http only. Under Plesk/Passenger the static files are
// usually served by the web server directly and only /api/* reaches Node,
// but this server can also stand alone (node server.js).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ROOT, PHOTO_DIR, openDb, loadConfig, loadCare, matchProfile,
  listPlants, getPlant, insertPlant, updatePlant, waterPlant, deletePlant,
  upsertSub, deleteSub, storePhoto, removePhoto, tokenFor, safeEqual,
  parseDateString, toDateString, MATERIAL_FACTOR, LIGHT_FACTOR,
} from './lib.js';
import { runCron } from './cron.js';

const config = await loadConfig();
loadCare();
const db = openDb();
const TOKEN = tokenFor(config.password);

const PUBLIC_DIR = path.join(ROOT, 'public');
const JSON_LIMIT = 2 * 1024 * 1024;
const UPLOAD_LIMIT = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Żądanie jest za duże.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const buf = await readBody(req, JSON_LIMIT);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); }
  catch { throw new HttpError(400, 'Nieprawidłowy JSON.'); }
}

async function readMultipart(req) {
  const buf = await readBody(req, UPLOAD_LIMIT);
  try {
    return await new Response(buf, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData();
  } catch {
    throw new HttpError(400, 'Nieprawidłowe dane formularza.');
  }
}

function requireAuth(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const token = bearer || url.searchParams.get('t') || '';
  if (!token || !safeEqual(token, TOKEN)) throw new HttpError(401, 'Brak autoryzacji — zaloguj się ponownie.');
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

// ---------------------------------------------------------------------------
// Pl@ntNet proxy
// ---------------------------------------------------------------------------

async function plantnetIdentify(file, lang) {
  const url = new URL('https://my-api.plantnet.org/v2/identify/all');
  url.searchParams.set('api-key', config.plantnetApiKey);
  url.searchParams.set('include-related-images', 'false');
  if (lang) url.searchParams.set('lang', lang);

  const fd = new FormData();
  fd.append('images', file, file.name || 'photo.jpg');
  fd.append('organs', 'auto');

  const res = await fetch(url, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) });
  if (res.status === 400 && lang && lang !== 'en') return plantnetIdentify(file, 'en');
  if (res.status === 404) throw new HttpError(404, 'Pl@ntNet nie rozpoznał rośliny na tym zdjęciu. Spróbuj inne ujęcie (liść z bliska, cała roślina) albo wpisz nazwę ręcznie.');
  if (res.status === 429) throw new HttpError(429, 'Dzienny limit zapytań do Pl@ntNet (500) wyczerpany. Spróbuj jutro albo wpisz nazwę ręcznie.');
  if (res.status === 401 || res.status === 403) throw new HttpError(502, 'Pl@ntNet odrzucił klucz API — sprawdź plantnetApiKey w config.js.');
  if (!res.ok) throw new HttpError(502, `Pl@ntNet zwrócił błąd ${res.status}.`);
  const data = await res.json();
  return (data.results ?? []).slice(0, 5).map((r) => {
    const species = r.species?.scientificNameWithoutAuthor ?? '';
    const genus = r.species?.genus?.scientificNameWithoutAuthor ?? '';
    const family = r.species?.family?.scientificNameWithoutAuthor ?? '';
    const profile = matchProfile({ species, genus, family });
    return {
      score: Math.round((r.score ?? 0) * 1000) / 10,
      species,
      genus,
      family,
      common: (r.species?.commonNames ?? []).slice(0, 3),
      profile,
    };
  });
}

// ---------------------------------------------------------------------------
// API actions
// ---------------------------------------------------------------------------

const actions = {
  async login(req, res) {
    const { password } = await readJson(req);
    if (typeof password !== 'string' || !safeEqual(tokenFor(password), TOKEN)) {
      await sleep(400);
      throw new HttpError(401, 'Nieprawidłowe hasło.');
    }
    sendJson(res, 200, { token: TOKEN });
  },

  async plants(req, res, url) {
    requireAuth(req, url);
    sendJson(res, 200, { plants: listPlants(db), today: toDateString() });
  },

  async identify(req, res, url) {
    requireAuth(req, url);
    if (!config.plantnetApiKey) throw new HttpError(503, 'Brak klucza Pl@ntNet w config.js — wpisz nazwę rośliny ręcznie.');
    const fd = await readMultipart(req);
    const file = fd.get('image');
    if (!(file instanceof Blob) || !file.size) throw new HttpError(400, 'Brak zdjęcia w żądaniu.');
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new HttpError(400, 'Zdjęcie musi być JPEG, PNG albo WebP.');
    let results;
    try {
      results = await plantnetIdentify(file, config.plantnetLang || 'pl');
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, 'Nie udało się połączyć z Pl@ntNet. Spróbuj ponownie albo wpisz nazwę ręcznie.');
    }
    sendJson(res, 200, { results });
  },

  async lookup(req, res, url) {
    requireAuth(req, url);
    const { species } = await readJson(req);
    const name = str(species, 120);
    if (!name) throw new HttpError(400, 'Podaj nazwę rośliny.');
    sendJson(res, 200, { species: name, profile: matchProfile({ species: name }) });
  },

  async save(req, res, url) {
    requireAuth(req, url);
    const b = await readJson(req);
    const id = b.id ? Number(b.id) : null;
    const existing = id ? getPlant(db, id) : null;
    if (id && !existing) throw new HttpError(404, 'Nie ma takiej rośliny.');

    const name = str(b.name, 80);
    if (!name) throw new HttpError(400, 'Nazwa rośliny jest wymagana.');
    const pot_cm = Math.round(Number(b.pot_cm));
    if (!Number.isFinite(pot_cm) || pot_cm < 4 || pot_cm > 80) throw new HttpError(400, 'Średnica doniczki: 4–80 cm.');
    const pot_material = String(b.pot_material);
    if (!(pot_material in MATERIAL_FACTOR)) throw new HttpError(400, 'Nieznany materiał doniczki.');
    const light = String(b.light);
    if (!(light in LIGHT_FACTOR)) throw new HttpError(400, 'Nieznany poziom światła.');
    let last_watered = null;
    if (b.last_watered) {
      if (!parseDateString(b.last_watered)) throw new HttpError(400, 'Nieprawidłowa data podlania.');
      last_watered = b.last_watered;
    }

    const species = str(b.species, 120);
    const genus = str(b.genus, 60);
    const family = str(b.family, 60);
    const profile = matchProfile({ species, genus, family });

    const plant = {
      name,
      species,
      common: str(b.common, 120),
      genus,
      family,
      group_key: profile.group,
      base_summer: profile.summer,
      base_winter: profile.winter,
      pot_cm,
      pot_material,
      light,
      dry_air: !!b.dry_air,
      note: str(b.note, 500),
      last_watered,
      photo: existing?.photo ?? null,
    };

    let plantId = id;
    if (!existing) plantId = insertPlant(db, plant);

    if (typeof b.photo === 'string' && b.photo.startsWith('data:')) {
      try {
        const stored = storePhoto(b.photo, plantId);
        removePhoto(existing?.photo);
        plant.photo = stored;
      } catch (e) {
        if (!existing) deletePlant(db, plantId);
        throw new HttpError(e.status ?? 400, e.message);
      }
    } else if (b.photo === null && existing?.photo) {
      removePhoto(existing.photo);
      plant.photo = null;
    }

    updatePlant(db, plantId, plant);
    const saved = listPlants(db).find((p) => p.id === plantId);
    sendJson(res, 200, { plant: saved });
  },

  async water(req, res, url) {
    requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    if (!getPlant(db, id)) throw new HttpError(404, 'Nie ma takiej rośliny.');
    const date = b.date ? String(b.date) : toDateString();
    if (!parseDateString(date)) throw new HttpError(400, 'Nieprawidłowa data.');
    waterPlant(db, id, date);
    sendJson(res, 200, { plant: listPlants(db).find((p) => p.id === id) });
  },

  async delete(req, res, url) {
    requireAuth(req, url);
    const b = await readJson(req);
    if (!deletePlant(db, Number(b.id))) throw new HttpError(404, 'Nie ma takiej rośliny.');
    sendJson(res, 200, { ok: true });
  },

  async vapid(req, res, url) {
    requireAuth(req, url);
    sendJson(res, 200, { publicKey: config.vapid?.publicKey || '' });
  },

  async subscribe(req, res, url) {
    requireAuth(req, url);
    const b = await readJson(req);
    if (typeof b.endpoint !== 'string' || !b.endpoint.startsWith('https://') || !b.keys?.p256dh || !b.keys?.auth) {
      throw new HttpError(400, 'Nieprawidłowa subskrypcja push.');
    }
    upsertSub(db, { endpoint: b.endpoint, keys: { p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) } });
    sendJson(res, 200, { ok: true });
  },

  async unsubscribe(req, res, url) {
    requireAuth(req, url);
    const b = await readJson(req);
    if (typeof b.endpoint === 'string') deleteSub(db, b.endpoint);
    sendJson(res, 200, { ok: true });
  },

  async photo(req, res, url, rest) {
    requireAuth(req, url);
    if (!/^\d+-[a-f0-9]{8}\.(jpg|png|webp)$/.test(rest ?? '')) throw new HttpError(404, 'Nie znaleziono.');
    const file = path.join(PHOTO_DIR, rest);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Nie znaleziono.');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  },

  // HTTP fallback for the daily reminder — protected by cronSecret, not by the login token.
  async cron(req, res, url) {
    const secret = url.searchParams.get('secret') ?? '';
    if (!config.cronSecret || !safeEqual(secret, config.cronSecret)) throw new HttpError(401, 'Nieprawidłowy sekret.');
    const result = await runCron(config, db);
    sendJson(res, 200, result);
  },
};

// ---------------------------------------------------------------------------
// static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  const stat = fs.statSync(file);
  const lastModified = stat.mtime.toUTCString();
  // Code and markup: always revalidate (cheap 304s) so deploys show up immediately. Images: cache a day.
  const isAsset = ['.png', '.jpg', '.webp', '.svg', '.ico'].includes(ext);
  const headers = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': isAsset ? 'public, max-age=86400' : 'no-cache',
    'Last-Modified': lastModified,
  };
  if (req.headers['if-modified-since'] === lastModified) {
    res.writeHead(304, headers);
    return res.end();
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

// ---------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // Match "/api/<action>[/<rest>]" anywhere in the path so the app works under a sub-folder too.
  const m = /\/api\/([a-z]+)(?:\/([^/]+))?\/?$/.exec(url.pathname);
  if (!m) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); return res.end();
    }
    return serveStatic(req, res, url.pathname);
  }
  const action = actions[m[1]];
  try {
    if (!action) throw new HttpError(404, 'Nieznana akcja.');
    const isGet = ['plants', 'vapid', 'photo', 'cron'].includes(m[1]);
    if (isGet ? req.method !== 'GET' : req.method !== 'POST') throw new HttpError(405, 'Niedozwolona metoda.');
    await action(req, res, url, m[2]);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    sendJson(res, status, { error: status === 500 ? 'Błąd serwera.' : e.message });
  }
});

const port = Number(process.env.PORT) || config.port || 8080;
server.listen(port, () => console.log(`greenLy listening on ${port}`));
