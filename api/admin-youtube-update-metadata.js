// Vercel Serverless Function: /api/admin-youtube-update-metadata
//
// Corrects the metadata of an ALREADY-PUBLISHED YouTube video through
// Zernio's POST /v1/posts/{postId}/update-metadata (the only platform Zernio
// supports metadata edits on). No re-upload, no new post, no new video.
//
// WHY (Atlas 2026-09-25): cron-post-videos derived the YouTube title from
// video_library.topic. That column used to hold a human sentence, but the
// 2026-09-17 feature-demo ingestion writes an internal slug there
// ("dossie-d1-cap6-977d5507") — and that slug shipped as the public title of
// a live video. The generator is fixed in cron-post-videos.js; this route
// repairs videos that already went out with a bad title.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Method: POST
// Body (post-based — video published through Zernio):
//   { "postId": "<zernio post id>", "title": "...", "description": "..." }
// Body (direct — video uploaded outside Zernio):
//   { "videoId": "<youtube id>", "accountId": "<zernio account id>",
//     "title": "...", "description": "..." }
//
// Only title / description / tags / privacyStatus / thumbnailUrl are
// forwarded — nothing that could republish or delete.

const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const ZERNIO_BASE = 'https://zernio.com/api/v1';

const ALLOWED_FIELDS = ['title', 'description', 'tags', 'privacyStatus', 'thumbnailUrl'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
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

  const { postId, videoId, accountId } = body;
  if (!postId && !(videoId && accountId)) {
    return res.status(400).json({
      ok: false,
      error: 'either postId (post-based) or videoId + accountId (direct) is required',
    });
  }

  const payload = { platform: 'youtube' };
  if (!postId) {
    payload.videoId = String(videoId);
    payload.accountId = String(accountId);
  }
  let updatable = 0;
  for (const f of ALLOWED_FIELDS) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== '') {
      payload[f] = body[f];
      updatable++;
    }
  }
  if (updatable === 0) {
    return res.status(400).json({ ok: false, error: `at least one of ${ALLOWED_FIELDS.join(', ')} is required` });
  }
  if (payload.title && String(payload.title).length > 100) {
    return res.status(400).json({ ok: false, error: 'title exceeds YouTube\'s 100-character limit' });
  }

  const target = `${ZERNIO_BASE}/posts/${encodeURIComponent(postId ? String(postId) : '_')}/update-metadata`;

  try {
    const r = await fetch(target, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      zernio_status: r.status,
      sent: { ...payload, description: payload.description ? `${String(payload.description).length} chars` : undefined },
      data,
      raw: data ? undefined : text.slice(0, 1000),
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e && e.message });
  }
};
