/**
 * ADMIN: Post a pinned-context comment on a live Zernio post.
 *
 * One-off admin route for the 2026-08-28 fix: two live posts on Heath's
 * personal "Heath Shepard, Realtor" FB Page + Instagram (Rust fitness app
 * beta promo) had no context tying the video back to him as a realtor. Fix
 * is a first comment, in his voice, on both live posts — not a re-post.
 *
 * Endpoint: POST /api/admin-post-comment
 * Auth: CRON_SECRET (bearer token) — same pattern as other admin-*.js routes.
 * Body: { postId, accountId, message }
 *
 * Zernio: POST https://zernio.com/api/v1/inbox/comments/{postId}
 *   body: { accountId, message }
 *   Idempotency-Key header — docs.zernio.com says this endpoint is safe to
 *   retry when the same key is reused, so key is derived from postId (stable
 *   across retries of the same logical comment).
 */

const { retryFetch } = require('./_lib/retry.js');

const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const ZERNIO_BASE_URL = 'https://zernio.com/api/v1';

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');
  if (token !== process.env.CRON_SECRET) {
    return res.status(403).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST' && req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured' });
  }

  // GET ?postId=... — verification helper, reads back comments on a post.
  // Not part of the original ask but needed since local .env.local's
  // ZERNIO_API_KEY is a write-only Vercel Sensitive var (see CLAUDE.md
  // Section 19) — this route runs where the real key lives.
  if (req.method === 'GET') {
    const postId = req.query.postId;
    const accountIdQ = req.query.accountId;
    if (!postId || !accountIdQ) {
      return res.status(400).json({ ok: false, error: 'postId and accountId query params required' });
    }
    try {
      const zRes = await retryFetch(
        `${ZERNIO_BASE_URL}/inbox/comments/${encodeURIComponent(postId)}?accountId=${encodeURIComponent(accountIdQ)}`,
        { headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` } },
        { name: 'Zernio-comment-get', maxAttempts: 2, baseDelay: 1000 }
      );
      const text = await zRes.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return res.status(zRes.status).json({ ok: zRes.ok, status: zRes.status, data });
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }

  const { postId, accountId, message } = req.body || {};
  if (!postId || !accountId || !message) {
    return res.status(400).json({ ok: false, error: 'postId, accountId, message are required' });
  }

  const url = `${ZERNIO_BASE_URL}/inbox/comments/${encodeURIComponent(postId)}`;
  const idempotencyKey = `admin-post-comment-${postId}`;

  try {
    const zRes = await retryFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ZERNIO_API_KEY}`,
          'Idempotency-Key': idempotencyKey,
        },
        body: JSON.stringify({ accountId, message }),
      },
      { name: 'Zernio-comment', maxAttempts: 3, baseDelay: 2000 }
    );

    const text = await zRes.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }

    if (!zRes.ok) {
      console.error(`[admin-post-comment] Zernio ${zRes.status} for postId=${postId}:`, text.slice(0, 500));
      return res.status(zRes.status).json({ ok: false, status: zRes.status, error: text.slice(0, 500), data });
    }

    console.log(`[admin-post-comment] posted comment on postId=${postId}:`, JSON.stringify(data).slice(0, 500));
    return res.status(200).json({ ok: true, postId, data });
  } catch (err) {
    console.error(`[admin-post-comment] exception for postId=${postId}:`, err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
