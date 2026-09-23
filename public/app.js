// app.js — greenLy frontend. Plain ES module, no build step.

// Bump on every deploy together with the ?v= query strings in index.html and CACHE in sw.js
// (test/version.test.mjs checks they match). The server reads this constant from the file and
// the running app compares it with /api/version to offer a reload after a deploy.
export const APP_VERSION = '15';

import { t, lang, setLang, plural, locale, translateDom } from './i18n.js';

const API = './api/';
const TOKEN_KEY = 'greenly.token';

// The pot that holds the roots is what matters; a decorative cachepot only counts when water stays in it.
const MATERIALS = [
  ['terracotta', t('Terakota / glina niepolewana — szybko wysycha')],
  ['ceramic', t('Ceramika szkliwiona')],
  ['plastic', t('Plastik z otworami (także w osłonce)')],
  ['cachepot', t('Bez otworów odpływowych — woda nie odpływa')],
];
const LIGHTS = [
  ['sun', t('Pełne słońce — parapet S/W, słońce na liściach')],
  ['bright', t('Jasno, bez ostrego słońca — przy oknie E/N')],
  ['partial', t('Półcień — 1–2 m od okna')],
  ['dark', t('Ciemny kąt — daleko od okna')],
];
const LEVEL_LABEL = {
  species: t('profil gatunku'),
  genus: t('profil rodzaju'),
  family: t('profil rodziny'),
  universal: t('profil uniwersalny'),
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

export function estimate({ base_summer, base_winter, pot_cm, pot_material, light, dry_air, interval_adjust }, when = new Date()) {
  const s = seasonFactor(when);
  const base = base_winter + (base_summer - base_winter) * s;
  const days = base
    * potFactor(pot_cm)
    * (MATERIAL_FACTOR[pot_material] ?? 1)
    * (LIGHT_FACTOR[light] ?? 1)
    * (dry_air ? DRY_AIR_FACTOR : 1)
    * (Number(interval_adjust) || 1);
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.round(days)));
}

// ---------------------------------------------------------------------------
// state + dom helpers
// ---------------------------------------------------------------------------
const state = {
  token: localStorage.getItem(TOKEN_KEY),
  user: null,      // {login, has_key, key_hint, model, effort}
  plants: [],
  pushSub: null,
  ai: false,       // this user has an Anthropic key → check-ups, doctor and species profiles available
  plantView: null, // currently open plant id
  plantJson: null, // JSON of the data currently rendered in the profile view (skip re-render when unchanged)
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
  pushState: $('#push-state'),
  menu: $('#menu'),
  menuBtn: $('#menu-btn'),
  menuBackdrop: $('#menu-backdrop'),
  iosHint: $('#ios-hint'),
  installModal: $('#install-modal'),
  installBackdrop: $('#install-backdrop'),
  installBody: $('#install-body'),
};

// ---------------------------------------------------------------------------
// local cache: the last server responses, so every view paints instantly on open and the
// network only patches what changed (no skeleton → content flash on a warm start)
// ---------------------------------------------------------------------------
const CACHE_PREFIX = 'greenly.cache.';
function cacheGet(key) {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + key)); } catch { return null; }
}
function cacheSet(key, value) {
  try { localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(value)); } catch { /* quota — ignore */ }
}
function cacheClear() {
  for (const k of Object.keys(localStorage)) if (k.startsWith(CACHE_PREFIX)) localStorage.removeItem(k);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function dni(n) {
  return plural(n, ['dzień', 'dni', 'dni'], ['day', 'days']);
}
const days = (n) => `${Math.abs(n)} ${dni(n)}`;

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

// ---------------------------------------------------------------------------
// inline form validation (forms are `novalidate`; the browser's bubbles are never shown)
// ---------------------------------------------------------------------------
function fieldError(input, msg) {
  let err = input.nextElementSibling;
  if (!err?.classList.contains('field-error')) {
    err = document.createElement('p');
    err.className = 'field-error';
    err.setAttribute('role', 'alert');
    input.insertAdjacentElement('afterend', err);
    input.addEventListener('input', () => fieldError(input, null), { once: false });
  }
  input.classList.toggle('is-invalid', !!msg);
  input.setAttribute('aria-invalid', msg ? 'true' : 'false');
  err.textContent = msg ?? '';
  err.hidden = !msg;
}

/** rules: [[input, (value) => message | null], …]. Shows every message, focuses the first. Returns true when clean. */
function validate(rules) {
  let first = null;
  for (const [input, check] of rules) {
    const msg = check(input.value.trim());
    fieldError(input, msg);
    if (msg && !first) first = input;
  }
  first?.focus();
  return !first;
}
const required = (msg) => (v) => (v ? null : msg);
const LOGIN_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/i;
const loginRule = (v) => (!v ? t('Wpisz login.') : LOGIN_RE.test(v) ? null : t('3–32 znaki: litery, cyfry, kropka, myślnik lub podkreślenie.'));
const passwordRule = (v) => (!v ? t('Wpisz hasło.') : v.length < 8 ? t('Hasło musi mieć co najmniej 8 znaków.') : null);

/** Server-side messages that clearly belong to one field land under it instead of a toast. */
function serverFieldError(msg, map) {
  for (const [needle, input] of map) if (msg.toLowerCase().includes(needle)) { fieldError(input, msg); input.focus(); return true; }
  return false;
}

const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------
async function api(action, { json, form } = {}) {
  const headers = { 'X-Lang': lang }; // server-side messages come back in this language
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let body;
  if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (form) body = form;
  let res;
  try {
    res = await fetch(API + action, { method: body === undefined ? 'GET' : 'POST', headers, body });
  } catch {
    throw new Error(t('Brak połączenia z serwerem.'));
  }
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON */ }
  if (res.status === 401 && action !== 'login' && action !== 'register' && action !== 'account') {
    logout({ remote: false });
    throw new Error(data.error || t('Sesja wygasła — zaloguj się ponownie.'));
  }
  if (!res.ok) throw new Error(data.error || t('Błąd {n}', { n: res.status }));
  return data;
}

