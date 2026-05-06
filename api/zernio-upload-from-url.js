// Vercel Serverless Function: /api/zernio-upload-from-url
// Runtime-side Zernio upload helper. Takes a publicly accessible file URL,
// fetches the bytes, runs the documented two-step Zernio upload (presign →
// PUT), and returns the publicUrl. Lets the local renderer trigger an
// authenticated upload without needing ZERNIO_API_KEY locally.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { fileUrl: "https://...", fileName: "morning-brief-square.mp4",
//         fileType: "video/mp4" }
// Returns: { ok, publicUrl, uploadUrl, expires, presignBody, putStatus,
//            sizeBytes }
//
// Note: Vercel function memory + body limits cap this at ~50 MB practical
// upload size on Pro. Our renders are ≤10 MB so this is fine.

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_PRESIGN_URL = 'https://zernio.com/api/v1/media/presign';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const { fileUrl, fileName, fileType = 'video/mp4' } = body;
  if (!fileUrl || !fileName) {
    return res.status(400).json({ ok: false, error: 'fileUrl and fileName required' });
  }

  try {
    // Step 1: presign
    const presignResp = await fetch(ZERNIO_PRESIGN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ fileName, fileType }),
    });
    const presignText = await presignResp.text();
    let presignBody = null;
    try { presignBody = presignText ? JSON.parse(presignText) : null; } catch { presignBody = null; }
    if (!presignResp.ok) {
      return res.status(502).json({
        ok: false, step: 'presign', status: presignResp.status,
        error: presignBody ?? presignText.slice(0, 2000),
      });
    }
    const { uploadUrl, publicUrl, expires } = presignBody || {};
    if (!uploadUrl || !publicUrl) {
      return res.status(502).json({
        ok: false, step: 'presign', error: 'missing uploadUrl/publicUrl',
        body: presignBody,
      });
    }

    // Step 2: download source bytes, then PUT to the presigned URL
    const dlResp = await fetch(fileUrl);
    if (!dlResp.ok) {
      return res.status(502).json({
        ok: false, step: 'download', status: dlResp.status,
        error: `Failed to fetch fileUrl: ${dlResp.status}`,
      });
    }
    const fileBuf = Buffer.from(await dlResp.arrayBuffer());
    const sizeBytes = fileBuf.length;
    const putResp = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': fileType },
      body: fileBuf,
    });
    if (!putResp.ok) {
      const putText = await putResp.text();
      return res.status(502).json({
        ok: false, step: 'put', status: putResp.status,
        error: putText.slice(0, 2000), publicUrl, uploadUrl,
      });
    }

    return res.status(200).json({
      ok: true, publicUrl, uploadUrl, expires,
      putStatus: putResp.status, sizeBytes,
    });
  } catch (err) {
    return res.status(502).json({ ok: false, error: (err && err.message) || String(err) });
  }
};
