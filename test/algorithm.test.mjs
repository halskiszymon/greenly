// node --test — interval algorithm, season curve, profile cascade, care.json integrity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROOT, intervalDays, seasonFactor, matchProfile, normalizeName, loadCare, MIN_DAYS, MAX_DAYS,
} from '../lib.js';

const care = loadCare();

test('care.json: every group referenced by species/genus/family exists', () => {
  const groups = Object.keys(care.groups);
  for (const [k, v] of Object.entries(care.species)) assert.ok(groups.includes(v.group), `species ${k} → ${v.group}`);
  for (const [k, v] of Object.entries(care.genus)) assert.ok(groups.includes(v), `genus ${k} → ${v}`);
  for (const [k, v] of Object.entries(care.family)) assert.ok(groups.includes(v), `family ${k} → ${v}`);
  for (const [k, g] of Object.entries(care.groups)) {
    assert.ok(g.label && g.note, `group ${k} needs label and note`);
    assert.ok(g.winter >= g.summer, `group ${k}: winter should be ≥ summer`);
  }
  assert.ok(Object.keys(care.species).length >= 35);
  assert.ok(Object.keys(care.genus).length >= 70);
  assert.ok(Object.keys(care.family).length >= 25);
  assert.ok(care.groups.universal);
});

test('care.json parses as strict JSON', () => {
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(ROOT, 'care.json'), 'utf8')));
});

test('season curve: 0 in mid-winter, ~1 in mid-summer', () => {
  assert.equal(seasonFactor(new Date(2026, 0, 1)), 0);
  assert.ok(seasonFactor(new Date(2026, 6, 2)) > 0.999);
  assert.ok(Math.abs(seasonFactor(new Date(2026, 3, 2)) - 0.5) < 0.02);
});

test('interval grows toward winter and stays within [2, 60]', () => {
  const plant = { base_summer: 9, base_winter: 14, pot_cm: 18, pot_material: 'ceramic', light: 'bright', dry_air: 0 };
  const jan = intervalDays(plant, new Date(2026, 0, 15));
  const apr = intervalDays(plant, new Date(2026, 3, 15));
  const jul = intervalDays(plant, new Date(2026, 6, 15));
  const oct = intervalDays(plant, new Date(2026, 9, 15));
  console.log(`  Monstera-like 18 cm ceramic bright: Jan=${jan} Apr=${apr} Jul=${jul} Oct=${oct}`);
  assert.ok(jul < apr && apr <= oct && oct < jan, 'Jul < Apr ≤ Oct < Jan');
  for (const d of [jan, apr, jul, oct]) assert.ok(d >= MIN_DAYS && d <= MAX_DAYS);
});

test('multipliers push in the expected direction', () => {
  const base = { base_summer: 9, base_winter: 14, pot_cm: 18, pot_material: 'ceramic', light: 'bright', dry_air: 0 };
  const when = new Date(2026, 3, 15);
  const ref = intervalDays(base, when);
  assert.ok(intervalDays({ ...base, pot_cm: 8 }, when) < ref);
  assert.ok(intervalDays({ ...base, pot_cm: 35 }, when) > ref);
  assert.ok(intervalDays({ ...base, pot_material: 'terracotta' }, when) < ref);
  assert.ok(intervalDays({ ...base, pot_material: 'cachepot' }, when) > ref);
  assert.ok(intervalDays({ ...base, light: 'sun' }, when) < ref);
  assert.ok(intervalDays({ ...base, light: 'dark' }, when) > ref);
  assert.ok(intervalDays({ ...base, dry_air: 1 }, when) < ref);
});

test('clamping to [2, 60]', () => {
  assert.equal(intervalDays({ base_summer: 2, base_winter: 3, pot_cm: 6, pot_material: 'terracotta', light: 'sun', dry_air: 1 }, new Date(2026, 6, 1)), MIN_DAYS);
  assert.equal(intervalDays({ base_summer: 18, base_winter: 45, pot_cm: 40, pot_material: 'cachepot', light: 'dark', dry_air: 0 }, new Date(2026, 0, 1)), MAX_DAYS);
});

test('cascade: species → genus → family → universal', () => {
  const sp = matchProfile({ species: 'Monstera deliciosa', genus: 'Monstera', family: 'Araceae' });
  assert.equal(sp.level, 'species');
  assert.equal(sp.group, 'aroid');
  assert.equal(sp.summer, 9);

  const ge = matchProfile({ species: 'Monstera obliqua', genus: 'Monstera', family: 'Araceae' });
  assert.equal(ge.level, 'genus');
  assert.equal(ge.group, 'aroid');
  assert.equal(ge.summer, care.groups.aroid.summer);

  const fa = matchProfile({ species: 'Amorphophallus konjac', genus: 'Amorphophallus', family: 'Araceae' });
  assert.equal(fa.level, 'family');
  assert.equal(fa.group, 'aroid');

  const un = matchProfile({ species: 'Nonexistus plantus', genus: 'Nonexistus', family: 'Madeupaceae' });
  assert.equal(un.level, 'universal');
  assert.equal(un.group, 'universal');
});

test('cascade from a manually typed name derives the genus', () => {
  assert.equal(matchProfile({ species: 'Calathea makoyana' }).level, 'genus');
  assert.equal(matchProfile({ species: 'calathea' }).group, 'marantaceae');
  assert.equal(matchProfile({ species: 'Alocasia × amazonica' }).level, 'species');
  assert.equal(matchProfile({ species: "Ficus elastica 'Robusta'" }).level, 'species');
  assert.equal(matchProfile({ species: 'Citrus x sinensis (L.) Osbeck' }).level, 'species');
});

test('normalizeName', () => {
  assert.equal(normalizeName('Alocasia × amazonica'), 'alocasia amazonica');
  assert.equal(normalizeName("Ficus elastica 'Tineke'"), 'ficus elastica');
  assert.equal(normalizeName('Citrus x sinensis (L.) Osbeck'), 'citrus sinensis');
  assert.equal(normalizeName('  MONSTERA   Deliciosa Liebm.'), 'monstera deliciosa');
});
