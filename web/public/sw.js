/* roz — service worker
   Dos trabajos: (1) shell de la PWA para arranques rápidos / offline, y (2) recibir web push
   y abrir la app en la vista correcta al tocar la notificación. Archivo vanilla: Vite lo copia
   tal cual desde web/public → dist (no pasa por el bundler). */

const CACHE = 'roz-shell-v3';
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
// El backend envía un JSON: { title, body, url, tag, icon, badge, requireInteraction, data }.
// `data.kind === 'chat'` trae `conversationId`, `messageId` (y `threadId` si es una respuesta en hilo).

/** ¿Hay una ventana de roz enfocada mostrando esa conversación? Entonces el aviso sobra: la
 *  persona ya lo está viendo (y el chat lo recibe por tiempo real). Se le avisa a esa ventana por
 *  postMessage por si su conexión en vivo estaba caída. */
async function chatAlreadyVisible(info) {
  if (!info || info.kind !== 'chat' || !info.conversationId) return false;
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  let visible = false;
  for (const client of all) {
    try {
      const url = new URL(client.url);
      if (client.focused && client.visibilityState === 'visible' && url.pathname === '/app/chat/' + info.conversationId) {
        visible = true;
        client.postMessage({ type: 'chat-push', conversationId: info.conversationId, threadId: info.threadId || null });
      }
    } catch (_) { /* noop */ }
  }
  return visible;
}

// ---- Sonido propio (notificacion.mp3) ----
// Ningún navegador respeta la opción `sound` de showNotification: el aviso del sistema suena con el
// tono del sistema operativo. Y un service worker no puede reproducir audio. Así que, si hay una
// ventana de roz abierta, se le pide a ELLA que suene (lib/sound.ts) y el aviso se muestra en
// silencio para no oír dos. Si ninguna contesta a tiempo (app cerrada, o pestaña congelada en el
// teléfono), el aviso sale con el sonido y la vibración del sistema.

const SOUND_TIMEOUT_MS = 800;

function askClientToPlay(client, msg) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), SOUND_TIMEOUT_MS);
    channel.port1.onmessage = (e) => { clearTimeout(timer); resolve(!!(e.data && e.data.handled)); };
    try { client.postMessage(msg, [channel.port2]); } catch (_) { clearTimeout(timer); resolve(false); }
  });
}

/** ¿Alguna ventana abierta hizo sonar el aviso? Se pregunta en orden (la enfocada, luego las
 *  visibles, luego el resto) y la primera que suena gana: dos ventanas no suenan a la vez. */
async function playInOpenWindow(key) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const rank = (c) => (c.focused ? 0 : c.visibilityState === 'visible' ? 1 : 2);
  const ordered = all.slice().sort((a, b) => rank(a) - rank(b)).slice(0, 3);
  for (const client of ordered) {
    if (await askClientToPlay(client, { type: 'play-sound', sound: 'notification', key })) return true;
  }
  return false;
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data && event.data.text() }; }

  const title = data.title || 'Roz';
  const info = data.data || {};
  // Misma llave que usa la app al recibir el mensaje por tiempo real: suena una sola vez.
  const soundKey = info.kind === 'chat' && info.messageId ? 'chat:' + info.messageId : data.tag || undefined;

  event.waitUntil((async () => {
    if (await chatAlreadyVisible(info)) return;
    const silent = await playInOpenWindow(soundKey);
    const options = {
      body: data.body || '',
      // Los avisos los firma Roz-bot: el backend manda su avatar con la expresión del aviso.
      icon: data.icon || '/brand/roz-bot.png',
      badge: data.badge || '/icon-192.png',
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: !!data.requireInteraction,
      timestamp: Date.now(),
      silent,
      data: { url: data.url || '/app/infra' },
    };
    // Vibración tipo mensaje en Android. Una notificación silenciosa no puede llevarla (lanza).
    if (!silent) options.vibrate = [120, 60, 120];
    await self.registration.showNotification(title, options);
  })());
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
