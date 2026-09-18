'use strict';

// Sage trigger marker parser.
//
// Sage can include markers in her replies to fire approved cron jobs. Example:
//
//   [TRIGGER: generate-posts]
//   [TRIGGER: reddit-scan]
//   [TRIGGER: send-for-approval]
//
// The webhook parses these markers, calls api/sage-trigger which authenticates
// via SAGE_TRIGGER_SECRET, fires the actual cron, and reports execution back
// to Sage's chat.

const ALLOWED_TRIGGERS = {
  'generate-posts':      { path: '/api/cron-generate-posts',     method: 'POST' },
  'reddit-scan':         { path: '/api/cron-reddit-scanner',     method: 'POST' },
  'send-for-approval':   { path: '/api/cron-send-for-approval',  method: 'POST' },
  'fb-group-post':       { path: '/api/cron-daily-fb-posts',     method: 'POST' },
  'publish-approved':    { path: '/api/cron-publish-approved',   method: 'POST' },
  // 'social-digest' removed 2026-09-18 — cron-social-digest.js was retired
  // (folded into api/cron-silence-alarm.js's morning heartbeat, see that
  // file's header). Deleted, not just unlisted — do not re-add.
  'analytics-sync':      { path: '/api/cron-analytics-sync',     method: 'POST' },
  'sage-trends':         { path: '/api/cron-sage-trends',        method: 'POST' },
};

const TRIGGER_MARKER_REGEX = /\[\s*TRIGGER\s*:\s*([a-z0-9_-]{2,40})\s*\]/gi;

function extractTriggerMarkers(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  for (const m of text.matchAll(TRIGGER_MARKER_REGEX)) {
    const name = String(m[1] || '').trim().toLowerCase();
    if (!ALLOWED_TRIGGERS[name]) continue;
    out.push({ raw: m[0], trigger: name });
  }
  return out;
}

function stripTriggerMarkers(text) {
  if (!text || typeof text !== 'string') return text || '';
  return text.replace(TRIGGER_MARKER_REGEX, (_match, name) => {
    return `[firing ${String(name || '').trim()}...]`;
  });
}

module.exports = {
  ALLOWED_TRIGGERS,
  extractTriggerMarkers,
  stripTriggerMarkers,
};
