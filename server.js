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
  ensureWateringRow, deleteWatering, tsForDate, snoozePlant, PHOTO_FULL_MAX_BYTES,
  EVENT_TYPES, insertEvent, getEvent, listEvents, deleteEvent,
  insertCheck, getCheck, listChecks, checkChain, checkPhotoNames,
  upsertSub, deleteSub, storePhoto, storePhotoBuffer, readPhotoBase64, sniffImageType, removePhoto, photoBelongsTo,
  safeEqual, parseDateString, toDateString, MATERIAL_FACTOR, LIGHT_FACTOR,
  normalizeLogin, MIN_PASSWORD, verifyPassword, createUser, getUser, getUserByLogin, setUserPassword, setUserAi,
  createSession, sessionUser, deleteSession, deleteUserSessions, encryptSecret, decryptSecret, loadSecret, ensureAdmin,
  setAdmin, countAdmins, listUsersAdmin, deleteUser, createInvite, listInvites, setInviteDisabled, deleteInvite, consumeInvite,
  setUseGlobalKey, getSetting, setSetting,
} from './lib.js';
import { runCron } from './cron.js';
import { createClient as createAiClient, analyzeHealth, describeSpecies, describeEvent, verifyKey, MODELS, EFFORTS, DEFAULT_MODEL, DEFAULT_EFFORT } from './ai.js';

// NOTE: no top-level await anywhere in this module graph. Plesk/Passenger loads the
// startup file with require(), and Node refuses require() on an ESM graph that
// contains top-level await (ERR_REQUIRE_ASYNC_MODULE). Everything async lives in main().
let config;
let db;
let secret; // server secret for encrypting per-user API keys
let appVersion = null; // APP_VERSION read from public/app.js at start (see /api/version)

const PUBLIC_DIR = path.join(ROOT, 'public');
const JSON_LIMIT = 6 * 1024 * 1024; // save: thumbnail + full-size photo as base64 data URLs
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

function requestToken(req, url) {
  const header = req.headers.authorization ?? '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  return bearer || url.searchParams.get('t') || '';
}

/** Session → user row (without the token). Throws 401 when missing or unknown. */
function requireAuth(req, url) {
  const user = sessionUser(db, requestToken(req, url));
  if (!user) throw new HttpError(401, 'Brak autoryzacji — zaloguj się ponownie.');
  return user;
}

function globalInfo() {
  const g = globalAi();
  return { has_key: !!g.key, key_hint: g.key ? g.key.slice(-4) : null, model: g.model, effort: g.effort };
}

function requireAdmin(req, url) {
  const user = requireAuth(req, url);
  if (!user.is_admin) throw new HttpError(403, 'Tylko dla administratora.');
  return user;
}

