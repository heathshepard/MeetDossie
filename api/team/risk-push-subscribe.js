// POST/DELETE /api/team/risk-push-subscribe
//
// Stores/removes a browser's Web Push subscription for the Dossie Team
// Dashboard's real-time risk-alert feature — additive to
// api/cron-weekly-team-risk-digest.js's Monday email, this is the "don't
// make a team lead wait for Monday" path: api/cron-hourly-team-risk-alerts.js
// pushes an instant OS notification the hour a NEW risk condition is
// detected (a deadline that just passed, a disclosure that just went
// missing, an action item that just went overdue).
//
// Distinct from api/jarvis-push-subscribe.js / public.push_subscriptions —
// that table is Jarvis-specific, single-tenant, gated to
// heath.shepard@kw.com only. This app is multi-tenant (many Team/Brokerage
// orgs), so subscriptions are scoped to org_id + the requesting admin, using
// the same admin gate as every other /api/team/* endpoint (org-risk-
// overview.js, org-dossiers.js): a valid Supabase bearer token AND an ACTIVE
// 'admin' role on org_id, checked via _mt_user_is_org_admin before any
// write. See supabase/migrations/20260823180000_team_risk_push_alerts.sql
// for the table design.
//
// POST body: { org_id, subscription: <PushSubscription.toJSON() shape>, user_agent? }
//   -> 200 { ok: true }
//   Upserts on `endpoint` — re-subscribing (e.g. after a permission
//   re-grant, or switching devices) updates rather than piling up dead rows.
//
// DELETE body: { org_id, endpoint }
//   -> 200 { ok: true }
//   Called when a team lead explicitly turns risk alerts off.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return await new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);

    let body;
    try {
      body = await readBody(req);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }

    const orgId = body.org_id;
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    const supabase = getServiceClient();

    // Hard gate FIRST, before any data is touched — identical pattern to
    // org-risk-overview.js.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[risk-push-subscribe] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    if (req.method === 'POST') {
      const sub = body.subscription;
      const endpoint = sub && String(sub.endpoint || '').trim();
      const p256dh = sub && sub.keys && String(sub.keys.p256dh || '').trim();
      const authKey = sub && sub.keys && String(sub.keys.auth || '').trim();
      if (!endpoint || !p256dh || !authKey) {
        return res.status(400).json({ ok: false, error: 'invalid_subscription' });
      }

      const { error: upsertErr } = await supabase
        .from('team_risk_push_subscriptions')
        .upsert({
          org_id: orgId,
          user_id: caller.id,
          endpoint,
          p256dh,
          auth_key: authKey,
          user_agent: body.user_agent ? String(body.user_agent).slice(0, 500) : null,
          last_used_at: new Date().toISOString(),
        }, { onConflict: 'endpoint' });

      if (upsertErr) {
        return res.status(502).json({ ok: false, error: 'subscribe_failed', detail: upsertErr.message });
      }
      return res.status(200).json({ ok: true });
    }

    // DELETE
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ ok: false, error: 'endpoint_required' });

    const { error: delErr } = await supabase
      .from('team_risk_push_subscriptions')
      .delete()
      .eq('org_id', orgId)
      .eq('endpoint', endpoint);

    if (delErr) {
      return res.status(502).json({ ok: false, error: 'unsubscribe_failed', detail: delErr.message });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
