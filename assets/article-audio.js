// assets/article-audio.js
// "Listen to this guide/answer" button — shared by /guides/* and /answers/*
// static templates (scripts/build-guides.js, scripts/build-answers.js).
//
// Markup contract (set by the page template):
//   <button id="dossie-listen-btn" class="listen-btn"
//           data-type="guide|answer" data-slug="...">
//     <span class="listen-icon">...</span>
//     <span class="listen-label">Listen to this guide</span>
//   </button>
//   <audio id="dossie-listen-audio" preload="none"></audio>
//
// Audio comes from GET /api/article-audio?type=...&slug=... — first click
// per page triggers on-demand ElevenLabs generation server-side (cached in
// Supabase Storage after that), so the first play on a cold page can take a
// few seconds; the button shows a loading state for it.

(function () {
  var btn = document.getElementById('dossie-listen-btn');
  var audio = document.getElementById('dossie-listen-audio');
  if (!btn || !audio) return;

  var label = btn.querySelector('.listen-label');
  var icon = btn.querySelector('.listen-icon');
  var loading = false;
  var started = false;

  var ICONS = {
    idle: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    playing: '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    loading: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" class="listen-spin"><circle cx="12" cy="12" r="9" stroke-opacity="0.25"/><path d="M21 12a9 9 0 0 0-9-9"/></svg>',
  };

  var LABELS = {
    idle: btn.getAttribute('data-idle-label') || 'Listen to this guide',
    loading: 'Loading audio…',
    playing: 'Pause',
    paused: 'Resume listening',
  };

  function setState(s) {
    btn.setAttribute('data-state', s);
    if (label) label.textContent = LABELS[s] || LABELS.idle;
    if (icon) icon.innerHTML = s === 'playing' ? ICONS.playing : (s === 'loading' ? ICONS.loading : ICONS.idle);
  }

  function track(event) {
    try {
      if (window.posthog && window.posthog.capture) {
        window.posthog.capture(event, { page_type: btn.getAttribute('data-type'), page_slug: btn.getAttribute('data-slug') });
      }
    } catch (_) { /* analytics never load-bearing */ }
  }

  setState('idle');

  btn.addEventListener('click', function () {
    if (loading) return;

    if (started) {
      if (audio.paused) { audio.play(); } else { audio.pause(); }
      return;
    }

    loading = true;
    setState('loading');
    track('article_audio_started');

    var type = btn.getAttribute('data-type') || 'guide';
    var slug = btn.getAttribute('data-slug') || '';
    audio.src = '/api/article-audio?type=' + encodeURIComponent(type) + '&slug=' + encodeURIComponent(slug);

    audio.play().then(function () {
      started = true;
      loading = false;
      setState('playing');
    }).catch(function (err) {
      loading = false;
      started = false;
      setState('idle');
      console.warn('[article-audio] playback failed', err);
    });
  });

  audio.addEventListener('play', function () { setState('playing'); });
  audio.addEventListener('pause', function () { if (started) setState('paused'); });
  audio.addEventListener('ended', function () { started = false; setState('idle'); });
  audio.addEventListener('error', function () {
    if (loading || started) {
      loading = false;
      started = false;
      setState('idle');
    }
  });
})();