// Photos are <img> loads, so they carry a short-lived photo-only token (from /plants) instead of the session.
function photoUrl(p) {
  return p.photo && state.user?.photo_token ? `${p.photo}?t=${encodeURIComponent(state.user.photo_token)}` : null;
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------
const SEEN_KEY = 'greenly.seen'; // set after the first successful login: returning visitors skip the intro tab
function showLogin() {
  el.login.hidden = false;
  el.app.hidden = true;
  el.plantView.hidden = true;
  el.actions.hidden = true;
  $('.topbar').hidden = true; // the auth screens carry their own branding
  setAuthTab(localStorage.getItem(SEEN_KEY) ? 'login' : 'start');
}

function logout({ remote = true } = {}) {
  if (remote && state.token) api('logout', { json: {} }).catch(() => {}); // POST: a bare api() call is a GET and the route is POST-only
  state.token = null;
  state.user = null;
  state.plants = [];
  state.plantView = null;
  state.plantJson = null;
  localStorage.removeItem(TOKEN_KEY);
  cacheClear();
  el.list.replaceChildren();
  el.plantView.replaceChildren();
  closeSheet();
  closeInstall();
  closeMenu();
  if (location.hash) history.replaceState(null, '', location.pathname);
  showLogin();
}

// ---------------------------------------------------------------------------
// hamburger menu
// ---------------------------------------------------------------------------
let menuTimer = null;
function openMenu() {
  clearTimeout(menuTimer);
  const u = state.user;
  $('#menu-login').textContent = u?.login ?? '…';
  $('#menu-avatar').textContent = (u?.login ?? '?').slice(0, 1);
  $('#menu-role').textContent = u?.is_admin ? t('administrator') : t('użytkownik');
  $('#menu-lang-state').textContent = lang === 'pl' ? '🇵🇱 PL' : '🇬🇧 EN';
  $('#btn-admin').hidden = !u?.is_admin;
  el.menuBackdrop.hidden = false;
  el.menu.hidden = false;
  void el.menu.offsetHeight;
  el.menuBackdrop.classList.add('open');
  el.menu.classList.add('open');
  el.menuBtn.setAttribute('aria-expanded', 'true');
}
function closeMenu() {
  if (el.menu.hidden) return;
  el.menuBackdrop.classList.remove('open');
  el.menu.classList.remove('open');
  el.menuBtn.setAttribute('aria-expanded', 'false');
  const finish = () => { el.menu.hidden = true; el.menuBackdrop.hidden = true; };
  clearTimeout(menuTimer);
  if (reduceMotion.matches) finish(); else menuTimer = setTimeout(finish, 240);
}
el.menuBtn.addEventListener('click', () => (el.menu.hidden ? openMenu() : closeMenu()));
el.menuBackdrop.addEventListener('click', closeMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
$('#menu-home').addEventListener('click', closeMenu);
$('#btn-admin').addEventListener('click', () => { closeMenu(); openAdmin(); });
$('#btn-install').addEventListener('click', () => { closeMenu(); openInstall(); });
$('#btn-refresh').addEventListener('click', () => { closeMenu(); toast(t('Odświeżam…')); hardRefresh(); });
$('#btn-logout').addEventListener('click', () => logout());
$('#btn-lang').addEventListener('click', () => switchLang(lang === 'pl' ? 'en' : 'pl'));

/** Language change re-renders everything, so it is a reload (the choice is remembered). */
function switchLang(next) {
  setLang(next);
  if (state.user) api('account', { json: { lang: next } }).catch(() => {}); // for push notifications
  location.reload();
}
const langSelect = $('#lang-select');
langSelect.value = lang;
langSelect.addEventListener('change', () => { if (langSelect.value !== lang) switchLang(langSelect.value); });

function setAuthTab(tab) {
  for (const b of $('#auth-tabs').children) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  }
  $('#start-panel').hidden = tab !== 'start';
  $('#login-form').hidden = tab !== 'login';
  $('#register-form').hidden = tab !== 'register';
  if (tab === 'login') $('#login-user').focus();
  if (tab === 'register') $('#reg-user').focus();
  window.scrollTo(0, 0);
}
$('#auth-tabs').addEventListener('click', (e) => { const b = e.target.closest('.auth-tab'); if (b) setAuthTab(b.dataset.tab); });
$('#start-register').addEventListener('click', () => setAuthTab('register'));
$('#start-login').addEventListener('click', () => setAuthTab('login'));
$('#login-forgot').addEventListener('click', (e) => {
  const panel = $('#forgot-panel');
  panel.hidden = !panel.hidden;
  e.currentTarget.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
});

async function startSession({ token, user }, { fresh = false } = {}) {
  state.token = token;
  state.user = user;
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(SEEN_KEY, '1');
  await enterApp({ fresh });
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#login-user');
  const pass = $('#login-password');
  if (!validate([[user, required(t('Wpisz login.'))], [pass, required(t('Wpisz hasło.'))]])) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const data = await api('login', { json: { login: user.value.trim(), password: pass.value, lang } });
    pass.value = '';
    await startSession(data);
  } catch (err) {
    if (!serverFieldError(err.message, [['hasło', pass], ['password', pass]])) toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const user = $('#reg-user');
  const pass = $('#reg-password');
  const invite = $('#reg-invite');
  if (!validate([[user, loginRule], [pass, passwordRule], [invite, required(t('Wpisz kod zaproszenia.'))]])) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const data = await api('register', { json: { login: user.value.trim(), password: pass.value, invite: invite.value.trim(), lang } });
    pass.value = '';
    invite.value = '';
    toast(t('Witaj, {name}!', { name: data.user.login }));
    await startSession(data, { fresh: true });
  } catch (err) {
    if (!serverFieldError(err.message, [['login', user], ['kod', invite], ['invite', invite], ['hasło', pass], ['password', pass]])) toast(err.message, 'error', 5000);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-account').addEventListener('click', () => { closeMenu(); openAccount(); });

// ---------------------------------------------------------------------------
// plant list
// ---------------------------------------------------------------------------
async function enterApp({ fresh = false } = {}) {
  el.login.hidden = true;
  el.actions.hidden = false;
  $('.topbar').hidden = false;
  el.iosHint.hidden = !(isIOS && !isStandalone);
  // Paint from the cache first, pick the view synchronously, then let the network patch things.
  const cached = cacheGet('plants');
  if (cached?.plants) {
    state.plants = cached.plants;
    state.user = cached.user ?? state.user;
    state.ai = !!cached.user?.has_key;
    renderList({ animate: false });
  }
  route();
  if (fresh || shouldNagInstall()) openInstall({ consent: true });
  await refresh();
  refreshPushState();
}

async function refresh() {
  try {
    const { plants, ai, user } = await api('plants');
    state.plants = plants;
    state.ai = !!ai;
    state.user = user;
    cacheSet('plants', { plants, user });
    renderList();
    if (state.plantView) showPlant(state.plantView);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Status line. On the list a due plant shows the amount instead of the interval (the card is narrow). */
function metaText(p, { list = false } = {}) {
  const every = ` · ${t('co {n}', { n: days(p.interval) })}`;
  const tail = list && p.water_ml ? ` · ${t('ok. {ml} ml', { ml: p.water_ml })}` : every;
  if (p.days_left === null) return t('Brak daty podlania') + every;
  if (p.days_left > 0) return `${t(p.snoozed ? 'Odłożone · za' : 'Za')} ${days(p.days_left)}` + every;
  if (p.days_left === 0) return t('Dziś') + tail;
  return t('Spóźnione o {n}', { n: days(p.days_left) }) + tail;
}
const isDue = (p) => p.days_left !== null && p.days_left <= 0;

function fillPercent(p) {
  if (p.days_left === null) return 0;
  return Math.max(0, Math.min(1, p.days_left / p.interval)) * 100;
}

function renderList({ animate = true } = {}) {
  const tpl = $('#tpl-plant');
  const existing = new Map([...el.list.children].map((li) => [Number(li.dataset.id), li]));
  animate = animate && existing.size > 0; // first paint: bars sit at their value, no sweep
  const frag = document.createDocumentFragment();

  for (const p of state.plants) {
    let li = existing.get(p.id);
    if (!li) {
      li = tpl.content.firstElementChild.cloneNode(true);
      translateDom(li);
      li.dataset.id = p.id;
      li.querySelector('.plant-main').addEventListener('click', () => { location.hash = `plant/${p.id}`; });
      li.querySelector('.btn-water').addEventListener('click', () => water(p.id, li));
      li.querySelector('.btn-wet').addEventListener('click', () => openSnooze(state.plants.find((x) => x.id === p.id) ?? p));
    }
    li.querySelector('.btn-wet').hidden = !isDue(p);
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
    bar.setAttribute('aria-label', t('Wilgotność {pct}%', { pct: Math.round(pct) }));
    fill.classList.toggle('low', pct < 20);
    // Force a layout pass first so the width transition also runs for freshly created cards.
    if (animate && !existing.has(p.id)) fill.getBoundingClientRect();
    else if (!animate) fill.style.transition = 'none';
    fill.style.width = `${pct}%`;
    if (!animate) requestAnimationFrame(() => { fill.style.transition = ''; });
    li.querySelector('.plant-meta').textContent = metaText(p, { list: true });
    frag.appendChild(li);
  }
  el.list.replaceChildren(frag);
  el.empty.hidden = state.plants.length > 0;
}

// ---------------------------------------------------------------------------
// watering with a 5-second undo window
// The watering is saved immediately; the button turns into "Cofnij · 5…1" with a
// draining fill. Tapping it deletes that history row and restores the previous state.
// ---------------------------------------------------------------------------
const UNDO_MS = 5000;

function stopUndo(btn) {
  if (btn._undo) { clearInterval(btn._undo.iv); clearTimeout(btn._undo.to); }
  btn._undo = null;
  delete btn.dataset.wateringId;
  btn.classList.remove('undo');
  btn.textContent = t('Podlej');
}

function startUndo(btn, wateringId, onExpire) {
  btn.dataset.wateringId = String(wateringId);
  btn.classList.add('undo');
  let left = UNDO_MS / 1000;
  btn.innerHTML = `<span class="undo-fill" style="animation-duration:${UNDO_MS}ms"></span><span class="undo-label">${t('Cofnij · {s}', { s: left })}</span>`;
  const iv = setInterval(() => {
    left = Math.max(1, left - 1);
    const l = btn.querySelector('.undo-label');
    if (l) l.textContent = t('Cofnij · {s}', { s: left });
  }, 1000);
  const to = setTimeout(() => { stopUndo(btn); onExpire(); }, UNDO_MS);
  btn._undo = { iv, to };
}

/**
 * @param {object} h
 * @param {(plant:object)=>void} h.onWatered   immediate UI update after the watering is saved
 * @param {(plant:object|null, undone:boolean)=>void} h.onSettled   undo window ended (undone or expired)
 */
async function waterWithUndo(plantId, btn, h) {
  if (btn.dataset.wateringId) {
    const wateringId = Number(btn.dataset.wateringId);
    stopUndo(btn);
    btn.disabled = true;
    try {
      const { plant } = await api('unwater', { json: { watering_id: wateringId } });
      toast(t('Cofnięto podlanie.'));
      h.onSettled(plant, true);
    } catch (err) {
      toast(err.message, 'error');
      h.onSettled(null, true);
    } finally {
      btn.disabled = false;
    }
    return;
  }
  btn.disabled = true;
  try {
    const { plant, watering_id } = await api('water', { json: { id: plantId } });
    h.onWatered(plant);
    startUndo(btn, watering_id, () => h.onSettled(plant, false));
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

async function water(id, li) {
  const btn = li.querySelector('.btn-water');
  const put = (plant) => { const i = state.plants.findIndex((p) => p.id === id); if (i >= 0) state.plants[i] = plant; };
  await waterWithUndo(id, btn, {
    onWatered(plant) {
      put(plant);
      renderListInPlace(plant, li); // animate the bar in place; re-sort once the undo window closes
      toast(t('Podlano: {name}', { name: plant.name }));
    },
    onSettled(plant, undone) {
      if (plant) { put(plant); if (undone) renderListInPlace(plant, li); }
      state.plants.sort(sortPlants);
      renderList();
    },
  });
}

function sortPlants(a, b) {
  return (a.days_left ?? -9999) - (b.days_left ?? -9999) || a.name.localeCompare(b.name, 'pl');
}

function renderListInPlace(p, li) {
  li.classList.toggle('is-overdue', p.days_left !== null && p.days_left < 0);
  li.classList.toggle('is-today', p.days_left === 0);
  li.querySelector('.btn-wet').hidden = !isDue(p);
  const fill = li.querySelector('.bar-fill');
  const pct = fillPercent(p);
  fill.classList.toggle('low', pct < 20);
  fill.style.width = `${pct}%`;
  li.querySelector('.plant-meta').textContent = metaText(p, { list: true });
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
  closeSelect();
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

// Swipe-down to dismiss. Starts on the handle/header, or on the body only when it is scrolled to the
// very top and the finger moves clearly downwards — so normal scrolling inside the sheet is untouched.
// Release: past 30 % of the sheet's height, or a quick flick (> 0.6 px/ms) → close; otherwise snap back.
let drag = null;
function dragStart(x, y, target) {
  const fromHead = !!target.closest('.sheet-handle, .sheet-head');
  const bodyAtTop = el.sheetBody.contains(target) && el.sheetBody.scrollTop <= 0 && !target.closest('input, textarea, select');
  if (!fromHead && !bodyAtTop) return;
  drag = { x0: x, y0: y, dy: 0, active: false, fromHead, samples: [] };
}
function dragMove(x, y) {
  if (!drag) return false;
  const dy = y - drag.y0;
  const dx = x - drag.x0;
  if (!drag.active) {
    const claim = drag.fromHead ? Math.abs(dy) > 4 : dy > 10 && dy > Math.abs(dx) * 1.5;
    if (!claim) {
      if (!drag.fromHead && (dy < -4 || Math.abs(dx) > 10)) drag = null; // a scroll or a horizontal move: not ours
      return false;
    }
    drag.active = true;
    el.sheet.style.transition = 'none';
    el.backdrop.style.transition = 'none';
  }
  drag.dy = Math.max(0, dy);
  drag.samples.push([performance.now(), drag.dy]);
  if (drag.samples.length > 6) drag.samples.shift();
  el.sheet.style.transform = `translateY(${drag.dy}px)`;
  el.backdrop.style.opacity = String(1 - Math.min(1, drag.dy / el.sheet.offsetHeight) * 0.85);
  return true;
}
function dragEnd() {
  if (!drag) return;
  const d = drag;
  drag = null;
  el.sheet.style.transition = '';
  el.backdrop.style.transition = '';
  el.sheet.style.transform = '';
  el.backdrop.style.opacity = '';
  if (!d.active) return;
  const [t0, y0] = d.samples[0];
  const [t1, y1] = d.samples[d.samples.length - 1];
  const velocity = t1 > t0 ? (y1 - y0) / (t1 - t0) : 0; // px/ms over the last few samples
  if (d.dy > el.sheet.offsetHeight * 0.3 || (velocity > 0.6 && d.dy > 24)) closeSheet();
}
el.sheet.addEventListener('touchstart', (e) => dragStart(e.touches[0].clientX, e.touches[0].clientY, e.target), { passive: true });
el.sheet.addEventListener('touchmove', (e) => { if (dragMove(e.touches[0].clientX, e.touches[0].clientY)) e.preventDefault(); }, { passive: false });
el.sheet.addEventListener('touchend', dragEnd);
el.sheet.addEventListener('touchcancel', dragEnd);
el.sheet.addEventListener('mousedown', (e) => { if (e.button === 0 && e.target.closest('.sheet-handle, .sheet-head') && !e.target.closest('button')) { dragStart(e.clientX, e.clientY, e.target); e.preventDefault(); } });
document.addEventListener('mousemove', (e) => { if (drag) dragMove(e.clientX, e.clientY); });
document.addEventListener('mouseup', dragEnd);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !el.sheet.hidden) closeSheet(); });

// ---------------------------------------------------------------------------
// add: step 1 — identify
// ---------------------------------------------------------------------------
$('#btn-add').addEventListener('click', openAdd);

function openAdd() {
  openSheet(t('Nowa roślina'));
  el.sheetBody.innerHTML = `
    <div class="identify">
      <div class="photo-pick">
        <button type="button" class="btn btn-primary" tabindex="-1">${t('Zrób zdjęcie / wybierz z galerii')}</button>
        <input type="file" accept="image/*" id="photo-input" aria-label="${t('Zdjęcie rośliny')}">
      </div>
      <img class="photo-preview" id="photo-preview" alt="${t('Podgląd zdjęcia')}" hidden>
      <p class="status" id="identify-status"></p>
      <ul class="results" id="results"></ul>
      <div class="divider">${t('albo')}</div>
      <form class="manual" id="manual-form">
        <input type="text" id="manual-name" placeholder="${t('Wpiszę nazwę sam, np. Monstera deliciosa')}" aria-label="${t('Nazwa łacińska lub potoczna')}" autocomplete="off">
        <button type="submit" class="btn btn-primary">${t('Dalej')}</button>
      </form>
    </div>`;

  const draft = { thumb: null, full: null };

  $('#photo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const status = $('#identify-status');
    const results = $('#results');
    results.replaceChildren();
    status.textContent = t('Przygotowuję zdjęcie…');
    try {
      const { upload, thumb, full } = await processImage(file);
      draft.thumb = thumb;
      draft.full = full;
      const preview = $('#photo-preview');
      preview.src = thumb;
      preview.hidden = false;
      status.textContent = t('Rozpoznaję przez Pl@ntNet…');
      const form = new FormData();
      form.append('image', upload, 'photo.jpg');
      const { results: list } = await api('identify', { form });
      status.textContent = list.length ? t('Wybierz właściwe trafienie:') : t('Brak trafień — wpisz nazwę ręcznie.');
      renderResults(list, draft);
    } catch (err) {
      status.textContent = err.message + ' ' + t('Możesz wpisać nazwę ręcznie poniżej.');
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
      openForm({ species, common: '', genus: '', family: '', profile, thumb: draft.thumb, full: draft.full });
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
    li.querySelector('button').addEventListener('click', () => openForm({ ...r, thumb: draft.thumb, full: draft.full }));
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
  const full = c1.toDataURL('image/jpeg', 0.82); // stored next to the thumbnail for the lightbox

  bitmap.close?.();
  return { upload, thumb, full };
}

// ---------------------------------------------------------------------------
// step 2 — conditions form (add + edit)
// ---------------------------------------------------------------------------
function openEdit(id) {
  const p = state.plants.find((x) => x.id === id);
  if (!p) return;
  openSheet(t('Edycja rośliny'));
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
      <span class="thumb ${photoSrc ? 'has-photo' : ''}" id="form-thumb"><img alt="" ${photoSrc ? `src="${esc(photoSrc)}"` : ''}></span>
      <div>
        <div class="sci">${esc(ctx.species) || '—'}</div>
        <div class="com">${esc(commonName)}</div>
      </div>
    </div>
    <div class="photo-actions">
      <span class="btn pick">${t(photoSrc ? 'Zmień zdjęcie' : 'Dodaj zdjęcie')}<input type="file" accept="image/*" id="form-photo" aria-label="${t('Zdjęcie rośliny')}"></span>
      <button type="button" class="btn btn-ghost" id="form-photo-remove" ${photoSrc ? '' : 'hidden'}>${t('Usuń zdjęcie')}</button>
    </div>
    <div class="preview" id="preview" aria-live="polite">
      <strong id="preview-days"></strong>
      ${t('w tych warunkach, o tej porze roku')}
      <span class="chip level-${esc(ctx.profile.level)}">${esc(ctx.profile.label)} · ${LEVEL_LABEL[ctx.profile.level]}</span>
      <div class="note">${esc(ctx.profile.note)}</div>
    </div>
    <form id="plant-form" autocomplete="off">
      <div class="field">
        <label for="f-name">${t('Nazwa własna')}</label>
        <input type="text" id="f-name" name="name" maxlength="80" required value="${esc(defaultName)}">
      </div>
      <div class="field">
        <label for="f-pot">${t('Średnica doniczki')}: <span class="range-value" id="pot-value">${v.pot_cm ?? 15}</span> cm</label>
        <input type="range" id="f-pot" name="pot_cm" min="6" max="40" step="1" value="${v.pot_cm ?? 15}">
      </div>
      <div class="field-row">
        <div class="field">
          <label for="f-material">${t('Doniczka')}</label>
          <select id="f-material" name="pot_material">${options(MATERIALS, v.pot_material ?? 'ceramic')}</select>
        </div>
        <div class="field">
          <label for="f-light">${t('Światło')}</label>
          <select id="f-light" name="light">${options(LIGHTS, v.light ?? 'bright')}</select>
        </div>
      </div>
      <p class="hint">${t('Liczy się doniczka, w której są korzenie. Osłonka nie ma znaczenia — chyba że po podlaniu zostaje w niej woda, wtedy wybierz „bez otworów”.')}</p>
      <div class="field">
        <label class="check"><input type="checkbox" id="f-dry" name="dry_air" ${v.dry_air ? 'checked' : ''}> ${t('Suche powietrze / blisko grzejnika')}</label>
      </div>
      <div class="field">
        <label for="f-last">${t('Ostatnie podlanie')}</label>
        <input type="date" id="f-last" name="last_watered" value="${esc(v.last_watered ?? todayStr())}" max="${todayStr()}">
      </div>
      <div class="field">
        <label for="f-note">${t('Notatka')}</label>
        <textarea id="f-note" name="note" maxlength="500">${esc(v.note ?? '')}</textarea>
      </div>
      <div class="form-actions">
        ${isEdit ? `<button type="button" class="btn btn-danger" id="f-delete">${t('Usuń')}</button>` : ''}
        <button type="submit" class="btn btn-primary">${t(isEdit ? 'Zapisz zmiany' : 'Dodaj roślinę')}</button>
      </div>
    </form>`;

  const form = $('#plant-form');
  const draft = { photo: undefined, full: null }; // photo: undefined = unchanged, data URL = new thumbnail, null = remove
  const setThumb = (src) => {
    const t = $('#form-thumb');
    t.classList.toggle('has-photo', !!src);
    t.querySelector('img').src = src || '';
    $('#form-photo-remove').hidden = !src;
    $('.photo-actions .pick').firstChild.textContent = t(src ? 'Zmień zdjęcie' : 'Dodaj zdjęcie');
  };
  $('#form-photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { thumb, full } = await processImage(file);
      draft.photo = thumb;
      draft.full = full;
      setThumb(thumb);
    } catch { toast(t('Nie udało się przetworzyć zdjęcia.'), 'error'); }
  });
  $('#form-photo-remove').addEventListener('click', () => { draft.photo = null; setThumb(null); });

  const update = () => {
    const d = estimate({
      base_summer: ctx.profile.summer,
      base_winter: ctx.profile.winter,
      pot_cm: form.pot_cm.value,
      pot_material: form.pot_material.value,
      light: form.light.value,
      dry_air: form.dry_air.checked,
      interval_adjust: v.interval_adjust,
    });
    $('#preview-days').textContent = t('co {n}', { n: days(d) });
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
      if (draft.photo !== undefined) { payload.photo = draft.photo; payload.photo_full = draft.full; }
      else if (ctx.thumb) { payload.photo = ctx.thumb; payload.photo_full = ctx.full ?? null; }
      const { plant } = await api('save', { json: payload });
      toast(t(isEdit ? 'Zapisano.' : 'Dodano roślinę.'));
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
    if (!confirm(t('Usunąć „{name}”?', { name: form.name.value }))) return;
    try {
      await api('delete', { json: { id: ctx.id } });
      localStorage.removeItem(`${CACHE_PREFIX}plant.${ctx.id}`);
      toast(t('Usunięto.'));
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
    t('Service worker nie jest aktywny. Zamknij aplikację całkowicie, otwórz ponownie i spróbuj jeszcze raz.'))), ms));
  const reg = await Promise.race([navigator.serviceWorker.ready, timeout]);
  return reg;
}

async function refreshPushState() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.btnPush.setAttribute('aria-pressed', 'false');
    el.pushState.textContent = t(isIOS && !isStandalone ? 'po instalacji' : 'brak');
    return;
  }
  try {
    const reg = await swReady();
    state.pushSub = await reg.pushManager.getSubscription();
  } catch { state.pushSub = null; }
  el.btnPush.setAttribute('aria-pressed', state.pushSub ? 'true' : 'false');
  el.pushState.textContent = t(state.pushSub ? 'wł.' : 'wył.');
}

el.btnPush.addEventListener('click', async () => {
  closeMenu();
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast(isIOS && !isStandalone
      ? t('Na iPhonie dodaj greenLy do ekranu początkowego i włącz powiadomienia z ikony.')
      : t('Ta przeglądarka nie obsługuje powiadomień push.'), 'error', 5000);
    return;
  }
  el.btnPush.disabled = true;
  try {
    const reg = await swReady();
    if (state.pushSub) {
      await api('unsubscribe', { json: { endpoint: state.pushSub.endpoint } });
      await state.pushSub.unsubscribe();
      state.pushSub = null;
      toast(t('Powiadomienia wyłączone.'));
    } else {
      const { publicKey } = await api('vapid');
      if (!publicKey) throw new Error(t('Serwer nie ma skonfigurowanych kluczy VAPID.'));
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error(t('Brak zgody na powiadomienia.'));
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });
      await api('subscribe', { json: sub.toJSON() });
      state.pushSub = sub;
      toast(t('Powiadomienia włączone.'));
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
const STATUS_LABEL = { healthy: t('W porządku'), watch: t('Obserwuj'), sick: t('Wymaga działania') };
const CONF_LABEL = { low: t('niska pewność'), medium: t('średnia pewność'), high: t('wysoka pewność') };
const MODE_LABEL = { checkup: t('Kontrola'), doctor: t('Doktor') };
// USD per 1M tokens (input, output) — only for the approximate cost shown under each analysis.
const PRICES = { 'claude-opus-5': [5, 25], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5] };

const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? key;
const fmtDate = (iso) => new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

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
  const switching = state.plantView !== id || !el.plantView.childElementCount;
  state.plantView = id;
  el.app.hidden = true;
  el.plantView.hidden = false;
  if (switching) {
    // Last known data of this plant paints at once; only a never-opened plant gets the skeleton.
    const cached = cacheGet(`plant.${id}`);
    if (cached) { state.plantJson = JSON.stringify(cached); renderPlant(cached); }
    else { state.plantJson = null; renderPlantSkeleton(state.plants.find((p) => p.id === id)); }
    window.scrollTo(0, 0);
  }
  try {
    const data = await api(`plant/${id}`);
    if (state.plantView !== id) return;
    state.ai = !!data.ai;
    const json = JSON.stringify(data);
    cacheSet(`plant.${id}`, data);
    if (json === state.plantJson) return; // nothing changed — keep the DOM (and the scroll position) as is
    state.plantJson = json;
    renderPlant(data);
  } catch (err) {
    toast(err.message, 'error');
    location.hash = '';
  }
}

/** Instant header from the list data plus placeholder blocks — shown until /api/plant answers. */
function renderPlantSkeleton(p) {
  window.scrollTo(0, 0);
  const photo = p ? photoUrl(p) : null;
  const pct = p ? fillPercent(p) : 0;
  el.plantView.innerHTML = `
    <a class="back" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>${t('Rośliny')}</a>
    <div class="pv-head">
      <span class="thumb ${photo ? 'has-photo' : ''}"><img alt="" ${photo ? `src="${esc(photo)}"` : ''}></span>
      <div>
        <h1>${p ? esc(p.name) : '&nbsp;'}</h1>
        <div class="sci">${p ? (esc(p.species) || '—') : ''}</div>
        ${p ? `<div class="chips"><span class="chip soft level-${esc(p.match_level)}">${esc(p.group_label)} · ${LEVEL_LABEL[p.match_level]}</span></div>` : ''}
      </div>
    </div>
    ${p ? `<div class="pv-status ${p.days_left !== null && p.days_left < 0 ? 'is-overdue' : ''} ${p.days_left === 0 ? 'is-today' : ''}">
      <span class="bar ${p.days_left === null ? 'unknown' : ''}"><span class="bar-fill ${pct < 20 ? 'low' : ''}" style="width:${pct}%"></span></span>
      <span class="plant-meta">${esc(metaText(p))}</span>
      <button type="button" class="btn btn-water" disabled>${t('Podlej')}</button>
    </div>` : '<div class="skel" style="min-height:58px;margin-bottom:12px"></div>'}
    <div class="pv-actions"><button class="btn btn-soft" disabled>${t('Kontrola')}</button><button class="btn btn-soft" disabled>${t('Doktor')}</button><button class="btn" disabled>${t('Edytuj')}</button></div>
    <div class="pv-actions two"><button class="btn" disabled>${t('+ Zdarzenie')}</button><button class="btn" disabled>${t('Rozsadź')}</button></div>
    <section class="section"><h2>${t('Warunki')}</h2><div class="skel" style="min-height:120px"></div></section>
    <section class="section"><h2>${t('Jak dbać')}</h2><div class="skel" style="min-height:140px"></div></section>
    <section class="section"><h2>${t('Historia')}</h2><div class="skel"></div></section>`;
}

function approxCost(check) {
  const p = PRICES[check.model];
  if (!p || check.input_tokens == null) return '';
  const usd = (check.input_tokens * p[0] + (check.output_tokens ?? 0) * p[1]) / 1e6;
  return ` · ≈ $${usd.toFixed(3)}`;
}

function renderPlant({ plant: p, care, waterings, checks, events = [] }) {
  const photo = photoUrl(p);
  const pct = fillPercent(p);
  const intervals = [];
  for (let i = 0; i + 1 < waterings.length; i++) {
    intervals.push((new Date(waterings[i].ts) - new Date(waterings[i + 1].ts)) / 86400000);
  }
  const avg = intervals.length ? Math.round(intervals.reduce((a, b) => a + b, 0) / intervals.length) : null;
  const answered = new Set(checks.map((c) => c.parent_id).filter(Boolean));

  el.plantView.innerHTML = `
    <a class="back" href="#"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>${t('Rośliny')}</a>
    <div class="pv-head">
      ${photo ? `<button type="button" class="thumb has-photo thumb-btn" id="pv-photo" aria-label="${t('Powiększ zdjęcie')}"><img alt="" src="${esc(photo)}"></button>` : '<span class="thumb"><img alt=""></span>'}
      <div>
        <h1>${esc(p.name)}</h1>
        <div class="sci">${esc(p.species) || '—'}${p.common ? ` · ${esc(p.common)}` : ''}</div>
        <div class="chips"><span class="chip soft level-${esc(p.match_level)}">${esc(p.group_label)} · ${LEVEL_LABEL[p.match_level]}</span></div>
      </div>
    </div>
    <div class="pv-status ${p.days_left !== null && p.days_left < 0 ? 'is-overdue' : ''} ${p.days_left === 0 ? 'is-today' : ''}">
      <span class="bar ${p.days_left === null ? 'unknown' : ''}"><span class="bar-fill ${pct < 20 ? 'low' : ''}" style="width:${pct}%"></span></span>
      <span class="plant-meta">${esc(metaText(p))}</span>
      <button type="button" class="btn btn-water" id="pv-water">${t('Podlej')}</button>
    </div>
    <p class="pv-ml">
      <span>${p.water_mode === 'soak'
        ? t('Zamiast porcji: <b>zanurz doniczkę</b> w letniej wodzie na 10–15 min, potem odsącz.')
        : t('Na raz ok. <b>{ml} ml</b> — aż woda pokaże się w podstawce, nadmiar wylej.', { ml: p.water_ml })}${p.ml_adjust < 1 || p.interval_adjust > 1
        ? ` <span class="learned" title="${t('Nauczone z „Nadal mokro”: porcja ×{ml}, interwał ×{iv}', { ml: p.ml_adjust, iv: p.interval_adjust })}">${t('↓ dopasowane')}</span>` : ''}</span>
      <button type="button" class="btn btn-wet" id="pv-wet" ${isDue(p) ? '' : 'hidden'}>${t('Nadal mokro')}</button>
    </p>
    <div class="pv-actions">
      <button type="button" class="btn btn-soft ${state.ai ? '' : 'needs-key'}" id="pv-checkup">${t('Kontrola')}</button>
      <button type="button" class="btn btn-soft ${state.ai ? '' : 'needs-key'}" id="pv-doctor">${t('Doktor')}</button>
      <button type="button" class="btn" id="pv-edit">${t('Edytuj')}</button>
    </div>
    <div class="pv-actions two">
      <button type="button" class="btn" id="pv-event">${t('+ Zdarzenie')}</button>
      <button type="button" class="btn" id="pv-split">${t('Rozsadź')}</button>
    </div>

    <section class="section">
      <h2>${t('Warunki')}</h2>
      <div class="card"><dl class="kv">
        <dt>${t('Doniczka')}</dt><dd>${p.pot_cm} cm · ${esc(label(MATERIALS, p.pot_material))}</dd>
        <dt>${t('Światło')}</dt><dd>${esc(label(LIGHTS, p.light))}</dd>
        <dt>${t('Powietrze')}</dt><dd>${t(p.dry_air ? 'suche / grzejnik w pobliżu' : 'normalne')}</dd>
        <dt>${t('Podlewanie')}</dt><dd>${t('co {n}', { n: days(p.interval) })} ${t('o tej porze roku')}${avg ? ` · ${t('faktycznie średnio co {n}', { n: days(avg) })}` : ''}</dd>
        ${p.note ? `<dt>${t('Notatka')}</dt><dd>${esc(p.note)}</dd>` : ''}
      </dl></div>
    </section>

    <section class="section">
      <h2>${t('Jak dbać — {label}', { label: esc(care.label) })}</h2>
      <div class="card care">
        <p><b>${t('Światło')}:</b> ${esc(care.light)}</p>
        <p><b>${t('Wilgotność')}:</b> ${esc(care.humidity)}</p>
        <p><b>${t('Temperatura')}:</b> ${esc(care.temp)}</p>
        <p><b>${t('Gdzie postawić')}:</b> ${esc(care.placement)}</p>
        <p><b>${t('Podlewanie')}:</b> ${esc(care.note)}</p>
      </div>
    </section>

    <section class="section" id="pv-profile">
      <h2>${t('Profil gatunku')}</h2>
      ${p.profile ? renderProfile(p.profile) : `<div class="card"><p class="muted" style="margin:0 0 10px">${t('Szczegółowy opis gatunku napisany przez AI: pochodzenie, światło, podlewanie, nawożenie, przesadzanie, toksyczność dla zwierząt, typowe problemy.')}</p>
        <button type="button" class="btn btn-soft ${state.ai ? '' : 'needs-key'}" id="pv-gen-profile">${t('Opisz gatunek')}</button></div>`}
    </section>

    <section class="section">
      <h2>${t('Analizy')}</h2>
      ${checks.length ? `<ul class="check-list">${checks.map((c) => renderCheck(c)).join('')}</ul>`
        : `<p class="muted">${t('Jeszcze żadnej. „Kontrola” ocenia ogólny stan i warunki, „Doktor” szuka przyczyny konkretnego problemu.')}</p>`}
    </section>

    <section class="section" id="pv-history">
      <h2>${t('Historia')}</h2>
      <div class="filters" role="tablist">
        ${[['all', t('Wszystko')], ['care', t('Zabiegi')], ['water', t('Podlewania')], ['ai', t('Analizy')]].map(([k, l]) => `<button type="button" class="chip ${histFilter === k ? 'active' : ''}" data-f="${k}">${l}</button>`).join('')}
      </div>
      <ul class="timeline" id="timeline"></ul>
    </section>`;

  const put = (plant) => { const i = state.plants.findIndex((x) => x.id === p.id); if (i >= 0) state.plants[i] = plant; };
  $('#pv-water').addEventListener('click', (e) => waterWithUndo(p.id, e.currentTarget, {
    onWatered(plant) { put(plant); renderStatusInPlace(plant); toast(t('Podlano: {name}', { name: plant.name })); },
    onSettled(plant) { if (plant) put(plant); showPlant(p.id); },
  }));
  $('#pv-event').addEventListener('click', () => openEventPicker(p));
  $('#pv-split').addEventListener('click', () => openSplitForm(p));
  $('#pv-wet').addEventListener('click', () => openSnooze(p));
  $('#pv-photo')?.addEventListener('click', () => openLightbox(p.photo_full ? photoSrc(p.photo_full) : photo));

  const items = buildTimeline({ plant: p, waterings, checks, events, answered });
  const drawTimeline = () => {
    const list = histFilter === 'all' ? items : items.filter((it) => it.cat === histFilter);
    $('#timeline').innerHTML = list.length ? list.map(renderTimelineItem).join('')
      : `<li class="tl-empty">${t('Nic tu jeszcze nie ma.')}</li>`;
    for (const li of $('#timeline').querySelectorAll('.tl-item')) {
      const it = items.find((x) => x.key === li.dataset.key);
      if (!it) continue;
      if (it.check) li.addEventListener('click', (e) => { if (!e.target.closest('.btn-x')) openCheckSheet(it.check, p.id, answered.has(it.check.id)); });
      li.querySelector('.btn-x')?.addEventListener('click', async () => {
        if (!confirm(t('Usunąć: {title} ({when})?', { title: it.title, when: fmtDateTime(it.ts) }))) return;
        try {
          const { plant } = await api(it.kind === 'water' ? 'unwater' : 'unevent', { json: it.kind === 'water' ? { watering_id: it.id } : { event_id: it.id } });
          put(plant);
          toast(t('Usunięto.'));
          showPlant(p.id);
        } catch (err) { toast(err.message, 'error'); }
      });
    }
  };
  drawTimeline();
  for (const chip of el.plantView.querySelectorAll('.filters .chip')) {
    chip.addEventListener('click', () => {
      histFilter = chip.dataset.f;
      for (const c of el.plantView.querySelectorAll('.filters .chip')) c.classList.toggle('active', c === chip);
      drawTimeline();
    });
  }
  $('#pv-edit').addEventListener('click', () => openEdit(p.id));
  $('#pv-checkup').addEventListener('click', () => withAi(() => openCheck(p, 'checkup')));
  $('#pv-doctor').addEventListener('click', () => withAi(() => openCheck(p, 'doctor')));
  $('#pv-gen-profile')?.addEventListener('click', (e) => withAi(() => generateProfile(p.id, e.target)));
  $('#pv-refresh-profile')?.addEventListener('click', (e) => withAi(() => generateProfile(p.id, e.target, true)));

  for (const head of el.plantView.querySelectorAll('.check-head')) {
    head.addEventListener('click', () => {
      const c = checks.find((x) => x.id === Number(head.dataset.id));
      if (c) openCheckSheet(c, p.id, answered.has(c.id));
    });
  }
}

/** Updates the status card of the open profile without re-rendering the whole view (keeps the undo button alive). */
function renderStatusInPlace(p) {
  const st = $('.pv-status', el.plantView);
  if (!st) return;
  st.classList.toggle('is-overdue', p.days_left !== null && p.days_left < 0);
  st.classList.toggle('is-today', p.days_left === 0);
  const pct = fillPercent(p);
  const fill = st.querySelector('.bar-fill');
  fill.classList.toggle('low', pct < 20);
  fill.style.width = `${pct}%`;
  st.querySelector('.plant-meta').textContent = metaText(p);
  const wet = $('#pv-wet');
  if (wet) wet.hidden = !isDue(p);
}

// ---------------------------------------------------------------------------
// "still wet": push the reminder instead of watering into soggy soil
// ---------------------------------------------------------------------------
function openSnooze(p) {
  openSheet(t('Nadal mokro: {name}', { name: p.name }));
  el.sheetBody.innerHTML = `
    <div class="preview" style="margin-bottom:14px">
      <strong>${t('Nie podlewaj')}</strong>
      ${t('dopóki 2–3 cm podłoża pod powierzchnią nie przeschną. Sprawdź palcem albo patyczkiem.')}
      <div class="note">${p.water_mode === 'soak' ? t('Storczyk: moczysz doniczkę zamiast lać porcję, więc') : t('Plan zakłada ok. <b>{ml} ml</b> na raz przy tej doniczce. Jeśli ziemia jest mokra po tylu dniach,', { ml: p.water_ml })} ${t('przy następnym podlaniu')} ${t(p.water_mode === 'soak' ? 'skróć moczenie' : 'wlej mniej')} ${t('albo sprawdź, czy w osłonce nie stoi woda.')}</div>
    </div>
    <p class="muted" style="margin:0 0 8px">${t('Przypomnę ponownie za:')}</p>
    <div class="snooze-grid">
      ${[1, 2, 3, 5].map((d) => `<button type="button" class="btn ${d === 2 ? 'btn-soft' : ''}" data-days="${d}">${days(d)}</button>`).join('')}
    </div>
    <div class="field" style="margin-top:14px"><label for="snooze-note">${t('Notatka (opcjonalnie)')}</label><input type="text" id="snooze-note" maxlength="200" placeholder="${t('np. osłonka była pełna wody')}"></div>
    <p class="hint">${t('Odłożenie trafia do historii. Gdy powtórzy się w tym samym cyklu albo dwa cykle z rzędu, greenLy sam zmniejszy porcję o 15 % i wydłuży interwał o 10 % dla tej rośliny; trzy spokojne cykle przywracają normę.')}${p.ml_adjust < 1 || p.interval_adjust > 1 ? ' ' + t('Teraz: porcja ×{ml}, interwał ×{iv}.', { ml: p.ml_adjust, iv: p.interval_adjust }) : ''}</p>`;
  for (const b of el.sheetBody.querySelectorAll('.snooze-grid .btn')) {
    b.addEventListener('click', async () => {
      const d = Number(b.dataset.days);
      for (const x of el.sheetBody.querySelectorAll('.snooze-grid .btn')) x.disabled = true;
      try {
        const { plant, learned } = await api('postpone', { json: { id: p.id, days: d, note: $('#snooze-note').value.trim() } });
        const i = state.plants.findIndex((x) => x.id === p.id);
        if (i >= 0) state.plants[i] = plant;
        toast(learned
          ? t('Przypomnę za {n}. Ta roślina dostaje mniej: {portion}, co {every}.', { n: days(d), portion: plant.water_mode === 'soak' ? t('krótsze moczenie') : t('ok. {ml} ml', { ml: plant.water_ml }), every: days(plant.interval) })
          : t('Przypomnę za {n}.', { n: days(d) }), 'info', learned ? 6000 : 3200);
        closeSheet();
        state.plants.sort(sortPlants);
        renderList();
        if (state.plantView === p.id) showPlant(p.id);
      } catch (err) {
        toast(err.message, 'error');
        for (const x of el.sheetBody.querySelectorAll('.snooze-grid .btn')) x.disabled = false;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// lightbox: tap a photo to see it full screen; double-tap toggles 2.5× zoom
// ---------------------------------------------------------------------------
const lightbox = $('#lightbox');
const lightboxImg = $('#lightbox-img');
function openLightbox(src) {
  lightboxImg.src = src;
  lightboxImg.classList.remove('zoomed');
  lightbox.hidden = false;
  void lightbox.offsetHeight;
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
}
function closeLightbox() {
  if (lightbox.hidden) return;
  lightbox.classList.remove('open');
  document.body.style.overflow = el.sheet.hidden ? '' : 'hidden';
  const finish = () => { lightbox.hidden = true; lightboxImg.src = ''; };
  if (reduceMotion.matches) finish(); else setTimeout(finish, 220);
}
$('#lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });
lightboxImg.addEventListener('dblclick', () => lightboxImg.classList.toggle('zoomed'));
let lastTap = 0;
lightboxImg.addEventListener('touchend', (e) => {
  const now = Date.now();
  if (now - lastTap < 300) { e.preventDefault(); lightboxImg.classList.toggle('zoomed'); }
  lastTap = now;
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
el.sheetBody.addEventListener('click', (e) => {
  const img = e.target.closest('.check-photos img');
  if (img) openLightbox(img.src);
});

function renderProfile(pr) {
  const row = (k, v) => (v ? `<p><b>${k}:</b> ${esc(v)}</p>` : '');
  return `<div class="card care">
    ${row(t('Pochodzenie'), pr.origin)}${row(t('Światło'), pr.light)}${row(t('Podlewanie'), pr.watering)}${row(t('Wilgotność'), pr.humidity)}
    ${row(t('Temperatura'), pr.temperature)}${row(t('Podłoże i doniczka'), pr.soil_and_pot)}${row(t('Nawożenie'), pr.fertilizing)}
    ${row(t('Przesadzanie'), pr.repotting)}${row(t('Zwierzęta'), pr.pets)}${row(t('Gdzie postawić'), pr.placement)}
    ${pr.common_problems?.length ? `<p><b>${t('Typowe problemy:')}</b></p><ul>${pr.common_problems.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="inline-actions"><button type="button" class="btn btn-soft ${state.ai ? '' : 'needs-key'}" id="pv-refresh-profile">${t('Napisz od nowa')}</button></div>
  </div>`;
}

async function generateProfile(id, btn, refresh = false) {
  const card = btn.closest('.card');
  const saved = card.innerHTML;
  const think = startThinking(card, 'profile');
  try {
    await api('profile', { json: { id, refresh } });
    think.finish();
    toast(t('Opis gotowy.'));
    setTimeout(() => showPlant(id), reduceMotion.matches ? 0 : 400);
  } catch (err) {
    think.fail();
    card.innerHTML = saved;
    $('#pv-gen-profile')?.addEventListener('click', (e) => withAi(() => generateProfile(id, e.target)));
    $('#pv-refresh-profile')?.addEventListener('click', (e) => withAi(() => generateProfile(id, e.target, true)));
    toast(err.message, 'error', 6000);
  }
}

function renderResult(r) {
  return `
    <span class="verdict ${esc(r.status)}">${STATUS_LABEL[r.status] ?? esc(r.status)}</span>
    <p style="margin:4px 0 8px">${esc(r.summary)}</p>
    ${r.findings?.length ? `<ul class="findings">${r.findings.map((f) => `<li><b>${esc(f.observation)}</b> → ${esc(f.likely_cause)} <span class="conf">(${CONF_LABEL[f.confidence] ?? esc(f.confidence)})</span></li>`).join('')}</ul>` : ''}
    ${r.actions?.length ? `<p style="margin:8px 0 0"><b>${t('Co zrobić:')}</b></p><ol class="actions-list">${r.actions.map((a) => `<li>${esc(a)}</li>`).join('')}</ol>` : ''}
    ${r.watering ? `<p style="margin:8px 0 0"><b>${t('Podlewanie:')}</b> ${esc(r.watering)}</p>` : ''}`;
}

const photoSrc = (url) => `${url}?t=${encodeURIComponent(state.user?.photo_token ?? '')}`;

/** One row in the analyses list; details open in the sheet. */
function renderCheck(c) {
  const r = c.result ?? {};
  const thumb = c.photos?.[0] ?? c.photo;
  return `<li class="check">
    <button type="button" class="check-head" data-id="${c.id}">
      <span class="thumb ${thumb ? 'has-photo' : ''}"><img alt="" loading="lazy" ${thumb ? `src="${esc(photoSrc(thumb))}"` : ''}></span>
      <span class="title">
        <span class="row"><span class="dot ${esc(r.status)}"></span>${esc(r.title || STATUS_LABEL[r.status] || t('Analiza'))}</span>
        <span class="mode">${MODE_LABEL[c.mode] ?? esc(c.mode)}${c.parent_id ? ` · ${t('dopytanie')}` : ''}${r.questions?.length ? ` · ${t('pyta')}` : ''}</span>
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
      <b>${t(answered ? 'Pytania (odpowiedziano)' : 'Doktor pyta:')}</b>
      <ol>${r.questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
      ${answered ? '' : `<form class="answer-form" data-parent="${c.id}">
        <textarea name="text" placeholder="${t('Odpowiedz po kolei…')}" required></textarea>
        <button type="submit" class="btn btn-primary btn-block">${t('Odpowiedz i zaktualizuj diagnozę')}</button>
      </form>`}
    </div>` : ''}
    <p class="usage">${fmtDateTime(c.ts)} · ${esc(c.model || '')}${c.input_tokens != null ? ` · ${c.input_tokens}+${c.output_tokens ?? 0} ${t('tokenów')}` : ''}${approxCost(c)}</p>`;
}

function openCheckSheet(c, plantId, answered) {
  openSheet(c.result?.title || MODE_LABEL[c.mode] || t('Analiza'));
  fillCheckSheet(c, plantId, answered);
}

function fillCheckSheet(c, plantId, answered) {
  el.sheetTitle.textContent = c.result?.title || MODE_LABEL[c.mode] || t('Analiza');
  el.sheetBody.innerHTML = `${renderCheckDetails(c, answered)}
    <button type="button" class="btn btn-block" id="check-close" style="margin-top:12px">${t('Zamknij')}</button>`;
  el.sheetBody.scrollTop = 0;
  $('#check-close').addEventListener('click', closeSheet);
  $('.answer-form', el.sheetBody)?.addEventListener('submit', (e) => submitFollowUp(e, plantId));
}

async function submitFollowUp(e, plantId) {
  e.preventDefault();
  const form = e.target;
  const answer = form.text.value.trim();
  const host = document.createElement('div');
  form.insertAdjacentElement('afterend', host);
  form.hidden = true;
  const think = startThinking(host, 'followup');
  try {
    const fd = new FormData();
    fd.append('id', plantId);
    fd.append('parent_id', form.dataset.parent);
    fd.append('text', answer);
    const { check } = await api('health', { form: fd });
    think.finish();
    toast(t('Diagnoza zaktualizowana.'));
    setTimeout(() => fillCheckSheet(check, plantId, false), reduceMotion.matches ? 0 : 500);
    showPlant(plantId); // refresh the list behind the sheet
  } catch (err) {
    think.fail();
    host.remove();
    form.hidden = false;
    toast(err.message, 'error', 6000);
  }
}

// ---------------------------------------------------------------------------
// "thinking" panel shown while Claude works — rotating messages, a progress bar
// paced by an estimate learned from previous runs, elapsed/expected time
// ---------------------------------------------------------------------------
const THINK_TEXTS = {
  checkup: [
    'Oglądam zdjęcia', 'Sprawdzam liście i ich kolor', 'Patrzę na końcówki i brzegi liści', 'Szukam plam, przebarwień i śladów szkodników',
    'Oceniam turgor — czy liście są jędrne', 'Porównuję z warunkami, w jakich stoi', 'Sprawdzam, czy światło pasuje do gatunku',
    'Zerkam na doniczkę i podłoże', 'Sprawdzam rytm podlewania i porę roku', 'Liczę, ile dni minęło od podlania',
    'Zestawiam z tym, co lubi ten gatunek', 'Przeglądam ostatnie zdarzenia w historii', 'Zastanawiam się nad nawożeniem',
    'Sprawdzam, czy nie czas na przesadzenie', 'Oceniam wilgotność powietrza wokół rośliny', 'Układam zalecenia od najważniejszego',
    'Dobieram wskazówki do Twojego mieszkania', 'Sprawdzam, czy niczego nie przeoczyłem', 'Redaguję ocenę', 'Jeszcze chwila, dopinam szczegóły',
  ],
  doctor: [
    'Oglądam zdjęcia', 'Czytam Twój opis', 'Szukam objawów na liściach', 'Sprawdzam spód liści i łodygi', 'Przyglądam się podłożu',
    'Zestawiam objawy z Twoim opisem', 'Ważę możliwe przyczyny', 'Sprawdzam, czy to przelanie', 'Sprawdzam, czy to przesuszenie',
    'Rozważam szkodniki', 'Rozważam grzyby i bakterie', 'Sprawdzam, czy winne jest światło', 'Sprawdzam, czy winne jest suche powietrze',
    'Porównuję z historią podlewania', 'Szeregują hipotezy od najbardziej prawdopodobnej', 'Zastanawiam się, co sprawdzić palcem w doniczce',
    'Sprawdzam, czego brakuje do diagnozy', 'Układam pytania, jeśli są potrzebne', 'Układam plan działania', 'Wybieram, co zrobić od razu', 'Redaguję diagnozę',
  ],
  followup: [
    'Czytam odpowiedzi', 'Wracam do zdjęć', 'Zestawiam odpowiedzi z objawami', 'Wykluczam, co się nie zgadza', 'Sprawdzam, która hipoteza została',
    'Aktualizuję diagnozę', 'Sprawdzam, co jeszcze wykluczyć', 'Przeliczam ryzyko przelania', 'Sprawdzam, czy pasuje do gatunku',
    'Weryfikuję plan działania', 'Zastanawiam się, czy potrzebne są kolejne pytania', 'Doprecyzowuję zalecenia', 'Redaguję odpowiedź',
  ],
  profile: [
    'Przypominam sobie gatunek', 'Sprawdzam, skąd pochodzi', 'Sprawdzam wymagania świetlne', 'Dobieram rytm podlewania do polskiego mieszkania',
    'Myślę o zimie z grzejnikiem pod parapetem', 'Sprawdzam wilgotność, jaką lubi', 'Sprawdzam zakres temperatur', 'Dobieram podłoże i doniczkę',
    'Ustalam, jak i kiedy nawozić', 'Ustalam, kiedy przesadzać', 'Sprawdzam, czy jest bezpieczna dla kotów i psów', 'Spisuję typowe problemy',
    'Zestawiam z warunkami, w których stoi', 'Szukam, gdzie najlepiej ją postawić', 'Skracam do konkretów', 'Redaguję opis',
  ],
};
const THINK_DEFAULT = { checkup: 45, doctor: 45, followup: 35, profile: 30 };

function thinkEstimate(kind) {
  try {
    const arr = JSON.parse(localStorage.getItem(`greenly.est.${kind}`) || '[]');
    if (arr.length) { const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.floor(s.length / 2)]); }
  } catch { /* ignore */ }
  return THINK_DEFAULT[kind] ?? 45;
}

function thinkRecord(kind, secs) {
  try {
    const arr = JSON.parse(localStorage.getItem(`greenly.est.${kind}`) || '[]');
    arr.push(Math.round(secs));
    localStorage.setItem(`greenly.est.${kind}`, JSON.stringify(arr.slice(-6)));
  } catch { /* ignore */ }
}

/** Renders the panel into `host` and returns {finish, fail}. */
function startThinking(host, kind) {
  const est = thinkEstimate(kind);
  const pool = THINK_TEXTS[kind] ?? THINK_TEXTS.checkup;
  // First three in order (they read as a sequence), the rest shuffled so every wait looks different.
  const tail = pool.slice(3);
  for (let j = tail.length - 1; j > 0; j--) { const k = Math.floor(Math.random() * (j + 1)); [tail[j], tail[k]] = [tail[k], tail[j]]; }
  const texts = [...pool.slice(0, 3), ...tail];
  host.innerHTML = `<div class="thinking" role="status" aria-live="polite">
    <span class="think-leaf" aria-hidden="true">🌿</span>
    <p class="think-text"><span class="t">${esc(t(texts[0]))}</span><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
    <div class="think-bar"><span></span></div>
    <p class="think-time">${t('zwykle ok. {est} s', { est })}</p>
  </div>`;
  const textEl = host.querySelector('.think-text');
  const tEl = textEl.querySelector('.t');
  const bar = host.querySelector('.think-bar span');
  const timeEl = host.querySelector('.think-time');
  const started = Date.now();
  let i = 0;

  const tick = () => {
    const sec = (Date.now() - started) / 1000;
    // Ease toward ~92% at the estimate, then creep — never claim "done" before the answer arrives.
    const x = Math.min(sec / est, 1);
    const pct = sec <= est ? 92 * (1 - Math.pow(1 - x, 2)) : 92 + 6 * (1 - Math.exp(-(sec - est) / est));
    bar.style.width = `${pct.toFixed(1)}%`;
    if (sec <= est) {
      timeEl.textContent = t('minęło {s} s · zwykle ok. {est} s', { s: Math.floor(sec), est });
    } else {
      timeEl.textContent = t('minęło {s} s · trwa dłużej niż zwykle, model dokładnie ogląda zdjęcia', { s: Math.floor(sec) });
      timeEl.classList.add('over');
    }
  };
  const swap = () => {
    i = (i + 1) % texts.length;
    textEl.classList.add('swap');
    setTimeout(() => { tEl.textContent = t(texts[i]); textEl.classList.remove('swap'); }, reduceMotion.matches ? 0 : 300);
  };
  tick();
  const t1 = setInterval(tick, 1000);
  const t2 = setInterval(swap, 3800);
  const stop = () => { clearInterval(t1); clearInterval(t2); };
  return {
    finish() { stop(); thinkRecord(kind, (Date.now() - started) / 1000); bar.style.width = '100%'; },
    fail() { stop(); host.replaceChildren(); },
  };
}

// ---------------------------------------------------------------------------
// care events, division, timeline
// ---------------------------------------------------------------------------
const EVENT_DEFS = {
  repot: { icon: '🪴', label: t('Przesadzenie'), hint: t('nowa doniczka lub podłoże') },
  split: { icon: '✂️', label: t('Rozsadzenie'), hint: t('podział na dwie rośliny') },
  move: { icon: '🪟', label: t('Przestawienie'), hint: t('nowe miejsce, inne światło') },
  fertilize: { icon: '🧪', label: t('Nawożenie'), hint: t('czym i ile') },
  prune: { icon: '🌿', label: t('Przycięcie'), hint: t('formowanie, usunięte liście') },
  treat: { icon: '🐛', label: t('Zabieg / oprysk'), hint: t('szkodniki, grzyb') },
  shower: { icon: '🚿', label: t('Prysznic / zraszanie'), hint: t('mycie liści') },
  bloom: { icon: '🌸', label: t('Kwitnienie'), hint: t('obserwacja') },
  growth: { icon: '🌱', label: t('Nowy przyrost'), hint: t('liść, pęd, korzeń') },
  note: { icon: '📝', label: t('Notatka'), hint: t('cokolwiek innego') },
};
const HIDDEN_EVENTS = { snooze: { icon: '⏳', label: t('Odłożone podlanie') } }; // logged by the app, not picked by hand
let histFilter = 'all';

const SHORT_MATERIAL = { terracotta: t('terakota'), ceramic: t('ceramika'), plastic: t('plastik'), cachepot: t('bez odpływu') };
const SHORT_LIGHT = { sun: t('pełne słońce'), bright: t('jasno'), partial: t('półcień'), dark: t('ciemny kąt') };

/** Human detail line for an event (Polish). */
function eventDetail(e) {
  const d = e.data ?? {};
  const bits = [];
  if (e.type === 'repot') bits.push(`${d.pot_cm_from && d.pot_cm_from !== d.pot_cm ? `${d.pot_cm_from} → ` : ''}${d.pot_cm} cm · ${SHORT_MATERIAL[d.pot_material] ?? esc(d.pot_material ?? '')}`);
  if (e.type === 'move') bits.push(`${SHORT_LIGHT[d.light] ?? esc(d.light ?? '')}${d.dry_air ? ` · ${t('suche powietrze')}` : ''}`);
  if (e.type === 'split') bits.push(`${t(d.role === 'child' ? 'odłączona od' : 'oddzielono')} <a href="#plant/${d.sibling_id}">${esc(d.sibling_name)}</a>`);
  if (e.type === 'snooze') bits.push(`${t('nadal mokro · o {n}', { n: days(d.days) })}${d.until ? ` (${t('do {date}', { date: fmtDate(d.until) })})` : ''}${d.adjusted ? ` · ${t('porcja −15 %, interwał +10 %')}` : ''}`);
  if (d.watered) bits.push(t('podlana przy okazji'));
  if (e.note) bits.push(esc(e.note));
  return bits.join(' · ');
}

function buildTimeline({ plant, waterings, checks, events, answered }) {
  const items = [];
  for (const e of events) {
    const def = EVENT_DEFS[e.type] ?? HIDDEN_EVENTS[e.type] ?? { icon: '•', label: e.type };
    items.push({ key: `e${e.id}`, kind: 'event', id: e.id, cat: 'care', ts: e.ts, icon: def.icon, title: def.label, detail: eventDetail(e), removable: true });
  }
  for (const w of waterings) items.push({ key: `w${w.id}`, kind: 'water', id: w.id, cat: 'water', ts: w.ts, icon: '💧', title: t('Podlanie'), detail: '', removable: true });
  for (const c of checks) {
    const r = c.result ?? {};
    items.push({ key: `c${c.id}`, kind: 'check', id: c.id, cat: 'ai', ts: c.ts, icon: c.mode === 'doctor' ? '🩺' : '🔍', check: c,
      title: r.title || STATUS_LABEL[r.status] || t('Analiza'),
      detail: `${MODE_LABEL[c.mode] ?? c.mode}${c.parent_id ? ` · ${t('dopytanie')}` : ''} · ${STATUS_LABEL[r.status] ?? ''}${r.questions?.length && !answered.has(c.id) ? ` · ${t('czeka na odpowiedź')}` : ''}` });
  }
  items.push({ key: 'created', kind: 'created', cat: 'care', ts: plant.created_at, icon: '🌿', title: t('Dodano do greenLy'), detail: plant.species ? `<i>${esc(plant.species)}</i>` : '', removable: false });
  items.sort((a, b) => new Date(b.ts) - new Date(a.ts));
  return items;
}

function renderTimelineItem(it) {
  return `<li class="tl-item ${it.check ? 'clickable' : ''}" data-key="${it.key}">
    <span class="tl-ico" aria-hidden="true">${it.icon}</span>
    <div class="tl-main"><div class="tl-title">${esc(it.title)}</div>${it.detail ? `<div class="tl-detail">${it.detail}</div>` : ''}</div>
    <span class="tl-when">${fmtDateTime(it.ts)}</span>
    ${it.removable ? `<button type="button" class="btn-x" aria-label="${t('Usuń')}">×</button>` : ''}
  </li>`;
}

function openEventPicker(p) {
  openSheet(t('Zdarzenie: {name}', { name: p.name }));
  el.sheetBody.innerHTML = `<div class="type-grid">${Object.entries(EVENT_DEFS).map(([k, d]) =>
    `<button type="button" class="type-btn" data-type="${k}"><span class="ico" aria-hidden="true">${d.icon}</span><span><b>${d.label}</b><small>${d.hint}</small></span></button>`).join('')}</div>`;
  for (const b of el.sheetBody.querySelectorAll('.type-btn')) {
    b.addEventListener('click', () => (b.dataset.type === 'split' ? openSplitForm(p) : openEventForm(p, b.dataset.type)));
  }
}

function openEventForm(p, type) {
  const def = EVENT_DEFS[type];
  const options = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
  if (el.sheet.hidden) openSheet(`${def.icon} ${def.label}`); else el.sheetTitle.textContent = `${def.icon} ${def.label}`;
  const extra = type === 'repot' ? `
      <div class="field">
        <label for="e-pot">${t('Nowa średnica doniczki')}: <span class="range-value" id="e-pot-value">${p.pot_cm}</span> cm</label>
        <input type="range" id="e-pot" name="pot_cm" min="6" max="40" step="1" value="${p.pot_cm}">
      </div>
      <div class="field"><label for="e-material">${t('Doniczka')}</label><select id="e-material" name="pot_material">${options(MATERIALS, p.pot_material)}</select></div>
      <div class="field"><label class="check"><input type="checkbox" name="watered" checked> ${t('Przy okazji podlana')}</label></div>
      <div class="preview" id="e-preview"><strong id="e-days"></strong> po tej zmianie</div>`
    : type === 'move' ? `
      <div class="field"><label for="e-light">${t('Światło w nowym miejscu')}</label><select id="e-light" name="light">${options(LIGHTS, p.light)}</select></div>
      <div class="field"><label class="check"><input type="checkbox" name="dry_air" ${p.dry_air ? 'checked' : ''}> ${t('Suche powietrze / blisko grzejnika')}</label></div>
      <div class="preview" id="e-preview"><strong id="e-days"></strong> po tej zmianie</div>`
    : '';
  el.sheetBody.innerHTML = `
    <form id="event-form" autocomplete="off">
      ${extra}
      <div class="field"><label for="e-date">${t('Data')}</label><input type="date" id="e-date" name="date" value="${todayStr()}" max="${todayStr()}" required></div>
      <div class="field"><label for="e-note">${t(type === 'note' ? 'Treść' : 'Notatka (opcjonalnie)')}</label>
        <textarea id="e-note" name="note" maxlength="500" ${type === 'note' ? 'required' : ''} placeholder="${type === 'fertilize' ? t('np. Biohumus 1:20') : type === 'treat' ? t('np. mydło potasowe na przędziorki') : ''}"></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="e-back">${t('Wstecz')}</button>
        <button type="submit" class="btn btn-primary">${t('Zapisz')}</button>
      </div>
    </form>`;
  const form = $('#event-form');
  const preview = () => {
    if (!$('#e-days')) return;
    const days = estimate({
      base_summer: p.base_summer, base_winter: p.base_winter,
      pot_cm: form.pot_cm ? form.pot_cm.value : p.pot_cm,
      pot_material: form.pot_material ? form.pot_material.value : p.pot_material,
      light: form.light ? form.light.value : p.light,
      dry_air: form.dry_air ? form.dry_air.checked : p.dry_air,
    });
    $('#e-days').textContent = `co ${days} ${dni(days)}`;
    if ($('#e-pot-value')) $('#e-pot-value').textContent = form.pot_cm.value;
  };
  form.addEventListener('input', preview);
  preview();
  $('#e-back').addEventListener('click', () => openEventPicker(p));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const data = {};
      if (type === 'repot') Object.assign(data, { pot_cm: Number(form.pot_cm.value), pot_material: form.pot_material.value, watered: form.watered.checked });
      if (type === 'move') Object.assign(data, { light: form.light.value, dry_air: form.dry_air.checked });
      await api('event', { json: { plant_id: p.id, type, date: form.date.value, note: form.note.value.trim(), data } });
      toast(t('Zapisano: {label}.', { label: def.label.toLowerCase() }));
      closeSheet();
      await refresh();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  ($('#e-note') || form.querySelector('input,select')).focus();
}

function openSplitForm(p) {
  const options = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${l}</option>`).join('');
  const splitTitle = t('✂️ Rozsadzenie: {name}', { name: p.name });
  if (el.sheet.hidden) openSheet(splitTitle); else el.sheetTitle.textContent = splitTitle;
  el.sheetBody.innerHTML = `
    <p class="muted" style="margin:0 0 12px">${t('Powstanie druga roślina tego samego gatunku z tymi samymi warunkami — poniżej ustaw jej nazwę i doniczkę. Obie dostaną wpis w historii. Doniczkę tej rośliny zmienisz osobno w „Edytuj” lub przez „Przesadzenie”.')}</p>
    <form id="split-form" autocomplete="off">
      <div class="species-head">
        <span class="thumb" id="split-thumb"><img alt=""></span>
        <div><div class="sci">${esc(p.species) || '—'}</div><div class="com">${esc(p.common)}</div></div>
      </div>
      <div class="photo-actions"><span class="btn pick">${t('Zdjęcie nowej rośliny')}<input type="file" accept="image/*" id="split-photo"></span></div>
      <div class="field"><label for="s-name">${t('Nazwa nowej rośliny')}</label><input type="text" id="s-name" name="name" maxlength="80" required value="${esc(p.name)} (2)"></div>
      <div class="field">
        <label for="s-pot">${t('Średnica jej doniczki')}: <span class="range-value" id="s-pot-value">${p.pot_cm}</span> cm</label>
        <input type="range" id="s-pot" name="pot_cm" min="6" max="40" step="1" value="${p.pot_cm}">
      </div>
      <div class="field"><label for="s-material">${t('Doniczka')}</label><select id="s-material" name="pot_material">${options(MATERIALS, p.pot_material)}</select></div>
      <div class="field"><label class="check"><input type="checkbox" name="watered" checked> ${t('Obie podlane przy rozsadzaniu')}</label></div>
      <div class="field"><label for="s-date">${t('Data')}</label><input type="date" id="s-date" name="date" value="${todayStr()}" max="${todayStr()}" required></div>
      <div class="field"><label for="s-note">${t('Notatka (opcjonalnie)')}</label><textarea id="s-note" name="note" maxlength="500"></textarea></div>
      <div class="form-actions">
        <button type="button" class="btn btn-ghost" id="s-back">${t('Wstecz')}</button>
        <button type="submit" class="btn btn-primary">${t('Rozsadź')}</button>
      </div>
    </form>`;
  const form = $('#split-form');
  let photo = null;
  let photoFull = null;
  form.addEventListener('input', () => { $('#s-pot-value').textContent = form.pot_cm.value; });
  $('#split-photo').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { thumb, full } = await processImage(file);
      photo = thumb;
      photoFull = full;
      $('#split-thumb').classList.add('has-photo');
      $('#split-thumb img').src = thumb;
    } catch { toast(t('Nie udało się przetworzyć zdjęcia.'), 'error'); }
  });
  $('#s-back').addEventListener('click', () => openEventPicker(p));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const { plant } = await api('split', { json: {
        id: p.id, name: form.name.value.trim(), pot_cm: Number(form.pot_cm.value), pot_material: form.pot_material.value,
        watered: form.watered.checked, date: form.date.value, note: form.note.value.trim(), photo, photo_full: photoFull,
      } });
      toast(t('Utworzono „{name}”.', { name: plant.name }));
      closeSheet();
      await refresh();
      location.hash = `plant/${plant.id}`;
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
    }
  });
  $('#s-name').focus();
}

