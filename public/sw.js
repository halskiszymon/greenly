// sw.js — offline shell cache + web push. API calls always go to the network.
const CACHE = 'greenly-shell-v2';
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

  // Shell: cache first, refresh in background.
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((cached) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
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
