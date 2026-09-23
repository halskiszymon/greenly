// Every t('…') key in app.js and every data-t / data-t-html / data-t-attr key in index.html has an English entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { ROOT } from '../lib.js';

const read = (f) => fs.readFileSync(path.join(ROOT, 'public', f), 'utf8');

async function loadEn() {
  // i18n.js touches document/navigator at import time — stub the minimum.
  globalThis.document = { documentElement: {} };
  Object.defineProperty(globalThis, 'navigator', { value: { language: 'pl' }, configurable: true });
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const mod = await import('../public/i18n.js');
  return mod.EN;
}

test('all UI keys have English translations', async () => {
  const EN = await loadEn();
  const missing = new Set();
  const app = read('app.js');
  for (const m of app.matchAll(/\bt\('((?:[^'\\]|\\.)*)'/g)) {
    const key = m[1].replace(/\\'/g, "'");
    if (!(key in EN)) missing.add(key);
  }
  const html = read('index.html');
  for (const m of html.matchAll(/data-t(?:-html)?="([^"]+)"/g)) {
    const key = m[1].replace(/&quot;/g, '"');
    if (!(key in EN)) missing.add(key);
  }
  for (const m of html.matchAll(/(aria-label|alt)="([^"]+)"[^>]*data-t-attr="\1"/g)) if (!(m[2] in EN)) missing.add(m[2]);
  for (const m of html.matchAll(/data-t-attr="(aria-label|alt)"[^>]*\1="([^"]+)"/g)) if (!(m[2] in EN)) missing.add(m[2]);
  assert.deepEqual([...missing], [], 'missing English translations');
});

test('thinking texts and event labels are translated', async () => {
  const EN = await loadEn();
  const app = read('app.js');
  const block = app.slice(app.indexOf('const THINK_TEXTS = {'), app.indexOf('\n};', app.indexOf('const THINK_TEXTS = {')));
  const missing = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((k) => !(k in EN));
  assert.deepEqual(missing, []);
});
