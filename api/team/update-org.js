// POST /api/team/update-org
// Admin-only org rename. Confirmed via grep 2026-08-23: no endpoint existed
// for updating organizations.name anywhere — create-org.js only ever sets it
// once, at creation. This is the follow-up gap noted in api/complete-onboarding.js
// (the auto-created "{first name}'s Team" default has no way to be renamed).
//
// Body: { org_id, name }
// Same gate as billing.js / org-dossiers.js / org-risk-overview.js:
// _mt_user_is_org_admin check BEFORE any write.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const body = req.body || {};
    const orgId = body.org_id;
    const name = typeof body.name === 'string' ? body.name.trim() : '';

    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }
    if (!name || name.length < 2 || name.length > 200) {
      return res.status(400).json({ ok: false, error: 'Team name must be 2-200 characters.' });
    }

    const supabase = getServiceClient();

    // Hard gate FIRST, before any write — same RPC every other /api/team/*
    // admin endpoint uses.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[update-org] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    const { data: updated, error: updateErr } = await supabase
      .from('organizations')
      .update({ name })
      .eq('id', orgId)
      .select('id, name')
      .maybeSingle();
    if (updateErr) {
      console.error('[update-org] update failed:', updateErr.message);
      return res.status(500).json({ ok: false, error: updateErr.message });
    }
    if (!updated) {
      return res.status(404).json({ ok: false, error: 'org not found' });
    }

    return res.status(200).json({ ok: true, org_id: updated.id, name: updated.name });
  } catch (err) {
    return sendError(res, err);
  }
};
