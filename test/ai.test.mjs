// ai.js — request shape and response handling with a fake Anthropic client (no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHealth, describeSpecies, buildHealthMessages, HEALTH_SCHEMA, AiError } from '../ai.js';
import { loadCare, groupCare } from '../lib.js';

loadCare();
const plant = {
  id: 1, name: 'Monstera z salonu', species: 'Monstera deliciosa', common: 'monstera', group_key: 'aroid',
  match_level: 'species', pot_cm: 18, pot_material: 'plastic', light: 'bright', dry_air: false,
  interval: 10, last_watered: '2026-08-30', note: 'okno wschodnie',
};
const care = groupCare('aroid');
const image = { data: 'AAAA', mediaType: 'image/jpeg' };
const config = { anthropicModel: 'claude-opus-5', anthropicEffort: 'medium' };

function fakeClient(reply, capture = {}) {
  return { beta: { messages: { create: async (params) => { capture.params = params; return typeof reply === 'function' ? reply(params) : reply; } } } };
}
const okResult = { status: 'watch', title: 'Lekkie przelanie', summary: 's', findings: [{ observation: 'o', likely_cause: 'c', confidence: 'medium' }], actions: ['a'], watering: 'w', questions: [] };
const okReply = { stop_reason: 'end_turn', model: 'claude-opus-5', usage: { input_tokens: 1500, output_tokens: 300 }, content: [{ type: 'text', text: JSON.stringify(okResult) }] };

test('analyzeHealth sends image + context and asks for the JSON schema', async () => {
  const cap = {};
  const { result, usage } = await analyzeHealth(fakeClient(okReply, cap), config, { plant, care, mode: 'doctor', userText: 'żółkną liście', image, today: new Date(2026, 8, 4) });
  assert.deepEqual(result, okResult);
  assert.equal(usage.input_tokens, 1500);
  const p = cap.params;
  assert.equal(p.model, 'claude-opus-5');
  assert.equal(p.fallbacks, 'default');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.output_config.effort, 'medium');
  assert.equal(p.output_config.format.type, 'json_schema');
  assert.equal(p.output_config.format.schema, HEALTH_SCHEMA);
  assert.equal(p.messages.length, 1);
  assert.equal(p.messages[0].content[0].type, 'image');
  assert.equal(p.messages[0].content[0].source.media_type, 'image/jpeg');
  const text = p.messages[0].content[1].text;
  assert.match(text, /Monstera deliciosa/);
  assert.match(text, /plastik z otworami/);
  assert.match(text, /5 dni temu/);
  assert.match(text, /żółkną liście/);
  assert.match(text, /DOKTOR/);
  assert.match(p.system, /po polsku/);
});

test('follow-up chain alternates assistant JSON and user answers', () => {
  const chain = [
    { user_text: 'żółkną liście', result: { ...okResult, questions: ['Czy podłoże jest mokre?'] } },
    { user_text: 'tak, mokre', result: { ...okResult, questions: ['Czy doniczka ma otwory?'] } },
  ];
  const { messages } = buildHealthMessages({ plant, care, mode: 'doctor', userText: 'ma otwory', image, chain });
  assert.equal(messages.length, 5);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  assert.match(messages[0].content[1].text, /żółkną liście/);
  assert.match(messages[2].content, /tak, mokre/);
  assert.match(messages[4].content, /ma otwory/);
  assert.equal(JSON.parse(messages[3].content).questions[0], 'Czy doniczka ma otwory?');
});

test('checkup mode leaves questions empty in the instructions and includes remarks', () => {
  const { messages } = buildHealthMessages({ plant, care, mode: 'checkup', userText: 'nowe liście', image });
  assert.match(messages[0].content[1].text, /KONTROLA/);
  assert.match(messages[0].content[1].text, /nowe liście/);
});

test('refusal, truncation and unparsable output become AiError 502', async () => {
  for (const reply of [
    { stop_reason: 'refusal', content: [], usage: {} },
    { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }], usage: {} },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} },
  ]) {
    await assert.rejects(
      analyzeHealth(fakeClient(reply), config, { plant, care, mode: 'checkup', userText: '', image }),
      (e) => e instanceof AiError && e.status === 502,
    );
  }
});

test('describeSpecies uses the profile schema and no image', async () => {
  const cap = {};
  const profile = { origin: 'o', light: 'l', watering: 'w', humidity: 'h', temperature: 't', soil_and_pot: 's', fertilizing: 'f', repotting: 'r', pets: 'p', common_problems: ['x'], placement: 'pl' };
  const { result } = await describeSpecies(fakeClient({ ...okReply, content: [{ type: 'text', text: JSON.stringify(profile) }] }, cap), {}, { plant, care });
  assert.deepEqual(result, profile);
  assert.equal(cap.params.model, 'claude-opus-5');
  assert.equal(typeof cap.params.messages[0].content, 'string');
  assert.ok(cap.params.output_config.format.schema.required.includes('pets'));
});
