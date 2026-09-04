// lib.js — database, care profile matching and the watering interval algorithm.
// This file is the source of truth for the interval formula. The same formula is
// duplicated in public/app.js as estimate() for the live preview in the form —
// keep both in sync when changing anything below.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const ROOT = import.meta.dirname;
export const DATA_DIR = path.join(ROOT, 'data');
export const PHOTO_DIR = path.join(DATA_DIR, 'photos');
export const DB_FILE = path.join(DATA_DIR, 'greenly.sqlite');

// ---------------------------------------------------------------------------
// Interval algorithm
//   days = speciesBase(season) × pot × material × light × air
// ---------------------------------------------------------------------------

export const MIN_DAYS = 2;
export const MAX_DAYS = 60;

export const MATERIAL_FACTOR = { terracotta: 0.80, ceramic: 1.00, plastic: 1.08, cachepot: 1.20 };
export const LIGHT_FACTOR = { sun: 0.82, bright: 1.00, partial: 1.22, dark: 1.45 };
export const DRY_AIR_FACTOR = 0.85;

export function potFactor(cm) {
  cm = Number(cm) || 0;
  if (cm <= 10) return 0.72;
  if (cm <= 15) return 0.88;
  if (cm <= 22) return 1.00;
  if (cm <= 30) return 1.18;
  return 1.35;
}

/** 0-based day of the year in local time (same as PHP date('z')). */
export function dayOfYear(d) {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((now - start) / 86400000);
}

/** Smooth season curve: 0 = mid-winter (Jan 1), 1 = peak summer (~Jul 2). */
export function seasonFactor(when = new Date()) {
  return (1 - Math.cos(2 * Math.PI * dayOfYear(when) / 365)) / 2;
}

/**
 * @param {{base_summer:number, base_winter:number, pot_cm:number, pot_material:string, light:string, dry_air:boolean|number}} p
 * @returns {number} whole days, clamped to [MIN_DAYS, MAX_DAYS]
 */
export function intervalDays(p, when = new Date()) {
  const s = seasonFactor(when);
  const base = p.base_winter + (p.base_summer - p.base_winter) * s;
  const days = base
    * potFactor(p.pot_cm)
    * (MATERIAL_FACTOR[p.pot_material] ?? 1)
    * (LIGHT_FACTOR[p.light] ?? 1)
    * (p.dry_air ? DRY_AIR_FACTOR : 1);
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));
}

// ---------------------------------------------------------------------------
// Care profiles (care.json)
// ---------------------------------------------------------------------------

let care = null;
let index = null;

