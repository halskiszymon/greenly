// Guards the duplicated formula: public/app.js estimate() must agree with lib.js intervalDays().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, intervalDays, MATERIAL_FACTOR, LIGHT_FACTOR } from '../lib.js';

// app.js touches the DOM at module scope, so extract estimate() and its helpers by source slicing.
const src = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const start = src.indexOf('const MATERIAL_FACTOR');
const end = src.indexOf('// ---', start);
const snippet = src.slice(start, end).replace('export function estimate', 'function estimate');
const estimate = new Function(`${snippet}; return estimate;`)();

test('estimate() in app.js matches intervalDays() in lib.js on a grid of inputs', () => {
  const dates = [new Date(2026, 0, 10), new Date(2026, 3, 10), new Date(2026, 6, 10), new Date(2026, 9, 10)];
  const bases = [[3, 5], [8, 13], [18, 45]];
  let checked = 0;
  for (const when of dates) for (const [s, w] of bases) for (const pot_cm of [8, 12, 18, 26, 36])
    for (const pot_material of Object.keys(MATERIAL_FACTOR)) for (const light of Object.keys(LIGHT_FACTOR)) for (const dry_air of [0, 1]) {
      const p = { base_summer: s, base_winter: w, pot_cm, pot_material, light, dry_air };
      assert.equal(estimate(p, when), intervalDays(p, when), JSON.stringify({ ...p, when }));
      checked++;
    }
  assert.ok(checked > 1000);
});
