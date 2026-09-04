// app.js — greenLy frontend. Plain ES module, no build step.

const API = './api/';
const TOKEN_KEY = 'greenly.token';

// The pot that holds the roots is what matters; a decorative cachepot only counts when water stays in it.
const MATERIALS = [
  ['terracotta', 'Terakota / glina niepolewana — szybko wysycha'],
  ['ceramic', 'Ceramika szkliwiona'],
  ['plastic', 'Plastik z otworami (także w osłonce)'],
  ['cachepot', 'Bez otworów odpływowych — woda nie odpływa'],
];
const LIGHTS = [
  ['sun', 'Pełne słońce — parapet S/W, słońce na liściach'],
  ['bright', 'Jasno, bez ostrego słońca — przy oknie E/N'],
  ['partial', 'Półcień — 1–2 m od okna'],
  ['dark', 'Ciemny kąt — daleko od okna'],
];
const LEVEL_LABEL = {
  species: 'profil gatunku',
  genus: 'profil rodzaju',
  family: 'profil rodziny',
  universal: 'profil uniwersalny',
};

// ---------------------------------------------------------------------------
// Interval estimate — MUST match intervalDays() in lib.js (server is the source
// of truth). Used only for the live preview while editing the form.
// ---------------------------------------------------------------------------
const MATERIAL_FACTOR = { terracotta: 0.80, ceramic: 1.00, plastic: 1.08, cachepot: 1.20 };
const LIGHT_FACTOR = { sun: 0.82, bright: 1.00, partial: 1.22, dark: 1.45 };
const DRY_AIR_FACTOR = 0.85;
const MIN_DAYS = 2;
const MAX_DAYS = 60;

function potFactor(cm) {
  cm = Number(cm) || 0;
  if (cm <= 10) return 0.72;
  if (cm <= 15) return 0.88;
  if (cm <= 22) return 1.00;
  if (cm <= 30) return 1.18;
  return 1.35;
}

function dayOfYear(d) {
  const start = Date.UTC(d.getFullYear(), 0, 1);
  const now = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((now - start) / 86400000);
}

function seasonFactor(when = new Date()) {
  return (1 - Math.cos(2 * Math.PI * dayOfYear(when) / 365)) / 2;
}

export function estimate({ base_summer, base_winter, pot_cm, pot_material, light, dry_air }, when = new Date()) {
  const s = seasonFactor(when);
  const base = base_winter + (base_summer - base_winter) * s;
  const days = base
    * potFactor(pot_cm)
    * (MATERIAL_FACTOR[pot_material] ?? 1)
    * (LIGHT_FACTOR[light] ?? 1)
    * (dry_air ? DRY_AIR_FACTOR : 1);
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));
}

// ---------------------------------------------------------------------------
// state + dom helpers
// ---------------------------------------------------------------------------
const state = {
  token: localStorage.getItem(TOKEN_KEY),
  plants: [],
  pushSub: null,
  ai: false,       // server has an Anthropic key → check-ups, doctor and species profiles available
  plantView: null, // currently open plant id
};

const $ = (sel, root = document) => root.querySelector(sel);
const el = {
  login: $('#view-login'),
  app: $('#view-app'),
  plantView: $('#view-plant'),
  actions: $('#topbar-actions'),
  list: $('#plants'),
  empty: $('#empty'),
  sheet: $('#sheet'),
  sheetBody: $('#sheet-body'),
  sheetTitle: $('#sheet-title'),
  backdrop: $('#sheet-backdrop'),
  toasts: $('#toasts'),
  btnPush: $('#btn-push'),
  iosHint: $('#ios-hint'),
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dni(n) {
  n = Math.abs(n);
  return n === 1 ? 'dzień' : 'dni';
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function toast(msg, type = 'info', ms = 3200) {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  el.toasts.appendChild(t);
  setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 260); }, ms);
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
async function api(action, { json, form } = {}) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  let res;
  try {
    res = await fetch(API + action, { method: body === undefined ? 'GET' : 'POST', headers, body });
  } catch {
    throw new Error('Brak połączenia z serwerem.');
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && action !== 'login') {
    logout();
    throw new Error(data.error || 'Sesja wygasła — zaloguj się ponownie.');
  }
  if (!res.ok) throw new Error(data.error || `Błąd ${res.status}`);
  return data;
}

