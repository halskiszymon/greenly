// ai.js — Claude integration: plant health check-ups, "doctor" diagnosis and species profiles.
// One request per analysis (image + structured JSON output); no agent loop.
// The API key never leaves the server; the browser only talks to /api/health and /api/profile.

import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5';
export const DEFAULT_EFFORT = 'medium';

export class AiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function createClient(config) {
  if (!config.anthropicApiKey) return null;
  return new Anthropic({ apiKey: config.anthropicApiKey });
}

const MATERIAL_LABEL = {
  terracotta: 'terakota (niepolewana glina)',
  ceramic: 'ceramika szkliwiona',
  plastic: 'plastik z otworami odpływowymi',
  cachepot: 'naczynie bez otworów odpływowych',
};
const LIGHT_LABEL = {
  sun: 'pełne słońce',
  bright: 'jasno, bez ostrego słońca',
  partial: 'półcień, 1–2 m od okna',
  dark: 'ciemny kąt, daleko od okna',
};

// ---------------------------------------------------------------------------
// JSON schemas for structured outputs (additionalProperties: false is required)
// ---------------------------------------------------------------------------

export const HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['healthy', 'watch', 'sick'] },
    title: { type: 'string' },
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          observation: { type: 'string' },
          likely_cause: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['observation', 'likely_cause', 'confidence'],
        additionalProperties: false,
      },
    },
    actions: { type: 'array', items: { type: 'string' } },
    watering: { type: 'string' },
    questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['status', 'title', 'summary', 'findings', 'actions', 'watering', 'questions'],
  additionalProperties: false,
};

export const PROFILE_SCHEMA = {
  type: 'object',
  properties: {
    origin: { type: 'string' },
    light: { type: 'string' },
    watering: { type: 'string' },
    humidity: { type: 'string' },
    temperature: { type: 'string' },
    soil_and_pot: { type: 'string' },
    fertilizing: { type: 'string' },
    repotting: { type: 'string' },
    pets: { type: 'string' },
    common_problems: { type: 'array', items: { type: 'string' } },
    placement: { type: 'string' },
  },
  required: ['origin', 'light', 'watering', 'humidity', 'temperature', 'soil_and_pot', 'fertilizing', 'repotting', 'pets', 'common_problems', 'placement'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// prompts
// ---------------------------------------------------------------------------

const SYSTEM_HEALTH = `Jesteś doświadczonym ogrodnikiem specjalizującym się w roślinach doniczkowych w polskich mieszkaniach.
Oceniasz stan rośliny na podstawie zdjęcia i podanych warunków. Odpowiadasz po polsku, konkretnie i praktycznie.
Zasady:
- Opisuj tylko to, co faktycznie widać na zdjęciu, i łącz to z warunkami (doniczka, światło, podlewanie, pora roku).
- Nie zgaduj chorób, których nie widać. Każdemu spostrzeżeniu przypisz uczciwą pewność.
- Ze zdjęcia nie widać korzeni ani wilgotności podłoża — gdy to istotne, powiedz wprost, co sprawdzić palcem lub w doniczce.
- Zalecenia mają być wykonalne w domu, uporządkowane od najważniejszego. Bez ogólników w stylu „dbaj o roślinę”.
- Pole "watering": jedno–dwa zdania o tym, czy obecny rytm podlewania pasuje; pusty string, jeśli nie ma uwag.
- Pole "status": healthy = w porządku, watch = drobne sygnały do obserwacji, sick = wyraźny problem wymagający działania.`;

const SYSTEM_PROFILE = `Jesteś doświadczonym ogrodnikiem. Piszesz zwięzły, praktyczny profil pielęgnacyjny rośliny doniczkowej dla osoby mieszkającej w Polsce (ogrzewanie zimą, krótkie dni, suche powietrze).
Odpowiadasz po polsku. Każde pole to 1–3 zdania, konkretnie: liczby, kierunki okien, częstotliwości. Pole "pets": czy roślina jest trująca dla kotów/psów. Pole "common_problems": 3–5 najczęstszych problemów w formie „objaw → przyczyna”.`;

function daysSince(dateStr, today) {
  if (!dateStr) return null;
  const a = new Date(dateStr);
  return Math.round((today - a) / 86400000);
}

/** Plain-text context block shared by both analyses. */
export function plantContext(plant, care, today = new Date()) {
  const lines = [
    `Nazwa własna: ${plant.name}`,
    `Gatunek: ${plant.species || 'nieznany'}${plant.common ? ` (${plant.common})` : ''}`,
    `Grupa pielęgnacyjna: ${care.label}${plant.match_level ? ` — dopasowanie na poziomie: ${plant.match_level}` : ''}`,
    `Porada dla grupy: ${care.note}`,
    `Doniczka: ${plant.pot_cm} cm, ${MATERIAL_LABEL[plant.pot_material] ?? plant.pot_material}`,
    `Światło: ${LIGHT_LABEL[plant.light] ?? plant.light}`,
    `Suche powietrze / grzejnik w pobliżu: ${plant.dry_air ? 'tak' : 'nie'}`,
    `Wyliczony interwał podlewania: co ${plant.interval} dni`,
  ];
  const since = daysSince(plant.last_watered, today);
  lines.push(since === null ? 'Ostatnie podlanie: brak danych' : `Ostatnie podlanie: ${since} dni temu (${plant.last_watered})`);
  if (plant.note) lines.push(`Notatka właściciela: ${plant.note}`);
  lines.push(`Data: ${today.toISOString().slice(0, 10)}`);
  return lines.join('\n');
}

function imageBlock(image) {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } };
}

