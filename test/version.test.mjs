// One version string in three places: APP_VERSION in app.js, ?v= on the assets in index.html, CACHE in sw.js.
// A deploy with a mismatch would serve stale CSS/JS from browser or service-worker caches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../lib.js';

const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

test('app.js, index.html and sw.js agree on the version', () => {
  const app = /APP_VERSION = '([^']+)'/.exec(read('app.js'))?.[1];
  assert.ok(app, 'APP_VERSION missing in app.js');
  const html = read('index.html');
  for (const asset of ['styles.css', 'app.js']) {
    const m = new RegExp(`\\./${asset.replace('.', '\\.')}\\?v=([^"]+)"`).exec(html);
    assert.equal(m?.[1], app, `index.html: ${asset} must be referenced with ?v=${app}`);
  }
  const sw = /CACHE = 'greenly-shell-v([^']+)'/.exec(read('sw.js'))?.[1];
  assert.equal(sw, app, 'sw.js CACHE version must match APP_VERSION');
});
