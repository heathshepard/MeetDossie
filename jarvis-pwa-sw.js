/* Jarvis PWA service worker — Session 1
 * Caches the shell + manifest + icon for offline open.
 * Does NOT cache API responses (voice / chat / TTS must always go live).
 * Per DoD criteria 94, 95: offline graceful degradation, last-50-messages
 * cached via IndexedDB (handled in app code, not here).
 *
 * 2026-06-26 (Atlas): cache key bumped to v4 to invalidate stale Capacitor
 * WebView caches of jarvis-pwa.html that were serving pre-STT-fix HTML even
 * after main shipped 0465144 (Android empty-audio STT silent-fail fix).
 * Switched to network-only for the HTML shell so a stale cached page can
 * never be served while the device is online — offline still falls back
 * to whatever was last cached.
 */
const CACHE = 'jarvis-pwa-v4-2026-06-26-stt-fix-invalidate';
const SHELL = [
  '/myjarvis',
  '/jarvis-pwa.html',
  '/jarvis-pwa-manifest.json',
  '/jarvis-pwa-icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim()).then(async () => {
      // 2026-06-26 (Atlas): when a new SW takes control, force-reload all
      // window clients so they pick up the fresh shell HTML/JS instead of
      // whatever the page was already rendering when the SW upgraded.
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        try { client.navigate(client.url); } catch (_) { /* navigate not supported on some WebViews */ }
      }
    })
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never cache API calls
  if (url.pathname.startsWith('/api/')) {
    return;
  }
  // Never cache Supabase requests
  if (url.host.endsWith('.supabase.co')) {
    return;
  }

  // Shell paths — network ONLY when online, fall back to cache only on network failure.
  // 2026-06-26 (Atlas): was "network first then store" but Capacitor WebView was
  // racing and serving cached HTML on cold start. Force network with a no-store fetch
  // so the WebView's HTTP cache layer also gets bypassed. Cache is updated for
  // offline fallback but never served while online.
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      fetch(req, { cache: 'no-store' }).then((res) => {
        if (res && res.status === 200) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // Default: try cache, fall back to network
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req).catch(() => cached))
  );
});

// Listen for push notifications (Session 2 will hook real subscriptions)
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'Jarvis', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Jarvis', {
      body: payload.body || '',
      icon: '/jarvis-pwa-icon.svg',
      badge: '/jarvis-pwa-icon.svg',
      data: payload.data || {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const target = (event.notification.data && event.notification.data.url) || '/myjarvis';
      for (const client of clients) {
        if (client.url.includes('/myjarvis') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
