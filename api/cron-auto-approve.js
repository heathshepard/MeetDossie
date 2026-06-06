// Vercel Serverless Function: /api/cron-auto-approve
// Auto-approves draft social posts that have already been previewed via
// Telegram (telegram_sent_at IS NOT NULL) and whose veto window has expired.
//
// Two windows:
//   requires_approval=false (veto mode): auto-approve after 10 minutes
//   requires_approval=true  (manual)  : auto-approve after 30 minutes
//   fb_comment_replies (veto mode)    : auto-approve after 10 minutes
//
// Runs every 10 minutes (vercel.json schedule: */10 * * * *).
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1

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

  const now = new Date();
  const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000).toISOString();

  // ── Social posts — two separate queries by requires_approval ────────────
  // Veto mode (requires_approval=false): approve after 10 min silence
  const { ok: loadVetoOk, data: vetoPosts } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=not.is.null&requires_approval=eq.false&telegram_sent_at=lte.${encodeURIComponent(tenMinutesAgo)}&select=id`,
  );
  // Approval mode (requires_approval=true): approve after 30 min silence
  const { ok: loadApprOk, data: apprPosts } = await supabaseFetch(
    `/rest/v1/social_posts?status=eq.draft&telegram_sent_at=not.is.null&requires_approval=eq.true&telegram_sent_at=lte.${encodeURIComponent(thirtyMinutesAgo)}&select=id`,
  );

  if (!loadVetoOk || !loadApprOk) {
    console.error('[cron-auto-approve] failed to load posts');
    return res.status(502).json({ ok: false, error: 'failed to load posts' });
  }

  const allIds = [
    ...((Array.isArray(vetoPosts) ? vetoPosts : []).map((p) => p.id)),
    ...((Array.isArray(apprPosts) ? apprPosts : []).map((p) => p.id)),
  ].filter(Boolean);

  console.log('[cron-auto-approve] veto-mode eligible:', (Array.isArray(vetoPosts) ? vetoPosts : []).length, '| approval-mode eligible:', (Array.isArray(apprPosts) ? apprPosts : []).length);

  // ── FB comment replies — approve after 10 min silence ───────────────────
  const { ok: loadReplyOk, data: replyRows } = await supabaseFetch(
    `/rest/v1/fb_comment_replies?status=eq.pending&telegram_sent_at=not.is.null&telegram_sent_at=lte.${encodeURIComponent(tenMinutesAgo)}&select=id`,
  );
  const replyIds = (loadReplyOk && Array.isArray(replyRows) ? replyRows : []).map((r) => r.id).filter(Boolean);
  console.log('[cron-auto-approve] fb_comment_replies eligible:', replyIds.length);

  // ── Approve social posts ─────────────────────────────────────────────────
  let autoApproved = 0;
  if (allIds.length > 0) {
    const idFilter = allIds.map((id) => encodeURIComponent(id)).join(',');
    const { ok: patchOk, status: patchStatus } = await supabaseFetch(
      `/rest/v1/social_posts?id=in.(${idFilter})`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'approved' }),
      },
    );
    if (!patchOk) {
      console.error('[cron-auto-approve] social posts patch failed, status:', patchStatus);
    } else {
      autoApproved = allIds.length;
      console.log('[cron-auto-approve] auto-approved', autoApproved, 'social posts');
    }
  }

  // ── Approve fb_comment_replies and notify Heath to post them ────────────
  let approvedReplies = 0;
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  for (const replyId of replyIds) {
    const { ok: replyPatch } = await supabaseFetch(
      `/rest/v1/fb_comment_replies?id=eq.${encodeURIComponent(replyId)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'approved' }),
      },
    );
    if (replyPatch) {
      approvedReplies++;
      // Send Heath the run command via personal bot
      if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
        const personalToken = process.env.TELEGRAM_BOT_TOKEN;
        if (personalToken) {
          fetch(`https://api.telegram.org/bot${personalToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHAT_ID,
              text: `Auto-approved FB comment reply. Run:\nnode scripts/fb-reply-poster.js --reply-id ${replyId}`,
              disable_web_page_preview: true,
            }),
          }).catch((err) => console.warn('[cron-auto-approve] reply notify failed:', err && err.message));
        }
      }
    }
  }

  if (approvedReplies > 0) {
    console.log('[cron-auto-approve] auto-approved', approvedReplies, 'fb_comment_replies');
  }

  return res.status(200).json({ ok: true, autoApproved, approvedReplies });
};
