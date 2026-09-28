'use strict';

// Vercel Serverless Function: /api/admin-probe-zernio-dm-endpoints
//
// TEMPORARY, READ-ONLY investigation endpoint for task 3 of the 2026-09-28
// autonomy build (DM monitoring). "Do not fake this. Investigate what is
// actually possible today... an honest 'blocked until ManyChat' is the
// correct deliverable if that's the truth."
//
// api/_lib/zernio-comments.js only documents VERIFIED comment endpoints
// (/v1/accounts, /v1/inbox/comments*, /v1/comment-automations*) — no DM-read
// endpoint appears anywhere in that file's "VERIFIED AGAINST THE LIVE API"
// list. This probes the most plausible DM/conversation/message endpoint
// shapes directly against the real Zernio API with the real key, the same
// way zernio-comments.js's own header was built, rather than trusting
// docs.zernio.com (which that file's own header notes disagrees with the
// live API in places).
//
// GET only. No body is ever logged/returned beyond a short excerpt — this
// never writes anything, never DMs anyone, and is deleted after the probe.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const { zernio, makeBudget } = require('./_lib/zernio-comments.js');

const CRON_SECRET = process.env.CRON_SECRET;

// Every plausible shape for a DM/conversation-read endpoint, guessed from
// Zernio's existing /v1/inbox/comments naming convention and common
// competitor API shapes (ManyChat, Chatfuel, etc. all use "conversations").
const CANDIDATES = [
  'GET /inbox/conversations',
  'GET /inbox/messages',
  'GET /inbox/dms',
  'GET /conversations',
  'GET /messages',
  'GET /dms',
  'GET /inbox',
];

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!process.env.ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  const budget = makeBudget(20);
  const results = [];

  for (const candidate of CANDIDATES) {
    const [, path] = candidate.split(' ');
    try {
      const r = await zernio(path, {}, budget);
      results.push({
        candidate,
        status: r.status,
        ok: r.ok,
        // Only the shape, never real content — top-level keys tell us
        // whether this is a real endpoint (200 + a real payload shape) or
        // a 404/405 (doesn't exist) vs a 403 (exists but needs an add-on,
        // same as /v1/inbox/comments without the Inbox add-on).
        top_level_keys: r.data && typeof r.data === 'object' ? Object.keys(r.data).slice(0, 10) : null,
        error_excerpt: r.ok ? null : String(r.error || '').slice(0, 200),
      });
    } catch (err) {
      results.push({ candidate, status: 0, ok: false, error_excerpt: err.message });
    }
  }

  return res.status(200).json({ ok: true, budget_used: budget.used, results });
};
