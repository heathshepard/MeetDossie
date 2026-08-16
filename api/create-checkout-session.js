// Vercel Serverless Function: /api/create-checkout-session
// CLOSED 2026-08-13 — Founding Member ($29/mo) closed permanently 2026-08-04,
// no new signups. This endpoint used to create a Stripe Checkout Session for
// that price with zero gating (no cap check, no auth) — anyone who POSTed to
// it directly (bypassing the UI) could still buy the closed $29/mo-for-life
// rate. Found during the 2026-08-13 pricing sweep; disabled rather than
// repointed because Solo/Team have no live Stripe price IDs yet (see
// api/signup.js) — there is nothing valid to sell here until Heath creates
// those prices.
//
// POST -> 410 { ok: false, error: 'Founding membership is closed. ...' }

const { applyCorsHeaders } = require('./_middleware/cors');

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type' });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  res.status(410).json({
    ok: false,
    error: 'Founding membership is closed — no new signups. See meetdossie.com/signup for current pricing.',
  });
};
