// sw.js — offline shell cache + web push. API calls always go to the network.
const CACHE = 'greenly-shell-v5';
// Shell files are fetched network-first so an installed PWA runs the latest deploy on every open;
// the cache is the offline fallback. Everything else (icons) is cache-first with a background refresh.
const SHELL_PATHS = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest'];
const NETWORK_TIMEOUT_MS = 4000;
// Core shell: install fails if any of these is missing (the app cannot work without them).
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest'];
// Best-effort extras: a missing icon must never block installation (a stuck install
// leaves navigator.serviceWorker.ready pending forever, which breaks push setup).
const EXTRAS = ['./img/icon-192.png', './img/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL).then(() => Promise.allSettled(EXTRAS.map((u) => c.add(u)))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache the API (plants, photos, auth).
  if (url.pathname.includes('/api/')) return;
  if (url.origin !== self.location.origin) return;

  const isShell = request.mode === 'navigate' || SHELL_PATHS.some((p) => url.pathname.endsWith(p));
  event.respondWith(isShell ? networkFirst(request) : staleWhileRevalidate(request));
});

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await withTimeout(fetch(request), NETWORK_TIMEOUT_MS);
    if (res.ok) await cache.put(request, res.clone());
    return res;
  } catch {
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    if (request.mode === 'navigate') return cache.match('./index.html') ?? cache.match('./');
    throw new Error('offline');
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, { ignoreSearch: true });
  const network = fetch(request)
    .then((res) => { if (res.ok) cache.put(request, res.clone()); return res; })
    .catch(() => cached);
  return cached || network;
}

// The page asks for a hard refresh: drop every cache so the next load is entirely fresh.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'greenly-clear-cache') {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))));
  }
});

self.addEventListener('push', (event) => {
  let data = { title: 'greenLy', body: 'Czas podlać rośliny.', url: './' };
  try { data = { ...data, ...event.data.json() }; } catch { /* plain text payload */ }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: './img/icon-192.png',
      badge: './img/icon-192.png',
      tag: data.tag || 'greenly',
      renotify: true,
      data: { url: data.url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || './', self.location.href).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
    }),
  );
});
