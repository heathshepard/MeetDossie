// Vercel Serverless Function: /api/cron-auto-approve
// Auto-approves draft social posts that have already been previewed via
// Telegram (telegram_sent_at IS NOT NULL). Runs 30 minutes after
// cron-send-for-approval so Heath has a window to reject anything he
// doesn't want. Posts he doesn't act on publish automatically.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// Schedule: vercel.json — 0 12 * * * (12:00 UTC / 7:00 AM CST)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

  // Find drafts that have been previewed (telegram_sent_at is set) but not
  // yet acted on (still status='draft'). Reject-override and edit-override
  // both change status away from 'draft', so those are naturally excluded.
  const { ok: loadOk, data: posts } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=not.is.null&select=id`,
  );
  if (!loadOk) {
    console.error('[cron-auto-approve] failed to load posts');
    return res.status(502).json({ ok: false, error: 'failed to load posts' });
  }

  const items = Array.isArray(posts) ? posts : [];
  console.log('[cron-auto-approve] posts eligible for auto-approval:', items.length);

  if (items.length === 0) {
    return res.status(200).json({ ok: true, autoApproved: 0 });
  }

  const ids = items.map((p) => p.id);
  const idFilter = ids.map((id) => encodeURIComponent(id)).join(',');

  const { ok: patchOk, status: patchStatus } = await supabaseFetch(
    `/rest/v1/social_posts?id=in.(${idFilter})`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ status: 'approved' }),
    },
  );

  if (!patchOk) {
    console.error('[cron-auto-approve] patch failed, status:', patchStatus);
    return res.status(502).json({ ok: false, error: 'patch failed', patchStatus });
  }

  console.log('[cron-auto-approve] auto-approved', ids.length, 'posts');
  return res.status(200).json({ ok: true, autoApproved: ids.length });
};
