// HTTP-level checks against a real server process: auth, ownership (IDOR), admin gate, rate limits,
// security headers, body limits. Boots server.js on a random port with a temp config and data dir.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib.js';

let child;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenly-api-'));
  const cfg = path.join(dir, 'config.js');
  fs.writeFileSync(cfg, "export default { password: 'admin-pass-1', adminLogin: 'admin', inviteCode: 'invite-1', timezone: 'UTC', cronSecret: 'cron-1' };\n");
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', GREENLY_CONFIG: cfg, GREENLY_DATA: path.join(dir, 'data'), GREENLY_FAKE_AI: '1', NODE_OPTIONS: '--no-warnings' },
  });
  let out = '';
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 10000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /listening on (\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.stderr.on('data', (d) => { out += d; });
  });
});

after(() => {
  child?.kill();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(action, { json, token, method, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) { h['content-type'] = 'application/json'; body = JSON.stringify(json); }
  if (raw !== undefined) { h['content-type'] = 'application/json'; body = raw; }
  const res = await fetch(`${base}/api/${action}`, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: h, body });
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers };
}

const PLANT = { name: 'Monstera', species: 'Monstera deliciosa', pot_cm: 15, pot_material: 'ceramic', light: 'bright', last_watered: '2026-01-01' };

test('admin from config can log in; wrong password and unknown login look identical', async () => {
  const ok = await call('login', { json: { login: 'admin', password: 'admin-pass-1' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.user.is_admin, true);
  assert.match(ok.data.token, /^[a-f0-9]{64}$/);
  const bad = await call('login', { json: { login: 'admin', password: 'nope' } });
  const unknown = await call('login', { json: { login: 'ghost', password: 'nope' } });
  assert.equal(bad.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(bad.data.error, unknown.data.error);
  const legacy = await call('login', { json: { password: 'admin-pass-1' } }); // no login field → no admin shortcut
  assert.equal(legacy.status, 401);
});

test('security headers on API responses; no HSTS over plain http', async () => {
  const r = await call('version');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.ok(r.headers.get('referrer-policy'));
  assert.equal(r.headers.get('strict-transport-security'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const fwd = await call('version', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(fwd.headers.get('strict-transport-security'), /max-age=/);
  const html = await fetch(`${base}/`);
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
});

test('registration needs a valid invite; users only see their own plants (IDOR)', async () => {
  const noInvite = await call('register', { json: { login: 'ala', password: 'password123', invite: 'wrong' } });
  assert.equal(noInvite.status, 403);
  const ala = (await call('register', { json: { login: 'ala', password: 'password123', invite: 'invite-1' } })).data;
  const ola = (await call('register', { json: { login: 'ola', password: 'password123', invite: 'invite-1' } })).data;
  assert.ok(ala.token && ola.token);
  const saved = await call('save', { token: ala.token, json: PLANT });
  assert.equal(saved.status, 200);
  const id = saved.data.plant.id;
  assert.equal((await call(`plant/${id}`, { token: ala.token })).status, 200);
  assert.equal((await call(`plant/${id}`, { token: ola.token })).status, 404);
  assert.equal((await call('water', { token: ola.token, json: { id } })).status, 404);
  assert.equal((await call('delete', { token: ola.token, json: { id } })).status, 404);
  assert.equal((await call('save', { token: ola.token, json: { ...PLANT, id, name: 'hijack' } })).status, 404);
  assert.equal((await call('event', { token: ola.token, json: { plant_id: id, type: 'note', note: 'x' } })).status, 404);
  assert.equal((await call('postpone', { token: ola.token, json: { id, days: 1 } })).status, 404);
  const mine = await call('plants', { token: ola.token });
  assert.equal(mine.data.plants.length, 0);
  assert.ok(mine.data.user.photo_token);
  // session token in the query string is not accepted anywhere
  const q = await fetch(`${base}/api/plants?t=${ala.token}`);
  assert.equal(q.status, 401);
  // ala cannot touch admin endpoints
  assert.equal((await call('admin', { token: ala.token })).status, 403);
  assert.equal((await call('adminuser', { token: ala.token, json: { id: 1, action: 'delete' } })).status, 403);
  // unauthenticated
  assert.equal((await call('plants')).status, 401);
  assert.equal((await call('logout', { method: 'POST' })).status, 401);
});

test('photos: photo token grants only that user, session token in the URL does not', async () => {
  const ala = (await call('login', { json: { login: 'ala', password: 'password123' } })).data;
  const ola = (await call('login', { json: { login: 'ola', password: 'password123' } })).data;
  const plants = (await call('plants', { token: ala.token })).data.plants;
  const id = plants[0].id;
  // 1×1 PNG thumbnail
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const saved = await call('save', { token: ala.token, json: { ...PLANT, id, photo: png } });
  assert.equal(saved.status, 200);
  const url = saved.data.plant.photo; // api/photo/<name>
  const name = url.split('/').pop();
  assert.equal((await fetch(`${base}/api/photo/${name}?t=${ala.user.photo_token}`)).status, 200);
  assert.equal((await fetch(`${base}/api/photo/${name}?t=${ola.user.photo_token}`)).status, 404);
  assert.equal((await fetch(`${base}/api/photo/${name}?t=${ala.token}`)).status, 401);
  assert.equal((await fetch(`${base}/api/photo/${name}`)).status, 401);
  assert.equal((await fetch(`${base}/api/photo/${name}`, { headers: { authorization: `Bearer ${ala.token}` } })).status, 200);
  assert.equal((await fetch(`${base}/api/photo/..%2F..%2Fconfig.js?t=${ala.user.photo_token}`)).status, 404);
});

test('body limits and malformed input do not leak details', async () => {
  const big = await call('login', { raw: '{"login":"' + 'a'.repeat(20000) + '"}' });
  assert.equal(big.status, 413);
  const badJson = await call('login', { raw: '{nope' });
  assert.equal(badJson.status, 400);
  const ala = (await call('login', { json: { login: 'ala', password: 'password123' } })).data;
  const longPw = await call('register', { json: { login: 'ela', password: 'x'.repeat(300), invite: 'invite-1' } });
  assert.equal(longPw.status, 400);
  const nope = await call('nope', { token: ala.token });
  assert.equal(nope.status, 404);
  assert.deepEqual(Object.keys(nope.data), ['error']);
});

test('logout deletes the session server-side', async () => {
  const ala = (await call('login', { json: { login: 'ala', password: 'password123' } })).data;
  assert.equal((await call('plants', { token: ala.token })).status, 200);
  assert.equal((await call('logout', { token: ala.token, json: {} })).status, 200);
  assert.equal((await call('plants', { token: ala.token })).status, 401);
});

test('cron: secret in header or query, rate limited', async () => {
  assert.equal((await call('cron')).status, 401);
  assert.equal((await call('cron', { headers: { 'x-cron-secret': 'cron-1' } })).status, 200);
  assert.equal((await fetch(`${base}/api/cron?secret=cron-1`)).status, 200);
});

test('login is rate limited per IP after 10 failures', async () => {
  let last;
  for (let i = 0; i < 12; i++) last = await call('login', { json: { login: 'ghost', password: 'nope' }, headers: { 'x-forwarded-for': '203.0.113.9' } });
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
  // another client is unaffected
  const other = await call('login', { json: { login: 'ala', password: 'password123' }, headers: { 'x-forwarded-for': '203.0.113.10' } });
  assert.equal(other.status, 200);
});
