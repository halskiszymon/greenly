// SQLite schema: fresh DB, migration of an old-schema DB, health check chains, cascade on delete.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb, loadCare, insertPlant, insertCheck, getCheck, listChecks, checkChain, deletePlant, setProfile, listPlants, ensureColumn } from '../lib.js';

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
  const c1 = insertCheck(db, { plant_id: id, mode: 'doctor', photo: null, user_text: 'liście', result: r1, model: 'm', input_tokens: 1, output_tokens: 2 });
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
