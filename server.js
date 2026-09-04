// server.js — static files from public/ + JSON API under /api/*.
// No framework: node:http only. Under Plesk/Passenger the static files are
// usually served by the web server directly and only /api/* reaches Node,
// but this server can also stand alone (node server.js).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  ROOT, PHOTO_DIR, openDb, loadConfig, loadCare, matchProfile, groupCare,
  listPlants, getPlant, insertPlant, updatePlant, waterPlant, deletePlant, setProfile, listWaterings,
  insertCheck, getCheck, listChecks, checkChain, checkPhotoNames,
  upsertSub, deleteSub, storePhoto, storePhotoBuffer, readPhotoBase64, sniffImageType, removePhoto,
  tokenFor, safeEqual, parseDateString, toDateString, MATERIAL_FACTOR, LIGHT_FACTOR,
} from './lib.js';
import { runCron } from './cron.js';
import { createClient as createAiClient, analyzeHealth, describeSpecies } from './ai.js';

// NOTE: no top-level await anywhere in this module graph. Plesk/Passenger loads the
// startup file with require(), and Node refuses require() on an ESM graph that
// contains top-level await (ERR_REQUIRE_ASYNC_MODULE). Everything async lives in main().
let config;
let db;
let TOKEN;
let ai = null; // Anthropic client, null when anthropicApiKey is not configured

const PUBLIC_DIR = path.join(ROOT, 'public');
const JSON_LIMIT = 2 * 1024 * 1024;
const UPLOAD_LIMIT = 24 * 1024 * 1024; // up to 4 check-up photos of ≤ 5 MB
const MAX_CHECK_PHOTOS = 4;

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
    sendJson(res, 200, { plants: listPlants(db), today: toDateString(), ai: !!ai });
  },

  // Everything the profile view needs: plant, group care info, watering history, health checks.
  async plant(req, res, url, rest) {
    requireAuth(req, url);
    const id = Number(rest);
    const plant = listPlants(db).find((p) => p.id === id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
    sendJson(res, 200, {
      plant,
      care: groupCare(plant.group_key),
      waterings: listWaterings(db, id),
      checks: listChecks(db, id),
      ai: !!ai,
    });
  },

  // Claude analysis. Multipart: id, mode (checkup|doctor), text, image (new check) or parent_id + text (follow-up).
  async health(req, res, url) {
    requireAuth(req, url);
    if (!ai) throw new HttpError(503, 'Brak klucza Anthropic w config.js — analiza niedostępna.');
    const fd = await readMultipart(req);
    const id = Number(fd.get('id'));
    if (!getPlant(db, id)) throw new HttpError(404, 'Nie ma takiej rośliny.');
    const plant = listPlants(db).find((p) => p.id === id);
    let mode = String(fd.get('mode') ?? 'checkup');
    if (!['checkup', 'doctor'].includes(mode)) throw new HttpError(400, 'Nieznany tryb analizy.');
    const text = str(fd.get('text'), 1000);
    const parentId = fd.get('parent_id') ? Number(fd.get('parent_id')) : null;

    let chain = [];
    const images = [];       // {data, mediaType} sent to the model
    const uploads = [];      // {buf, mediaType} stored on success (new checks only)
    if (parentId) {
      const parent = getCheck(db, parentId);
      if (!parent || parent.plant_id !== id) throw new HttpError(404, 'Nie ma takiej analizy.');
      if (!text) throw new HttpError(400, 'Wpisz odpowiedzi na pytania.');
      chain = checkChain(db, parentId);
      mode = chain[0].mode;
      for (const name of checkPhotoNames(chain[0])) {
        const img = readPhotoBase64(name);
        if (img) images.push(img);
      }
      if (!images.length) throw new HttpError(410, 'Zdjęcia z pierwotnej analizy już nie istnieją — zrób nową analizę.');
    } else {
      const files = fd.getAll('image').filter((f) => f instanceof Blob && f.size);
      if (!files.length) throw new HttpError(400, 'Dodaj zdjęcie rośliny.');
      if (files.length > MAX_CHECK_PHOTOS) throw new HttpError(400, `Maksymalnie ${MAX_CHECK_PHOTOS} zdjęcia na jedną analizę.`);
      if (mode === 'doctor' && !text) throw new HttpError(400, 'Opisz krótko, co Cię niepokoi.');
      for (const file of files) {
        const buf = Buffer.from(await file.arrayBuffer());
        if (buf.length > 5 * 1024 * 1024) throw new HttpError(413, 'Zdjęcie jest za duże (limit 5 MB).');
        const mediaType = sniffImageType(buf);
        if (!mediaType) throw new HttpError(400, 'Plik nie jest poprawnym obrazem (JPEG, PNG lub WebP).');
        uploads.push({ buf, mediaType });
        images.push({ data: buf.toString('base64'), mediaType });
      }
    }

    const { result, usage, model } = await analyzeHealth(ai, config, {
      plant, care: groupCare(plant.group_key), mode, userText: text, images, chain,
    });
    const photos = uploads.map((u) => storePhotoBuffer(u.buf, u.mediaType, id));
    const checkId = insertCheck(db, {
      plant_id: id, parent_id: parentId, mode, photos, user_text: text, result, model,
      input_tokens: usage?.input_tokens ?? null, output_tokens: usage?.output_tokens ?? null,
    });
    sendJson(res, 200, { check: getCheck(db, checkId) });
  },

  // Species care profile written by Claude, cached on the plant row. {id, refresh?}
  async profile(req, res, url) {
    requireAuth(req, url);
    if (!ai) throw new HttpError(503, 'Brak klucza Anthropic w config.js — opis niedostępny.');
    const b = await readJson(req);
    const id = Number(b.id);
    const plant = listPlants(db).find((p) => p.id === id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
    if (plant.profile && !b.refresh) return sendJson(res, 200, { profile: plant.profile, cached: true });
    const { result } = await describeSpecies(ai, config, { plant, care: groupCare(plant.group_key) });
    setProfile(db, id, JSON.stringify(result));
    sendJson(res, 200, { profile: result, cached: false });
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
    const isGet = ['plants', 'plant', 'vapid', 'photo', 'cron'].includes(m[1]);
    if (isGet ? req.method !== 'GET' : req.method !== 'POST') throw new HttpError(405, 'Niedozwolona metoda.');
    await action(req, res, url, m[2]);
  } catch (e) {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    sendJson(res, status, { error: status === 500 ? 'Błąd serwera.' : e.message });
  }
});

