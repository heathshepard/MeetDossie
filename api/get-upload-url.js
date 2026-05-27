// Vercel Serverless Function: /api/get-upload-url
// Called by media-studio.html before a browser upload.
// Returns a signed Supabase Storage upload URL + metadata so the
// browser can PUT the file directly without hitting this server again.
//
// POST /api/get-upload-url
// Body: { filename, fileSize, password }
// Response: { signedUrl, publicUrl, type, platforms, stem }

const SUPABASE_URL         = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET          = process.env.CRON_SECRET;
const STUDIO_PASSWORD      = process.env.STUDIO_PASSWORD;

function classifyVideo(filename) {
  const stem = filename.replace(/\.mp4$/i, '').toLowerCase();

  let type, platforms;

  if (stem.includes('selfie')) {
    type      = 'selfie';
    platforms = ['tiktok', 'instagram'];
  } else if (stem.startsWith('skit-')) {
    type      = 'skit';
    platforms = ['tiktok', 'instagram'];
  } else if (stem.includes('-mobile-')) {
    type      = 'screen_recording';
    platforms = ['tiktok', 'instagram'];
  } else if (stem.includes('-desktop-')) {
    type      = 'screen_recording';
    platforms = ['facebook', 'twitter', 'linkedin'];
  } else {
    type      = 'selfie';
    platforms = ['tiktok', 'instagram'];
  }

  return { type, platforms, stem: filename.replace(/\.mp4$/i, '') };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Auth: check password against STUDIO_PASSWORD or fall back to CRON_SECRET
  const allowed = STUDIO_PASSWORD || CRON_SECRET;
  if (!allowed || body.password !== allowed) {
    return res.status(401).json({ ok: false, error: 'Wrong password' });
  }

  const { filename, fileSize } = body;

  if (!filename || typeof filename !== 'string') {
    return res.status(400).json({ ok: false, error: 'filename required' });
  }
  if (!filename.toLowerCase().endsWith('.mp4')) {
    return res.status(400).json({ ok: false, error: 'Only .mp4 files accepted' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
  }

  // Classify the video
  const { type, platforms, stem } = classifyVideo(filename);

  // Request a signed upload URL from Supabase Storage
  const storagePath = `video-library/${filename}`;
  const signEndpoint = `${SUPABASE_URL}/storage/v1/object/sign/videos/${storagePath}`;

  let signedURL;
  try {
    const resp = await fetch(signEndpoint, {
      method: 'POST',
      headers: {
        'apikey':        SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ expiresIn: 3600 }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[get-upload-url] Supabase sign error:', resp.status, text);
      return res.status(502).json({ ok: false, error: `Storage sign failed: ${resp.status}` });
    }

    const data = await resp.json();
    // data.signedURL is a relative path like /storage/v1/object/sign/...
    signedURL = data.signedURL;
    if (!signedURL) {
      return res.status(502).json({ ok: false, error: 'No signedURL in Supabase response' });
    }
    // Prefix relative URL with base
    if (signedURL.startsWith('/')) {
      signedURL = `${SUPABASE_URL}/storage/v1${signedURL}`;
    }
  } catch (err) {
    console.error('[get-upload-url] fetch error:', err && err.message);
    return res.status(502).json({ ok: false, error: 'Failed to reach Supabase Storage' });
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;

  return res.status(200).json({
    ok: true,
    signedUrl: signedURL,
    publicUrl,
    type,
    platforms,
    stem,
  });
};