function str(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

/** The admin's server-wide key and its model/effort (key decrypted; null when unset). */
function globalAi() {
  return {
    key: decryptSecret(secret, getSetting(db, 'global_anthropic_key')),
    model: getSetting(db, 'global_model') || config.anthropicModel || DEFAULT_MODEL,
    effort: getSetting(db, 'global_effort') || config.anthropicEffort || DEFAULT_EFFORT,
  };
}

/** Which key a user runs on: their own, or the global one when the admin assigned it. */
function resolveAi(u) {
  if (u.use_global_key) {
    const g = globalAi();
    return { key: g.key, model: g.model, effort: g.effort, source: 'global' };
  }
  return {
    key: decryptSecret(secret, u.anthropic_key),
    model: u.anthropic_model || DEFAULT_MODEL,
    effort: u.anthropic_effort || DEFAULT_EFFORT,
    source: 'own',
  };
}

/** Public account info sent to the client. */
function userInfo(u) {
  const a = resolveAi(u);
  return {
    login: u.login,
    is_admin: !!u.is_admin,
    has_key: !!a.key || !!process.env.GREENLY_FAKE_AI,
    key_source: a.source,           // 'global' = assigned by the admin, settings locked
    key_hint: a.source === 'own' && a.key ? a.key.slice(-4) : null,
    model: a.model,
    effort: a.effort,
  };
}

/** Anthropic client and settings for a user, or null when there is no usable key. */
function aiFor(u) {
  if (process.env.GREENLY_FAKE_AI) return { client: fakeAiClient(), settings: {} };
  const a = resolveAi(u);
  if (!a.key) return null;
  return { client: createAiClient({ anthropicApiKey: a.key }), settings: { anthropicModel: a.model, anthropicEffort: a.effort } };
}

/** Validates a key against Anthropic and returns it encrypted. */
async function checkedKey(raw) {
  const key = String(raw).trim();
  if (!/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(key)) throw new HttpError(400, 'To nie wygląda na klucz Anthropic (zaczyna się od sk-ant-).');
  await verifyKey(createAiClient({ anthropicApiKey: key }));
  return encryptSecret(secret, key);
}

const NO_KEY = 'Brak klucza Anthropic — dodaj go w ustawieniach konta.';
const myPlant = (u, id) => listPlants(db, u.id).find((p) => p.id === id);

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
    const b = await readJson(req);
    // A stale cached app.js may still send only {password}: that is the admin.
    const login = normalizeLogin(b.login ?? config.adminLogin ?? 'admin');
    const user = login ? getUserByLogin(db, login) : null;
    if (!user || typeof b.password !== 'string' || !verifyPassword(b.password, user.pass_hash)) {
      await sleep(400);
      throw new HttpError(401, 'Nieprawidłowy login lub hasło.');
    }
    sendJson(res, 200, { token: createSession(db, user.id), user: userInfo(user) });
  },

  // {login, password, invite} → new account + session. The code is an admin-made invite
  // (or config.inviteCode, which never runs out).
  async register(req, res) {
    const b = await readJson(req);
    const login = normalizeLogin(b.login);
    if (!login) throw new HttpError(400, 'Login: 3–32 znaki, małe litery, cyfry, kropka, myślnik lub podkreślenie.');
    if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) throw new HttpError(400, `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`);
    if (getUserByLogin(db, login)) throw new HttpError(409, 'Ten login jest już zajęty.');
    const code = typeof b.invite === 'string' ? b.invite.trim() : '';
    const viaConfig = !!config.inviteCode && code && safeEqual(code, config.inviteCode);
    if (!viaConfig && !consumeInvite(db, code)) {
      await sleep(400);
      throw new HttpError(403, 'Nieprawidłowy albo wykorzystany kod zaproszenia.');
    }
    const id = createUser(db, { login, password: b.password, invite_code: viaConfig ? null : code, anthropic_model: config.anthropicModel || null, anthropic_effort: config.anthropicEffort || null });
    sendJson(res, 200, { token: createSession(db, id), user: userInfo(getUser(db, id)) });
  },

  // ---- admin panel ----
  async admin(req, res, url) {
    requireAdmin(req, url);
    sendJson(res, 200, { users: listUsersAdmin(db), invites: listInvites(db), config_invite: !!config.inviteCode, global: globalInfo() });
  },

  // Global Claude key: {anthropic_key?: string|null, model?, effort?}. Users with use_global_key run on it.
  async adminglobal(req, res, url) {
    requireAdmin(req, url);
    const b = await readJson(req);
    if (b.anthropic_key === null) setSetting(db, 'global_anthropic_key', null);
    else if (typeof b.anthropic_key === 'string' && b.anthropic_key.trim()) setSetting(db, 'global_anthropic_key', await checkedKey(b.anthropic_key));
    if (b.model !== undefined) {
      if (!MODELS.includes(b.model)) throw new HttpError(400, 'Nieznany model.');
      setSetting(db, 'global_model', b.model);
    }
    if (b.effort !== undefined) {
      if (!EFFORTS.includes(b.effort)) throw new HttpError(400, 'Nieznany poziom analizy.');
      setSetting(db, 'global_effort', b.effort);
    }
    sendJson(res, 200, { global: globalInfo() });
  },

  // {id, action: 'delete' | 'password' | 'admin' | 'unadmin', password?}
  async adminuser(req, res, url) {
    const me = requireAdmin(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    const target = getUser(db, id);
    if (!target) throw new HttpError(404, 'Nie ma takiego użytkownika.');
    switch (b.action) {
      case 'delete':
        if (id === me.id) throw new HttpError(400, 'Nie możesz usunąć własnego konta z panelu.');
        deleteUser(db, id);
        break;
      case 'password':
        if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) throw new HttpError(400, `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`);
        setUserPassword(db, id, b.password);
        deleteUserSessions(db, id);
        break;
      case 'admin':
        setAdmin(db, id, true);
        break;
      case 'unadmin':
        if (id === me.id) throw new HttpError(400, 'Nie możesz odebrać sobie uprawnień.');
        if (countAdmins(db) <= 1) throw new HttpError(400, 'Musi zostać co najmniej jeden administrator.');
        setAdmin(db, id, false);
        break;
      case 'global':
        setUseGlobalKey(db, id, true);
        break;
      case 'unglobal':
        setUseGlobalKey(db, id, false);
        break;
      default:
        throw new HttpError(400, 'Nieznana akcja.');
    }
    sendJson(res, 200, { users: listUsersAdmin(db) });
  },

  // {action: 'create' | 'disable' | 'enable' | 'delete', code?, note?, max_uses?}
  async admininvite(req, res, url) {
    const me = requireAdmin(req, url);
    const b = await readJson(req);
    let code = null;
    switch (b.action) {
      case 'create':
        code = createInvite(db, { note: str(b.note, 80), max_uses: Math.min(100, Number(b.max_uses) || 1), created_by: me.id });
        break;
      case 'disable':
      case 'enable':
        if (!setInviteDisabled(db, String(b.code ?? ''), b.action === 'disable')) throw new HttpError(404, 'Nie ma takiego kodu.');
        break;
      case 'delete':
        if (!deleteInvite(db, String(b.code ?? ''))) throw new HttpError(404, 'Nie ma takiego kodu.');
        break;
      default:
        throw new HttpError(400, 'Nieznana akcja.');
    }
    sendJson(res, 200, { invites: listInvites(db), code });
  },

  async logout(req, res, url) {
    requireAuth(req, url);
    deleteSession(db, requestToken(req, url));
    sendJson(res, 200, { ok: true });
  },

  // Account settings: {anthropic_key?, model?, effort?, password?, current_password?}.
  // anthropic_key: string = verify against Anthropic and store encrypted; null = remove.
  async account(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const ai = {};
    const touchesAi = b.anthropic_key !== undefined || b.model !== undefined || b.effort !== undefined;
    if (touchesAi && u.use_global_key) throw new HttpError(400, 'Twoje konto korzysta z globalnego klucza Claude — te ustawienia zmienia administrator.');
    if (b.anthropic_key === null) ai.anthropic_key = null;
    else if (typeof b.anthropic_key === 'string' && b.anthropic_key.trim()) ai.anthropic_key = await checkedKey(b.anthropic_key);
    if (b.model !== undefined) {
      if (!MODELS.includes(b.model)) throw new HttpError(400, 'Nieznany model.');
      ai.anthropic_model = b.model;
    }
    if (b.effort !== undefined) {
      if (!EFFORTS.includes(b.effort)) throw new HttpError(400, 'Nieznany poziom analizy.');
      ai.anthropic_effort = b.effort;
    }
    if (Object.keys(ai).length) setUserAi(db, u.id, ai);
    if (b.password !== undefined) {
      if (typeof b.current_password !== 'string' || !verifyPassword(b.current_password, u.pass_hash)) {
        await sleep(400);
        throw new HttpError(401, 'Obecne hasło jest nieprawidłowe.');
      }
      if (typeof b.password !== 'string' || b.password.length < MIN_PASSWORD) throw new HttpError(400, `Hasło musi mieć co najmniej ${MIN_PASSWORD} znaków.`);
      setUserPassword(db, u.id, b.password);
      deleteUserSessions(db, u.id, requestToken(req, url)); // other devices must log in again
    }
    sendJson(res, 200, { user: userInfo(getUser(db, u.id)) });
  },

  async plants(req, res, url) {
    const u = requireAuth(req, url);
    const info = userInfo(u);
    sendJson(res, 200, { plants: listPlants(db, u.id), today: toDateString(), ai: info.has_key, user: info });
  },

  // Everything the profile view needs: plant, group care info, watering history, health checks.
  async plant(req, res, url, rest) {
    const u = requireAuth(req, url);
    const id = Number(rest);
    const plant = myPlant(u, id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
    sendJson(res, 200, {
      plant,
      care: groupCare(plant.group_key),
      waterings: listWaterings(db, id),
      checks: listChecks(db, id),
      events: listEvents(db, id),
      ai: userInfo(u).has_key,
    });
  },

  // Care event: {plant_id, type, date?, note?, data?}. Repotting and moving also update the plant's
  // conditions (the interval follows); data.watered logs a watering on the same date.
  async event(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.plant_id);
    const existing = getPlant(db, id, u.id);
    if (!existing) throw new HttpError(404, 'Nie ma takiej rośliny.');
    const type = String(b.type ?? '');
    if (!EVENT_TYPES.includes(type) || type === 'split' || type === 'snooze') throw new HttpError(400, 'Nieznany typ zdarzenia.');
    const date = b.date ? parseDateString(String(b.date)) && String(b.date) : null;
    if (b.date && !date) throw new HttpError(400, 'Nieprawidłowa data.');
    const note = str(b.note, 500);
    const d = b.data && typeof b.data === 'object' ? b.data : {};
    const data = {};
    if (type === 'repot') {
      const cm = Number(d.pot_cm);
      if (!Number.isFinite(cm) || cm < 4 || cm > 80) throw new HttpError(400, 'Podaj średnicę doniczki (4–80 cm).');
      if (!(d.pot_material in MATERIAL_FACTOR)) throw new HttpError(400, 'Nieznany materiał doniczki.');
      Object.assign(data, { pot_cm_from: existing.pot_cm, pot_material_from: existing.pot_material, pot_cm: cm, pot_material: d.pot_material });
      updatePlant(db, id, { ...existing, pot_cm: cm, pot_material: d.pot_material });
    } else if (type === 'move') {
      if (!(d.light in LIGHT_FACTOR)) throw new HttpError(400, 'Nieznany poziom światła.');
      Object.assign(data, { light_from: existing.light, dry_air_from: !!existing.dry_air, light: d.light, dry_air: !!d.dry_air });
      updatePlant(db, id, { ...existing, light: d.light, dry_air: d.dry_air ? 1 : 0 });
    }
    if (d.watered) {
      data.watered = true;
      waterPlant(db, id, date ?? toDateString());
    }
    const eventId = insertEvent(db, { plant_id: id, type, ts: tsForDate(date), note, data });
    sendJson(res, 200, { event: getEvent(db, eventId), plant: myPlant(u, id) });
  },

  async unevent(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const plantId = deleteEvent(db, Number(b.event_id), u.id);
    if (!plantId) throw new HttpError(404, 'Nie ma takiego zdarzenia.');
    sendJson(res, 200, { plant: myPlant(u, plantId) });
  },

  // Division: {id, name, pot_cm, pot_material, photo?, watered?, note?, date?} → a second plant with the same
  // species and care profile; both get a `split` event pointing at each other.
  async split(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    const src = getPlant(db, id, u.id);
    if (!src) throw new HttpError(404, 'Nie ma takiej rośliny.');
    const name = str(b.name, 80);
    if (!name) throw new HttpError(400, 'Podaj nazwę nowej rośliny.');
    const cm = Number(b.pot_cm ?? src.pot_cm);
    if (!Number.isFinite(cm) || cm < 4 || cm > 80) throw new HttpError(400, 'Podaj średnicę doniczki (4–80 cm).');
    const material = b.pot_material ?? src.pot_material;
    if (!(material in MATERIAL_FACTOR)) throw new HttpError(400, 'Nieznany materiał doniczki.');
    const date = b.date ? parseDateString(String(b.date)) && String(b.date) : null;
    if (b.date && !date) throw new HttpError(400, 'Nieprawidłowa data.');
    const note = str(b.note, 500);
    const watered = !!b.watered;
    const day = date ?? toDateString();

    const child = {
      name, species: src.species, common: src.common, genus: src.genus, family: src.family, group_key: src.group_key,
      base_summer: src.base_summer, base_winter: src.base_winter, pot_cm: cm, pot_material: material,
      light: src.light, dry_air: src.dry_air, photo: null, note: '', last_watered: watered ? day : src.last_watered,
      user_id: u.id,
    };
    const childId = insertPlant(db, child);
    if (typeof b.photo === 'string' && b.photo.startsWith('data:')) {
      try {
        const photo = storePhoto(b.photo, childId);
        const photo_full = typeof b.photo_full === 'string' && b.photo_full.startsWith('data:') ? storePhoto(b.photo_full, childId, PHOTO_FULL_MAX_BYTES) : null;
        updatePlant(db, childId, { ...child, photo, photo_full });
      } catch (e) {
        deletePlant(db, childId);
        throw e;
      }
    }
    if (watered) { waterPlant(db, id, day); waterPlant(db, childId, day); } else if (src.last_watered) { ensureWateringRow(db, childId, src.last_watered); }
    const ts = tsForDate(date);
    insertEvent(db, { plant_id: id, type: 'split', ts, note, data: { role: 'parent', sibling_id: childId, sibling_name: name, watered } });
    insertEvent(db, { plant_id: childId, type: 'split', ts, note, data: { role: 'child', sibling_id: id, sibling_name: src.name, watered } });
    const all = listPlants(db, u.id);
    sendJson(res, 200, { plant: all.find((p) => p.id === childId), original: all.find((p) => p.id === id) });
  },

  // Claude analysis. Multipart: id, mode (checkup|doctor), text, image (new check) or parent_id + text (follow-up).
  async health(req, res, url) {
    const u = requireAuth(req, url);
    const ai = aiFor(u);
    if (!ai) throw new HttpError(503, NO_KEY);
    const fd = await readMultipart(req);
    const id = Number(fd.get('id'));
    const plant = myPlant(u, id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
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

    const { result, usage, model } = await analyzeHealth(ai.client, ai.settings, {
      plant: withRecentEvents(plant), care: groupCare(plant.group_key), mode, userText: text, images, chain,
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
    const u = requireAuth(req, url);
    const ai = aiFor(u);
    if (!ai) throw new HttpError(503, NO_KEY);
    const b = await readJson(req);
    const id = Number(b.id);
    const plant = myPlant(u, id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
    if (plant.profile && !b.refresh) return sendJson(res, 200, { profile: plant.profile, cached: true });
    const { result } = await describeSpecies(ai.client, ai.settings, { plant: withRecentEvents(plant), care: groupCare(plant.group_key) });
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
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = b.id ? Number(b.id) : null;
    const existing = id ? getPlant(db, id, u.id) : null;
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
      photo_full: existing?.photo_full ?? null,
      user_id: u.id,
    };

    let plantId = id;
    if (!existing) plantId = insertPlant(db, plant);

    if (typeof b.photo === 'string' && b.photo.startsWith('data:')) {
      try {
        const stored = storePhoto(b.photo, plantId);
        const storedFull = typeof b.photo_full === 'string' && b.photo_full.startsWith('data:') ? storePhoto(b.photo_full, plantId, PHOTO_FULL_MAX_BYTES) : null;
        removePhoto(existing?.photo);
        removePhoto(existing?.photo_full);
        plant.photo = stored;
        plant.photo_full = storedFull;
      } catch (e) {
        if (!existing) deletePlant(db, plantId);
        throw new HttpError(e.status ?? 400, e.message);
      }
    } else if (b.photo === null && existing?.photo) {
      removePhoto(existing.photo);
      removePhoto(existing.photo_full);
      plant.photo = null;
      plant.photo_full = null;
    }

    updatePlant(db, plantId, plant);
    if (plant.last_watered && plant.last_watered !== existing?.last_watered) ensureWateringRow(db, plantId, plant.last_watered);
    sendJson(res, 200, { plant: myPlant(u, plantId) });
  },

  async water(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    if (!getPlant(db, id, u.id)) throw new HttpError(404, 'Nie ma takiej rośliny.');
    const date = b.date ? String(b.date) : toDateString();
    if (!parseDateString(date)) throw new HttpError(400, 'Nieprawidłowa data.');
    const watering_id = waterPlant(db, id, date);
    sendJson(res, 200, { plant: myPlant(u, id), watering_id });
  },

  // "Still wet": {id, days (1–7), note?} → reminder moved by `days`, logged as a snooze event.
  async postpone(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    const plant = getPlant(db, id, u.id);
    if (!plant) throw new HttpError(404, 'Nie ma takiej rośliny.');
    if (!plant.last_watered) throw new HttpError(400, 'Ta roślina nie ma jeszcze daty podlania.');
    const days = Math.round(Number(b.days));
    if (!Number.isFinite(days) || days < 1 || days > 7) throw new HttpError(400, 'Odłóż o 1–7 dni.');
    const until = snoozePlant(db, id, days);
    insertEvent(db, { plant_id: id, type: 'snooze', note: str(b.note, 200), data: { days, until } });
    sendJson(res, 200, { plant: myPlant(u, id), until });
  },

  // Removes one watering (undo, or a wrong entry in the history) and recomputes last_watered.
  async unwater(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const plantId = deleteWatering(db, Number(b.watering_id), u.id);
    if (!plantId) throw new HttpError(404, 'Nie ma takiego podlania.');
    sendJson(res, 200, { plant: myPlant(u, plantId) });
  },

  async delete(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    const id = Number(b.id);
    if (!getPlant(db, id, u.id) || !deletePlant(db, id)) throw new HttpError(404, 'Nie ma takiej rośliny.');
    sendJson(res, 200, { ok: true });
  },

  async vapid(req, res, url) {
    requireAuth(req, url);
    sendJson(res, 200, { publicKey: config.vapid?.publicKey || '' });
  },

  async subscribe(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    if (typeof b.endpoint !== 'string' || !b.endpoint.startsWith('https://') || !b.keys?.p256dh || !b.keys?.auth) {
      throw new HttpError(400, 'Nieprawidłowa subskrypcja push.');
    }
    upsertSub(db, { endpoint: b.endpoint, keys: { p256dh: String(b.keys.p256dh), auth: String(b.keys.auth) }, user_id: u.id });
    sendJson(res, 200, { ok: true });
  },

  async unsubscribe(req, res, url) {
    const u = requireAuth(req, url);
    const b = await readJson(req);
    if (typeof b.endpoint === 'string') deleteSub(db, b.endpoint, u.id);
    sendJson(res, 200, { ok: true });
  },

  async photo(req, res, url, rest) {
    const u = requireAuth(req, url);
    if (!photoBelongsTo(db, rest, u.id)) throw new HttpError(404, 'Nie znaleziono.');
    const file = path.join(PHOTO_DIR, rest);
    if (!fs.existsSync(file)) throw new HttpError(404, 'Nie znaleziono.');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'private, max-age=86400' });
    fs.createReadStream(file).pipe(res);
  },

  // Version of the frontend on disk; the running app compares it with its own APP_VERSION.
  async version(req, res) {
    sendJson(res, 200, { version: appVersion });
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
    const isGet = ['plants', 'plant', 'vapid', 'photo', 'cron', 'admin', 'version'].includes(m[1]);
    if (isGet ? req.method !== 'GET' : req.method !== 'POST') throw new HttpError(405, 'Niedozwolona metoda.');
    await action(req, res, url, m[2]);
  } catch (e) {
    const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
    if (status === 500) console.error(e);
    sendJson(res, status, { error: status === 500 ? 'Błąd serwera.' : e.message });
  }
});

