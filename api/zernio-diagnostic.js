// Vercel Serverless Function: /api/zernio-diagnostic
//
// Read-only + validate-only window into Zernio, for diagnosing the video
// posting pipeline from a machine that does not hold ZERNIO_API_KEY.
// ZERNIO_API_KEY is a Vercel *Sensitive* var, so `vercel env pull` writes the
// literal string "[SENSITIVE]" into .env.local — every local Zernio call
// returns 401. This route is the supported way to ask Zernio questions
// without ever moving the key off Vercel.
//
// Built 2026-09-25 (Atlas) while chasing "video has never posted".
//
// Auth: Authorization: Bearer ${CRON_SECRET}
//
// Actions (?action=):
//   accounts        GET  /v1/accounts                  — connected accounts + token health
//   posts           GET  /v1/posts?limit=&status=      — recent posts Zernio knows about
//   post            GET  /v1/posts/{id}                — one post: status + platformPostUrl
//   account-posts   GET  /v1/accounts/{id}/posts       — posts for one connected account
//   validate-media  POST /v1/tools/validate/media      — is this URL fetchable + within platform limits
//   validate-post   POST /v1/tools/validate/post       — would this exact payload be accepted
//
// NOTHING here creates, schedules, edits or deletes a Zernio post. The two
// validate endpoints are documented as non-persisting. Publishing stays in
// cron-post-videos / cron-publish-approved where the schedule + cap gates live.

const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const ZERNIO_BASE = 'https://zernio.com/api/v1';

async function zernio(method, path, body) {
  const res = await fetch(`${ZERNIO_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ZERNIO_API_KEY}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { status: res.status, ok: res.ok, data, raw: data ? undefined : text.slice(0, 2000) };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!ZERNIO_API_KEY) {
    return res.status(500).json({ ok: false, error: 'ZERNIO_API_KEY not configured in this environment' });
  }

  const q = req.query || {};
  const action = String(q.action || 'accounts');

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  try {
    switch (action) {
      case 'accounts':
        return res.status(200).json({ ok: true, action, result: await zernio('GET', '/accounts') });

      case 'posts': {
        const params = new URLSearchParams();
        if (q.limit) params.set('limit', String(q.limit));
        if (q.status) params.set('status', String(q.status));
        if (q.platform) params.set('platform', String(q.platform));
        const qs = params.toString();
        return res.status(200).json({ ok: true, action, result: await zernio('GET', `/posts${qs ? `?${qs}` : ''}`) });
      }

      case 'post': {
        if (!q.id) return res.status(400).json({ ok: false, error: 'id required' });
        return res.status(200).json({
          ok: true, action,
          result: await zernio('GET', `/posts/${encodeURIComponent(String(q.id))}`),
        });
      }

      case 'account-posts': {
        if (!q.accountId) return res.status(400).json({ ok: false, error: 'accountId required' });
        const params = new URLSearchParams();
        if (q.limit) params.set('limit', String(q.limit));
        const qs = params.toString();
        return res.status(200).json({
          ok: true, action,
          result: await zernio('GET', `/accounts/${encodeURIComponent(String(q.accountId))}/posts${qs ? `?${qs}` : ''}`),
        });
      }

      case 'validate-media': {
        const url = q.url || body.url;
        if (!url) return res.status(400).json({ ok: false, error: 'url required' });
        return res.status(200).json({
          ok: true, action,
          result: await zernio('POST', '/tools/validate/media', { url: String(url) }),
        });
      }

      case 'validate-post': {
        if (!body || !body.platforms) {
          return res.status(400).json({ ok: false, error: 'POST body with platforms[] required' });
        }
        // Strip anything that could make this publish. validate/post does not
        // persist, but belt-and-braces: never forward publish intent.
        const { publishNow, scheduledFor, queuedFromProfile, isDraft, ...safe } = body;
        return res.status(200).json({
          ok: true, action,
          result: await zernio('POST', '/tools/validate/post', safe),
        });
      }

      default:
        return res.status(400).json({
          ok: false,
          error: `unknown action: ${action}`,
          actions: ['accounts', 'posts', 'post', 'account-posts', 'validate-media', 'validate-post'],
        });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, action, error: e && e.message });
  }
};