// ---------------------------------------------------------------------------
// check-up / doctor sheet
// ---------------------------------------------------------------------------
function openCheck(p, mode) {
  const isDoctor = mode === 'doctor';
  openSheet(t(isDoctor ? 'Doktor: {name}' : 'Kontrola: {name}', { name: p.name }));
  el.sheetBody.innerHTML = `
    <p class="muted" style="margin:0 0 12px">${isDoctor
      ? t('Zrób wyraźne zdjęcie problematycznego miejsca (liść z bliska, łodyga, podłoże) i opisz, co Cię niepokoi. Jeśli do diagnozy zabraknie informacji, Doktor zada pytania.')
      : t('Zrób zdjęcie całej rośliny w naturalnym świetle. Ocena obejmie stan liści, dopasowanie światła, doniczki i podlewania.')}</p>
    <form id="check-form" class="identify">
      <div class="photo-pick">
        <button type="button" class="btn btn-primary" tabindex="-1" id="check-pick-label">${t('Zrób zdjęcie / wybierz z galerii')}</button>
        <input type="file" accept="image/*" multiple id="check-photo" aria-label="${t('Zdjęcia (do 4)')}">
      </div>
      <div class="photo-row" id="check-previews"></div>
      <p class="muted" id="check-photo-hint" style="margin:0">${t('Możesz dodać do 4 zdjęć — np. cała roślina, chory liść z bliska, podłoże.')}</p>
      <div class="field">
        <label for="check-text">${t(isDoctor ? 'Co Cię niepokoi?' : 'Uwagi (opcjonalnie)')}</label>
        <textarea id="check-text" name="text" maxlength="1000" ${isDoctor ? 'required' : ''} placeholder="${t(isDoctor ? 'np. od tygodnia żółkną dolne liście, na spodzie białe kropki' : 'np. przesadzona 2 tygodnie temu')}"></textarea>
      </div>
      <button type="submit" class="btn btn-primary btn-block" id="check-submit" disabled>${t(isDoctor ? 'Postaw diagnozę' : 'Sprawdź stan')}</button>
      <p class="muted" style="margin:6px 0 0">${t('Analiza trwa 15–60 s i kosztuje kilka–kilkanaście groszy za zdjęcie (Claude, płatność za użycie).')}</p>
    </form>`;

  const uploads = []; // {blob, thumb}
  const MAX = 4;
  const renderPreviews = () => {
    $('#check-previews').innerHTML = uploads.map((u) => `<img src="${u.thumb}" alt="">`).join('');
    $('#check-submit').disabled = uploads.length === 0;
    $('#check-pick-label').textContent = uploads.length ? t('Dodaj kolejne zdjęcie ({n}/{max})', { n: uploads.length, max: MAX }) : t('Zrób zdjęcie / wybierz z galerii');
    $('#check-photo').disabled = uploads.length >= MAX;
  };
  $('#check-photo').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files ?? []).slice(0, MAX - uploads.length);
    e.target.value = '';
    for (const file of files) {
      try {
        const out = await processImage(file);
        uploads.push({ blob: out.upload, thumb: out.thumb });
      } catch { toast(t('Nie udało się przetworzyć zdjęcia.'), 'error'); }
    }
    renderPreviews();
  });

  $('#check-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!uploads.length) return;
    const form = $('#check-form');
    const intro = form.previousElementSibling;
    const host = document.createElement('div');
    form.insertAdjacentElement('afterend', host);
    form.hidden = true;
    intro.hidden = true;
    el.sheetTitle.textContent = t(isDoctor ? 'Doktor myśli…' : 'Sprawdzam…');
    const think = startThinking(host, mode);
    try {
      const fd = new FormData();
      fd.append('id', p.id);
      fd.append('mode', mode);
      fd.append('text', $('#check-text').value.trim());
      uploads.forEach((u, i) => fd.append('image', u.blob, `photo-${i + 1}.jpg`));
      const { check } = await api('health', { form: fd });
      think.finish();
      setTimeout(() => fillCheckSheet(check, p.id, false), reduceMotion.matches ? 0 : 500);
      showPlant(p.id); // refresh the profile behind the sheet
    } catch (err) {
      think.fail();
      host.remove();
      form.hidden = false;
      intro.hidden = false;
      el.sheetTitle.textContent = t(isDoctor ? 'Doktor: {name}' : 'Kontrola: {name}', { name: p.name });
      toast(err.message, 'error', 7000);
    }
  });
}

