'use strict';

// api/_lib/cron-multiplex.js
//
// WHY
//   2026-09-16: staging's vercel.json hit the hard schema ceiling of 100
//   `crons` array entries (101 registered, deploy 167cb30a rejected outright
//   by Vercel's schema validator). Adding one more standalone cron entry per
//   new job was the pattern that got us there; it doesn't scale.
//
// WHAT
//   Lets N job handlers that already share the exact same Vercel `schedule`
//   string collapse into ONE vercel.json cron entry ("dispatcher"). The
//   dispatcher is invoked by Vercel at the shared schedule and fan-outs to
//   each real handler IN-PROCESS, in parallel, using the *same incoming
//   request* (so each handler's own existing CRON_SECRET / x-vercel-cron
//   auth check still runs unmodified — see note below).
//
// WHY THIS PRESERVES CADENCE EXACTLY
//   Only jobs with byte-identical `schedule` strings are grouped. The
//   dispatcher fires at that literal schedule; every merged job fires at
//   exactly the same minute it always did. No behavior change, just fewer
//   vercel.json entries.
//
// WHY THIS PRESERVES AUTH (CLAUDE.md section 15)
//   TWO layers, both required:
//     1. TOP-LEVEL GATE (isAuthorizedDispatch, below) — every dispatcher
//        calls this FIRST and returns 401 with zero sub-jobs invoked if it
//        fails. Added 2026-09-16 after Quinn's QA on staging found an
//        unauthenticated probe of a dispatcher route returned 207 (each
//        sub-job self-rejected, so no side effects ran, but the dispatcher
//        was still a free, publicly-callable way to fan out to and hammer
//        every handler on demand — a real surface even with zero jobs
//        actually executing).
//     2. PER-SUB-JOB GATE (unchanged, defense in depth) — Vercel's cron
//        invoker sets `x-vercel-cron: 1` on the dispatcher's incoming
//        request; a manual trigger sets `Authorization: Bearer
//        CRON_SECRET`. Both headers are forwarded unchanged to every
//        sub-handler via the SAME `req` object used to call the
//        dispatcher, so each sub-handler's own pre-existing auth check
//        still runs exactly as it would standalone. Deliberately NOT
//        removed even though the top-level gate now makes it redundant for
//        traffic that goes through the dispatcher — it's still the only
//        gate for anyone hitting a member's own standalone route directly.
//
// EXECUTION MODEL
//   Parallel (Promise.all), not sequential — summing several jobs'
//   maxDuration would blow past the platform's per-function ceiling.
//   Running them concurrently keeps wall-clock roughly at the SLOWEST
//   member, not the sum. One job throwing/erroring never blocks or hides
//   the others (each wrapped in its own try/catch).
//
// RES SHIM
//   Sub-handlers call `res.status(...).json(...)` / `res.setHeader(...)`
//   etc. exactly like a real Vercel response object, but nothing is
//   actually written to the wire until the dispatcher sends ONE real
//   response built from all the shimmed results.
//
// Owner: Atlas, 2026-09-16.
//
// BUGFIX 2026-09-17 (Carter) — see api/_lib/telegram-gate.js header for the
// full incident. Each sub-handler is invoked inside
// telegramGate.runWithJobContext(h.name, ...) so its Telegram sends are
// gated under ITS OWN name, not whichever sibling module happened to
// require() telegram-gate.js first in this dispatcher's HANDLERS list.

const telegramGate = require('./telegram-gate.js');

// Top-level dispatcher gate. Mirrors the exact check every individual
// sub-handler already does (x-vercel-cron header set by Vercel's own cron
// invoker, OR a valid `Authorization: Bearer $CRON_SECRET`) — see CLAUDE.md
// section 15. No secret value ever lives here or anywhere else in tracked
// source; CRON_SECRET is read from the environment only.
function isAuthorizedDispatch(req) {
  const headers = (req && req.headers) || {};
  const isVercelCron = headers['x-vercel-cron'] === '1';
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = headers.authorization || headers.Authorization || '';
  const isManualAuth = !!cronSecret && authHeader === `Bearer ${cronSecret}`;
  return !!(isVercelCron || isManualAuth);
}

function makeShimRes(name) {
  const shim = {
    _name: name,
    _status: 200,
    _body: undefined,
    _headers: {},
    // BUGFIX 2026-09-17 (Carter): api/_lib/cron-telemetry.js's withTelemetry
    // reads `res.statusCode` (the real Vercel res property) to decide
    // ok-vs-error, not `_status`. Every multiplexed sub-handler that also
    // uses withTelemetry was reporting http_status:0 / always 'ok' to
    // cron_runs regardless of its real result, because this shim never
    // exposed statusCode — a silent-failure mask on top of the telegram-gate
    // bug (see telegram-gate.js header), found while diagnosing the same
    // incident. Mirror _status onto statusCode on every status() call.
    get statusCode() { return this._status; },
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
    send(body) { if (this._body === undefined) this._body = body; return this; },
    end(body) { if (this._body === undefined) this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; },
  };
  return shim;
}

/**
 * @param {object} req - the real incoming request (headers forwarded as-is)
 * @param {Array<{name: string, mod: Function}>} handlers
 * @returns {Promise<Array<{name: string, status: number, body: any, error?: string}>>}
 */
async function runGroup(req, handlers) {
  const jobs = handlers.map(async (h) => {
    const shim = makeShimRes(h.name);
    try {
      await telegramGate.runWithJobContext(h.name, () => h.mod(req, shim));
      return { name: h.name, status: shim._status, body: shim._body };
    } catch (err) {
      return { name: h.name, status: 500, error: (err && err.message) || String(err) };
    }
  });
  return Promise.all(jobs);
}

module.exports = { runGroup, makeShimRes, isAuthorizedDispatch };
