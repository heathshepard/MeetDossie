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
 *
 * 2026-08-22 (Carter): cache key bumped to v12 for real Web Push. The `push`
 * / `notificationclick` listeners below already existed as a stub ("Session
 * 2 will hook real subscriptions") -- this pass is that Session 2: real
 * VAPID keys, api/jarvis-push-subscribe.js storing the subscription,
 * api/jarvis-push-send.js sending from the server the moment
 * scripts/jarvis-bridge/server.ts's `reply` tool goes final. Notification
 * icon switched from the SVG to the PNG (192px) -- Chrome/Android's
 * showNotification() icon support for SVG is inconsistent, PNG is not.
 * Added `tag`+`renotify` so a second push for the same turn (shouldn't
 * happen, but defensive) replaces rather than stacks.
 *
 * 2026-08-22 PM (Carter): cache key bumped to v13 for the new "Today"
 * session-log panel (header button + api/jarvis-session-log.js) -- per this
 * file's own documented recurring bug above, an already-open tab or
 * installed PWA will keep running stale JS and never show a brand-new
 * button unless the cache key changes.
 *
 * 2026-08-26 (Atlas): cache key bumped to v14. Root cause of "mic self-
 * healing isn't working" (2026-08-26 live report): the mic self-heal code
 * itself (recoverMicStream + the 4 real triggers, commits ab26e7ac/1aad1fe4,
 * shipped 2026-08-25 ~14:47-14:51) is correct on disk and re-verified in a
 * real signed-in browser session today -- but this SW file (and therefore
 * CACHE) was never touched by those commits, and per the exact recurring
 * pattern documented above (v9/v10/v13), an already-open Jarvis session from
 * BEFORE that fix shipped has been running the old in-memory JS ever since --
 * no self-heal code was ever loaded into it, so of course it never fired.
 * Three more commits landed on top since (TTS pre-buffer 3c604ef8, jarvis-
 * balls 4d35502e, jarvis-approvals 26ff25cc) with the same gap. Bumping now
 * forces the controllerchange->reload cycle on Heath's NEXT real navigation.
 * If a plain tab reload doesn't pick it up (Android suspend/resume is not a
 * real navigation, per the v10 comment), a true close + reopen or Force stop
 * is required.
 *
 * 2026-08-26 PM (Atlas): cache key bumped to v15 -- fixes a live outage the
 * v14 bump itself caused ("couldn't load" on every panel, reported
 * immediately after Heath closed+reopened per the v14 instructions).
 * Reproduced with Playwright: registered v13 as the "already-open session,"
 * then let v15's real script through and reloaded the same tab (simulating
 * close+reopen) -- captured 4 stacked boot() cycles and multiple
 * `TypeError: Failed to fetch` errors in afterSignIn/loadCalendar/
 * loadPendingApprovals/loadInFlightWork/loadTickers, i.e. real panel fetches
 * getting aborted mid-flight. Root cause: TWO independent triggers both try
 * to reload the page the instant a new SW takes control -- this file's own
 * `activate` handler below used to call `client.navigate(client.url)` on
 * every window client right after `clients.claim()`, AND jarvis-pwa.html has
 * its own `controllerchange` listener that calls `window.location.reload()`
 * (added the same day, 2026-06-26, as a belt-and-suspenders duplicate of the
 * same intent). `clients.claim()` fires `controllerchange` in the page
 * essentially synchronously with this handler's own subsequent
 * `client.navigate()` call, so both fire near-simultaneously and race: the
 * browser ends up re-navigating/re-running boot() 3-4x instead of once, and
 * any boot() cycle caught mid-fetch when the NEXT navigation starts throws
 * "Failed to fetch" for that panel with no retry logic to recover it -- the
 * panel is left stuck on "Couldn't load" until a further manual reload,
 * which is exactly what Heath saw ("couldn't load" on every panel) right
 * after doing the close+reopen he was told to do. Fix: removed the
 * `client.navigate()` loop from `activate` below -- the page's own
 * `controllerchange` -> `reload()` listener is the single source of truth
 * for "reload when a new SW takes control" now, so there's exactly one
 * navigation trigger instead of two racing ones. `clients.claim()` is kept
 * (still needed so the new SW controls existing clients at all). Re-verified
 * with the same v13->v15 transition repro: 1 boot() cycle, zero fetch
 * failures, all panels render real data.
 */
const CACHE = 'jarvis-pwa-v15-2026-08-26-fix-double-reload-race';
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
    ).then(() => self.clients.claim())
    // 2026-08-26 (Atlas): removed the `client.navigate()` force-reload loop
    // that used to live here (added 2026-06-26). It raced with
    // jarvis-pwa.html's own `controllerchange` -> `window.location.reload()`
    // listener, which already handles "reload when a new SW takes control."
    // Two simultaneous navigation triggers on the same client caused 3-4x
    // stacked boot() cycles and aborted in-flight panel fetches
    // ("Failed to fetch" / "Couldn't load" on every panel) -- see the v15
    // header comment above for the full repro. `clients.claim()` alone is
    // enough: it's what makes `controllerchange` fire in the page in the
    // first place, and the page's listener does the single reload from there.
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

// Real Web Push — api/jarvis-push-send.js sends the payload shape this
// expects: { title, body, data: { url, tag } }. Fired the moment a live
// bridge reply goes final (scripts/jarvis-bridge/server.ts's `reply` tool),
// so this is what reaches Heath when the Jarvis tab is backgrounded/suspended
// and can't finish its own client-side poll loop.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch { payload = { title: 'Jarvis', body: event.data.text() }; }
  const data = payload.data || {};
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Jarvis', {
      body: payload.body || '',
      icon: '/jarvis-pwa-icon-192.png',
      badge: '/jarvis-pwa-icon-192.png',
      tag: data.tag || 'jarvis-reply',
      renotify: true,
      data,
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