function photoUrl(p) {
  return p.photo ? `${p.photo}?t=${encodeURIComponent(state.token)}` : null;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
function showLogin() {
  el.login.hidden = false;
  el.app.hidden = true;
  el.plantView.hidden = true;
  el.actions.hidden = true;
  $('#login-password').focus();
}

function logout() {
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  closeSheet();
  showLogin();
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { token } = await api('login', { json: { password: $('#login-password').value } });
    state.token = token;
    localStorage.setItem(TOKEN_KEY, token);
    $('#login-password').value = '';
    await enterApp();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-logout').addEventListener('click', logout);

// ---------------------------------------------------------------------------
// plant list
// ---------------------------------------------------------------------------
async function enterApp() {
  el.login.hidden = true;
  el.app.hidden = false;
  el.actions.hidden = false;
  el.iosHint.hidden = !(isIOS && !isStandalone);
  await refresh();
  refreshPushState();
  route();
}

async function refresh() {
  try {
    const { plants, ai } = await api('plants');
    state.plants = plants;
    state.ai = !!ai;
    renderList();
    if (state.plantView) showPlant(state.plantView);
  } catch (err) {
    toast(err.message, 'error');
  }
}

function metaText(p) {
  const every = ` · co ${p.interval} ${dni(p.interval)}`;
  if (p.days_left === null) return 'Brak daty podlania' + every;
  if (p.days_left > 0) return `Za ${p.days_left} ${dni(p.days_left)}` + every;
  if (p.days_left === 0) return 'Dziś' + every;
  return `Spóźnione o ${-p.days_left} ${dni(p.days_left)}` + every;
}

function fillPercent(p) {
  if (p.days_left === null) return 0;
  return Math.max(0, Math.min(1, p.days_left / p.interval)) * 100;
}

function renderList() {
  const tpl = $('#tpl-plant');
  const existing = new Map([...el.list.children].map((li) => [Number(li.dataset.id), li]));
  const frag = document.createDocumentFragment();

  for (const p of state.plants) {
    let li = existing.get(p.id);
    if (!li) {
      li = tpl.content.firstElementChild.cloneNode(true);
      li.dataset.id = p.id;
      li.querySelector('.plant-main').addEventListener('click', () => { location.hash = `plant/${p.id}`; });
      li.querySelector('.btn-water').addEventListener('click', () => water(p.id, li));
    }
    li.classList.toggle('is-overdue', p.days_left !== null && p.days_left < 0);
    li.classList.toggle('is-today', p.days_left === 0);
    li.querySelector('.plant-name').textContent = p.name;
    li.querySelector('.plant-species').textContent = p.species;
    const thumb = li.querySelector('.thumb');
    const img = thumb.querySelector('img');
    const url = photoUrl(p);
    thumb.classList.toggle('has-photo', !!url);
    if (url && img.getAttribute('src') !== url) img.src = url;
    const bar = li.querySelector('.bar');
    const fill = li.querySelector('.bar-fill');
    const pct = fillPercent(p);
    bar.classList.toggle('unknown', p.days_left === null);
    bar.setAttribute('aria-label', `Wilgotność ${Math.round(pct)}%`);
    fill.classList.toggle('low', pct < 20);
    // Force a layout pass first so the width transition also runs for freshly created cards.
    if (!existing.has(p.id)) fill.getBoundingClientRect();
    fill.style.width = `${pct}%`;
    li.querySelector('.plant-meta').textContent = metaText(p);
    frag.appendChild(li);
  }
  el.list.replaceChildren(frag);
  el.empty.hidden = state.plants.length > 0;
}

async function water(id, li) {
  const btn = li.querySelector('.btn-water');
  btn.disabled = true;
  try {
    const { plant } = await api('water', { json: { id } });
    const i = state.plants.findIndex((p) => p.id === id);
    if (i >= 0) state.plants[i] = plant;
    // Animate the bar in place first, then re-sort the list after the transition.
    renderListInPlace(plant, li);
    setTimeout(() => { state.plants.sort(sortPlants); renderList(); }, 650);
    toast(`Podlano: ${plant.name}`);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function sortPlants(a, b) {
  return (a.days_left ?? -9999) - (b.days_left ?? -9999) || a.name.localeCompare(b.name, 'pl');
}

function renderListInPlace(p, li) {
  li.classList.remove('is-overdue', 'is-today');
  const fill = li.querySelector('.bar-fill');
  const pct = fillPercent(p);
  fill.classList.toggle('low', pct < 20);
  fill.style.width = `${pct}%`;
  li.querySelector('.plant-meta').textContent = metaText(p);
}

// ---------------------------------------------------------------------------
// bottom sheet
// ---------------------------------------------------------------------------
let lastFocus = null;

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let sheetTimer = null;

function openSheet(title) {
  clearTimeout(sheetTimer);
  lastFocus = document.activeElement;
  el.sheetTitle.textContent = title;
  el.sheetBody.scrollTop = 0;
  el.backdrop.hidden = false;
  el.sheet.hidden = false;
  // Force a layout pass so the closed state is committed, then transition to .open.
  // (Synchronous reflow rather than requestAnimationFrame — rAF does not fire in background tabs.)
  void el.sheet.offsetHeight;
  el.backdrop.classList.add('open');
  el.sheet.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeSheet() {
  if (el.sheet.hidden) return;
  el.backdrop.classList.remove('open');
  el.sheet.classList.remove('open');
  document.body.style.overflow = '';
  const finish = () => {
    el.sheet.hidden = true;
    el.backdrop.hidden = true;
    el.sheetBody.replaceChildren();
    lastFocus?.focus?.();
  };
  clearTimeout(sheetTimer);
  if (reduceMotion.matches) finish(); else sheetTimer = setTimeout(finish, 360);
}

$('#sheet-close').addEventListener('click', closeSheet);
el.backdrop.addEventListener('click', closeSheet);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.sheet.hidden) closeSheet(); });

// ---------------------------------------------------------------------------
// add: step 1 — identify
// ---------------------------------------------------------------------------
$('#btn-add').addEventListener('click', openAdd);

function openAdd() {
  openSheet('Nowa roślina');
  el.sheetBody.innerHTML = `
    <div class="identify">
      <div class="photo-pick">
        <button type="button" class="btn btn-primary" tabindex="-1">Zrób zdjęcie / wybierz z galerii</button>
        <input type="file" accept="image/*" id="photo-input" aria-label="Zdjęcie rośliny">
      </div>
      <img class="photo-preview" id="photo-preview" alt="Podgląd zdjęcia" hidden>
      <p class="status" id="identify-status"></p>
      <ul class="results" id="results"></ul>
      <div class="divider">albo</div>
      <form class="manual" id="manual-form">
        <input type="text" id="manual-name" placeholder="Wpiszę nazwę sam, np. Monstera deliciosa" aria-label="Nazwa łacińska lub potoczna" autocomplete="off">
        <button type="submit" class="btn btn-primary">Dalej</button>
      </form>
    </div>`;

  const draft = { thumb: null };

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#identify-status');
    const results = $('#results');
    results.replaceChildren();
    status.textContent = 'Przygotowuję zdjęcie…';
    try {
      const { upload, thumb } = await processImage(file);
      draft.thumb = thumb;
      const preview = $('#photo-preview');
      preview.src = thumb;
      preview.hidden = false;
      status.textContent = 'Rozpoznaję przez Pl@ntNet…';
      const form = new FormData();
      form.append('image', upload, 'photo.jpg');
      const { results: list } = await api('identify', { form });
      status.textContent = list.length ? 'Wybierz właściwe trafienie:' : 'Brak trafień — wpisz nazwę ręcznie.';
      renderResults(list, draft);
    } catch (err) {
      status.textContent = err.message + ' Możesz wpisać nazwę ręcznie poniżej.';
      status.classList.add('is-error');
    }
  });

  $('#manual-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#manual-name').value.trim();
    if (!name) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      const { species, profile } = await api('lookup', { json: { species: name } });
      openForm({ species, common: '', genus: '', family: '', profile, thumb: draft.thumb });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#photo-input').focus();
}