/** Lower-case, strip hybrid marks/cultivars/authors, keep "genus epithet". */
export function normalizeName(name) {
  if (!name) return '';
  return String(name)
    .toLowerCase()
    .replace(/['‘’"“”].*$/, '')          // cultivar names
    .replace(/[×]/g, ' ')                 // hybrid sign
    .replace(/\b(x|var|subsp|ssp|f|cv)\b\.?/g, ' ')
    .replace(/[^a-z\- ]/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
}

export function loadCare(file = path.join(ROOT, 'care.json')) {
  care = JSON.parse(fs.readFileSync(file, 'utf8'));
  index = { species: new Map(), genus: new Map(), family: new Map() };
  for (const [k, v] of Object.entries(care.species)) index.species.set(normalizeName(k), { key: k, ...v });
  for (const [k, v] of Object.entries(care.genus)) index.genus.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(care.family)) index.family.set(k.toLowerCase(), v);
  return care;
}

export function getCare() {
  return care ?? loadCare();
}

/**
 * Cascade: species → genus → family → universal.
 * @returns {{group:string, level:'species'|'genus'|'family'|'universal', label:string, note:string, summer:number, winter:number}}
 */
export function matchProfile({ species = '', genus = '', family = '' } = {}) {
  const c = getCare();
  const withGroup = (group, level, summer, winter) => {
    const g = c.groups[group] ?? c.groups.universal;
    return { group, level, label: g.label, note: g.note, summer: summer ?? g.summer, winter: winter ?? g.winter };
  };

  const sp = index.species.get(normalizeName(species));
  if (sp) return withGroup(sp.group, 'species', sp.summer, sp.winter);

  const genusName = (genus || normalizeName(species).split(' ')[0] || '').toLowerCase();
  const ge = index.genus.get(genusName);
  if (ge) return withGroup(ge, 'genus');

  const fa = index.family.get(String(family).toLowerCase());
  if (fa) return withGroup(fa, 'family');

  return withGroup('universal', 'universal');
}

// ---------------------------------------------------------------------------
// Dates (local time, day granularity)
// ---------------------------------------------------------------------------

export function toDateString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(d, n) {
  const r = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  r.setDate(r.getDate() + n);
  return r;
}

function daysBetween(a, b) {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / 86400000);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export function openDb(file = DB_FILE) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS plants (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      species       TEXT NOT NULL DEFAULT '',
      common        TEXT NOT NULL DEFAULT '',
      genus         TEXT NOT NULL DEFAULT '',
      family        TEXT NOT NULL DEFAULT '',
      group_key     TEXT NOT NULL DEFAULT 'universal',
      base_summer   REAL NOT NULL,
      base_winter   REAL NOT NULL,
      pot_cm        INTEGER NOT NULL DEFAULT 15,
      pot_material  TEXT NOT NULL DEFAULT 'ceramic',
      light         TEXT NOT NULL DEFAULT 'bright',
      dry_air       INTEGER NOT NULL DEFAULT 0,
      photo         TEXT,
      note          TEXT NOT NULL DEFAULT '',
      last_watered  TEXT,
      last_notified TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS waterings (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id  INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      ts        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS waterings_plant ON waterings(plant_id);
    CREATE TABLE IF NOT EXISTS subs (
      endpoint    TEXT PRIMARY KEY,
      p256dh      TEXT NOT NULL,
      auth        TEXT NOT NULL,
      created_at  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_checks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id      INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      parent_id     INTEGER REFERENCES health_checks(id) ON DELETE CASCADE,
      mode          TEXT NOT NULL,
      ts            TEXT NOT NULL,
      photo         TEXT,
      user_text     TEXT NOT NULL DEFAULT '',
      result        TEXT NOT NULL,
      model         TEXT,
      input_tokens  INTEGER,
      output_tokens INTEGER
    );
    CREATE INDEX IF NOT EXISTS health_checks_plant ON health_checks(plant_id);
  `);
  // Columns added after the first release (CREATE TABLE IF NOT EXISTS does not alter existing tables).
  ensureColumn(db, 'plants', 'profile', 'TEXT');
  ensureColumn(db, 'health_checks', 'photos', 'TEXT'); // JSON array of file names; `photo` keeps the first one
  backfillWaterings(db);
  return db;
}

/** ALTER TABLE ... ADD COLUMN, only when the column is missing. */
export function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/** Row → API object with computed schedule fields. */
export function decoratePlant(row, now = new Date()) {
  const c = getCare();
  const interval = intervalDays(row, now);
  const last = parseDateString(row.last_watered);
  let next_due = null;
  let days_left = null;
  if (last) {
    const due = addDays(last, interval);
    next_due = toDateString(due);
    days_left = daysBetween(now, due);
  }
  const g = c.groups[row.group_key] ?? c.groups.universal;
  const level = matchProfile(row).level;
  let profile = null;
  if (row.profile) { try { profile = JSON.parse(row.profile); } catch { profile = null; } }
  return {
    ...row,
    dry_air: !!row.dry_air,
    photo: row.photo ? `api/photo/${row.photo}` : null,
    profile,
    interval,
    next_due,
    days_left,
    group_label: g.label,
    group_note: g.note,
    match_level: level,
  };
}

/** Group-level care info (label, note, light, humidity, temp, placement). */
export function groupCare(groupKey) {
  const c = getCare();
  return c.groups[groupKey] ?? c.groups.universal;
}

export function listPlants(db, now = new Date()) {
  const rows = db.prepare('SELECT * FROM plants').all();
  return rows
    .map((r) => decoratePlant(r, now))
    .sort((a, b) => (a.days_left ?? -9999) - (b.days_left ?? -9999) || a.name.localeCompare(b.name, 'pl'));
}

export function getPlant(db, id) {
  return db.prepare('SELECT * FROM plants WHERE id = ?').get(id) ?? null;
}

export function insertPlant(db, p) {
  const r = db.prepare(`
    INSERT INTO plants (name, species, common, genus, family, group_key, base_summer, base_winter,
                        pot_cm, pot_material, light, dry_air, photo, note, last_watered, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.name, p.species, p.common, p.genus, p.family, p.group_key, p.base_summer, p.base_winter,
    p.pot_cm, p.pot_material, p.light, p.dry_air ? 1 : 0, p.photo, p.note, p.last_watered, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function updatePlant(db, id, p) {
  db.prepare(`
    UPDATE plants SET name=?, species=?, common=?, genus=?, family=?, group_key=?, base_summer=?, base_winter=?,
                      pot_cm=?, pot_material=?, light=?, dry_air=?, photo=?, note=?, last_watered=?
    WHERE id=?
  `).run(p.name, p.species, p.common, p.genus, p.family, p.group_key, p.base_summer, p.base_winter,
    p.pot_cm, p.pot_material, p.light, p.dry_air ? 1 : 0, p.photo, p.note, p.last_watered, id);
}

/** Timestamp for a watering: now, or noon local time of the given date (so a date-only entry sorts sanely). */
function wateringTs(date) {
  if (!date || date === toDateString()) return new Date().toISOString();
  const d = parseDateString(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString();
}

/** Marks the plant watered, appends to the history. Returns the new watering id (for undo). */
export function waterPlant(db, id, date = toDateString()) {
  db.prepare('UPDATE plants SET last_watered = ?, last_notified = NULL WHERE id = ?').run(date, id);
  const r = db.prepare('INSERT INTO waterings (plant_id, ts) VALUES (?, ?)').run(id, wateringTs(date));
  return Number(r.lastInsertRowid);
}

/** Adds a history row for a manually entered date unless one already exists for that day. */
export function ensureWateringRow(db, id, date) {
  if (!date) return;
  const rows = db.prepare('SELECT ts FROM waterings WHERE plant_id = ?').all(id);
  if (rows.some((r) => toDateString(new Date(r.ts)) === date)) return;
  db.prepare('INSERT INTO waterings (plant_id, ts) VALUES (?, ?)').run(id, wateringTs(date));
}

/** Deletes one history row and recomputes last_watered from what is left. Returns the plant id or null. */
export function deleteWatering(db, wateringId) {
  const row = db.prepare('SELECT id, plant_id FROM waterings WHERE id = ?').get(wateringId);
  if (!row) return null;
  db.prepare('DELETE FROM waterings WHERE id = ?').run(wateringId);
  const latest = db.prepare('SELECT ts FROM waterings WHERE plant_id = ? ORDER BY ts DESC LIMIT 1').get(row.plant_id);
  const last = latest ? toDateString(new Date(latest.ts)) : null;
  db.prepare('UPDATE plants SET last_watered = ? WHERE id = ?').run(last, row.plant_id);
  return Number(row.plant_id);
}

/** One-time backfill: plants with a last_watered date but no history rows (saved before history mattered). */
export function backfillWaterings(db) {
  const rows = db.prepare(`
    SELECT p.id, p.last_watered FROM plants p
    WHERE p.last_watered IS NOT NULL AND NOT EXISTS (SELECT 1 FROM waterings w WHERE w.plant_id = p.id)
  `).all();
  for (const r of rows) ensureWateringRow(db, r.id, r.last_watered);
  return rows.length;
}

export function deletePlant(db, id) {
  const row = getPlant(db, id);
  if (!row) return false;
  const checkRows = db.prepare('SELECT photo, photos FROM health_checks WHERE plant_id = ?').all(id);
  db.prepare('DELETE FROM plants WHERE id = ?').run(id);
  if (row.photo) fs.rmSync(path.join(PHOTO_DIR, row.photo), { force: true });
  for (const c of checkRows) for (const name of checkPhotoNames(c)) fs.rmSync(path.join(PHOTO_DIR, name), { force: true });
  return true;
}

export function setProfile(db, id, profileJson) {
  db.prepare('UPDATE plants SET profile = ? WHERE id = ?').run(profileJson, id);
}

export function listWaterings(db, plantId) {
  return db.prepare('SELECT id, ts FROM waterings WHERE plant_id = ? ORDER BY ts DESC LIMIT 200').all(plantId);
}

// ---------------------------------------------------------------------------
// Health checks (Claude analyses)
// ---------------------------------------------------------------------------

/** Raw stored file names of a check's photos (new `photos` JSON column, falling back to `photo`). */
export function checkPhotoNames(row) {
  if (row.photos) { try { const a = JSON.parse(row.photos); if (Array.isArray(a)) return a; } catch { /* fall through */ } }
  return row.photo ? [row.photo] : [];
}

function decorateCheck(row) {
  if (!row) return null;
  let result = null;
  try { result = JSON.parse(row.result); } catch { result = null; }
  const photos = checkPhotoNames(row).map((n) => `api/photo/${n}`);
  return { ...row, photo: photos[0] ?? null, photos, result };
}

export function insertCheck(db, c) {
  const photos = c.photos ?? (c.photo ? [c.photo] : []);
  const r = db.prepare(`
    INSERT INTO health_checks (plant_id, parent_id, mode, ts, photo, photos, user_text, result, model, input_tokens, output_tokens)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.plant_id, c.parent_id ?? null, c.mode, new Date().toISOString(), photos[0] ?? null, JSON.stringify(photos), c.user_text ?? '',
    JSON.stringify(c.result), c.model ?? null, c.input_tokens ?? null, c.output_tokens ?? null);
  return Number(r.lastInsertRowid);
}

export function getCheck(db, id) {
  return decorateCheck(db.prepare('SELECT * FROM health_checks WHERE id = ?').get(id));
}

export function listChecks(db, plantId) {
  return db.prepare('SELECT * FROM health_checks WHERE plant_id = ? ORDER BY ts DESC LIMIT 100').all(plantId).map(decorateCheck);
}

/** Root → … → the given check (follow-up conversation), oldest first. Raw photo file names. */
export function checkChain(db, id) {
  const chain = [];
  let row = db.prepare('SELECT * FROM health_checks WHERE id = ?').get(id);
  while (row) {
    chain.unshift({ ...row, result: JSON.parse(row.result) });
    row = row.parent_id ? db.prepare('SELECT * FROM health_checks WHERE id = ?').get(row.parent_id) : null;
  }
  return chain;
}

export function markNotified(db, ids, date = toDateString()) {
  const st = db.prepare('UPDATE plants SET last_notified = ? WHERE id = ?');
  for (const id of ids) st.run(date, id);
}

/** Plants due today or overdue, watered at least once, not yet notified today. */
export function duePlants(db, now = new Date()) {
  const today = toDateString(now);
  return listPlants(db, now).filter((p) => p.last_watered && p.days_left !== null && p.days_left <= 0 && p.last_notified !== today);
}

export function listSubs(db) {
  return db.prepare('SELECT endpoint, p256dh, auth FROM subs').all();
}

export function upsertSub(db, { endpoint, keys }) {
  db.prepare(`
    INSERT INTO subs (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth
  `).run(endpoint, keys.p256dh, keys.auth, new Date().toISOString());
}

export function deleteSub(db, endpoint) {
  db.prepare('DELETE FROM subs WHERE endpoint = ?').run(endpoint);
}

// ---------------------------------------------------------------------------
// Photos (data URL → file in data/photos)
// ---------------------------------------------------------------------------

export const PHOTO_MAX_BYTES = 600 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** Validates and stores a data URL (thumbnail). Returns the stored file name. Throws Error with .status on bad input. */
export function storePhoto(dataUrl, plantId) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
  if (!m) throw Object.assign(new Error('Nieobsługiwany format zdjęcia.'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > PHOTO_MAX_BYTES) throw Object.assign(new Error('Zdjęcie jest za duże (limit 600 KB).'), { status: 413 });
  return storePhotoBuffer(buf, m[1], plantId);
}

/** Validates magic bytes against the declared type and writes the file. Returns the file name. */
export function storePhotoBuffer(buf, declaredType, plantId) {
  const type = sniffImage(buf);
  if (!type || type !== declaredType) throw Object.assign(new Error('Plik nie jest poprawnym obrazem.'), { status: 400 });
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const name = `${plantId}-${crypto.randomBytes(4).toString('hex')}.${PHOTO_TYPES[type]}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf);
  return name;
}

/** Reads a stored photo back as {data (base64), mediaType} — used to re-send the root photo on follow-ups. */
export function readPhotoBase64(name) {
  const file = path.join(PHOTO_DIR, name);
  if (!fs.existsSync(file)) return null;
  const buf = fs.readFileSync(file);
  const type = sniffImage(buf);
  return type ? { data: buf.toString('base64'), mediaType: type } : null;
}

export function sniffImageType(buf) {
  return sniffImage(buf);
}

export function removePhoto(name) {
  if (name) fs.rmSync(path.join(PHOTO_DIR, name), { force: true });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export function tokenFor(password) {
  return crypto.createHash('sha256').update('greenly|' + password).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export async function loadConfig() {
  const file = process.env.GREENLY_CONFIG || path.join(ROOT, 'config.js');
  if (!fs.existsSync(file)) {
    throw new Error('Missing config.js — copy config.example.js to config.js and fill it in.');
  }
  const mod = await import(`${pathToFileURL(file).href}?ts=${Date.now()}`);
  const cfg = mod.default ?? mod;
  if (!cfg.password) throw new Error('config.js: "password" must not be empty.');
  if (cfg.timezone) process.env.TZ = cfg.timezone;
  return cfg;
}