/** Plant copy with the last few care events described for the model. */
function withRecentEvents(plant) {
  return { ...plant, recent_events: listEvents(db, plant.id, 6).map(describeEvent) };
}

/** Dev-only stand-in for the Anthropic client (GREENLY_FAKE_AI=1): returns canned JSON matching the schemas. */
function fakeAiClient() {
  return {
    beta: { messages: { create: async (params) => {
      await sleep(Number(process.env.GREENLY_FAKE_AI) > 1 ? Number(process.env.GREENLY_FAKE_AI) : 800); // ms; GREENLY_FAKE_AI=4000 to watch the thinking panel
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
  secret = loadSecret(config);
  appVersion = /APP_VERSION = '([^']+)'/.exec(fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'))?.[1] ?? null;
  const adminId = ensureAdmin(db, config, secret);
  if (adminId) console.log(`greenLy: created user "${normalizeLogin(config.adminLogin) || 'admin'}" from config.password and assigned existing plants to it`);
  if (config.inviteCode) console.log('greenLy: config.inviteCode is set — it works as an unlimited invite next to the codes from the admin panel');
  if (process.env.GREENLY_FAKE_AI) console.log('greenLy: GREENLY_FAKE_AI — canned analyses for every user');
  const port = process.env.PORT !== undefined ? Number(process.env.PORT) : (config.port || 8080); // PORT=0 (tests) = any free port
  server.listen(port, () => console.log(`greenLy listening on ${port}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