function renderResults(list, draft) {
  const ul = $('#results');
  ul.replaceChildren();
  for (const r of list) {
    const li = document.createElement('li');
    li.innerHTML = `
      <button type="button" class="result">
        <span class="score">${r.score.toFixed(0)}%</span>
        <span>
          <span class="sci">${esc(r.species)}</span><br>
          <span class="com">${esc(r.common.join(', ')) || '&nbsp;'}</span><br>
          <span class="lvl">${esc(r.profile.label)} · ${LEVEL_LABEL[r.profile.level]}</span>
        </span>
      </button>`;
    li.querySelector('button').addEventListener('click', () => openForm({ ...r, thumb: draft.thumb }));
    ul.appendChild(li);
  }
}

/** Downscale to 1200 px (JPEG q0.82) for upload and a 320 px square thumbnail for storage. */
async function processImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bitmap.width;
  const h = bitmap.height;

  const scale = Math.min(1, 1200 / Math.max(w, h));
  const c1 = document.createElement('canvas');
  c1.width = Math.round(w * scale);
  c1.height = Math.round(h * scale);
  c1.getContext('2d').drawImage(bitmap, 0, 0, c1.width, c1.height);
  const upload = await new Promise((resolve) => c1.toBlob(resolve, 'image/jpeg', 0.82));

  const side = Math.min(w, h);
  const c2 = document.createElement('canvas');
  c2.width = 320;
  c2.height = 320;
  c2.getContext('2d').drawImage(bitmap, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 320, 320);
  const thumb = c2.toDataURL('image/jpeg', 0.8);

  bitmap.close?.();
  return { upload, thumb };
}

// ---------------------------------------------------------------------------
// step 2 — conditions form (add + edit)
// ---------------------------------------------------------------------------
function openEdit(id) {
  const p = state.plants.find((x) => x.id === id);
  if (!p) return;
  openSheet('Edycja rośliny');
  openForm({
    id: p.id,
    species: p.species,
    common: p.common,
    genus: p.genus,
    family: p.family,
    profile: { group: p.group_key, level: p.match_level, label: p.group_label, note: p.group_note, summer: p.base_summer, winter: p.base_winter },
    photoUrl: photoUrl(p),
    values: p,
  });
}

