// Vercel Serverless Function: /api/debug-zernio-accounts
// TEMPORARY diagnostic endpoint. Calls Zernio's /accounts endpoint with the
// production ZERNIO_API_KEY (which can't be pulled locally) and returns the
// raw response so we can compare live account_ids against zernio_accounts.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Delete this file after the diagnosis is complete.

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ZERNIO_ACCOUNTS_URL = 'https://zernio.com/api/v1/accounts';

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) {
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured in this environment' });
  }

  try {
    const upstream = await fetch(ZERNIO_ACCOUNTS_URL, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        Accept: 'application/json',
      },
    });
    const text = await upstream.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return res.status(200).json({
      ok: upstream.ok,
      upstream_status: upstream.status,
      upstream_body: parsed ?? text.slice(0, 4000),
      key_length: ZERNIO_API_KEY.length,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
