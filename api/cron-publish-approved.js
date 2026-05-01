// Vercel Serverless Function: /api/cron-publish-approved
// Picks up approved social_posts and pushes each one to Zernio for fan-out
// to the connected platform account. Replaces the long-running Desktop
// autoposter for Phase 1 (text-only) so this no longer depends on a laptop
// being awake.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 30 min ("*/30 * * * *").

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ZERNIO_POSTS_URL = 'https://zernio.com/api/v1/posts';
const MAX_PER_RUN = 5;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

function buildPostBody(post) {
  const hashtags = Array.isArray(post.hashtags) ? post.hashtags : [];
  const tagLine = hashtags.length
    ? '\n\n' + hashtags.map((h) => `#${String(h).replace(/^#/, '')}`).join(' ')
    : '';
  const content = String(post.content || '');
  // If content already contains the hashtags inline, don't double-add.
  const text = /\B#\w/.test(content) ? content : `${content}${tagLine}`;
  return text.trim();
}

async function pushToZernio(post) {
  if (!ZERNIO_API_KEY) return { ok: false, error: 'ZERNIO_API_KEY not configured' };
  if (!post.zernio_account_id) return { ok: false, error: 'no zernio_account_id on row' };
  const text = buildPostBody(post);
  const payload = {
    account_id: post.zernio_account_id,
    content: text,
  };
  if (post.scheduled_for) payload.scheduled_for = post.scheduled_for;
  try {
    const res = await fetch(ZERNIO_POSTS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const respText = await res.text();
    let data = null;
    try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
    if (!res.ok) {
      return { ok: false, status: res.status, error: respText.slice(0, 300), data };
    }
    return { ok: true, status: res.status, data, zernio_post_id: data?.id || data?.post_id || null };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) {
    console.error('[cron-publish-approved] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!ZERNIO_API_KEY) {
    console.error('[cron-publish-approved] ZERNIO_API_KEY not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'zernio not configured' });
  }

  const nowIso = new Date().toISOString();
  // Pick approved-but-unpublished rows whose scheduled_for is null OR in the past.
  // Sort oldest-first so the queue drains FIFO.
  const filter = `status=eq.approved&posted_at=is.null&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(nowIso)})`;
  const { data: items, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?${filter}&order=approved_at.asc.nullslast&limit=${MAX_PER_RUN}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load approved posts' });
  }
  const queue = Array.isArray(items) ? items : [];
  console.log('[cron-publish-approved] approved-and-due rows:', queue.length);

  let published = 0;
  const errors = [];
  for (const post of queue) {
    if (!post || !post.id) continue;
    const result = await pushToZernio(post);
    if (result.ok) {
      const patch = await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'posted',
          posted_at: new Date().toISOString(),
          zernio_post_id: result.zernio_post_id,
        }),
      });
      if (patch.ok) published++;
      else errors.push({ id: post.id, error: 'patch after publish failed', status: patch.status });
    } else {
      console.error('[cron-publish-approved] push failed for', post.id, result);
      errors.push({ id: post.id, error: result.error, status: result.status });
      // Leave row at status='approved' for the next run to retry.
    }
  }

  console.log('[cron-publish-approved] done — published', published, 'errors:', errors.length);
  return res.status(200).json({ ok: true, published, attempted: queue.length, errors });
};
