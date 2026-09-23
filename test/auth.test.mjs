// Users, sessions, per-user secrets and ownership checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  openDb, loadCare, insertPlant, getPlant, listPlants, waterPlant, deleteWatering, insertEvent, deleteEvent,
  upsertSub, listSubs, deleteSub, photoBelongsTo, duePlants,
  hashPassword, verifyPassword, normalizeLogin, createUser, getUser, getUserByLogin, countUsers, setUserAi, setUserPassword,
  createSession, sessionUser, deleteSession, deleteUserSessions, encryptSecret, decryptSecret, loadSecret, ensureAdmin,
  setAdmin, countAdmins, listUsersAdmin, deleteUser, createInvite, listInvites, setInviteDisabled, deleteInvite, consumeInvite,
} from '../lib.js';

loadCare();
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'greenly-auth-'));
const tmp = () => path.join(tmpDir(), 'test.sqlite');
const basePlant = { name: 'P', species: 'Monstera deliciosa', common: '', genus: 'Monstera', family: 'Araceae', group_key: 'aroid', base_summer: 9, base_winter: 14, pot_cm: 18, pot_material: 'ceramic', light: 'bright', dry_air: 0, photo: null, note: '', last_watered: null };

test('passwords: scrypt hash verifies, wrong password and garbage do not', () => {
  const h = hashPassword('correct horse');
  assert.ok(h.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse', h), true);
  assert.equal(verifyPassword('Correct horse', h), false);
  assert.equal(verifyPassword('x', 'nonsense'), false);
  assert.notEqual(hashPassword('a'), hashPassword('a')); // random salt
});

test('logins are normalized and validated', () => {
  assert.equal(normalizeLogin('  Szymon.H '), 'szymon.h');
  assert.equal(normalizeLogin('ab'), '');
  assert.equal(normalizeLogin('-abc'), '');
  assert.equal(normalizeLogin('ok_name-1'), 'ok_name-1');
  assert.equal(normalizeLogin('zażółć'), '');
});

test('secrets: AES-GCM round trip, wrong secret or tampering yields null', () => {
  const blob = encryptSecret('s1', 'sk-ant-abc');
  assert.equal(decryptSecret('s1', blob), 'sk-ant-abc');
  assert.equal(decryptSecret('s2', blob), null);
  assert.equal(decryptSecret('s1', blob.slice(0, -4) + 'AAAA'), null);
  assert.equal(decryptSecret('s1', null), null);
  assert.notEqual(encryptSecret('s1', 'x'), encryptSecret('s1', 'x')); // random iv
});

test('loadSecret prefers config.secretKey, otherwise persists one in a file', () => {
  const file = path.join(tmpDir(), 'secret.key');
  assert.equal(loadSecret({ secretKey: 'cfg' }, file), 'cfg');
  const a = loadSecret({}, file);
  assert.equal(a.length, 64);
  assert.equal(loadSecret({}, file), a);
});

test('sessions: token → user, logout, password change drops other sessions', () => {
  const db = openDb(tmp());
  const id = createUser(db, { login: 'ala', password: 'password123' });
  const t1 = createSession(db, id);
  const t2 = createSession(db, id);
  assert.equal(sessionUser(db, t1).login, 'ala');
  assert.equal(sessionUser(db, t1).token, undefined);
  assert.equal(sessionUser(db, 'nope'), null);
  assert.equal(sessionUser(db, 'a'.repeat(64)), null);
  deleteUserSessions(db, id, t1);
  assert.equal(sessionUser(db, t2), null);
  assert.ok(sessionUser(db, t1));
  deleteSession(db, t1);
  assert.equal(sessionUser(db, t1), null);
  setUserPassword(db, id, 'newpassword1');
  assert.equal(verifyPassword('newpassword1', getUserByLogin(db, 'ala').pass_hash), true);
});

test('ensureAdmin: first start creates the admin from config and adopts every existing row', () => {
  const file = tmp();
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE plants (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, species TEXT NOT NULL DEFAULT '', common TEXT NOT NULL DEFAULT '', genus TEXT NOT NULL DEFAULT '', family TEXT NOT NULL DEFAULT '', group_key TEXT NOT NULL DEFAULT 'universal', base_summer REAL NOT NULL, base_winter REAL NOT NULL, pot_cm INTEGER NOT NULL DEFAULT 15, pot_material TEXT NOT NULL DEFAULT 'ceramic', light TEXT NOT NULL DEFAULT 'bright', dry_air INTEGER NOT NULL DEFAULT 0, photo TEXT, note TEXT NOT NULL DEFAULT '', last_watered TEXT, last_notified TEXT, created_at TEXT NOT NULL);
    CREATE TABLE subs (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO plants (name, base_summer, base_winter, created_at) VALUES ('Stara', 8, 13, 'x');
    INSERT INTO subs VALUES ('https://push/1', 'p', 'a', 'x');`);
  old.close();
  const db = openDb(file);
  const config = { password: 'admin-pass-1', adminLogin: 'Szymon', anthropicApiKey: 'sk-ant-old', anthropicModel: 'claude-sonnet-5' };
  const adminId = ensureAdmin(db, config, 'secret');
  assert.ok(adminId);
  const admin = getUserByLogin(db, 'szymon');
  assert.equal(admin.is_admin, 1);
  assert.equal(verifyPassword('admin-pass-1', admin.pass_hash), true);
  assert.equal(decryptSecret('secret', admin.anthropic_key), 'sk-ant-old');
  assert.equal(admin.anthropic_model, 'claude-sonnet-5');
  assert.equal(listPlants(db, adminId).length, 1);
  assert.equal(listSubs(db, adminId).length, 1);
  // second start: idempotent, no new user
  assert.equal(ensureAdmin(db, config, 'secret'), null);
  assert.equal(countUsers(db), 1);
  // a row that somehow lost its owner is adopted by the first user
  db.prepare("INSERT INTO plants (name, base_summer, base_winter, created_at) VALUES ('Sierota', 8, 13, 'x')").run();
  ensureAdmin(db, config, 'secret');
  assert.equal(listPlants(db, adminId).length, 2);
});

test('ownership: plants, waterings, events, photos and subs are scoped to the user', () => {
  const db = openDb(tmp());
  const ala = createUser(db, { login: 'ala', password: 'password123' });
  const ola = createUser(db, { login: 'ola', password: 'password123' });
  const pa = insertPlant(db, { ...basePlant, name: 'Ali', user_id: ala, photo: null });
  const po = insertPlant(db, { ...basePlant, name: 'Oli', user_id: ola });
  assert.deepEqual(listPlants(db, ala).map((p) => p.name), ['Ali']);
  assert.deepEqual(listPlants(db).map((p) => p.name).sort(), ['Ali', 'Oli']);
  assert.ok(getPlant(db, pa, ala));
  assert.equal(getPlant(db, pa, ola), null);
  const w = waterPlant(db, pa, '2026-09-01');
  assert.equal(deleteWatering(db, w, ola), null);
  assert.equal(deleteWatering(db, w, ala), pa);
  const e = insertEvent(db, { plant_id: po, type: 'note', note: 'x' });
  assert.equal(deleteEvent(db, e, ala), null);
  assert.equal(deleteEvent(db, e, ola), po);
  assert.equal(photoBelongsTo(db, `${pa}-0123abcd.jpg`, ala), true);
  assert.equal(photoBelongsTo(db, `${pa}-0123abcd.jpg`, ola), false);
  assert.equal(photoBelongsTo(db, '../etc/passwd', ala), false);
  upsertSub(db, { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' }, user_id: ala });
  upsertSub(db, { endpoint: 'https://push/x', keys: { p256dh: 'p', auth: 'a' }, user_id: ola }); // same device, new login
  assert.equal(listSubs(db, ala).length, 0);
  assert.equal(listSubs(db, ola).length, 1);
  deleteSub(db, 'https://push/x', ala); // not hers
  assert.equal(listSubs(db, ola).length, 1);
  deleteSub(db, 'https://push/x', ola);
  assert.equal(listSubs(db).length, 0);
  // due plants carry user_id so the cron can group them
  waterPlant(db, po, '2026-01-01');
  assert.equal(duePlants(db).find((p) => p.id === po).user_id, ola);
  setUserAi(db, ala, { anthropic_key: 'enc', anthropic_model: undefined, anthropic_effort: 'high' });
  const u = getUserByLogin(db, 'ala');
  assert.equal(u.anthropic_key, 'enc');
  assert.equal(u.anthropic_effort, 'high');
  assert.equal(u.anthropic_model, null);
});

test('there is always an admin: a pre-existing users table without one promotes the oldest account', () => {
  const db = openDb(tmp());
  const a = createUser(db, { login: 'first', password: 'password123' });
  createUser(db, { login: 'second', password: 'password123' });
  assert.equal(countAdmins(db), 0);
  ensureAdmin(db, { password: 'x' }, 's');
  assert.equal(countAdmins(db), 1);
  assert.equal(getUserByLogin(db, 'first').is_admin, 1);
  setAdmin(db, a, false);
  assert.equal(countAdmins(db), 0);
});

test('invites: single-use codes, disable, delete, listing with usage', () => {
  const db = openDb(tmp());
  const admin = createUser(db, { login: 'admin', password: 'password123', is_admin: true });
  const code = createInvite(db, { note: 'dla Oli', max_uses: 2, created_by: admin });
  assert.equal(consumeInvite(db, code), true);
  createUser(db, { login: 'ola', password: 'password123', invite_code: code });
  assert.equal(consumeInvite(db, code), true);
  assert.equal(consumeInvite(db, code), false); // exhausted
  assert.equal(consumeInvite(db, 'nope'), false);
  const [inv] = listInvites(db);
  assert.equal(inv.uses, 2);
  assert.equal(inv.used_by, 1);
  assert.equal(inv.note, 'dla Oli');
  const c2 = createInvite(db, { max_uses: 5 });
  assert.equal(setInviteDisabled(db, c2, true), true);
  assert.equal(consumeInvite(db, c2), false);
  setInviteDisabled(db, c2, false);
  assert.equal(consumeInvite(db, c2), true);
  assert.equal(deleteInvite(db, c2), true);
  assert.equal(deleteInvite(db, c2), false);
  assert.equal(listInvites(db).length, 1);
});

test('admin listing and deleting a user removes their plants, subs and sessions', () => {
  const db = openDb(tmp());
  const admin = createUser(db, { login: 'admin', password: 'password123', is_admin: true });
  const ola = createUser(db, { login: 'ola', password: 'password123' });
  insertPlant(db, { ...basePlant, user_id: ola });
  upsertSub(db, { endpoint: 'https://push/o', keys: { p256dh: 'p', auth: 'a' }, user_id: ola });
  const t = createSession(db, ola);
  const rows = listUsersAdmin(db);
  assert.deepEqual(rows.map((r) => [r.login, r.is_admin, r.plants, r.subs]), [['admin', true, 0, 0], ['ola', false, 1, 1]]);
  assert.ok(rows[1].last_seen);
  assert.equal(rows[0].has_key, false);
  assert.equal(deleteUser(db, ola), true);
  assert.equal(deleteUser(db, ola), false);
  assert.equal(listPlants(db).length, 0);
  assert.equal(listSubs(db).length, 0);
  assert.equal(sessionUser(db, t), null);
  assert.equal(countUsers(db), 1);
  assert.ok(getUser(db, admin));
});
