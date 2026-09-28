'use strict';

// api/admin-mark-dm-lead-replied.js
//
// THE ONLY WAY comment_dm_leads.user_replied becomes true today.
//
// Zernio has no verified endpoint for reading an Instagram/Facebook DM
// conversation (api/_lib/zernio-comments.js covers comment reads/writes and
// comment-automations only) -- so nothing on a schedule can discover a
// reply on its own. Someone (Heath, or whoever checks the Instagram/
// Facebook inbox) has to see the reply and tell this system it happened.
// That's what this endpoint is for: a one-line manual signal that opens the
// 24h Send-API window for api/cron-comment-dm-followups.js to act inside.
//
// POST { lead_id }  OR  { zernio_log_id }
//   -> sets user_replied=true, user_replied_at=now(), user_replied_marked_by
//
// Deliberately NOT a bulk endpoint and deliberately NOT reversible via a
// second field -- if the mark was wrong, re-run with an explicit timestamp
// or fix it directly in Supabase. Marking a reply that didn't happen would
// let an automated send fire outside the real window, which is exactly the
// Meta-policy violation this whole sequence is built to avoid.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (same admin gate as every
// admin-*.js route in this repo -- this is a human/ops action, not a cron).
//
// Owner: Carter, 2026-09-28

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const leadId = body.lead_id ? String(body.lead_id).trim() : null;
  const zernioLogId = body.zernio_log_id ? String(body.zernio_log_id).trim() : null;
  if (!leadId && !zernioLogId) {
    return res.status(400).json({ ok: false, error: 'lead_id_or_zernio_log_id_required' });
  }
  const repliedAt = body.replied_at ? new Date(body.replied_at) : new Date();
  if (Number.isNaN(repliedAt.getTime())) {
    return res.status(400).json({ ok: false, error: 'invalid_replied_at' });
  }
  const markedBy = body.marked_by ? String(body.marked_by).slice(0, 120) : 'manual';

  const filter = leadId
    ? `id=eq.${encodeURIComponent(leadId)}`
    : `zernio_log_id=eq.${encodeURIComponent(zernioLogId)}`;

  const patch = await sb(`comment_dm_leads?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      user_replied: true,
      user_replied_at: repliedAt.toISOString(),
      user_replied_marked_by: markedBy,
    }),
  });

  if (!patch.ok) {
    return res.status(500).json({ ok: false, error: `patch_failed_${patch.status}` });
  }
  const rows = Array.isArray(patch.data) ? patch.data : [];
  if (rows.length === 0) {
    return res.status(404).json({ ok: false, error: 'lead_not_found' });
  }

  return res.status(200).json({
    ok: true,
    updated: rows.length,
    lead: rows[0],
    note: 'This opens Meta\'s 24h standard-messaging window as of user_replied_at. '
      + 'cron-comment-dm-followups only sends touch 2/3 while that window is provably open.',
  });
};
