// GET /api/team/audit?org_id=...&limit=200
// DOD-A-6: org-wide audit log (last 200 admin/TC actions, plus TC consent events)

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const { user: caller } = await verifyBearer(req);
    const orgId = (req.query && req.query.org_id) || null;
    const limit = Math.min(Math.max(parseInt((req.query && req.query.limit) || '200', 10) || 200, 1), 500);
    if (!orgId) return res.status(400).json({ ok: false, error: 'org_id required' });

    const supabase = getServiceClient();
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id, p_org_id: orgId,
    });
    if (adminErr) return res.status(500).json({ ok: false, error: 'auth check failed' });
    if (!isAdmin) return res.status(403).json({ ok: false, error: 'not an admin' });

    const { data: admin } = await supabase
      .from('admin_actions_audit')
      .select('*')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    const { data: consent } = await supabase
      .from('tc_consent_events')
      .select('id, event_type, actor_user_id, agent_user_id, tc_user_id, created_at, payload_json')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
      .limit(limit);

    return res.status(200).json({
      ok: true,
      admin_actions: admin || [],
      tc_consent_events: consent || [],
    });
  } catch (err) {
    return sendError(res, err);
  }
};
