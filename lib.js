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
export const DATA_DIR = process.env.GREENLY_DATA || path.join(ROOT, 'data'); // env: tests point it at a temp dir
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
    * (p.dry_air ? DRY_AIR_FACTOR : 1)
    * (Number(p.interval_adjust) || 1); // learned from "still wet" snoozes, 1.0–1.6
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
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      plant_id    INTEGER NOT NULL REFERENCES plants(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,
      ts          TEXT NOT NULL,
      note        TEXT NOT NULL DEFAULT '',
      data        TEXT NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_plant ON events(plant_id);
    CREATE TABLE IF NOT EXISTS users (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      login            TEXT NOT NULL UNIQUE,
      pass_hash        TEXT NOT NULL,
      anthropic_key    TEXT,
      anthropic_model  TEXT,
      anthropic_effort TEXT,
      created_at       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  TEXT NOT NULL,
      last_seen   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS settings (
      key    TEXT PRIMARY KEY,
      value  TEXT
    );
    CREATE TABLE IF NOT EXISTS invites (
      code        TEXT PRIMARY KEY,
      note        TEXT NOT NULL DEFAULT '',
      max_uses    INTEGER NOT NULL DEFAULT 1,
      uses        INTEGER NOT NULL DEFAULT 0,
      disabled    INTEGER NOT NULL DEFAULT 0,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TEXT NOT NULL
    );
  `);
  // Columns added after the first release (CREATE TABLE IF NOT EXISTS does not alter existing tables).
  ensureColumn(db, 'plants', 'profile', 'TEXT');
  ensureColumn(db, 'health_checks', 'photos', 'TEXT'); // JSON array of file names; `photo` keeps the first one
  ensureColumn(db, 'plants', 'user_id', 'INTEGER');
  ensureColumn(db, 'subs', 'user_id', 'INTEGER');
  ensureColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'invite_code', 'TEXT');
  ensureColumn(db, 'users', 'use_global_key', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'lang', 'TEXT'); // 'pl' | 'en' — push notification language
  ensureColumn(db, 'plants', 'snoozed_until', 'TEXT'); // "still wet": reminder pushed to this date
  ensureColumn(db, 'plants', 'photo_full', 'TEXT');    // large photo for the lightbox; `photo` stays the thumbnail
  ensureColumn(db, 'plants', 'ml_adjust', 'REAL NOT NULL DEFAULT 1');       // learned: portion multiplier 0.5–1
  ensureColumn(db, 'plants', 'interval_adjust', 'REAL NOT NULL DEFAULT 1'); // learned: interval multiplier 1–1.6
  db.exec(`
    CREATE INDEX IF NOT EXISTS plants_user ON plants(user_id);
    CREATE INDEX IF NOT EXISTS subs_user ON subs(user_id);
  `);
  backfillWaterings(db);
  return db;
}

/** ALTER TABLE ... ADD COLUMN, only when the column is missing. */
export function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// Amount per watering: a share of the pot volume (cylinder, height ≈ diameter) set per care group in
// care.json (`ml`, ~5 % cacti … 13 % ferns), corrected for how fast the pot dries (material, light, dry
// air) and by what the plant taught us through "still wet" snoozes. Only a hint — "until it drains" applies.
export const ML_MATERIAL = { terracotta: 1.15, ceramic: 1.0, plastic: 1.0, cachepot: 0.8 };
export const ML_LIGHT = { sun: 1.15, bright: 1.0, partial: 0.9, dark: 0.8 };
export const ML_DRY_AIR = 1.05;
export function wateringMl(p) {
  const cm = Number(p.pot_cm) || 15;
  const volume = Math.PI * (cm / 2) ** 2 * cm; // ml
  const share = getCare().groups[p.group_key]?.ml ?? 0.1;
  const ml = volume * share
    * (ML_MATERIAL[p.pot_material] ?? 1)
    * (ML_LIGHT[p.light] ?? 1)
    * (p.dry_air ? ML_DRY_AIR : 1)
    * (Number(p.ml_adjust) || 1);
  return Math.max(30, Math.round(ml / 10) * 10);
}

/** 'soak' (orchids: dunk the pot, drain) or 'pour' (a measured portion). */
export function wateringMode(groupKey) {
  return getCare().groups[groupKey]?.ml_mode === 'soak' ? 'soak' : 'pour';
}

// ---------------------------------------------------------------------------
// Learning from "still wet": a plant that keeps being wet at its due date gets a smaller portion and a
// longer interval; three calm cycles in a row bring both back toward the defaults.
// ---------------------------------------------------------------------------
const ML_STEP = 0.85;
const INTERVAL_STEP = 1.1;
const ML_MIN = 0.5;
const INTERVAL_MAX = 1.6;

/** Snooze counts per watering cycle, newest first: [{since, until, snoozes}] (cycle 0 = since the last watering). */
export function snoozeCycles(db, plantId, limit = 4) {
  const waterings = db.prepare('SELECT ts FROM waterings WHERE plant_id = ? ORDER BY ts DESC LIMIT ?').all(plantId, limit).map((w) => w.ts);
  const snoozes = db.prepare("SELECT ts FROM events WHERE plant_id = ? AND type = 'snooze' ORDER BY ts DESC LIMIT 50").all(plantId).map((e) => e.ts);
  const bounds = [null, ...waterings]; // null = now
  const cycles = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const until = bounds[i];
    const since = bounds[i + 1];
    cycles.push({ since, until, snoozes: snoozes.filter((t) => t > since && (until === null || t <= until)).length });
  }
  return cycles;
}

/**
 * Called after a snooze was logged. Tightens the plant's portion/interval when this cycle has two snoozes,
 * or this and the previous cycle each have one — at most once per cycle. Returns the new factors or null.
 */
export function learnFromSnooze(db, plantId) {
  const p = getPlant(db, plantId);
  if (!p) return null;
  const cycles = snoozeCycles(db, plantId, 2);
  const now = cycles[0]?.snoozes ?? 0;
  const prev = cycles[1]?.snoozes ?? 0;
  if (!(now >= 2 || (now >= 1 && prev >= 1))) return null;
  const lastWatering = cycles[0]?.since ?? '';
  const already = db.prepare("SELECT 1 FROM events WHERE plant_id = ? AND type = 'snooze' AND ts > ? AND json_extract(data, '$.adjusted') IS NOT NULL LIMIT 1").get(plantId, lastWatering);
  if (already) return null;
  const ml_adjust = Math.max(ML_MIN, Math.round((Number(p.ml_adjust) || 1) * ML_STEP * 100) / 100);
  const interval_adjust = Math.min(INTERVAL_MAX, Math.round((Number(p.interval_adjust) || 1) * INTERVAL_STEP * 100) / 100);
  if (ml_adjust === p.ml_adjust && interval_adjust === p.interval_adjust) return null;
  db.prepare('UPDATE plants SET ml_adjust = ?, interval_adjust = ? WHERE id = ?').run(ml_adjust, interval_adjust, plantId);
  // Mark the snooze that triggered it (shown in the timeline, and the once-per-cycle guard above).
  const latest = db.prepare("SELECT id, data FROM events WHERE plant_id = ? AND type = 'snooze' ORDER BY ts DESC LIMIT 1").get(plantId);
  if (latest) {
    let data = {};
    try { data = JSON.parse(latest.data) || {}; } catch { data = {}; }
    setEventData(db, latest.id, { ...data, adjusted: { ml_adjust, interval_adjust } });
  }
  return { ml_adjust, interval_adjust };
}

/** Called after a watering. Relaxes one step when the last three completed cycles had no snooze. Returns new factors or null. */
export function learnFromWatering(db, plantId) {
  const p = getPlant(db, plantId);
  if (!p || ((Number(p.ml_adjust) || 1) >= 1 && (Number(p.interval_adjust) || 1) <= 1)) return null;
  const cycles = snoozeCycles(db, plantId, 4).slice(1, 4); // completed cycles only
  if (cycles.length < 3 || cycles.some((c) => c.snoozes > 0)) return null;
  const ml_adjust = Math.min(1, Math.round((Number(p.ml_adjust) || 1) / ML_STEP * 100) / 100);
  const interval_adjust = Math.max(1, Math.round((Number(p.interval_adjust) || 1) / INTERVAL_STEP * 100) / 100);
  db.prepare('UPDATE plants SET ml_adjust = ?, interval_adjust = ? WHERE id = ?').run(ml_adjust, interval_adjust, plantId);
  return { ml_adjust, interval_adjust };
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
  const snooze = parseDateString(row.snoozed_until);
  let snoozed = false;
  if (snooze && last && snooze > parseDateString(next_due)) {
    next_due = toDateString(snooze);
    days_left = daysBetween(now, snooze);
    snoozed = true;
  }
  const g = c.groups[row.group_key] ?? c.groups.universal;
  const level = matchProfile(row).level;
  let profile = null;
  if (row.profile) { try { profile = JSON.parse(row.profile); } catch { profile = null; } }
  return {
    ...row,
    dry_air: !!row.dry_air,
    photo: row.photo ? `api/photo/${row.photo}` : null,
    photo_full: row.photo_full ? `api/photo/${row.photo_full}` : null,
    profile,
    interval,
    next_due,
    days_left,
    snoozed,
    water_ml: wateringMl(row),
    water_mode: wateringMode(row.group_key),
    ml_adjust: Number(row.ml_adjust) || 1,
    interval_adjust: Number(row.interval_adjust) || 1,
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

/** All plants of one user (or every plant when userId is null — used by the cron). */
export function listPlants(db, userId = null, now = new Date()) {
  const rows = userId === null
    ? db.prepare('SELECT * FROM plants').all()
    : db.prepare('SELECT * FROM plants WHERE user_id = ?').all(userId);
  return rows
    .map((r) => decoratePlant(r, now))
    .sort((a, b) => (a.days_left ?? -9999) - (b.days_left ?? -9999) || a.name.localeCompare(b.name, 'pl'));
}

/** Raw plant row; with userId only when the plant belongs to that user. */
export function getPlant(db, id, userId = null) {
  const row = db.prepare('SELECT * FROM plants WHERE id = ?').get(id) ?? null;
  if (row && userId !== null && row.user_id !== userId) return null;
  return row;
}

export function insertPlant(db, p) {
  const r = db.prepare(`
    INSERT INTO plants (name, species, common, genus, family, group_key, base_summer, base_winter,
                        pot_cm, pot_material, light, dry_air, photo, note, last_watered, user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.name, p.species, p.common, p.genus, p.family, p.group_key, p.base_summer, p.base_winter,
    p.pot_cm, p.pot_material, p.light, p.dry_air ? 1 : 0, p.photo, p.note, p.last_watered, p.user_id ?? null, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function updatePlant(db, id, p) {
  db.prepare(`
    UPDATE plants SET name=?, species=?, common=?, genus=?, family=?, group_key=?, base_summer=?, base_winter=?,
                      pot_cm=?, pot_material=?, light=?, dry_air=?, photo=?, photo_full=?, note=?, last_watered=?
    WHERE id=?
  `).run(p.name, p.species, p.common, p.genus, p.family, p.group_key, p.base_summer, p.base_winter,
    p.pot_cm, p.pot_material, p.light, p.dry_air ? 1 : 0, p.photo, p.photo_full ?? null, p.note, p.last_watered, id);
}

/** "Still wet": push the reminder to `days` after today or the current due date, whichever is later. */
export function snoozePlant(db, id, days, now = new Date()) {
  const p = decoratePlant(getPlant(db, id), now);
  const base = p.next_due && parseDateString(p.next_due) > now ? parseDateString(p.next_due) : now;
  const until = toDateString(addDays(base, days));
  db.prepare('UPDATE plants SET snoozed_until = ?, last_notified = NULL WHERE id = ?').run(until, id);
  return until;
}

/** Timestamp for a dated entry: now, or noon local time of the given date (so a date-only entry sorts sanely). */
export function tsForDate(date) { return wateringTs(date); }

function wateringTs(date) {
  if (!date || date === toDateString()) return new Date().toISOString();
  const d = parseDateString(date);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12).toISOString();
}

/** Marks the plant watered, appends to the history. Returns the new watering id (for undo). */
export function waterPlant(db, id, date = toDateString()) {
  db.prepare('UPDATE plants SET last_watered = ?, last_notified = NULL, snoozed_until = NULL WHERE id = ?').run(date, id);
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
export function deleteWatering(db, wateringId, userId = null) {
  const row = db.prepare('SELECT w.id, w.plant_id, p.user_id FROM waterings w JOIN plants p ON p.id = w.plant_id WHERE w.id = ?').get(wateringId);
  if (!row || (userId !== null && row.user_id !== userId)) return null;
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
  if (row.photo_full) fs.rmSync(path.join(PHOTO_DIR, row.photo_full), { force: true });
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
  return listPlants(db, null, now).filter((p) => p.last_watered && p.days_left !== null && p.days_left <= 0 && p.last_notified !== today);
}

export function listSubs(db, userId = null) {
  return userId === null
    ? db.prepare('SELECT endpoint, p256dh, auth, user_id FROM subs').all()
    : db.prepare('SELECT endpoint, p256dh, auth, user_id FROM subs WHERE user_id = ?').all(userId);
}

/** A browser subscription follows whoever is logged in on that device: re-subscribing moves it to that user. */
export function upsertSub(db, { endpoint, keys, user_id }) {
  db.prepare(`
    INSERT INTO subs (endpoint, p256dh, auth, user_id, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_id = excluded.user_id
  `).run(endpoint, keys.p256dh, keys.auth, user_id ?? null, new Date().toISOString());
}

export function deleteSub(db, endpoint, userId = null) {
  if (userId === null) db.prepare('DELETE FROM subs WHERE endpoint = ?').run(endpoint);
  else db.prepare('DELETE FROM subs WHERE endpoint = ? AND user_id = ?').run(endpoint, userId);
}

// ---------------------------------------------------------------------------
// Photos (data URL → file in data/photos)
// ---------------------------------------------------------------------------

export const PHOTO_MAX_BYTES = 600 * 1024;
export const PHOTO_FULL_MAX_BYTES = 2 * 1024 * 1024;
const PHOTO_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/** Validates and stores a data URL (thumbnail). Returns the stored file name. Throws Error with .status on bad input. */
export function storePhoto(dataUrl, plantId, maxBytes = PHOTO_MAX_BYTES) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl ?? '');
  if (!m) throw Object.assign(new Error('Nieobsługiwany format zdjęcia.'), { status: 400 });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > maxBytes) throw Object.assign(new Error(`Zdjęcie jest za duże (limit ${Math.round(maxBytes / 1024)} KB).`), { status: 413 });
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

/** Photo files are named "<plantId>-<hex>.<ext>", so ownership is the owning plant's. */
export function photoBelongsTo(db, name, userId) {
  const m = /^(\d+)-[a-f0-9]{8}\.(jpg|png|webp)$/.exec(name ?? '');
  if (!m) return false;
  return !!getPlant(db, Number(m[1]), userId);
}

// ---------------------------------------------------------------------------
// Auth: users, passwords (scrypt), sessions (random bearer tokens), per-user secrets (AES-GCM)
// ---------------------------------------------------------------------------

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const hash = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), 32, SCRYPT);
  const expected = Buffer.from(hashHex, 'hex');
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