function openForm(ctx) {
  const isEdit = !!ctx.id;
  const v = ctx.values ?? {};
  const commonName = Array.isArray(ctx.common) ? ctx.common[0] ?? '' : ctx.common ?? '';
  const defaultName = v.name ?? (commonName || ctx.species || '');
  const photoSrc = ctx.thumb || ctx.photoUrl;
  const options = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');

  el.sheetBody.innerHTML = `
    <div class="species-head">
      <span class="thumb ${photoSrc ? 'has-photo' : ''}"><img alt="" ${photoSrc ? `src="${esc(photoSrc)}"` : ''}></span>
      <div>
        <div class="sci">${esc(ctx.species) || '—'}</div>
        <div class="com">${esc(commonName)}</div>
      </div>
    </div>
    <div class="preview" id="preview" aria-live="polite">
      <strong id="preview-days"></strong>
      w tych warunkach, o tej porze roku
      <span class="chip level-${esc(ctx.profile.level)}">${esc(ctx.profile.label)} · ${LEVEL_LABEL[ctx.profile.level]}</span>
      <div class="note">${esc(ctx.profile.note)}</div>
    </div>
    <form id="plant-form" autocomplete="off">
      <div class="field">
        <label for="f-name">Nazwa własna</label>
        <input type="text" id="f-name" name="name" maxlength="80" required value="${esc(defaultName)}">
      </div>
      <div class="field">
        <label for="f-pot">Średnica doniczki: <span class="range-value" id="pot-value">${v.pot_cm ?? 15}</span> cm</label>
        <input type="range" id="f-pot" name="pot_cm" min="6" max="40" step="1" value="${v.pot_cm ?? 15}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-material">Doniczka</label>
          <select id="f-material" name="pot_material">${options(MATERIALS, v.pot_material ?? 'ceramic')}</select>
        </div>
        <div class="field">
          <label for="f-light">Światło</label>
          <select id="f-light" name="light">${options(LIGHTS, v.light ?? 'bright')}</select>
        </div>
      </div>
      <p class="hint">Liczy się doniczka, w której są korzenie. Osłonka nie ma znaczenia — chyba że po podlaniu zostaje w niej woda, wtedy wybierz „bez otworów”.</p>
      <div class="field">
        <label class="check"><input type="checkbox" id="f-dry" name="dry_air" ${v.dry_air ? 'checked' : ''}> Suche powietrze / blisko grzejnika</label>
      </div>
      <div class="field">
        <label for="f-last">Ostatnie podlanie</label>
        <input type="date" id="f-last" name="last_watered" value="${esc(v.last_watered ?? todayStr())}" max="${todayStr()}">
      </div>
      <div class="field">
        <label for="f-note">Notatka</label>
        <textarea id="f-note" name="note" maxlength="500">${esc(v.note ?? '')}</textarea>
      </div>
      <div class="form-actions">
        ${isEdit ? '<button type="button" class="btn btn-danger" id="f-delete">Usuń</button>' : ''}
        <button type="submit" class="btn btn-primary">${isEdit ? 'Zapisz zmiany' : 'Dodaj roślinę'}</button>
      </div>
    </form>`;

  const form = $('#plant-form');
  const update = () => {
    const days = estimate({
      base_summer: ctx.profile.summer,
      base_winter: ctx.profile.winter,
      pot_cm: form.pot_cm.value,
      pot_material: form.pot_material.value,
      light: form.light.value,
      dry_air: form.dry_air.checked,
    });
    $('#preview-days').textContent = `co ${days} ${dni(days)}`;
    $('#pot-value').textContent = form.pot_cm.value;
  };
  form.addEventListener('input', update);
  update();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const payload = {
        id: ctx.id ?? null,
        name: form.name.value,
        species: ctx.species ?? '',
        common: commonName,
        genus: ctx.genus ?? '',
        family: ctx.family ?? '',
        pot_cm: Number(form.pot_cm.value),
        pot_material: form.pot_material.value,
        light: form.light.value,
        dry_air: form.dry_air.checked,
        last_watered: form.last_watered.value || null,
        note: form.note.value,
      };
      if (ctx.thumb) payload.photo = ctx.thumb;
      const { plant } = await api('save', { json: payload });
      toast(isEdit ? 'Zapisano.' : 'Dodano roślinę.');
      closeSheet();
      await refresh();
      if (!isEdit) location.hash = `plant/${plant.id}`;
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('#f-delete')?.addEventListener('click', async () => {
    if (!confirm(`Usunąć „${form.name.value}”?`)) return;
    try {
      await api('delete', { json: { id: ctx.id } });
      toast('Usunięto.');
      closeSheet();
      state.plantView = null;
      location.hash = '';
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#f-name').focus();
}

// ---------------------------------------------------------------------------
// push notifications
// ---------------------------------------------------------------------------
function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/** navigator.serviceWorker.ready never settles if the worker failed to install — so give it a deadline. */
async function swReady(ms = 6000) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error(
    'Service worker nie jest aktywny. Zamknij aplikację całkowicie, otwórz ponownie i spróbuj jeszcze raz.')), ms));
  const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
  return reg;
}

