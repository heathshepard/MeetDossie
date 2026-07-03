// PostHog loader for MeetDossie static landing pages.
//
// Why this file exists: static HTML pages (founding.html, index.html,
// welcome.html, calculator.html, agents/, coordinators/, etc.) have no
// Vite build step so they can't read import.meta.env at runtime. We
// fetch the public key from /api/public-config and boot PostHog once
// it lands. If the key isn't configured yet, all posthog.capture()
// calls quietly no-op — safe to ship before Heath's account exists.
//
// Usage on any page:
//   <script src="/assets/posthog-loader.js" defer></script>
//   <script>
//     document.addEventListener('posthog:ready', function () {
//       // now safe to call window.posthog.capture(...)
//     });
//   </script>
//
// The loader also automatically fires `$pageview` once init completes.

(function () {
  if (window.__posthogLoaderBooted) return;
  window.__posthogLoaderBooted = true;

  // Stub queue: any posthog.capture() calls made BEFORE the SDK finishes
  // loading get queued and drained after init. Same pattern PostHog's
  // snippet uses. Prevents dropped events during the ~200ms boot window.
  window.posthog = window.posthog || {
    _q: [],
    capture: function () { this._q.push(['capture', arguments]); },
    identify: function () { this._q.push(['identify', arguments]); },
    alias: function () { this._q.push(['alias', arguments]); },
    reset: function () { this._q.push(['reset', arguments]); },
  };

  function loadSdk(host, key) {
    var s = document.createElement('script');
    s.src = host + '/static/array.js';
    s.async = true;
    s.onload = function () {
      try {
        // The real posthog global replaces the stub; the SDK reads _q.
        window.posthog.init(key, {
          api_host: host,
          autocapture: false, // landing pages fire explicit events
          capture_pageview: true,
          persistence: 'localStorage+cookie',
        });
        document.dispatchEvent(new CustomEvent('posthog:ready'));
      } catch (err) {
        console.warn('[posthog-loader] init failed:', err && err.message);
      }
    };
    s.onerror = function () {
      console.warn('[posthog-loader] SDK failed to load from', host);
    };
    document.head.appendChild(s);
  }

  fetch('/api/public-config', { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg || !cfg.posthogKey) {
        // Analytics not configured. Every queued capture stays in the
        // stub queue and is silently dropped when the page unloads.
        // Fire the ready event anyway so page code doesn't hang waiting.
        document.dispatchEvent(new CustomEvent('posthog:ready', { detail: { configured: false } }));
        return;
      }
      loadSdk(cfg.posthogHost || 'https://us.i.posthog.com', cfg.posthogKey);
    })
    .catch(function (err) {
      console.warn('[posthog-loader] config fetch failed:', err && err.message);
      document.dispatchEvent(new CustomEvent('posthog:ready', { detail: { configured: false } }));
    });
})();