// ---------------------------------------------------------------------------
// "install me" prompt: greenLy is meant to run from the Home Screen (push works only there on
// iOS). Shown after registration and on every browser visit until the user explicitly agrees
// to use it in a tab. Never shown in the installed app.
// ---------------------------------------------------------------------------
const WEB_OK_KEY = 'greenly.webok';
let installPrompt = null; // Chrome/Android/desktop: deferred beforeinstallprompt
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('#install-native')?.removeAttribute('hidden'); });
window.addEventListener('appinstalled', () => { installPrompt = null; localStorage.setItem(WEB_OK_KEY, 'installed'); closeInstall(); toast(t('greenLy zainstalowane — otwórz aplikację z ikony.')); });

function shouldNagInstall() {
  return !isStandalone && !localStorage.getItem(WEB_OK_KEY);
}

function installSteps() {
  const ua = navigator.userAgent;
  if (isIOS) {
    const chrome = /CriOS/.test(ua);
    return { platform: t('iPhone / iPad'), steps: [
      t('Stuknij <b>Udostępnij</b> {where}.', { where: t(chrome ? 'w menu Chrome (ikona ze strzałką w górę)' : '(kwadrat ze strzałką w górę na dolnym pasku Safari)') }),
      t('Przewiń listę i wybierz <b>Do ekranu początkowego</b>.'),
      t('Stuknij <b>Dodaj</b> w prawym górnym rogu.'),
      t('Otwieraj greenLy <b>z ikony</b> na ekranie początkowym i tam włącz powiadomienia.'),
    ] };
  }
  if (/Android/.test(ua)) {
    return { platform: 'Android', steps: [
      t('Stuknij <b>⋮</b> (menu Chrome) w prawym górnym rogu.'),
      t('Wybierz <b>Zainstaluj aplikację</b> albo <b>Dodaj do ekranu głównego</b>.'),
      t('Potwierdź. Otwieraj greenLy z ikony.'),
    ] };
  }
  return { platform: t('Komputer'), steps: [
    t('Chrome / Edge: kliknij ikonę instalacji po prawej stronie paska adresu albo <b>⋮ → Zainstaluj greenLy</b>.'),
    t('Safari (macOS): <b>Plik → Dodaj do Docka</b>.'),
    t('Na telefonie otwórz ten sam adres i dodaj greenLy do ekranu początkowego — tam działają powiadomienia.'),
  ] };
}

