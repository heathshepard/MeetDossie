// Vercel Serverless Function: /api/debug-zernio-media-presign
// TEMPORARY diagnostic. Calls Zernio's POST /api/v1/media/presign with the
// production ZERNIO_API_KEY so we can verify the documented spec
// (https://docs.zernio.com/guides/media-uploads) responds as expected.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Query (optional):
//   ?fileName=morning-brief-vertical.mp4
//   ?fileType=video/mp4
// Defaults to a vertical MP4 probe.
//
// Delete this file after the diagnosis is complete.

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_PRESIGN_URL = 'https://zernio.com/api/v1/media/presign';

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

  const fileName = (req.query && req.query.fileName) || 'morning-brief-vertical.mp4';
  const fileType = (req.query && req.query.fileType) || 'video/mp4';

  try {
    const upstream = await fetch(ZERNIO_PRESIGN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ fileName, fileType }),
    });
    const text = await upstream.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return res.status(200).json({
      ok: upstream.ok,
      upstream_status: upstream.status,
      upstream_body: parsed ?? text.slice(0, 4000),
      sent: { fileName, fileType },
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
