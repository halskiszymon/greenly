// SQLite schema: fresh DB, migration of an old-schema DB, health check chains, cascade on delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, loadCare, insertPlant, insertCheck, snoozePlant, wateringMl, wateringMode, decoratePlant, getPlant, learnFromSnooze, learnFromWatering, snoozeCycles, intervalDays, getCheck, listChecks, checkChain, deletePlant, setProfile, listPlants, ensureColumn, waterPlant, deleteWatering, ensureWateringRow, listWaterings, backfillWaterings, insertEvent, listEvents, getEvent, deleteEvent, EVENT_TYPES } from '../lib.js';

loadCare();
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'greenly-db-')), 'test.sqlite');
const basePlant = { name: 'P', species: 'Monstera deliciosa', common: '', genus: 'Monstera', family: 'Araceae', group_key: 'aroid', base_summer: 9, base_winter: 14, pot_cm: 18, pot_material: 'ceramic', light: 'bright', dry_air: 0, photo: null, note: '', last_watered: null };

test('fresh database has all tables and the profile column', () => {
  const db = openDb(tmp());
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const t of ['plants', 'waterings', 'subs', 'health_checks']) assert.ok(tables.includes(t), t);
  assert.ok(db.prepare('PRAGMA table_info(plants)').all().some((c) => c.name === 'profile'));
});

