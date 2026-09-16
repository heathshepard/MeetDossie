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
//   Vercel's cron invoker sets `x-vercel-cron: 1` on the dispatcher's
//   incoming request; a manual trigger sets `Authorization: Bearer
//   CRON_SECRET`. Both headers are forwarded unchanged to every sub-handler
//   via the SAME `req` object used to call the dispatcher — each
//   sub-handler's own auth gate (already required going in; see
//   scripts that verified this before grouping) evaluates exactly as it
//   would have standalone. An unauthenticated hit on the dispatcher route
//   produces N unauthenticated hits on sub-handlers, each independently
//   rejected with 401 by the sub-handler itself. The dispatcher adds no new
//   trigger surface.
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

function makeShimRes(name) {
  const shim = {
    _name: name,
    _status: 200,
    _body: undefined,
    _headers: {},
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
      await h.mod(req, shim);
      return { name: h.name, status: shim._status, body: shim._body };
    } catch (err) {
      return { name: h.name, status: 500, error: (err && err.message) || String(err) };
    }
  });
  return Promise.all(jobs);
}

module.exports = { runGroup, makeShimRes };
