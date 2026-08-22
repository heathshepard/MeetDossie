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
 *
 * 2026-06-28 (Atlas): cache key bumped to v7 to force-refresh Heath's Z Fold —
 * Heath flagged TWO bugs caused by stale cached HTML:
 *   1) CUSTOMER ACTIVITY / ACTIONS FOR YOU / TO-DO panels showed "Offline."
 *      (Server returns 200 + real data; verified via signed-in Playwright as
 *      heath.shepard@kw.com — all three panels render. Heath's WebView was
 *      serving stale HTML where the render path threw.)
 *   2) Attach button only opened camera (fix 9d1047f4 removed capture="environment"
 *      but his WebView held the pre-fix HTML).
 * Bumping cache name forces SW activate → claim → navigate() reload of all
 * window clients, pulling the latest /jarvis-pwa.html.
 *
 * 2026-06-28 iter v3 (Atlas): cache key bumped to v8 — defensive panel render
 * + SW v7 had not yet merged to main when Heath retested, and Bug 1 (Offline.)
 * + Bug 2 (camera-only picker) were both still live in prod. Adding `multiple`
 * to the file input forces Android Z Fold to show the full picker chooser
 * (One UI default behavior: image/* single = camera, image/* multiple = chooser).
 * v8 forces fresh fetch of jarvis-pwa.html on activate.
 *
 * 2026-08-13 (Atlas): cache key bumped to v9 — NOT for a shell-caching bug
 * this time (the v8 network-only/no-store shell policy below already fetches
 * jarvis-pwa.html fresh on every real page load/reopen; that part was never
 * broken). Bumped because tonight's latency fix (jarvis-pwa.html routing +
 * VAD change, commits f9a16f2f/90742454) shipped to production while Heath's
 * Jarvis PWA tab was already open and running — confirmed live via fresh
 * jarvis-bridge Storage turns still hitting the old always-bridge code path
 * 30+ min after deploy. An already-open tab has the old inline JS resident in
 * memory; it does not re-fetch/re-run its own <script> tags just because the
 * server file changed, and this SW's own controllerchange->reload listener
 * (jarvis-pwa.html, ~line 8590) only fires when a NEW service worker
 * actually activates -- which requires this file's bytes to change. Since
 * v8 was untouched by tonight's fix, that self-heal chain never fired for
 * his already-open session. Bumping this file now (content-only change, no
 * fetch-strategy change) gives future same-shape fixes the same self-heal
 * path this comment describes, without Heath needing to manually
 * close/reopen the app. For TONIGHT's specific fix, closing and reopening
 * the app (or a hard refresh) is still the immediate unblock -- the v8 shell
 * policy already fetches fresh content on that next real load regardless of
 * this SW's own version.
 *
 * 2026-08-22 (Atlas): cache key bumped to v10 for the typed-text-bridge fix
 * (9dc6d5df, merged to main + verified live 2026-08-21). Same recurrence as
 * v9: Heath's already-open Jarvis PWA tab kept POSTing typed text through the
 * old API-only path -- confirmed directly via the jarvis-bridge Storage
 * bucket showing no new turn landed after the fix shipped. Asking Heath to
 * manually close/reopen the app TWICE did not unblock it this time, which
 * contradicts the v9 comment's claim that the v8 network-only shell policy
 * alone is enough on next real load. Re-read the fetch handler below to
 * confirm it's not regressed: it is not -- SHELL paths (including
 * /jarvis-pwa.html) still get a genuine `fetch(req, {cache:'no-store'})`,
 * bypassing both this SW's cache and the HTTP cache. The policy is correctly
 * implemented. The gap is upstream of it: on Android, "closing" an installed
 * PWA from the recent-apps switcher backgrounds/suspends the WebView instead
 * of tearing it down, and reopening it resumes the SAME in-memory page --
 * no new navigation, no new HTTP request, so this SW's fetch handler (and the
 * jarvis-pwa.html <script> that calls navigator.serviceWorker.register(),
 * ~line 8843) never re-runs at all. The stale inline JS just keeps executing
 * in place. A cache-key bump only forces the fix once a REAL navigation
 * happens (the browser's install/activate/controllerchange/reload cycle,
 * jarvis-pwa.html ~line 8849, needs an actual page load to fire). Bumping
 * this file is still correct and necessary -- it's what lets the very next
 * real load (or a force-stop of the app in Android Settings, not just
 * swipe-away) pick up the fix and self-heal without Heath doing anything
 * else. But if a swipe-close/reopen alone doesn't trigger a real navigation
 * on his device, that step will not be enough by itself -- he needs a true
 * process kill (Android Settings > Apps > Jarvis > Force stop, then reopen)
 * or a hard refresh if running it as a browser tab instead of the installed
 * PWA.
 */
const CACHE = 'jarvis-pwa-v11-2026-08-22-voice-mode-bridge-fix';
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
