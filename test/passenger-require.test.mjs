// Plesk/Passenger starts the app with require(startupFile). Node rejects require() on an
// ESM graph containing top-level await, so this test boots server.js exactly that way.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../lib.js';

test('server.js can be loaded with require() (no top-level await) and starts listening', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'greenly-'));
  const cfg = path.join(dir, 'config.js');
  fs.writeFileSync(cfg, "export default { password: 'x', timezone: 'UTC' };\n");
  const child = spawn(process.execPath, ['-e', "require(process.argv[1])", path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', GREENLY_CONFIG: cfg },
  });
  let out = '';
  const result = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), 8000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('listening')) { clearTimeout(timer); resolve('listening'); } });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => { clearTimeout(timer); resolve(`exit ${code}`); });
  });
  child.kill();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result, 'listening', out);
});