async function refreshPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.btnPush.setAttribute('aria-pressed', 'false');
    return;
  }
  try {
    const reg = await swReady();
    state.pushSub = await reg.pushManager.getSubscription();
  } catch { state.pushSub = null; }
  el.btnPush.setAttribute('aria-pressed', state.pushSub ? 'true' : 'false');
  el.btnPush.textContent = state.pushSub ? 'Powiadomienia: wł.' : 'Powiadomienia';
}

el.btnPush.addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast(isIOS && !isStandalone
      ? 'Na iPhonie dodaj greenLy do ekranu początkowego i włącz powiadomienia z ikony.'
      : 'Ta przeglądarka nie obsługuje powiadomień push.', 'error', 5000);
    return;
  }
  el.btnPush.disabled = true;
  try {
    const reg = await swReady();
    if (state.pushSub) {
      await api('unsubscribe', { json: { endpoint: state.pushSub.endpoint } });
      await state.pushSub.unsubscribe();
      state.pushSub = null;
      toast('Powiadomienia wyłączone.');
    } else {
      const { publicKey } = await api('vapid');
      if (!publicKey) throw new Error('Serwer nie ma skonfigurowanych kluczy VAPID.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Brak zgody na powiadomienia.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api('subscribe', { json: sub.toJSON() });
      state.pushSub = sub;
      toast('Powiadomienia włączone.');
    }
  } catch (err) {
    toast(err.message, 'error', 5000);
  } finally {
    el.btnPush.disabled = false;
    refreshPushState();
  }
});

// ---------------------------------------------------------------------------
// plant profile view  (#plant/<id>)
// ---------------------------------------------------------------------------
const STATUS_LABEL = { healthy: 'W porządku', watch: 'Obserwuj', sick: 'Wymaga działania' };
const CONF_LABEL = { low: 'niska pewność', medium: 'średnia pewność', high: 'wysoka pewność' };
const MODE_LABEL = { checkup: 'Kontrola', doctor: 'Doktor' };
// USD per 1M tokens (input, output) — only for the approximate cost shown under each analysis.
const PRICES = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5] };

