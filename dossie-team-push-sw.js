/* Dossie Team Dashboard — risk-alert Web Push service worker.
 *
 * Separate from jarvis-pwa-sw.js on purpose: that one owns the Jarvis PWA's
 * offline shell caching (a whole different app, a whole different concern)
 * and is scoped/registered only for heath.shepard@kw.com's Jarvis session.
 * This one has exactly one job — receive a Web Push event for the Team
 * Dashboard risk-alert feature (api/cron-hourly-team-risk-alerts.js) and
 * show a real OS notification, for any Team/Brokerage org admin who opted
 * in from TeamView.jsx ("Enable risk alerts"). No shell caching, no offline
 * fallback — the Dossie app itself is not an installed PWA, this SW exists
 * purely because the Push API requires an active service worker registration
 * to receive push events at all.
 *
 * Payload shape sent by api/cron-hourly-team-risk-alerts.js:
 *   { title, body, data: { url, tag } }
 *
 * Owner: Carter, 2026-08-23 (SV-ENG-TEAM-RISK-PUSH)
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'Dossie', body: event.data.text() }; }
  const data = payload.data || {};
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Dossie — Team risk alert', {
      body: payload.body || '',
      icon: '/jarvis-pwa-icon-192.png',
      badge: '/jarvis-pwa-icon-192.png',
      tag: data.tag || 'dossie-team-risk',
      renotify: true,
      data,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      const target = (event.notification.data && event.notification.data.url) || '/app';
      for (const client of clients) {
        if (client.url.includes('/app') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(target);
    })
  );
});
