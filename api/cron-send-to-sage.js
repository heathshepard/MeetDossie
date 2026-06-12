// Vercel Serverless Function: /api/cron-send-to-sage
// Replaces direct-to-Telegram approval. Routes draft posts to sage_inbox
// for Sage's autonomous review instead of waiting for Heath.
//
// Behavior:
//   1. Find draft posts where telegram_sent_at IS NULL
//   2. Create a row in sage_inbox with status='pending_sage_review'
//   3. Update post.telegram_sent_at to prevent re-queueing
//   4. Sage's cron-sage-autonomous-review picks them up next cycle
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 30 11 * * * (11:30 UTC, ~30 min after generation).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PER_RUN = 12;

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

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Find draft posts not yet queued to Sage (newest-first so fresh morning drafts
  // don't get blocked by a backlog of overnight items)
  const { data: posts, ok: loadOk } = await supabaseFetch(
    `/rest/v1/social_posts?telegram_sent_at=is.null&status=eq.draft&order=created_at.desc&limit=${MAX_PER_RUN}`,
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load posts' });
  }

  const items = Array.isArray(posts) ? posts : [];
  console.log('[cron-send-to-sage] posts to queue to Sage:', items.length);

  if (items.length === 0) {
    return res.status(200).json({ ok: true, queued: 0 });
  }

  let queued = 0;
  const errors = [];

  for (const post of items) {
    if (!post || !post.id) continue;

    // Insert into sage_inbox
    const { data: inbox, ok: inboxOk } = await supabaseFetch('/rest/v1/sage_inbox', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        post_id: post.id,
        status: 'pending_sage_review',
      }),
    });

    if (!inboxOk) {
      console.error('[cron-send-to-sage] failed to insert sage_inbox for', post.id);
      errors.push({ id: post.id, error: 'sage_inbox insert failed' });
      continue;
    }

    // Mark post as queued (set telegram_sent_at so it won't re-queue)
    const now = new Date().toISOString();
    const { ok: patchOk } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(post.id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ telegram_sent_at: now }),
      }
    );

    if (patchOk) {
      queued++;
      console.log('[cron-send-to-sage] queued to Sage:', post.id);
    } else {
      errors.push({ id: post.id, error: 'post patch failed' });
    }
  }

  return res.status(200).json({
    ok: true,
    queued,
    total: items.length,
    errors: errors.length > 0 ? errors : undefined,
  });
};
