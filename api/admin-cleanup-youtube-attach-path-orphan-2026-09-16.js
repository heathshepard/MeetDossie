// One-time cleanup: terminal-status the youtube social_posts row(s) orphaned
// by the 2026-09-16 attach-path bug (see api/cron-generate-posts.js
// GENERATION_DISABLED_PLATFORMS comment + docs).
//
// THE ROW(S)
// ----------
// posting_schedule.is_active was flipped live for youtube on 2026-09-16
// (78c1c876) to unblock Pipeline B (video_library -> cron-post-videos.js).
// That same flip re-armed cron-generate-posts.js's still-present youtube
// slot, which set video_required=true and relied on the per-post Creatomate
// render (dead, 402, since 2026-06-30). cron-publish-approved.js's media
// gate (needsVideo && !media_url) parked the row at status='pending_video'
// with error_message 'video_required=true but media_url is null —
// Creatomate pipeline must render and attach video before publish'. That
// path can never attach media — youtube is now generation-disabled
// (Pipeline B only) as of this same fix, so this row is permanently dead.
//
// Scoped narrowly (platform=youtube, status=pending_video,
// video_required=true, media_url null, created 2026-09-16) so this can
// never touch a future, legitimately-in-flight row. Idempotent — matches
// zero rows on a second run.
//
// Mirrors the same-day precedent: the ~70 accumulated instagram/tiktok
// orphans from the 2026-09-09/15 fix were bulk-flipped to status='rejected'
// with their existing error_message left in place, not deleted. This does
// the same for youtube's single orphan, with a message that says WHY,
// honestly, rather than a silent flip.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Remove this endpoint after Cole/Heath confirm it ran (repo convention —
// see admin-migrate-video-library-target-owner.js, admin-fix-silence-backlog).
//
// Owner: Carter, 2026-09-16

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const REJECT_REASON =
  'ORPHANED (2026-09-16): youtube generation routed through the retired per-post ' +
  'Creatomate path (dead since 2026-06-30) for one run after posting_schedule.is_active ' +
  'was flipped live for Pipeline B. youtube is now generation-disabled in ' +
  'cron-generate-posts.js (GENERATION_DISABLED_PLATFORMS) — all youtube video comes ' +
  'from Pipeline B (video_library -> cron-post-videos.js) going forward. This row can ' +
  'never receive media and is closed out, not deleted.';

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
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

  // Narrow filter — never touches a row with media_url already set, never
  // touches a status other than pending_video, never touches a non-2026-09-16 row.
  const filter =
    'platform=eq.youtube&status=eq.pending_video&video_required=eq.true&media_url=is.null' +
    '&created_at=gte.2026-09-16T00:00:00Z&created_at=lt.2026-09-17T00:00:00Z';

  const before = await supabaseFetch(`/rest/v1/social_posts?${filter}&select=id,platform,status,scheduled_for`);
  if (!before.ok) {
    return res.status(502).json({ ok: false, error: 'failed to query orphaned youtube rows', details: before.data });
  }
  const targetIds = (Array.isArray(before.data) ? before.data : []).map((r) => r.id);

  if (targetIds.length === 0) {
    return res.status(200).json({ ok: true, patched: 0, message: 'no matching orphaned youtube rows — nothing to do (idempotent)' });
  }

  const patch = await supabaseFetch(`/rest/v1/social_posts?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      status: 'rejected',
      publishing_started_at: null,
      error_message: REJECT_REASON,
    }),
  });

  if (!patch.ok) {
    return res.status(502).json({ ok: false, error: 'failed to patch orphaned youtube rows', details: patch.data });
  }

  return res.status(200).json({
    ok: true,
    patched: targetIds.length,
    row_ids: targetIds,
    new_status: 'rejected',
    reason: REJECT_REASON,
  });
};
