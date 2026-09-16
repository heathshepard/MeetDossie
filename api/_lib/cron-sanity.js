'use strict';

// api/_lib/cron-sanity.js
//
// Static scan of vercel.json's `crons` array — catches the exact trick that
// hid the 2026-07 content-engine shutdown for weeks: a cron schedule like
// `0 0 1 1 *` (fixed day-of-month AND fixed month = fires ~once a year,
// i.e. "disabled" without ever removing the entry or tripping a missed-fire
// alert) plus a cron whose `path` no longer has a matching handler file on
// disk (route 404s forever, invisible unless someone happens to curl it).
//
// Deliberately separate from api/cron-cron-fire-verifier.js's
// REGISTERED_CRONS check — that one verifies crons ALREADY in its hand-
// maintained list actually FIRED recently (via cron_runs). This one reads
// vercel.json directly (no hand-maintained list to drift out of sync) and
// catches problems that show up in the SCHEDULE SYNTAX or FILE PATH itself,
// before the cron would ever need to fire for the other check to notice.
//
// Runtime note: reading vercel.json + api/**/*.js from inside a Vercel
// function requires `includeFiles` in vercel.json's `functions` block for
// whichever route calls this (precedent: api/cron-codebase-facts-indexer.js
// already does `includeFiles: "{vercel.json,*.html,api/**/*.js}"`).
// api/cron-silence-alarm.js (this module's only caller) has the matching
// entry — see vercel.json.
//
// Owner: Carter, 2026-09-16

const fs = require('fs');
const path = require('path');
const { FROZEN_SCHEDULE_PATTERNS } = require('./paused-crons.js');

// A cron field ("min"/"hour"/"dom"/"month"/"dow") counts as FIXED when it's
// a single literal number — not `*`, not a list (`1,15`), not a range
// (`1-5`), not a step (`*/2`). Any of those means "recurs" and is fine.
function isFixedField(field) {
  if (typeof field !== 'string') return false;
  return /^\d+$/.test(field.trim());
}

// A schedule where BOTH day-of-month AND month are fixed literals fires at
// most once a year (`0 0 1 1 *` = Jan 1 only). That's the generalized form
// of the exact pattern that hid the 2026-07 shutdown — not hardcoded to
// Jan 1 specifically, so e.g. `0 0 15 6 *` (June 15 only) is caught too.
function isNearNeverSchedule(schedule) {
  const fields = String(schedule || '').trim().split(/\s+/);
  if (fields.length !== 5) return { nearNever: false, reason: null };
  const [, , dom, month] = fields;
  if (isFixedField(dom) && isFixedField(month)) {
    return { nearNever: true, reason: `day-of-month and month both fixed ("${dom} ${month}") — fires at most once/year` };
  }
  return { nearNever: false, reason: null };
}

// `/api/cron-foo` -> `<apiDir>/cron-foo.js`. Vercel's `path` field is always
// the route, never the file extension — mirror that mapping exactly.
function handlerFileFor(apiDir, routePath) {
  const rel = String(routePath || '').replace(/^\/?api\//, '');
  if (!rel) return null;
  return path.join(apiDir, `${rel}.js`);
}

/**
 * @param {object} opts
 * @param {string} [opts.vercelJsonPath] - defaults to repo-root vercel.json
 * @param {string} [opts.apiDir] - defaults to repo-root api/
 * @returns {{ ok: boolean, error?: string, totalCrons?: number, issues?: Array }}
 */
function scanCronSanity(opts = {}) {
  // Mirrors api/_lib/paused-crons.js's candidate-path fallback — Vercel's
  // process.cwd() at runtime doesn't always match __dirname-relative math,
  // so try both rather than betting on one.
  const candidates = opts.vercelJsonPath ? [opts.vercelJsonPath] : [
    path.join(process.cwd(), 'vercel.json'),
    path.join(__dirname, '..', '..', 'vercel.json'),
    path.resolve('vercel.json'),
  ];
  const apiDir = opts.apiDir || path.join(__dirname, '..');

  let raw = null;
  let triedPath = null;
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        raw = fs.readFileSync(p, 'utf8');
        triedPath = p;
        break;
      }
    } catch (_e) { /* keep trying */ }
  }
  if (!raw) {
    // Fail LOUD, not silent-zero — a missing vercel.json at runtime (e.g.
    // includeFiles not wired for the calling route) must never look like
    // "scanned, found nothing wrong".
    return { ok: false, error: `could not read vercel.json — tried: ${candidates.join(', ')}` };
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `vercel.json at ${triedPath} is not valid JSON: ${err.message}` };
  }

  const crons = Array.isArray(config.crons) ? config.crons : [];
  const issues = [];

  for (const cron of crons) {
    const { nearNever, reason } = isNearNeverSchedule(cron.schedule);
    if (nearNever) {
      // api/_lib/paused-crons.js already tracks a KNOWN, deliberate use of
      // this exact pattern (the 2026-07-03 cost-freeze marker) — still
      // reported here (Heath's ask: nothing near-never should be silently
      // invisible, deliberate or not, especially since this exact class of
      // schedule is what hid the 2026-07 shutdown) but labeled distinctly
      // from an unexplained one so a known freeze doesn't read as a fresh
      // incident every single morning.
      const isKnownFreeze = FROZEN_SCHEDULE_PATTERNS.has(cron.schedule);
      issues.push({
        type: isKnownFreeze ? 'near_never_schedule_known_freeze' : 'near_never_schedule',
        path: cron.path,
        schedule: cron.schedule,
        detail: isKnownFreeze ? `${reason} — matches the known cost-freeze marker (api/_lib/paused-crons.js)` : reason,
      });
    }

    const handlerFile = handlerFileFor(apiDir, cron.path);
    if (handlerFile && !fs.existsSync(handlerFile)) {
      issues.push({
        type: 'missing_handler',
        path: cron.path,
        schedule: cron.schedule,
        detail: `no handler file found at ${handlerFile}`,
      });
    }
  }

  return { ok: true, totalCrons: crons.length, issues };
}

module.exports = {
  isFixedField,
  isNearNeverSchedule,
  handlerFileFor,
  scanCronSanity,
};