test('an old-schema plants table gains the profile column on open', () => {
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE plants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, species TEXT NOT NULL DEFAULT '', common TEXT NOT NULL DEFAULT '', genus TEXT NOT NULL DEFAULT '', family TEXT NOT NULL DEFAULT '', group_key TEXT NOT NULL DEFAULT 'universal', base_summer REAL NOT NULL, base_winter REAL NOT NULL, pot_cm INTEGER NOT NULL DEFAULT 15, pot_material TEXT NOT NULL DEFAULT 'ceramic', light TEXT NOT NULL DEFAULT 'bright', dry_air INTEGER NOT NULL DEFAULT 0, photo TEXT, note TEXT NOT NULL DEFAULT '', last_watered TEXT, last_notified TEXT, created_at TEXT NOT NULL)`);
  old.prepare("INSERT INTO plants (name, base_summer, base_winter, created_at) VALUES ('Stara', 8, 13, 'x')").run();
  old.close();
  const db = openDb(file);
  assert.ok(db.prepare('PRAGMA table_info(plants)').all().some((c) => c.name === 'profile'));
  assert.equal(listPlants(db)[0].name, 'Stara');
  assert.equal(listPlants(db)[0].profile, null);
  ensureColumn(db, 'plants', 'profile', 'TEXT'); // idempotent
});

test('health checks: insert, chain, list, profile cache, cascade delete', () => {
  const db = openDb(tmp());
  const id = insertPlant(db, basePlant);
  const r1 = { status: 'sick', title: 't1', summary: '', findings: [], actions: [], watering: '', questions: ['q?'] };
  const c1 = insertCheck(db, { plant_id: id, mode: 'doctor', photos: ['a.jpg', 'b.jpg'], user_text: 'liście', result: r1, model: 'm', input_tokens: 1, output_tokens: 2 });
  assert.deepEqual(getCheck(db, c1).photos, ['api/photo/a.jpg', 'api/photo/b.jpg']);
  assert.equal(getCheck(db, c1).photo, 'api/photo/a.jpg');
  const c2 = insertCheck(db, { plant_id: id, parent_id: c1, mode: 'doctor', user_text: 'tak', result: { ...r1, questions: [] } });
  assert.equal(getCheck(db, c2).parent_id, c1);
  assert.deepEqual(getCheck(db, c1).result, r1);
  assert.deepEqual(checkChain(db, c2).map((c) => c.id), [c1, c2]);
  assert.equal(listChecks(db, id).length, 2);
  setProfile(db, id, JSON.stringify({ origin: 'Meksyk' }));
  assert.equal(listPlants(db)[0].profile.origin, 'Meksyk');
  assert.equal(deletePlant(db, id), true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_checks').get().n, 0);
});

test('watering undo: delete the latest row and last_watered falls back to the previous one', () => {
  const db = openDb(tmp());
  const id = insertPlant(db, { ...basePlant, last_watered: '2026-08-20' });
  ensureWateringRow(db, id, '2026-08-20');
  ensureWateringRow(db, id, '2026-08-20'); // idempotent per day
  assert.equal(listWaterings(db, id).length, 1);
  const w = waterPlant(db, id, '2026-09-04');
  assert.equal(listPlants(db)[0].last_watered, '2026-09-04');
  assert.equal(deleteWatering(db, w), id);
  assert.equal(listPlants(db)[0].last_watered, '2026-08-20');
  const [only] = listWaterings(db, id);
  deleteWatering(db, only.id);
  assert.equal(listPlants(db)[0].last_watered, null);
  assert.equal(deleteWatering(db, 9999), null);
});

test('backfill creates a history row for legacy plants with a date but no rows', () => {
  const db = openDb(tmp());
  const id = insertPlant(db, { ...basePlant, last_watered: '2026-08-01' });
  assert.equal(listWaterings(db, id).length, 0);
  assert.equal(backfillWaterings(db), 1);
  assert.equal(listWaterings(db, id).length, 1);
  assert.equal(backfillWaterings(db), 0);
});

test('events: insert, list newest first, parsed data, delete, cascade with the plant', () => {
  const db = openDb(tmp());
  const id = insertPlant(db, basePlant);
  assert.ok(EVENT_TYPES.includes('repot') && EVENT_TYPES.includes('split'));
  const e1 = insertEvent(db, { plant_id: id, type: 'repot', ts: '2026-09-01T12:00:00.000Z', data: { pot_cm_from: 15, pot_cm: 19, pot_material: 'plastic' } });
  const e2 = insertEvent(db, { plant_id: id, type: 'note', ts: '2026-09-10T12:00:00.000Z', note: 'nowy liść' });
  assert.deepEqual(listEvents(db, id).map((e) => e.id), [e2, e1]);
  assert.equal(getEvent(db, e1).data.pot_cm, 19);
  assert.equal(deleteEvent(db, e2), id);
  assert.equal(deleteEvent(db, e2), null);
  deletePlant(db, id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('still wet: snooze pushes next_due, watering clears it; water_ml scales with the pot and group', () => {
  const db = openDb(tmp());
  const now = new Date(2026, 8, 23);
  const id = insertPlant(db, { ...basePlant, last_watered: '2026-08-20' });
  const before = decoratePlant(getPlant(db, id), now);
  assert.ok(before.days_left < 0);
  assert.equal(before.snoozed, false);
  assert.equal(snoozePlant(db, id, 2, now), '2026-09-25'); // overdue → counts from today
  const after = decoratePlant(getPlant(db, id), now);
  assert.equal(after.next_due, '2026-09-25');
  assert.equal(after.days_left, 2);
  assert.equal(after.snoozed, true);
  waterPlant(db, id, '2026-09-23');
  assert.equal(decoratePlant(getPlant(db, id), now).snoozed, false);
  // not yet due → counts from the due date
  const due = decoratePlant(getPlant(db, id), now).next_due;
  assert.equal(snoozePlant(db, id, 1, now) > due, true);
  assert.equal(wateringMl({ pot_cm: 15, group_key: 'aroid' }), 290);
  assert.ok(wateringMl({ pot_cm: 15, group_key: 'cactus' }) < wateringMl({ pot_cm: 15, group_key: 'fern' }));
  assert.ok(wateringMl({ pot_cm: 30, group_key: 'universal' }) > wateringMl({ pot_cm: 15, group_key: 'universal' }));
  // pot and placement corrections: terracotta in the sun needs more, a cachepot in a dark corner less
  const base = wateringMl({ pot_cm: 15, group_key: 'aroid', pot_material: 'ceramic', light: 'bright' });
  assert.ok(wateringMl({ pot_cm: 15, group_key: 'aroid', pot_material: 'terracotta', light: 'sun', dry_air: 1 }) > base);
  assert.ok(wateringMl({ pot_cm: 15, group_key: 'aroid', pot_material: 'cachepot', light: 'dark' }) < base);
  assert.equal(wateringMl({ pot_cm: 15, group_key: 'aroid', ml_adjust: 0.5 }), 150);
  assert.equal(wateringMode('orchid'), 'soak');
  assert.equal(wateringMode('aroid'), 'pour');
});

test('learning: repeated "still wet" shrinks the portion and stretches the interval, calm cycles restore them', () => {
  const db = openDb(tmp());
  const id = insertPlant(db, { ...basePlant, last_watered: '2026-06-01' });
  const water = (d) => waterPlant(db, id, d);
  const snooze = (ts) => insertEvent(db, { plant_id: id, type: 'snooze', ts, data: { days: 2 } });
  water('2026-06-01');
  snooze('2026-06-10T10:00:00.000Z');
  assert.equal(learnFromSnooze(db, id), null); // one snooze in a cycle is normal
  snooze('2026-06-12T10:00:00.000Z');
  const l1 = learnFromSnooze(db, id);            // second in the same cycle → tighten
  assert.deepEqual(l1, { ml_adjust: 0.85, interval_adjust: 1.1 });
  assert.ok(getEvent(db, db.prepare("SELECT id FROM events WHERE plant_id = ? AND ts = ?").get(id, '2026-06-12T10:00:00.000Z').id).data.adjusted);
  snooze('2026-06-14T10:00:00.000Z');
  assert.equal(learnFromSnooze(db, id), null); // at most once per cycle
  const p = getPlant(db, id);
  assert.ok(intervalDays({ ...p }) > intervalDays({ ...p, interval_adjust: 1 }));
  assert.equal(decoratePlant(p).ml_adjust, 0.85);
  // previous cycle + this cycle each with one snooze also counts
  water('2026-06-20');
  snooze('2026-06-28T10:00:00.000Z');
  assert.deepEqual(learnFromSnooze(db, id), { ml_adjust: 0.72, interval_adjust: 1.21 });
  assert.deepEqual(snoozeCycles(db, id, 2).map((c) => c.snoozes), [1, 3]);
  // three completed calm cycles → relax one step
  water('2026-07-01'); assert.equal(learnFromWatering(db, id), null);
  water('2026-07-11'); assert.equal(learnFromWatering(db, id), null);
  water('2026-07-21'); assert.equal(learnFromWatering(db, id), null); // cycles: 07-11→07-21, 07-01→07-11, 06-20→07-01 (has a snooze)
  water('2026-07-31');
  assert.deepEqual(learnFromWatering(db, id), { ml_adjust: 0.85, interval_adjust: 1.1 });
  water('2026-08-10');
  assert.deepEqual(learnFromWatering(db, id), { ml_adjust: 1, interval_adjust: 1 });
  assert.equal(learnFromWatering(db, id), null); // nothing left to relax
});