const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? key;
const fmtDate = (iso) => new Date(iso).toLocaleDateString('pl-PL', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString('pl-PL', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function route() {
  if (!state.token) return;
  const m = /^#plant\/(\d+)$/.exec(location.hash);
  if (m) {
    showPlant(Number(m[1]));
  } else {
    state.plantView = null;
    el.plantView.hidden = true;
    el.app.hidden = false;
    window.scrollTo(0, 0);
  }
}

async function showPlant(id) {
  state.plantView = id;
  el.app.hidden = true;
  el.plantView.hidden = false;
  try {
    const data = await api(`plant/${id}`);
    if (state.plantView !== id) return;
    state.ai = !!data.ai;
    renderPlant(data);
  } catch (err) {
    toast(err.message, 'error');
    location.hash = '';
  }
}

function approxCost(check) {
  const p = PRICES[check.model];
  if (!p || check.input_tokens == null) return '';
  const usd = (check.input_tokens * p[0] + (check.output_tokens ?? 0) * p[1]) / 1e6;
  return ` · ≈ $${usd.toFixed(3)}`;
}

function renderPlant({ plant: p, care, waterings, checks }) {
  const photo = photoUrl(p);
  const pct = fillPercent(p);
  const intervals = [];
  for (let i = 0; i + 1 < waterings.length; i++) {
    intervals.push((new Date(waterings[i].ts) - new Date(waterings[i + 1].ts)) / 86400000);
  }
  const avg = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null;
  const answered = new Set(checks.map((c) => c.parent_id).filter(Boolean));

  el.plantView.innerHTML = `
    <a class="back" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>Rośliny</a>
    <div class="pv-head">
      <span class="thumb ${photo ? 'has-photo' : ''}"><img alt="" ${photo ? `src="${esc(photo)}"` : ''}></span>
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="sci">${esc(p.species) || '—'}${p.common ? ` · ${esc(p.common)}` : ''}</div>
        <div class="chips"><span class="chip soft level-${esc(p.match_level)}">${esc(p.group_label)} · ${LEVEL_LABEL[p.match_level]}</span></div>
      </div>
    </div>
    <div class="pv-status ${p.days_left !== null && p.days_left < 0 ? 'is-overdue' : ''} ${p.days_left === 0 ? 'is-today' : ''}">
      <span class="bar ${p.days_left === null ? 'unknown' : ''}"><span class="bar-fill ${pct < 20 ? 'low' : ''}" style="width:${pct}%"></span></span>
      <span class="plant-meta">${esc(metaText(p))}</span>
      <button type="button" class="btn btn-water" id="pv-water">Podlej</button>
    </div>
    <div class="pv-actions">
      <button type="button" class="btn btn-soft" id="pv-checkup" ${state.ai ? '' : 'disabled title="Brak klucza Anthropic w config.js"'}>Kontrola</button>
      <button type="button" class="btn btn-soft" id="pv-doctor" ${state.ai ? '' : 'disabled title="Brak klucza Anthropic w config.js"'}>Doktor</button>
      <button type="button" class="btn" id="pv-edit">Edytuj</button>
    </div>

    <section class="section">
      <h2>Warunki</h2>
      <div class="card"><dl class="kv">
        <dt>Doniczka</dt><dd>${p.pot_cm} cm · ${esc(label(MATERIALS, p.pot_material))}</dd>
        <dt>Światło</dt><dd>${esc(label(LIGHTS, p.light))}</dd>
        <dt>Powietrze</dt><dd>${p.dry_air ? 'suche / grzejnik w pobliżu' : 'normalne'}</dd>
        <dt>Podlewanie</dt><dd>co ${p.interval} ${dni(p.interval)} o tej porze roku${avg ? ` · faktycznie średnio co ${avg} ${dni(avg)}` : ''}</dd>
        ${p.note ? `<dt>Notatka</dt><dd>${esc(p.note)}</dd>` : ''}
      </dl></div>
    </section>

    <section class="section">
      <h2>Jak dbać — ${esc(care.label)}</h2>
      <div class="card care">
        <p><b>Światło:</b> ${esc(care.light)}</p>
        <p><b>Wilgotność:</b> ${esc(care.humidity)}</p>
        <p><b>Temperatura:</b> ${esc(care.temp)}</p>
        <p><b>Gdzie postawić:</b> ${esc(care.placement)}</p>
        <p><b>Podlewanie:</b> ${esc(care.note)}</p>
      </div>
    </section>

    <section class="section" id="pv-profile">
      <h2>Profil gatunku</h2>
      ${p.profile ? renderProfile(p.profile) : `<div class="card"><p class="muted" style="margin:0 0 10px">Szczegółowy opis gatunku napisany przez AI: pochodzenie, światło, podlewanie, nawożenie, przesadzanie, toksyczność dla zwierząt, typowe problemy.</p>
        <button type="button" class="btn btn-soft" id="pv-gen-profile" ${state.ai ? '' : 'disabled'}>Opisz gatunek</button></div>`}
    </section>

    <section class="section">
      <h2>Analizy</h2>
      ${checks.length ? `<ul class="check-list">${checks.map((c) => renderCheck(c)).join('')}</ul>`
        : '<p class="muted">Jeszcze żadnej. „Kontrola” ocenia ogólny stan i warunki, „Doktor” szuka przyczyny konkretnego problemu.</p>'}
    </section>

    <section class="section">
      <h2>Podlewania${waterings.length ? ` (${waterings.length})` : ''}</h2>
      ${waterings.length ? `<div class="card"><ul class="water-list">${waterings.slice(0, 30).map((w) => `<li>${fmtDateTime(w.ts)}</li>`).join('')}</ul></div>` : '<p class="muted">Brak zapisanych podlewań.</p>'}
    </section>`;

  $('#pv-water').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { plant } = await api('water', { json: { id: p.id } });
      toast(`Podlano: ${plant.name}`);
      const i = state.plants.findIndex((x) => x.id === p.id);
      if (i >= 0) state.plants[i] = plant;
      showPlant(p.id);
    } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  });
  $('#pv-edit').addEventListener('click', () => openEdit(p.id));
  $('#pv-checkup').addEventListener('click', () => openCheck(p, 'checkup'));
  $('#pv-doctor').addEventListener('click', () => openCheck(p, 'doctor'));
  $('#pv-gen-profile')?.addEventListener('click', (e) => generateProfile(p.id, e.target));
  $('#pv-refresh-profile')?.addEventListener('click', (e) => generateProfile(p.id, e.target, true));

  for (const head of el.plantView.querySelectorAll('.check-head')) {
    head.addEventListener('click', () => {
      const c = checks.find((x) => x.id === Number(head.dataset.id));
      if (c) openCheckSheet(c, p.id, answered.has(c.id));
    });
  }
  window.scrollTo(0, 0);
}