/** Lower-case a-z, digits, dot, dash, underscore; 3–32 chars. Returns '' when invalid. */
export function normalizeLogin(login) {
  const l = String(login ?? '').trim().toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(l) ? l : '';
}

export const MIN_PASSWORD = 8;

export function createUser(db, { login, password, anthropic_key = null, anthropic_model = null, anthropic_effort = null, is_admin = false, invite_code = null }) {
  const r = db.prepare(`
    INSERT INTO users (login, pass_hash, anthropic_key, anthropic_model, anthropic_effort, is_admin, invite_code, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(login, hashPassword(password), anthropic_key, anthropic_model, anthropic_effort, is_admin ? 1 : 0, invite_code, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function setUserLang(db, id, lang) {
  db.prepare('UPDATE users SET lang = ? WHERE id = ?').run(lang, id);
}

export function setUseGlobalKey(db, id, on) {
  db.prepare('UPDATE users SET use_global_key = ? WHERE id = ?').run(on ? 1 : 0, id);
}

// Server-wide settings (admin panel): the global Anthropic key and its model/effort.
export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value === null || value === undefined) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

export function setAdmin(db, id, isAdmin) {
  db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(isAdmin ? 1 : 0, id);
}

export function countAdmins(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get().n);
}

/** Everything the admin panel lists: no secrets, just counts and activity. */
export function listUsersAdmin(db) {
  return db.prepare(`
    SELECT u.id, u.login, u.is_admin, u.invite_code, u.use_global_key, u.created_at,
           (u.anthropic_key IS NOT NULL) AS has_key,
           (SELECT COUNT(*) FROM plants p WHERE p.user_id = u.id) AS plants,
           (SELECT COUNT(*) FROM subs s WHERE s.user_id = u.id) AS subs,
           (SELECT MAX(last_seen) FROM sessions s WHERE s.user_id = u.id) AS last_seen
    FROM users u ORDER BY u.id
  `).all().map((r) => ({ ...r, is_admin: !!r.is_admin, has_key: !!r.has_key, use_global_key: !!r.use_global_key }));
}

/** Removes the user with all their plants (and photo files), subscriptions and sessions. */
export function deleteUser(db, id) {
  const u = getUser(db, id);
  if (!u) return false;
  for (const p of db.prepare('SELECT id FROM plants WHERE user_id = ?').all(id)) deletePlant(db, p.id);
  db.prepare('DELETE FROM subs WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id); // sessions cascade
  return true;
}

// Invite codes (admin panel). A code is valid while it is enabled and has uses left.
export function createInvite(db, { note = '', max_uses = 1, created_by = null } = {}) {
  const code = crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO invites (code, note, max_uses, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(code, note, Math.max(1, Number(max_uses) || 1), created_by, new Date().toISOString());
  return code;
}

export function listInvites(db) {
  return db.prepare(`
    SELECT i.*, (SELECT COUNT(*) FROM users u WHERE u.invite_code = i.code) AS used_by
    FROM invites i ORDER BY i.created_at DESC
  `).all().map((r) => ({ ...r, disabled: !!r.disabled }));
}

export function setInviteDisabled(db, code, disabled) {
  return db.prepare('UPDATE invites SET disabled = ? WHERE code = ?').run(disabled ? 1 : 0, code).changes > 0;
}

export function deleteInvite(db, code) {
  return db.prepare('DELETE FROM invites WHERE code = ?').run(code).changes > 0;
}

/** Marks one use of a valid code. Returns true when the code was accepted. */
export function consumeInvite(db, code) {
  const r = db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ? AND disabled = 0 AND uses < max_uses').run(String(code ?? ''));
  return r.changes > 0;
}

export function getUser(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) ?? null;
}

export function getUserByLogin(db, login) {
  return db.prepare('SELECT * FROM users WHERE login = ?').get(login) ?? null;
}

export function countUsers(db) {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
}

export function setUserPassword(db, id, password) {
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hashPassword(password), id);
}

/** Stores the (already encrypted) key; null removes it. Model/effort undefined = unchanged. */
export function setUserAi(db, id, { anthropic_key, anthropic_model, anthropic_effort }) {
  const u = getUser(db, id);
  db.prepare('UPDATE users SET anthropic_key = ?, anthropic_model = ?, anthropic_effort = ? WHERE id = ?').run(
    anthropic_key === undefined ? u.anthropic_key : anthropic_key,
    anthropic_model === undefined ? u.anthropic_model : anthropic_model,
    anthropic_effort === undefined ? u.anthropic_effort : anthropic_effort,
    id,
  );
}

// Sessions are stored as sha256(token): a leaked database does not yield usable bearer tokens.
// Rows written before hashing existed hold the raw token; sessionUser() upgrades them on first use.
export function sessionKey(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function createSession(db, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, created_at, last_seen) VALUES (?, ?, ?, ?)').run(sessionKey(token), userId, now, now);
  return token;
}

/** User row for a session token, or null. last_seen is bumped at most once an hour. */
export function sessionUser(db, token) {
  if (!token || typeof token !== 'string' || token.length !== 64) return null;
  const find = db.prepare('SELECT s.token, s.last_seen, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?');
  const key = sessionKey(token);
  let row = find.get(key);
  if (!row) {
    row = find.get(token); // legacy raw row → rewrite as hash
    if (!row) return null;
    db.prepare('UPDATE sessions SET token = ? WHERE token = ?').run(key, token);
  }
  if (Date.now() - Date.parse(row.last_seen) > 3600_000) {
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(new Date().toISOString(), key);
  }
  const { token: _t, last_seen: _l, ...user } = row;
  return user;
}

export function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ? OR token = ?').run(sessionKey(token), token);
}

export function deleteUserSessions(db, userId, keepToken = null) {
  if (keepToken) db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ? AND token <> ?').run(userId, sessionKey(keepToken), keepToken);
  else db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

// Photo URLs are loaded by <img>, which cannot send an Authorization header, so they carry a token in
// the query string — and query strings end up in web-server access logs. That token is therefore not
// the session but a short-lived HMAC that only grants photo reads: "<userId>.<expiry>.<sig>".
export const PHOTO_TOKEN_TTL_MS = 7 * 86400000;

export function photoToken(secret, userId, now = Date.now()) {
  const exp = now + PHOTO_TOKEN_TTL_MS;
  const body = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', secretKey(secret)).update('photo|' + body).digest('base64url');
  return `${body}.${sig}`;
}

/** userId for a valid, unexpired photo token; null otherwise. */
export function photoTokenUser(secret, token, now = Date.now()) {
  const m = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]{43})$/.exec(String(token ?? ''));
  if (!m) return null;
  if (Number(m[2]) < now) return null;
  const expected = crypto.createHmac('sha256', secretKey(secret)).update(`photo|${m[1]}.${m[2]}`).digest('base64url');
  return safeEqual(m[3], expected) ? Number(m[1]) : null;
}

/** A dummy verification that costs as much as a real one, so an unknown login takes as long as a wrong password. */
const DUMMY_HASH = hashPassword('greenly-timing-dummy');
export function verifyPasswordOrDummy(password, stored) {
  return stored ? verifyPassword(password, stored) : (verifyPassword(password, DUMMY_HASH), false);
}

export const MAX_PASSWORD = 200; // scrypt on unbounded input is a cheap way to burn CPU

/** Sessions unused for a year are dropped on start. */
export function pruneSessions(db, maxAgeDays = 365) {
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  db.prepare('DELETE FROM sessions WHERE last_seen < ?').run(cutoff);
}

// AES-256-GCM with a key derived from the server secret. Output: base64(iv | tag | ciphertext).
function secretKey(secret) {
  return crypto.createHash('sha256').update('greenly-secret|' + secret).digest();
}

export function encryptSecret(secret, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(secret), iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decryptSecret(secret, blob) {
  if (!blob) return null;
  try {
    const buf = Buffer.from(blob, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(secret), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** config.secretKey, or a random secret persisted in data/secret.key on first run. */
export function loadSecret(config, file = path.join(DATA_DIR, 'secret.key')) {
  if (config.secretKey) return String(config.secretKey);
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, secret + '\n', { mode: 0o600 });
  return secret;
}

/**
 * First start after the user system: create the admin from config.password and give it every row
 * that has no owner yet. Also adopts orphans on later starts (rows saved before the column existed).
 * Returns the admin id, or null when users already existed and nothing was orphaned.
 */
export function ensureAdmin(db, config, secret) {
  let adminId = null;
  if (countUsers(db) === 0) {
    adminId = createUser(db, {
      login: normalizeLogin(config.adminLogin) || 'admin',
      password: config.password,
      anthropic_key: config.anthropicApiKey ? encryptSecret(secret, config.anthropicApiKey) : null,
      anthropic_model: config.anthropicModel || null,
      anthropic_effort: config.anthropicEffort || null,
      is_admin: true,
    });
  }
  const first = db.prepare('SELECT id FROM users ORDER BY id LIMIT 1').get();
  if (first && countAdmins(db) === 0) setAdmin(db, first.id, true); // there is always an admin: the oldest account
  const owner = adminId ?? first?.id;
  if (owner) {
    db.prepare('UPDATE plants SET user_id = ? WHERE user_id IS NULL').run(owner);
    db.prepare('UPDATE subs SET user_id = ? WHERE user_id IS NULL').run(owner);
  }
  pruneSessions(db);
  return adminId;
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

// ---------------------------------------------------------------------------
// Care events (repotting, division, moving, feeding, …) — the plant's timeline
// ---------------------------------------------------------------------------
export const EVENT_TYPES = ['repot', 'split', 'move', 'fertilize', 'prune', 'treat', 'shower', 'bloom', 'growth', 'note', 'snooze'];

function decorateEvent(row) {
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data) || {}; } catch { data = {}; }
  return { ...row, data };
}

export function insertEvent(db, e) {
  const r = db.prepare('INSERT INTO events (plant_id, type, ts, note, data, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(e.plant_id, e.type, e.ts ?? new Date().toISOString(), e.note ?? '', JSON.stringify(e.data ?? {}), new Date().toISOString());
  return Number(r.lastInsertRowid);
}

export function setEventData(db, id, data) {
  db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(data ?? {}), id);
}

export function getEvent(db, id) {
  return decorateEvent(db.prepare('SELECT * FROM events WHERE id = ?').get(id));
}

export function listEvents(db, plantId, limit = 200) {
  return db.prepare('SELECT * FROM events WHERE plant_id = ? ORDER BY ts DESC LIMIT ?').all(plantId, limit).map(decorateEvent);
}

/** Deletes an event row (side effects such as a changed pot size are not reverted). Returns the plant id or null. */
export function deleteEvent(db, id, userId = null) {
  const row = db.prepare('SELECT e.plant_id, p.user_id FROM events e JOIN plants p ON p.id = e.plant_id WHERE e.id = ?').get(id);
  if (!row || (userId !== null && row.user_id !== userId)) return null;
  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  return Number(row.plant_id);
}