/** @param {{consent?:boolean}} o  consent: the user must tick the box to keep using the browser */
function openInstall({ consent = false } = {}) {
  const { platform, steps } = installSteps();
  el.installBody.innerHTML = `
    <div class="install-head"><img src="./img/icon-192.png" alt="" width="56" height="56"><div>
      <h2 id="install-title">${t('Zainstaluj greenLy')}</h2>
      <p class="muted">${t('Ta strona jest aplikacją — najlepiej działa z ekranu początkowego.')}</p></div></div>
    <ul class="install-why">
      <li><span class="ico" aria-hidden="true">🔔</span><span>${t('<b>Przypomnienia o podlewaniu</b> przychodzą tylko do zainstalowanej aplikacji{ios}.', { ios: isIOS ? t(' (na iPhonie w przeglądarce nie działają wcale)') : '' })}</span></li>
      <li><span class="ico" aria-hidden="true">📱</span><span>${t('Pełny ekran, własna ikona, działa offline.')}</span></li>
    </ul>
    <p class="install-platform">${esc(platform)}</p>
    <ol class="install-steps">${steps.map((step) => `<li>${step}</li>`).join('')}</ol>
    <button type="button" class="btn btn-primary btn-block" id="install-native" ${installPrompt ? '' : 'hidden'}>${t('Zainstaluj teraz')}</button>
    ${consent ? `
      <label class="install-consent"><input type="checkbox" id="install-ok"> ${t('Rozumiem, że bez instalacji nie dostanę przypomnień, i chcę używać greenLy w przeglądarce.')}</label>
      <button type="button" class="btn btn-block" id="install-web" disabled>${t('Używaj w przeglądarce')}</button>`
      : `<button type="button" class="btn btn-block" id="install-close">${t('Zamknij')}</button>`}`;
  el.installBackdrop.hidden = false;
  el.installModal.hidden = false;
  void el.installModal.offsetHeight;
  el.installBackdrop.classList.add('open');
  el.installModal.classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#install-native').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    if (outcome !== 'accepted') $('#install-native').hidden = true;
  });
  if (consent) {
    $('#install-ok').addEventListener('change', (e) => { $('#install-web').disabled = !e.target.checked; });
    $('#install-web').addEventListener('click', () => { localStorage.setItem(WEB_OK_KEY, new Date().toISOString()); closeInstall(); });
  } else {
    $('#install-close').addEventListener('click', closeInstall);
  }
}