function renderProfile(pr) {
  const row = (k, v) => (v ? `<p><b>${k}:</b> ${esc(v)}</p>` : '');
  return `<div class="card care">
    ${row('Pochodzenie', pr.origin)}${row('Światło', pr.light)}${row('Podlewanie', pr.watering)}${row('Wilgotność', pr.humidity)}
    ${row('Temperatura', pr.temperature)}${row('Podłoże i doniczka', pr.soil_and_pot)}${row('Nawożenie', pr.fertilizing)}
    ${row('Przesadzanie', pr.repotting)}${row('Zwierzęta', pr.pets)}${row('Gdzie postawić', pr.placement)}
    ${pr.common_problems?.length ? `<p><b>Typowe problemy:</b></p><ul>${pr.common_problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="inline-actions"><button type="button" class="btn btn-ghost" id="pv-refresh-profile" ${state.ai ? '' : 'disabled'}>Napisz od nowa</button></div>
  </div>`;
}

async function generateProfile(id, btn, refresh = false) {
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Piszę opis…';
  try {
    await api('profile', { json: { id, refresh } });
    toast('Opis gotowy.');
    showPlant(id);
  } catch (err) {
    toast(err.message, 'error', 6000);
    btn.disabled = false;
    btn.textContent = refresh ? 'Napisz od nowa' : 'Opisz gatunek';
  }
}

function renderResult(r) {
  return `
    <span class="verdict ${esc(r.status)}">${STATUS_LABEL[r.status] ?? esc(r.status)}</span>
    <p style="margin:4px 0 8px">${esc(r.summary)}</p>
    ${r.findings?.length ? `<ul class="findings">${r.findings.map((f) => `<li><b>${esc(f.observation)}</b> → ${esc(f.likely_cause)} <span class="conf">(${CONF_LABEL[f.confidence] ?? esc(f.confidence)})</span></li>`).join('')}</ul>` : ''}
    ${r.actions?.length ? `<p style="margin:8px 0 0"><b>Co zrobić:</b></p><ol class="actions-list">${r.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : ''}
    ${r.watering ? `<p style="margin:8px 0 0"><b>Podlewanie:</b> ${esc(r.watering)}</p>` : ''}`;
}

const photoSrc = (url) => `${url}?t=${encodeURIComponent(state.token)}`;

/** One row in the analyses list; details open in the sheet. */
function renderCheck(c) {
  const r = c.result ?? {};
  const thumb = c.photos?.[0] ?? c.photo;
  return `<li class="check">
    <button type="button" class="check-head" data-id="${c.id}">
      <span class="thumb ${thumb ? 'has-photo' : ''}"><img alt="" loading="lazy" ${thumb ? `src="${esc(photoSrc(thumb))}"` : ''}></span>
      <span class="title">
        <span class="row"><span class="dot ${esc(r.status)}"></span>${esc(r.title || STATUS_LABEL[r.status] || 'Analiza')}</span>
        <span class="mode">${MODE_LABEL[c.mode] ?? esc(c.mode)}${c.parent_id ? ' · dopytanie' : ''}${r.questions?.length ? ' · pyta' : ''}</span>
      </span>
      <span class="when">${fmtDateTime(c.ts)}</span>
    </button>
  </li>`;
}

/** Full analysis in the bottom sheet: photos, verdict, actions, and the doctor's questions with an answer form. */
function renderCheckDetails(c, answered) {
  const r = c.result ?? {};
  const photos = c.photos?.length ? c.photos : (c.photo ? [c.photo] : []);
  return `
    ${photos.length ? `<div class="check-photos ${photos.length === 1 ? 'single' : ''}">${photos.map((u) => `<img src="${esc(photoSrc(u))}" alt="" loading="lazy">`).join('')}</div>` : ''}
    ${c.user_text ? `<p class="user-text">„${esc(c.user_text)}”</p>` : ''}
    ${renderResult(r)}
    ${r.questions?.length ? `<div class="questions">
      <b>${answered ? 'Pytania (odpowiedziano)' : 'Doktor pyta:'}</b>
      <ol>${r.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
      ${answered ? '' : `<form class="answer-form" data-parent="${c.id}">
        <textarea name="text" placeholder="Odpowiedz po kolei…" required></textarea>
        <button type="submit" class="btn btn-primary btn-block">Odpowiedz i zaktualizuj diagnozę</button>
      </form>`}
    </div>` : ''}
    <p class="usage">${fmtDateTime(c.ts)} · ${esc(c.model || '')}${c.input_tokens != null ? ` · ${c.input_tokens}+${c.output_tokens ?? 0} tokenów` : ''}${approxCost(c)}</p>`;
}

function openCheckSheet(c, plantId, answered) {
  openSheet(c.result?.title || MODE_LABEL[c.mode] || 'Analiza');
  fillCheckSheet(c, plantId, answered);
}

function fillCheckSheet(c, plantId, answered) {
  el.sheetTitle.textContent = c.result?.title || MODE_LABEL[c.mode] || 'Analiza';
  el.sheetBody.innerHTML = `${renderCheckDetails(c, answered)}
    <button type="button" class="btn btn-block" id="check-close" style="margin-top:12px">Zamknij</button>`;
  el.sheetBody.scrollTop = 0;
  $('#check-close').addEventListener('click', closeSheet);
  $('.answer-form', el.sheetBody)?.addEventListener('submit', (e) => submitFollowUp(e, plantId));
}

async function submitFollowUp(e, plantId) {
  e.preventDefault();
  const form = e.target;
  const btn = form.querySelector('button');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Analizuję…';
  try {
    const fd = new FormData();
    fd.append('id', plantId);
    fd.append('parent_id', form.dataset.parent);
    fd.append('text', form.text.value.trim());
    const { check } = await api('health', { form: fd });
    toast('Diagnoza zaktualizowana.');
    fillCheckSheet(check, plantId, false);
    showPlant(plantId); // refresh the list behind the sheet
  } catch (err) {
    toast(err.message, 'error', 6000);
    btn.disabled = false;
    btn.textContent = 'Odpowiedz i zaktualizuj diagnozę';
  }
}

// ---------------------------------------------------------------------------
// check-up / doctor sheet
// ---------------------------------------------------------------------------
function openCheck(p, mode) {
  const isDoctor = mode === 'doctor';
  openSheet(isDoctor ? `Doktor: ${p.name}` : `Kontrola: ${p.name}`);
  el.sheetBody.innerHTML = `
    <p class="muted" style="margin:0 0 12px">${isDoctor
      ? 'Zrób wyraźne zdjęcie problematycznego miejsca (liść z bliska, łodyga, podłoże) i opisz, co Cię niepokoi. Jeśli do diagnozy zabraknie informacji, Doktor zada pytania.'
      : 'Zrób zdjęcie całej rośliny w naturalnym świetle. Ocena obejmie stan liści, dopasowanie światła, doniczki i podlewania.'}</p>
    <form id="check-form" class="identify">
      <div class="photo-pick">
        <button type="button" class="btn btn-primary" tabindex="-1" id="check-pick-label">Zrób zdjęcie / wybierz z galerii</button>
        <input type="file" accept="image/*" multiple id="check-photo" aria-label="Zdjęcia (do 4)">
      </div>
      <div class="photo-row" id="check-previews"></div>
      <p class="muted" id="check-photo-hint" style="margin:0">Możesz dodać do 4 zdjęć — np. cała roślina, chory liść z bliska, podłoże.</p>
      <div class="field">
        <label for="check-text">${isDoctor ? 'Co jest nie tak?' : 'Uwagi (opcjonalnie)'}</label>
        <textarea id="check-text" name="text" maxlength="1000" ${isDoctor ? 'required' : ''} placeholder="${isDoctor ? 'np. od tygodnia żółkną dolne liście, na spodzie białe kropki' : 'np. przesadzona 2 tygodnie temu'}"></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block" id="check-submit" disabled>${isDoctor ? 'Postaw diagnozę' : 'Sprawdź stan'}</button>
      <p class="muted" style="margin:6px 0 0">Analiza trwa 15–60 s i kosztuje kilka–kilkanaście groszy za zdjęcie (Claude, płatność za użycie).</p>
    </form>`;

  const uploads = []; // {blob, thumb}
  const MAX = 4;
  const renderPreviews = () => {
    $('#check-previews').innerHTML = uploads.map((u) => `<img src="${u.thumb}" alt="">`).join('');
    $('#check-submit').disabled = uploads.length === 0;
    $('#check-pick-label').textContent = uploads.length ? `Dodaj kolejne zdjęcie (${uploads.length}/${MAX})` : 'Zrób zdjęcie / wybierz z galerii';
    $('#check-photo').disabled = uploads.length >= MAX;
  };
  $('#check-photo').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files ?? []).slice(0, MAX - uploads.length);
    e.target.value = '';
    for (const file of files) {
      try {
        const out = await processImage(file);
        uploads.push({ blob: out.upload, thumb: out.thumb });
      } catch { toast('Nie udało się przetworzyć zdjęcia.', 'error'); }
    }
    renderPreviews();
  });

  $('#check-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!uploads.length) return;
    const btn = $('#check-submit');
    btn.disabled = true;
    $('#check-photo').disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Analizuję… to może potrwać do minuty';
    try {
      const fd = new FormData();
      fd.append('id', p.id);
      fd.append('mode', mode);
      fd.append('text', $('#check-text').value.trim());
      uploads.forEach((u, i) => fd.append('image', u.blob, `photo-${i + 1}.jpg`));
      const { check } = await api('health', { form: fd });
      fillCheckSheet(check, p.id, false);
      showPlant(p.id); // refresh the profile behind the sheet
    } catch (err) {
      toast(err.message, 'error', 7000);
      btn.disabled = false;
      $('#check-photo').disabled = false;
      btn.textContent = isDoctor ? 'Postaw diagnozę' : 'Sprawdź stan';
    }
  });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.error('SW registration failed:', err));
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && !el.app.hidden) refresh();
});

window.addEventListener('hashchange', route);

if (state.token) enterApp(); else showLogin();
