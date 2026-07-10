/* roz — service worker
   Dos trabajos: (1) shell de la PWA para arranques rápidos / offline, y (2) recibir web push
   y abrir la app en la vista correcta al tocar la notificación. Archivo vanilla: Vite lo copia
   tal cual desde web/public → dist (no pasa por el bundler). */

const CACHE = 'roz-shell-v2';
const SHELL = ['/app', '/', '/icon-192.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Solo navegaciones: network-first (contenido fresco con red) con fallback al shell cacheado
// (offline). Los assets hasheados los resuelve el HTTP cache; nunca interceptamos API/webhooks.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (/^\/(api|v1|webhooks|mcp)\b/.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put('/app', fresh.clone()).catch(() => {});
        return fresh;
      } catch {
        return (await caches.match('/app')) || (await caches.match('/')) || Response.error();
      }
    })());
  }
});

// ---- Web Push ----
// El backend envía un JSON: { title, body, url, tag, icon, badge, requireInteraction }.
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }

  const title = data.title || 'ROZ';
  const options = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/icon-192.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    data: { url: data.url || '/app/infra' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/app/infra';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of all) {
      if ('focus' in client) {
        try { await client.focus(); } catch (_) { /* noop */ }
        if ('navigate' in client) { try { await client.navigate(target); } catch (_) { /* noop */ } }
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