/**
 * @param {object} o
 * @param {'checkup'|'doctor'} o.mode
 * @param {string} o.userText   user's description (doctor) or remarks (checkup); for a follow-up: the answers
 * @param {{data:string, mediaType:string}} o.image   root photo (base64)
 * @param {Array<{user_text:string, result:object}>} o.chain   previous rounds, oldest first (empty for a new check)
 */
export function buildHealthMessages({ plant, care, mode, userText, image, chain = [], today = new Date() }) {
  const task = mode === 'doctor'
    ? `Tryb DOKTOR. Właściciel uważa, że z rośliną jest coś nie tak. Jego opis: "${userText || 'brak opisu'}".
Postaw hipotezy przyczyn od najbardziej prawdopodobnej, powiedz co sprawdzić, żeby je potwierdzić lub wykluczyć, i co zrobić natychmiast.
Jeśli do trafnej diagnozy brakuje informacji, zadaj w polu "questions" maksymalnie 3 krótkie, konkretne pytania (np. „Czy podłoże jest mokre 3 cm pod powierzchnią?”). Jeśli nie brakuje — zostaw pustą listę.`
    : `Tryb KONTROLA. Oceń ogólny stan rośliny i dopasowanie warunków. Daj rekomendacje: światło, podlewanie, doniczka i podłoże, nawożenie, ewentualne przesadzenie, czyszczenie liści.${userText ? `\nUwagi właściciela: "${userText}".` : ''}
Pole "questions" zostaw puste.`;

  const root = chain[0];
  const rootText = root ? root.user_text : userText;
  const first = {
    role: 'user',
    content: [
      imageBlock(image),
      { type: 'text', text: `${plantContext(plant, care, today)}\n\n${task.replace(userText || '', rootText || userText || '')}` },
    ],
  };
  const messages = [first];
  for (let i = 0; i < chain.length; i++) {
    messages.push({ role: 'assistant', content: JSON.stringify(chain[i].result) });
    const next = i + 1 < chain.length ? chain[i + 1].user_text : userText;
    messages.push({ role: 'user', content: `Odpowiedzi właściciela na pytania: "${next}"\nZaktualizuj ocenę. Jeśli nadal czegoś brakuje, zadaj kolejne pytania, w przeciwnym razie zostaw "questions" puste.` });
  }
  return { system: SYSTEM_HEALTH, messages };
}

export function buildProfileMessages({ plant, care, today = new Date() }) {
  return {
    system: SYSTEM_PROFILE,
    messages: [{
      role: 'user',
      content: `${plantContext(plant, care, today)}\n\nNapisz profil pielęgnacyjny tego gatunku. Odnieś się do podanych warunków tam, gdzie coś wyraźnie nie pasuje (np. zbyt ciemno dla tego gatunku).`,
    }],
  };
}

// ---------------------------------------------------------------------------
// calls
// ---------------------------------------------------------------------------

async function callJson(client, { model, effort, system, messages, schema }) {
  let res;
  try {
    res = await client.beta.messages.create({
      model,
      max_tokens: 16000,
      // Server-side fallback: a safety-classifier refusal is re-run on Anthropic's recommended model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system,
      messages,
      output_config: { effort, format: { type: 'json_schema', schema } },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new AiError(502, 'Anthropic odrzucił klucz API — sprawdź anthropicApiKey w config.js.');
    if (err instanceof Anthropic.RateLimitError) throw new AiError(429, 'Limit zapytań do Anthropic — spróbuj za chwilę.');
    if (err instanceof Anthropic.BadRequestError) throw new AiError(502, `Anthropic: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new AiError(502, `Błąd Anthropic (${err.status}): ${err.message}`);
    throw new AiError(502, 'Nie udało się połączyć z Anthropic.');
  }
  if (res.stop_reason === 'refusal') throw new AiError(502, 'Model odmówił analizy tego zdjęcia.');
  if (res.stop_reason === 'max_tokens') throw new AiError(502, 'Odpowiedź modelu została ucięta — spróbuj ponownie.');
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return { result: JSON.parse(text), usage: res.usage, model: res.model };
  } catch {
    throw new AiError(502, 'Nieczytelna odpowiedź modelu — spróbuj ponownie.');
  }
}

export async function analyzeHealth(client, config, opts) {
  const { system, messages } = buildHealthMessages(opts);
  return callJson(client, {
    model: config.anthropicModel || DEFAULT_MODEL,
    effort: config.anthropicEffort || DEFAULT_EFFORT,
    system, messages, schema: HEALTH_SCHEMA,
  });
}

export async function describeSpecies(client, config, opts) {
  const { system, messages } = buildProfileMessages(opts);
  return callJson(client, {
    model: config.anthropicModel || DEFAULT_MODEL,
    effort: config.anthropicEffort || DEFAULT_EFFORT,
    system, messages, schema: PROFILE_SCHEMA,
  });
}