function closeInstall() {
  if (el.installModal.hidden) return;
  el.installBackdrop.classList.remove('open');
  el.installModal.classList.remove('open');
  document.body.style.overflow = el.sheet.hidden ? '' : 'hidden';
  const finish = () => { el.installModal.hidden = true; el.installBackdrop.hidden = true; el.installBody.replaceChildren(); };
  if (reduceMotion.matches) finish(); else setTimeout(finish, 260);
}

// ---------------------------------------------------------------------------
// "no Claude key yet" popup — shown instead of running an AI feature
// ---------------------------------------------------------------------------
// Rough per-analysis cost from the README measurements (2–3k input + 1–3k output tokens, photo included):
// Opus 5 ($5/$25 per MTok) ≈ $0.03–0.08, Sonnet 5 ($2/$10) ≈ $0.02–0.03. $5 therefore covers ~60–150 / ~200 analyses.
function openNoKey() {
  const u = state.user ?? {};
  const globalMissing = u.key_source === 'global' && !u.has_key;
  $('#nokey-body').innerHTML = globalMissing ? `
    <span class="modal-ico" aria-hidden="true">🔑</span>
    <h2 id="nokey-title">${t('Jeszcze chwila')}</h2>
    <p class="muted">${t('Administrator przypisał Ci wspólny klucz Claude, ale jeszcze go nie ustawił. Gdy to zrobi, Kontrola, Doktor i opisy gatunków zaczną działać same — nic nie musisz robić.')}</p>
    <button type="button" class="btn btn-primary btn-block" id="nokey-close">${t('Rozumiem')}</button>`
  : `
    <span class="modal-ico" aria-hidden="true">🌿</span>
    <h2 id="nokey-title">${t('Siemano! Tu potrzebny jest Twój klucz Claude')}</h2>
    <p class="muted">${t('Kontrola, Doktor i opisy gatunków to analizy robione przez Claude (AI od Anthropic). Żeby z nich korzystać, podepnij w ustawieniach konta <b>własny klucz API</b>. Rozliczasz się bezpośrednio z Anthropic, greenLy nic nie dolicza.')}</p>
    <ul class="nokey-facts">
      <li><span class="ico" aria-hidden="true">💸</span><span>${t('Płacisz z góry doładowanymi kredytami, bez abonamentu. Jedna analiza ze zdjęciem to zwykle <b>3–8 centów</b> na Claude Opus 5 albo <b>2–3 centy</b> na Sonnet 5.')}</span></li>
      <li><span class="ico" aria-hidden="true">🧮</span><span>${t('<b>5 $</b> wystarcza mniej więcej na <b>60–150 analiz</b> na Opus 5 albo <b>około 200</b> na Sonnet 5. Nowe konto Anthropic dostaje też małą pulę darmowych kredytów na start.')}</span></li>
      <li><span class="ico" aria-hidden="true">🔒</span><span>${t('Klucz jest szyfrowany na serwerze i nigdy nie wraca do przeglądarki. W Koncie masz instrukcję krok po kroku, jak go założyć.')}</span></li>
    </ul>
    <button type="button" class="btn btn-primary btn-block" id="nokey-go">${t('Podłącz klucz w Koncie')}</button>
    <button type="button" class="btn btn-block" id="nokey-close" style="margin-top:8px">${t('Może później')}</button>`;
  $('#nokey-backdrop').hidden = false;
  $('#nokey-modal').hidden = false;
  void $('#nokey-modal').offsetHeight;
  $('#nokey-backdrop').classList.add('open');
  $('#nokey-modal').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#nokey-close').addEventListener('click', closeNoKey);
  $('#nokey-go')?.addEventListener('click', () => { closeNoKey(); openAccount({ focusKey: true }); });
}
function closeNoKey() {
  const m = $('#nokey-modal');
  if (m.hidden) return;
  $('#nokey-backdrop').classList.remove('open');
  m.classList.remove('open');
  document.body.style.overflow = el.sheet.hidden ? '' : 'hidden';
  const finish = () => { m.hidden = true; $('#nokey-backdrop').hidden = true; };
  if (reduceMotion.matches) finish(); else setTimeout(finish, 240);
}
$('#nokey-backdrop').addEventListener('click', closeNoKey);

/** Runs `fn` when the user has a working key; otherwise shows the popup. */
function withAi(fn) {
  if (state.ai) return fn();
  openNoKey();
}

