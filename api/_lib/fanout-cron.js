'use strict';

// api/_lib/fanout-cron.js
//
// Thin fan-out helper for consolidated cron dispatcher routes. Vercel caps
// crons at 100 entries (vercel.json). Where several crons share an exact
// schedule and hit the same internal-reporting subsystem, one dispatcher
// entry relays to each existing handler's own already-deployed endpoint in
// sequence, over HTTP, with the same Bearer CRON_SECRET auth every other
// manual/internal caller uses. This changes NOTHING about what each handler
// does — same code path, same auth gate, same response shape at the
// sub-request level — it only changes who triggers it (the dispatcher
// instead of Vercel's scheduler calling each one directly).
//
// Owner: Atlas, 2026-09-10 (freed cron slots for testimonial crons).

const CRON_SECRET = process.env.CRON_SECRET;
const BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://meetdossie.com').replace(/\/$/, '');

// isAuthorizedCronCaller(req) — the standard gate used by every cron handler
// in this repo: Vercel's own cron header, or a correct manual Bearer secret.
function isAuthorizedCronCaller(req) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  return isVercelCron || isManualAuth;
}

// fanout(paths) — calls each /api/<path> in sequence with Bearer CRON_SECRET,
// same as any other authenticated internal caller. Never throws: a failure
// on one leg is recorded and the next leg still runs.
async function fanout(paths) {
  const results = [];
  for (const p of paths) {
    const startedAt = Date.now();
    try {
      const r = await fetch(`${BASE_URL}${p}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${CRON_SECRET}` },
      });
      const duration_ms = Date.now() - startedAt;
      let body = null;
      try { body = await r.json(); } catch { /* non-JSON or empty body */ }
      results.push({ path: p, ok: r.ok, status: r.status, duration_ms, body });
    } catch (err) {
      results.push({
        path: p,
        ok: false,
        status: 0,
        duration_ms: Date.now() - startedAt,
        error: err && err.message,
      });
    }
  }
  return results;
}

module.exports = { fanout, isAuthorizedCronCaller };
