// Vercel Serverless Function: /api/debug-zernio-accounts
// Read-only diagnostic. Lists every account Zernio's connected Meta Business
// (and other platform) integrations can currently see, straight from Zernio's
// own API — not our zernio_accounts table. Built 2026-08-17 (Atlas) to answer
// "can we already see Heath's realtor FB Page under the same Zernio
// connection as Dossie's Page, without a fresh OAuth grant."
//
// Auth: Authorization: Bearer ${CRON_SECRET} (same pattern as every other
// cron/debug route in this repo). No writes, no state change.

const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured' });
  }

  try {
    const r = await fetch('https://zernio.com/api/v1/accounts', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        Accept: 'application/json',
      },
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }

    return res.status(200).json({
      ok: r.ok,
      zernio_status: r.status,
      data,
      raw: data ? undefined : text.slice(0, 2000),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