// Step-by-step, from platform.claude.com/docs/en/get-api-key and the Console billing help — keep in sync with them.
const KEY_HOWTO = `
  <details class="howto">
    <summary>${t('Jak założyć klucz Claude — krok po kroku')}</summary>
    <ol>
      <li>${t('Wejdź na <a href="https://platform.claude.com/" target="_blank" rel="noopener">platform.claude.com</a> (Claude Console) i zaloguj się albo załóż konto — mail lub konto Google.')}</li>
      <li>${t('Doładuj kredyty: <b>Settings → Billing → Buy credits</b>, wpisz kwotę (np. 5 $) i zapłać kartą. Bez kredytów API nie odpowiada; nowe konto ma małą darmową pulę na start. Kredyty są ważne rok. W sekcji <b>Auto-reload</b> możesz włączyć automatyczne doładowanie.')}</li>
      <li>${t('Otwórz <a href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener">Settings → API keys</a> i kliknij <b>Create key</b>.')}</li>
      <li>${t('Nadaj nazwę (np. <i>greenLy</i>), wybierz ważność (<i>expiration</i>) i zostaw <b>Linked account</b> ustawione na siebie. Zatwierdź.')}</li>
      <li>${t('Skopiuj klucz — zaczyna się od <code>sk-ant-</code> i Console pokaże go <b>tylko raz</b>. Jeśli go zgubisz, po prostu utwórz nowy.')}</li>
      <li>${t('Wklej go tutaj i kliknij <b>Zapisz</b>. greenLy sprawdzi klucz w Anthropic zanim go zapisze.')}</li>
    </ol>
    <p class="hint" style="margin:8px 0 0">${t('Koszty: Opus 5 to 5 $ za milion tokenów wejścia i 25 $ za milion wyjścia, Sonnet 5 odpowiednio 2 $ i 10 $. Jedna analiza ze zdjęciem to 3–8 centów (Opus) albo 2–3 centy (Sonnet); opis gatunku jest tańszy. Zużycie widać w Console w zakładce <b>Usage</b>, a przybliżony koszt każdej analizy pod jej wynikiem w greenLy.')}</p>
  </details>`;

// ---------------------------------------------------------------------------
// account sheet: Anthropic key + model, password, install help, logout
// ---------------------------------------------------------------------------
const MODEL_OPTIONS = [['claude-opus-5', t('Claude Opus 5 — najdokładniejszy')], ['claude-sonnet-5', t('Claude Sonnet 5 — tańszy')]];
const EFFORT_OPTIONS = [['low', t('niski — szybko i tanio')], ['medium', t('średni — domyślny')], ['high', t('wysoki — wnikliwie, drożej')]];

function openAccount({ focusKey = false } = {}) {
  const u = state.user ?? { login: '…', has_key: false, model: 'claude-opus-5', effort: 'medium' };
  const options = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  openSheet(t('Konto'));
  el.sheetBody.innerHTML = `
    <p class="account-login">${t('Zalogowano jako')} <b>${esc(u.login)}</b></p>

    <section class="section">
      <h2>${t('Klucz Anthropic (Claude)')}</h2>
      ${u.key_source === 'global' ? `<div class="card">
        <p class="key-status ${u.has_key ? 'on' : ''}">${t(u.has_key ? 'Na Twoje konto jest przypisany globalny klucz Claude' : 'Administrator przypisał Ci globalny klucz, ale nie jest jeszcze ustawiony — analizy AI są wyłączone')}</p>
        <p class="muted" style="margin:0">${t('Kontrola, Doktor i opisy gatunków działają na kluczu administratora i nie obciążają Twojego konta Anthropic. Model: <b>{model}</b> · dokładność: <b>{effort}</b>. Własnego klucza nie ustawisz — o zmianę poproś administratora.', { model: esc(label(MODEL_OPTIONS, u.model)), effort: esc(label(EFFORT_OPTIONS, u.effort)) })}</p>
      </div>` : `<div class="card">
        <p class="muted" style="margin:0 0 10px">${t('Kontrola, Doktor i opisy gatunków działają na Twoim własnym kluczu i obciążają Twoje konto Anthropic (kilka centów za analizę). Klucz jest szyfrowany na serwerze i nigdy nie wraca do przeglądarki.')}</p>
        <p class="key-status ${u.has_key ? 'on' : ''}">${u.has_key ? `${t('Klucz ustawiony')}${u.key_hint ? ` · ${t('kończy się na …{hint}', { hint: esc(u.key_hint) })}` : ''}` : t('Brak klucza — analizy AI są wyłączone')}</p>
        <form id="key-form" autocomplete="off" novalidate>
          <div class="field">
            <label for="acc-key">${t(u.has_key ? 'Nowy klucz (zostaw puste, żeby nie zmieniać)' : 'Klucz API')}</label>
            <input type="password" id="acc-key" placeholder="sk-ant-…" autocapitalize="none" spellcheck="false">
          </div>
          <div class="field-row">
            <div class="field"><label for="acc-model">${t('Model')}</label><select id="acc-model">${options(MODEL_OPTIONS, u.model)}</select></div>
            <div class="field"><label for="acc-effort">${t('Dokładność')}</label><select id="acc-effort">${options(EFFORT_OPTIONS, u.effort)}</select></div>
          </div>
          <div class="form-actions">
            ${u.has_key ? `<button type="button" class="btn btn-danger" id="acc-key-remove">${t('Usuń klucz')}</button>` : ''}
            <button type="submit" class="btn btn-primary">${t('Zapisz')}</button>
          </div>
        </form>
        ${KEY_HOWTO}
      </div>`}
    </section>

    <section class="section">
      <h2>${t('Hasło')}</h2>
      <form class="card" id="pass-form" novalidate>
        <div class="field"><label for="acc-pass-old">${t('Obecne hasło')}</label><input type="password" id="acc-pass-old" autocomplete="current-password"></div>
        <div class="field"><label for="acc-pass-new">${t('Nowe hasło (min. 8 znaków)')}</label><input type="password" id="acc-pass-new" autocomplete="new-password"></div>
        <div class="form-actions"><button type="submit" class="btn btn-primary">${t('Zmień hasło')}</button></div>
      </form>
    </section>

    <section class="section">
      <h2>${t('Aplikacja')}</h2>
      <div class="card account-app">
        <p class="muted" style="margin:0 0 10px">${t(isStandalone ? 'Używasz zainstalowanej aplikacji. 👍' : 'Używasz greenLy w przeglądarce — przypomnienia działają dopiero po instalacji.')}</p>
        <div class="inline-actions" style="margin:0">
          <button type="button" class="btn" id="acc-install">${t('Jak zainstalować')}</button>
          <button type="button" class="btn" id="acc-refresh">${t('Odśwież aplikację')}</button>
          <button type="button" class="btn" id="acc-lang">${t('Język')}: ${lang === 'pl' ? 'Polski' : 'English'}</button>
        </div>
      </div>
    </section>

    ${u.is_admin ? `<section class="section"><h2>${t('Administracja')}</h2>
      <div class="card"><p class="muted" style="margin:0 0 10px">${t('Użytkownicy, kody zaproszeń, resetowanie haseł.')}</p>
      <button type="button" class="btn btn-soft btn-block" id="acc-admin">${t('Otwórz panel administratora')}</button></div></section>` : ''}

    <button type="button" class="btn btn-danger btn-block" id="acc-logout">${t('Wyloguj')}</button>`;
  $('#acc-lang').addEventListener('click', () => switchLang(lang === 'pl' ? 'en' : 'pl'));
  $('#acc-admin')?.addEventListener('click', () => openAdmin());
  if (focusKey && $('#acc-key')) {
    $('.howto', el.sheetBody).open = true;
    setTimeout(() => $('#acc-key').focus({ preventScroll: false }), reduceMotion.matches ? 0 : 380);
  }

  $('#key-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type="submit"]');
    const key = $('#acc-key').value.trim();
    if (!validate([[$('#acc-key'), (v) => (v && !/^sk-ant-/.test(v) ? t('Klucz Anthropic zaczyna się od sk-ant-…') : null)]])) return;
    const payload = { model: $('#acc-model').value, effort: $('#acc-effort').value };
    if (key) payload.anthropic_key = key;
    btn.disabled = true;
    btn.textContent = t(key ? 'Sprawdzam klucz…' : 'Zapisuję…');
    try {
      const { user } = await api('account', { json: payload });
      state.user = user;
      state.ai = !!user.has_key;
      cacheSet('plants', { plants: state.plants, user });
      toast(t(key ? 'Klucz działa — analizy AI włączone.' : 'Zapisano.'));
      openAccount();
      if (state.plantView) showPlant(state.plantView);
    } catch (err) {
      if (key && /klucz|key/i.test(err.message)) fieldError($('#acc-key'), err.message); else toast(err.message, 'error', 6000);
      btn.disabled = false;
      btn.textContent = t('Zapisz');
    }
  });
  $('#acc-key-remove')?.addEventListener('click', async () => {
    if (!confirm(t('Usunąć klucz? Analizy AI przestaną działać do czasu dodania nowego.'))) return;
    try {
      const { user } = await api('account', { json: { anthropic_key: null } });
      state.user = user;
      state.ai = false;
      cacheSet('plants', { plants: state.plants, user });
      toast(t('Klucz usunięty.'));
      openAccount();
      if (state.plantView) showPlant(state.plantView);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const oldPw = $('#acc-pass-old');
    const newPw = $('#acc-pass-new');
    if (!validate([[oldPw, required(t('Wpisz obecne hasło.'))], [newPw, passwordRule]])) return;
    const btn = e.target.querySelector('button');
    btn.disabled = true;
    try {
      await api('account', { json: { current_password: oldPw.value, password: newPw.value } });
      toast(t('Hasło zmienione. Inne urządzenia zostały wylogowane.'));
      e.target.reset();
    } catch (err) {
      if (!serverFieldError(err.message, [['obecne', oldPw], ['current', oldPw], ['hasło', newPw], ['password', newPw]])) toast(err.message, 'error', 5000);
    } finally { btn.disabled = false; }
  });
  $('#acc-install').addEventListener('click', () => { closeSheet(); openInstall(); });
  $('#acc-refresh').addEventListener('click', () => { toast(t('Odświeżam…')); hardRefresh(); });
  $('#acc-logout').addEventListener('click', () => logout());
}

// ---------------------------------------------------------------------------
// admin panel: users + invite codes
// ---------------------------------------------------------------------------
const fmtAgo = (iso) => {
  if (!iso) return t('nigdy');
  const d = (Date.now() - new Date(iso)) / 86400000;
  if (d < 1 / 24) return t('przed chwilą');
  if (d < 1) return t('{n} h temu', { n: Math.round(d * 24) });
  if (d < 30) return t('{n} temu', { n: days(Math.round(d)) });
  return fmtDate(iso);
};

async function openAdmin() {
  openSheet(t('Administracja'));
  el.sheetBody.innerHTML = '<div class="skel" style="min-height:140px"></div>';
  let data;
  try { data = await api('admin'); } catch (err) { toast(err.message, 'error'); closeSheet(); return; }
  renderAdmin(data);
}

