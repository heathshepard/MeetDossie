'use strict';

// api/_lib/paused-crons.js
// =============================================================================
// PAUSED-CRON DETECTOR
//
// WHY
//   During the 2026-07-03 emergency cost freeze, 24 Anthropic-hitting crons were
//   rescheduled to `0 0 1 1 *` (Jan 1 only) to stop the bleed. Watchdogs (queue
//   tick + autonomous-loop cron-failure signal) had no way to distinguish
//   "paused on purpose" from "actually broken", and hammered Heath overnight
//   with "Dispatcher appears stuck: 5 ready tasks..." and generated 5 stuck
//   agent_queue rows for phantom crons.
//
// WHAT
//   Reads `vercel.json` from the deployment bundle at cold start and exposes a
//   simple API for callers:
//     - isPaused(cronPath)  → true if schedule is the freeze pattern OR absent
//     - listPaused()        → array of paused cron paths
//     - pauseReason(path)   → 'schedule_frozen' | 'not_registered' | null
//
//   Both the frozen-schedule case AND the not-registered case get treated as
//   "intentionally paused" — a cron that's not in vercel.json can't fire, so
//   any downstream signal claiming it's failing is stale noise.
//
// COLD-START CACHE
//   vercel.json is read once per function instance and cached in module scope.
//   The next deploy invalidates all warm instances, so the cache stays fresh
//   automatically when someone updates the freeze list.
//
// FALLBACK
//   If vercel.json can't be read (bundle didn't include it), returns
//   isPaused() = false for everything. That's safe — the pre-fix behavior
//   was to alert on every stuck row, so falling back to that is fine.
//
// Owner: Atlas, 2026-07-04 (watchdog pause-aware refactor).

const fs = require('fs');
const path = require('path');

// The freeze pattern used on 2026-07-03. Anything matching this schedule is
// treated as intentionally paused. If a future freeze uses a different pattern
// (e.g. `0 0 29 2 *`), add it here.
const FROZEN_SCHEDULE_PATTERNS = new Set([
  '0 0 1 1 *',   // Jan 1 midnight UTC — the current freeze marker
]);

let _cache = null;   // { registered: Map<path,schedule>, paused: Set<path> }
let _loaded = false;
let _loadError = null;

function loadManifest() {
  if (_loaded) return _cache;
  _loaded = true;

  // Try a few candidate locations. Vercel serverless functions run under
  // process.cwd() = deployment root when includeFiles pulls the file in.
  const candidates = [
    path.join(process.cwd(), 'vercel.json'),
    path.join(__dirname, '..', '..', 'vercel.json'),
    path.resolve('vercel.json'),
  ];

  let raw = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        raw = fs.readFileSync(p, 'utf8');
        break;
      }
    } catch (e) {
      // keep trying
    }
  }

  if (!raw) {
    _loadError = 'vercel.json not found in bundle';
    _cache = { registered: new Map(), paused: new Set() };
    return _cache;
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    _loadError = `parse failed: ${e.message}`;
    _cache = { registered: new Map(), paused: new Set() };
    return _cache;
  }

  const registered = new Map();
  const paused = new Set();
  const crons = Array.isArray(manifest && manifest.crons) ? manifest.crons : [];
  for (const c of crons) {
    if (!c || !c.path) continue;
    registered.set(c.path, c.schedule || '');
    if (FROZEN_SCHEDULE_PATTERNS.has(c.schedule)) {
      paused.add(c.path);
    }
  }

  _cache = { registered, paused };
  return _cache;
}

// Normalize a cron identifier to the vercel.json path form. Callers may pass:
//   '/api/cron-agent-queue-dispatch'
//   'cron-agent-queue-dispatch'
//   'api/cron-agent-queue-dispatch'
// All three should resolve to '/api/cron-agent-queue-dispatch'.
function normalize(cronIdent) {
  if (!cronIdent) return null;
  let p = String(cronIdent).trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.startsWith('/api/')) {
    p = p.replace(/^\/+/, '/api/');
  }
  return p;
}

function isPaused(cronIdent) {
  const p = normalize(cronIdent);
  if (!p) return false;
  const m = loadManifest();
  if (m.paused.has(p)) return true;
  // Not registered at all → also treat as paused (can't fire = not our concern).
  if (!m.registered.has(p)) return true;
  return false;
}

function pauseReason(cronIdent) {
  const p = normalize(cronIdent);
  if (!p) return null;
  const m = loadManifest();
  if (m.paused.has(p)) return 'schedule_frozen';
  if (!m.registered.has(p)) return 'not_registered';
  return null;
}

function listPaused() {
  const m = loadManifest();
  return Array.from(m.paused).sort();
}

function debugState() {
  const m = loadManifest();
  return {
    loaded: _loaded,
    load_error: _loadError,
    registered_count: m.registered.size,
    paused_count: m.paused.size,
    paused_sample: Array.from(m.paused).slice(0, 5),
  };
}

module.exports = {
  isPaused,
  pauseReason,
  listPaused,
  debugState,
  FROZEN_SCHEDULE_PATTERNS,
};
