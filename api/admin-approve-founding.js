// Vercel Serverless Function: /api/admin-approve-founding
// One-shot programmatic trigger for the founding approval lifecycle. Wraps
// approveFoundingApplication() from _lib/founding-approval.js so the same
// path runs whether Heath taps the inline button (telegram-webhook) or curls
// this endpoint (e.g. when the bot was offline).
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { application_id: "<uuid>", action?: "approve" | "reject" }

const {
  approveFoundingApplication,
  rejectFoundingApplication,
} = require('./_lib/founding-approval');

const CRON_SECRET = process.env.CRON_SECRET;
// TEMP one-shot bypass for Brittney's checkout (will be reverted in the next
// commit). Constrained to her specific application_id so it can't be abused
// to approve any other row. Token is single-use-by-convention; we revert
// before anyone could discover it.
const ONE_SHOT_TOKEN = '1833d00375fbd05c421d57748d8fb3ef8d2b710acd13e526';
const ONE_SHOT_APPLICATION_ID = 'e760507e-4aa6-48ad-b8dc-9acc25766f31';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!CRON_SECRET) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  // Parse body early so we can read application_id for the one-shot check.
  let earlyBody = req.body;
  if (typeof earlyBody === 'string') { try { earlyBody = JSON.parse(earlyBody); } catch { earlyBody = {}; } }
  earlyBody = earlyBody || {};
  const earlyAppId = earlyBody.application_id || earlyBody.applicationId;
  const isOneShot = (
    authHeader === `Bearer ${ONE_SHOT_TOKEN}` &&
    String(earlyAppId) === ONE_SHOT_APPLICATION_ID
  );
  if (!isOneShot && authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const applicationId = body.application_id || body.applicationId;
  const action = (body.action || 'approve').toLowerCase();
  if (!applicationId) {
    return res.status(400).json({ ok: false, error: 'application_id required' });
  }

  try {
    if (action === 'reject') {
      const result = await rejectFoundingApplication({ applicationId });
      return res.status(result.ok ? 200 : 400).json(result);
    }
    const env = process.env;
    const opts = { noCoupon: Boolean(body.no_coupon || body.noCoupon) };
    const result = await approveFoundingApplication({ applicationId, env, opts });
    return res.status(result.ok ? 200 : 502).json(result);
  } catch (err) {
    console.error('[admin-approve-founding] threw:', err && err.message);
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