function renderAdmin({ users, invites, config_invite, global: g }) {
  const me = state.user?.login;
  const ctx = { users, invites, config_invite, global: g };
  const options = (list, sel) => list.map(([k, l]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const keyLabel = (u) => t(u.use_global_key ? (g.has_key ? 'globalny' : 'globalny (nieustawiony)') : u.has_key ? 'własny' : 'brak');
  const userRow = (u) => `<li class="adm-row" data-id="${u.id}">
    <div class="adm-main">
      <b>${esc(u.login)}</b>${u.is_admin ? ` <span class="chip soft">${t('admin')}</span>` : ''}${u.login === me ? ` <span class="muted">${t('(ty)')}</span>` : ''}
      <div class="adm-meta">${u.plants} ${plural(u.plants, ['roślina', 'rośliny', 'roślin'], ['plant', 'plants'])} · ${t('klucz AI')}: ${keyLabel(u)} · ${t('powiadomienia')}: ${u.subs} · ${t('ostatnio')}: ${fmtAgo(u.last_seen)}${u.invite_code ? ` · ${t('kod')}: ${esc(u.invite_code)}` : ''}</div>
    </div>
    <div class="adm-actions">
      <button type="button" class="btn ${u.use_global_key ? 'btn-soft' : ''}" data-act="${u.use_global_key ? 'unglobal' : 'global'}">${t(u.use_global_key ? 'Globalny klucz: wł.' : 'Przypisz globalny klucz')}</button>
      <button type="button" class="btn" data-act="password">${t('Hasło')}</button>
      ${u.login === me ? '' : `<button type="button" class="btn" data-act="${u.is_admin ? 'unadmin' : 'admin'}">${t(u.is_admin ? 'Odbierz admina' : 'Nadaj admina')}</button>
      <button type="button" class="btn btn-danger" data-act="delete">${t('Usuń')}</button>`}
    </div>
  </li>`;
  const inviteRow = (i) => `<li class="adm-row ${i.disabled || i.uses >= i.max_uses ? 'is-off' : ''}" data-code="${esc(i.code)}">
    <div class="adm-main">
      <b class="adm-code">${esc(i.code)}</b>${i.note ? ` <span class="muted">— ${esc(i.note)}</span>` : ''}
      <div class="adm-meta">${t('użyto {u}/{m}', { u: i.uses, m: i.max_uses })}${i.disabled ? ` · ${t('wyłączony')}` : ''} · ${fmtDate(i.created_at)}</div>
    </div>
    <div class="adm-actions">
      <button type="button" class="btn" data-act="copy">${t('Kopiuj')}</button>
      <button type="button" class="btn" data-act="${i.disabled ? 'enable' : 'disable'}">${t(i.disabled ? 'Włącz' : 'Wyłącz')}</button>
      <button type="button" class="btn btn-danger" data-act="delete">${t('Usuń')}</button>
    </div>
  </li>`;

  el.sheetBody.innerHTML = `
    <section class="section">
      <h2>${t('Globalny klucz Claude')}</h2>
      <form class="card" id="adm-global-form" autocomplete="off" novalidate>
        <p class="muted" style="margin:0 0 10px">${t('Jeden klucz dla wybranych użytkowników: analizy idą na Twoje konto Anthropic. Komu go przypiszesz (przycisk przy użytkowniku), ten nie może ustawić własnego klucza i widzi informację, że korzysta z globalnego.')}</p>
        <p class="key-status ${g.has_key ? 'on' : ''}">${g.has_key ? `${t('Klucz ustawiony')} · ${t('kończy się na …{hint}', { hint: esc(g.key_hint ?? '') })}` : t('Brak globalnego klucza')}</p>
        <div class="field"><label for="adm-key">${t(g.has_key ? 'Nowy klucz (zostaw puste, żeby nie zmieniać)' : 'Klucz API')}</label><input type="password" id="adm-key" placeholder="sk-ant-…" autocapitalize="none" spellcheck="false"></div>
        <div class="field-row">
          <div class="field"><label for="adm-model">${t('Model')}</label><select id="adm-model">${options(MODEL_OPTIONS, g.model)}</select></div>
          <div class="field"><label for="adm-effort">${t('Dokładność')}</label><select id="adm-effort">${options(EFFORT_OPTIONS, g.effort)}</select></div>
        </div>
        <div class="form-actions">
          ${g.has_key ? `<button type="button" class="btn btn-danger" id="adm-key-remove">${t('Usuń klucz')}</button>` : ''}
          <button type="submit" class="btn btn-primary">${t('Zapisz')}</button>
        </div>
      </form>
    </section>
    <section class="section">
      <h2>${t('Kody zaproszeń')}</h2>
      <form class="card adm-new" id="adm-invite-form">
        <div class="field-row">
          <div class="field"><label for="adm-note">${t('Dla kogo (notatka)')}</label><input type="text" id="adm-note" maxlength="80" placeholder="${t('np. Ola')}"></div>
          <div class="field"><label for="adm-uses">${t('Ile użyć')}</label><input type="number" id="adm-uses" min="1" max="100" value="1"></div>
        </div>
        <button type="submit" class="btn btn-primary btn-block">${t('Wygeneruj kod')}</button>
        ${config_invite ? `<p class="hint" style="margin:10px 0 0">${t('Dodatkowo działa stały kod z config.js (bez limitu użyć).')}</p>` : ''}
      </form>
      <ul class="adm-list" id="adm-invites">${invites.length ? invites.map(inviteRow).join('') : `<li class="tl-empty">${t('Brak kodów — wygeneruj pierwszy.')}</li>`}</ul>
    </section>
    <section class="section">
      <h2>${t('Użytkownicy ({n})', { n: users.length })}</h2>
      <ul class="adm-list" id="adm-users">${users.map(userRow).join('')}</ul>
    </section>
    <button type="button" class="btn btn-block" id="adm-back">${t('Wróć do konta')}</button>`;

  $('#adm-back').addEventListener('click', () => openAccount());
  $('#adm-global-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const keyEl = $('#adm-key');
    const key = keyEl.value.trim();
    if (!validate([[keyEl, (v) => (v && !/^sk-ant-/.test(v) ? t('Klucz Anthropic zaczyna się od sk-ant-…') : null)]])) return;
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = t(key ? 'Sprawdzam klucz…' : 'Zapisuję…');
    const payload = { model: $('#adm-model').value, effort: $('#adm-effort').value };
    if (key) payload.anthropic_key = key;
    try {
      const { global: ng } = await api('adminglobal', { json: payload });
      toast(t(key ? 'Globalny klucz działa.' : 'Zapisano.'));
      renderAdmin({ ...ctx, global: ng });
      if (state.user?.key_source === 'global') refresh();
    } catch (err) {
      if (key && /klucz|key/i.test(err.message)) fieldError(keyEl, err.message); else toast(err.message, 'error', 6000);
      btn.disabled = false;
      btn.textContent = t('Zapisz');
    }
  });
  $('#adm-key-remove')?.addEventListener('click', async () => {
    if (!confirm(t('Usunąć globalny klucz? Użytkownicy, którym jest przypisany, stracą analizy AI.'))) return;
    try {
      const { global: ng } = await api('adminglobal', { json: { anthropic_key: null } });
      toast(t('Globalny klucz usunięty.'));
      renderAdmin({ ...ctx, global: ng });
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#adm-invite-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { invites: list, code } = await api('admininvite', { json: { action: 'create', note: $('#adm-note').value, max_uses: Number($('#adm-uses').value) } });
      toast(t('Kod: {code}', { code }));
      renderAdmin({ ...ctx, invites: list });
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#adm-invites').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const code = btn.closest('.adm-row').dataset.code;
    const act = btn.dataset.act;
    if (act === 'copy') {
      try { await navigator.clipboard.writeText(code); toast(t('Skopiowano kod.')); } catch { prompt(t('Kod zaproszenia:'), code); }
      return;
    }
    if (act === 'delete' && !confirm(t('Usunąć kod {code}?', { code }))) return;
    try {
      const { invites: list } = await api('admininvite', { json: { action: act, code } });
      renderAdmin({ ...ctx, invites: list });
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#adm-users').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = btn.closest('.adm-row');
    const id = Number(row.dataset.id);
    const login = row.querySelector('b').textContent;
    const act = btn.dataset.act;
    const payload = { id, action: act };
    if (act === 'delete' && !confirm(t('Usunąć konto „{login}” razem ze wszystkimi roślinami i historią? Tego nie da się cofnąć.', { login }))) return;
    if (act === 'password') {
      const pw = prompt(t('Nowe hasło dla „{login}” (min. 8 znaków). Użytkownik zostanie wylogowany ze wszystkich urządzeń.', { login }));
      if (!pw) return;
      payload.password = pw;
    }
    try {
      const { users: list } = await api('adminuser', { json: payload });
      toast(t(act === 'password' ? 'Hasło zmienione.' : act === 'delete' ? 'Konto usunięte.' : 'Zapisano.'));
      renderAdmin({ ...ctx, users: list });
      if (login === me) refresh();
    } catch (err) { toast(err.message, 'error', 5000); }
  });
}

// ---------------------------------------------------------------------------
// custom selects: every <select> rendered into the sheet gets a styled button + animated list.
// The native element stays in the DOM (hidden) as the source of truth, so form.field.value and
// 'input'/'change' listeners keep working unchanged.
// ---------------------------------------------------------------------------
const xsel = { open: null }; // {sel, btn, list, closeFn}
const xselPortal = $('#xsel-portal');

function enhanceSelect(sel) {
  if (sel.dataset.enhanced) return;
  sel.dataset.enhanced = '1';
  sel.tabIndex = -1;
  sel.classList.add('xsel-native');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'xsel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.id) { btn.id = `${sel.id}-btn`; const lab = document.querySelector(`label[for="${sel.id}"]`); if (lab) lab.setAttribute('for', btn.id); }
  const sync = () => { const o = sel.options[sel.selectedIndex]; btn.innerHTML = `<span class="xsel-label">${esc(o?.dataset.short ?? o?.text ?? '')}</span><span class="xsel-chev" aria-hidden="true"></span>`; };
  sync();
  sel.addEventListener('change', sync);
  sel.insertAdjacentElement('afterend', btn);
  btn.addEventListener('click', () => (xsel.open?.sel === sel ? closeSelect() : openSelect(sel, btn)));
  btn.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); openSelect(sel, btn); }
  });
}

function openSelect(sel, btn) {
  closeSelect();
  const list = document.createElement('ul');
  list.className = 'xsel-list';
  list.setAttribute('role', 'listbox');
  list.tabIndex = -1;
  list.innerHTML = [...sel.options].map((o, i) => `<li role="option" class="xsel-opt ${o.selected ? 'is-selected' : ''}" data-i="${i}" aria-selected="${o.selected}" style="--d:${i * 28}ms">${esc(o.text)}</li>`).join('');
  xselPortal.appendChild(list);
  // Fixed-position popover next to the button: at least 260 px wide (long labels), clamped to the
  // viewport, flipped above the button when there is more room there. Re-run on scroll.
  const place = () => {
    const r = btn.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return closeSelect();
    const margin = 8;
    const h = Math.min(list.scrollHeight + 12, 320);
    const below = window.innerHeight - r.bottom - margin;
    const up = below < h && r.top > below;
    const width = Math.min(Math.max(r.width, 260), window.innerWidth - 16);
    list.style.width = `${width}px`;
    list.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
    list.style.maxHeight = `${Math.max(120, up ? r.top - margin * 2 : below - margin)}px`;
    list.classList.toggle('up', up);
    list.style.top = up ? '' : `${r.bottom + 4}px`;
    list.style.bottom = up ? `${window.innerHeight - r.top + 4}px` : '';
  };
  place();
  void list.offsetHeight;
  list.classList.add('open');
  btn.setAttribute('aria-expanded', 'true');
  btn.classList.add('is-open');

  let active = sel.selectedIndex;
  const opts = [...list.children];
  const highlight = (i) => { active = Math.max(0, Math.min(opts.length - 1, i)); opts.forEach((o, j) => o.classList.toggle('is-active', j === active)); opts[active].scrollIntoView({ block: 'nearest' }); };
  const choose = (i) => {
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    closeSelect();
    btn.focus();
  };
  list.addEventListener('click', (e) => { const li = e.target.closest('.xsel-opt'); if (li) choose(Number(li.dataset.i)); });
  list.addEventListener('mousemove', (e) => { const li = e.target.closest('.xsel-opt'); if (li) highlight(Number(li.dataset.i)); });
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeSelect(); btn.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); highlight(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight(active - 1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Tab') closeSelect();
  };
  const onDown = (e) => { if (!list.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeSelect(); };
  document.addEventListener('keydown', onKey);
  document.addEventListener('pointerdown', onDown, true);
  el.sheetBody.addEventListener('scroll', place, { passive: true });
  window.addEventListener('resize', closeSelect, { once: true });
  xsel.open = { sel, btn, list, closeFn() {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('pointerdown', onDown, true);
    el.sheetBody.removeEventListener('scroll', place);
  } };
  highlight(active);
  list.focus({ preventScroll: true });
}

function closeSelect() {
  const o = xsel.open;
  if (!o) return;
  xsel.open = null;
  o.closeFn();
  o.btn.setAttribute('aria-expanded', 'false');
  o.btn.classList.remove('is-open');
  o.list.classList.remove('open');
  const finish = () => o.list.remove();
  if (reduceMotion.matches) finish(); else setTimeout(finish, 180);
}

new MutationObserver(() => { for (const sel of el.sheetBody.querySelectorAll('select:not([data-enhanced])')) enhanceSelect(sel); })
  .observe(el.sheetBody, { childList: true, subtree: true });
enhanceSelect(langSelect);

// ---------------------------------------------------------------------------
// easter egg: hover (or tap) the logo and the screen fills with falling leaves and flowers
// ---------------------------------------------------------------------------
const LEAVES = ['🍃', '🌿', '🍂', '🌸', '🌼', '🌷', '🌱', '🍀', '🌺', '🪻', '🍁', '🌻'];
const rain = { timer: null, until: 0 };
function spawnLeaf() {
  const host = $('#leaf-rain');
  if (host.childElementCount > 90) return;
  const el = document.createElement('span');
  el.className = 'leaf';
  const dur = 3.2 + Math.random() * 3.5;
  el.style.setProperty('--x', `${Math.random() * 100}vw`);
  el.style.setProperty('--size', `${16 + Math.random() * 20}px`);
  el.style.setProperty('--dur', `${dur}s`);
  el.style.setProperty('--delay', `${Math.random() * 0.4}s`);
  el.style.setProperty('--sway', `${1.2 + Math.random() * 1.6}s`);
  el.style.setProperty('--amp', `${18 + Math.random() * 40}px`);
  el.style.setProperty('--spin', `${2 + Math.random() * 4}s`);
  el.style.setProperty('--turn', `${Math.random() < 0.5 ? '-' : ''}${180 + Math.random() * 540}deg`);
  el.innerHTML = `<i>${LEAVES[Math.floor(Math.random() * LEAVES.length)]}</i>`;
  el.addEventListener('animationend', (e) => { if (e.animationName === 'leaf-fall') el.remove(); });
  host.appendChild(el);
}
function startRain(ms = 0) {
  if (reduceMotion.matches) return;
  $('#brand').classList.add('is-raining');
  rain.until = ms ? Date.now() + ms : Infinity;
  if (rain.timer) return;
  for (let i = 0; i < 10; i++) spawnLeaf();
  rain.timer = setInterval(() => {
    if (Date.now() > rain.until) return stopRain();
    spawnLeaf(); spawnLeaf();
  }, 220);
}
function stopRain() {
  clearInterval(rain.timer);
  rain.timer = null;
  $('#brand').classList.remove('is-raining');
}
// Sprouts: a small leaf or flower grows out of the logo, drifts up and sideways, then falls for
// 1–2 s while fading out. The hero logo on the Start tab sprouts often, the header logo every few seconds.
const SPROUTS = ['🌸', '🌼', '🌷', '🍃', '🌿', '🌺', '🌱', '🍀'];
function sprout(host, { size = 16 } = {}) {
  if (reduceMotion.matches) return;
  const el = document.createElement('span');
  el.className = 'sprout';
  el.textContent = SPROUTS[Math.floor(Math.random() * SPROUTS.length)];
  const dir = Math.random() < 0.5 ? -1 : 1;
  el.style.setProperty('--size', `${size}px`);
  el.style.setProperty('--x0', `${(Math.random() * 40 - 20).toFixed(0)}%`);
  el.style.setProperty('--dx', `${(dir * (18 + Math.random() * 26)).toFixed(0)}px`);
  el.style.setProperty('--rise', `${(14 + Math.random() * 12).toFixed(0)}px`);
  el.style.setProperty('--fall', `${(22 + Math.random() * 18).toFixed(0)}px`);
  el.style.setProperty('--dur', `${(2.2 + Math.random() * 1.2).toFixed(2)}s`);
  el.style.setProperty('--rot', `${(dir * (20 + Math.random() * 40)).toFixed(0)}deg`);
  el.addEventListener('animationend', () => el.remove());
  host.appendChild(el);
}
function sproutLoop(host, minMs, maxMs, opts) {
  const tick = () => {
    if (host.isConnected && !host.closest('[hidden]')) sprout(host, opts);
    setTimeout(tick, minMs + Math.random() * (maxMs - minMs));
  };
  setTimeout(tick, minMs);
}
sproutLoop($('#brand-sprouts'), 3000, 6000, { size: 13 });
sproutLoop($('#hero-logo'), 1600, 2800, { size: 18 });

const brand = $('#brand');
brand.addEventListener('mouseenter', () => startRain());
brand.addEventListener('mouseleave', () => { rain.until = Date.now() + 600; });
brand.addEventListener('click', (e) => {
  e.preventDefault();
  if (!state.token) return;
  startRain(3500); // touch devices have no hover: a tap gives a short shower on the way home
  if (location.hash) location.hash = ''; else window.scrollTo({ top: 0, behavior: reduceMotion.matches ? 'auto' : 'smooth' });
});

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch((err) => console.error('SW registration failed:', err));
}

// ---------------------------------------------------------------------------
// app updates: the server reports the APP_VERSION of the app.js it has on disk; whenever it differs
// from the one running here (stale HTTP/SW cache, an app resumed from the background after a deploy)
// a blocking dialog offers a hard reload.
// ---------------------------------------------------------------------------
async function checkForUpdate() {
  try {
    const res = await fetch(`${API}version`, { cache: 'no-store' });
    const { version } = await res.json();
    if (version && version !== APP_VERSION) showUpdateModal();
  } catch { /* offline — nothing to do */ }
}
function showUpdateModal() {
  const m = $('#update-modal');
  if (!m.hidden) return;
  closeMenu();
  $('#update-backdrop').hidden = false;
  m.hidden = false;
  void m.offsetHeight;
  $('#update-backdrop').classList.add('open');
  m.classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#update-reload').focus();
}
async function hardRefresh() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    reg?.active?.postMessage({ type: 'greenly-clear-cache' });
    if ('caches' in window) await Promise.all((await caches.keys()).map((k) => caches.delete(k)));
    await reg?.update();
  } catch { /* still reload */ }
  location.reload();
}
$('#update-reload').addEventListener('click', hardRefresh);
checkForUpdate();
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkForUpdate(); });
setInterval(checkForUpdate, 30 * 60 * 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.token && !el.app.hidden) refresh();
});

window.addEventListener('hashchange', route);

translateDom();
if (state.token) enterApp(); else showLogin();