/** Dev-only stand-in for the Anthropic client (GREENLY_FAKE_AI=1): returns canned JSON matching the schemas. */
function fakeAiClient() {
  return {
    beta: { messages: { create: async (params) => {
      await sleep(800);
      const isProfile = 'pets' in (params.output_config?.format?.schema?.properties ?? {});
      const turn = params.messages.length;
      const body = isProfile
        ? { origin: 'Lasy tropikalne Ameryki Środkowej.', light: 'Jasne, rozproszone; parapet wschodni.', watering: 'Gdy 3–4 cm podłoża przeschnie.', humidity: '50–70%.', temperature: '18–27 °C.', soil_and_pot: 'Przepuszczalne podłoże z korą, doniczka z otworami.', fertilizing: 'Co 2–3 tygodnie od marca do września.', repotting: 'Co 2 lata, wiosną.', pets: 'Trująca dla kotów i psów (szczawiany wapnia).', common_problems: ['żółte dolne liście → przelanie', 'brązowe końcówki → suche powietrze'], placement: '1–2 m od okna wschodniego.' }
        : { status: turn > 1 ? 'sick' : 'watch', title: turn > 1 ? 'Przelanie — potwierdzone' : 'Prawdopodobne przelanie', summary: 'Dolne liście żółkną równomiernie, podłoże wygląda na mokre.', findings: [{ observation: 'Żółknięcie dolnych liści', likely_cause: 'nadmiar wody w osłonce bez odpływu', confidence: 'medium' }], actions: ['Wylej wodę z osłonki.', 'Nie podlewaj, aż 3 cm podłoża przeschnie.'], watering: 'Wydłuż interwał o 3–4 dni.', questions: turn > 1 ? [] : ['Czy podłoże 3 cm pod powierzchnią jest mokre?', 'Czy w osłonce stoi woda?'] };
      return { stop_reason: 'end_turn', model: 'claude-opus-5', usage: { input_tokens: 2100, output_tokens: 900 }, content: [{ type: 'text', text: JSON.stringify(body) }] };
    } } },
  };
}

async function main() {
  config = await loadConfig();
  loadCare();
  db = openDb();
  TOKEN = tokenFor(config.password);
  ai = createAiClient(config);
  if (process.env.GREENLY_FAKE_AI) ai = fakeAiClient(); // dev only: canned answers, no network
  if (!ai) console.log('greenLy: anthropicApiKey not set — health checks and species profiles disabled');
  const port = Number(process.env.PORT) || config.port || 8080;
  server.listen(port, () => console.log(`greenLy listening on ${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
