'use strict';

// api/cron-engagement-candidates-cleanup.js
//
// Daily storage hygiene for engagement_candidates. Deletes rows older than
// CLEANUP_DAYS where status is in a "terminal/stale" set:
//   - pending or recommended  (never acted on)
//   - rejected                 (Heath said no)
//   - skipped                  (Sage said SKIP)
// Keeps rows that are still in flight or that we want for analytics:
//   - drafted, sent_for_approval, approved, posting, posted, failed
//
// Schedule: Vercel cron daily 06:00 UTC.
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const CLEANUP_DAYS = 7;

// Aligned with the actual status CHECK constraint on engagement_candidates:
// pending | drafted | sent_for_approval | approved | rejected | stopped | posting | posted | failed
// We delete terminal/stale states that don't need to live forever.
// We KEEP posted (analytics) and approved/posting (in flight).
const DELETE_STATUSES = ['pending', 'drafted', 'sent_for_approval', 'rejected', 'stopped', 'failed'];

async function sbFetch(urlPath, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: res.ok, status: res.status, data };
}

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  try {
    const cutoff = new Date(Date.now() - CLEANUP_DAYS * 86400 * 1000).toISOString();
    const statusList = DELETE_STATUSES.map(s => `"${s}"`).join(',');
    const path = `/rest/v1/engagement_candidates`
      + `?created_at=lt.${encodeURIComponent(cutoff)}`
      + `&status=in.(${encodeURIComponent(statusList)})`;

    const { ok, status, data } = await sbFetch(path, {
      method: 'DELETE',
      headers: { Prefer: 'return=representation' },
    });

    const deleted = Array.isArray(data) ? data.length : 0;
    res.status(200).json({
      status: ok ? 'ok' : 'failed',
      cutoff_iso: cutoff,
      cleanup_days: CLEANUP_DAYS,
      deleted_count: deleted,
      delete_statuses: DELETE_STATUSES,
      supabase_status: status,
    });
  } catch (e) {
    console.error('cron-engagement-candidates-cleanup error:', e);
    res.status(500).json({ error: String(e.message || e) });
  }
};
