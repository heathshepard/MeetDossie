// POST /api/team/reassign-transaction
//
// Admin-only. Moves an open dossier from one active team member to another
// (e.g. an agent leaves or goes on leave) — no way to do this existed before
// 2026-08-23 (confirmed via grep). This is the write path from the
// drill-down TeamView.jsx already has for a single dossier
// (org-dossier-detail.js's UI).
//
// Body: { transaction_id, new_user_id }
//
// Security model: mirrors remove-member.js exactly — the body carries only
// transaction_id + new_user_id (never org_id), and the RPC
// (reassign_transaction) re-derives org_id from the transaction itself and
// re-checks _mt_user_is_org_admin on THAT org before touching anything. A
// caller who is admin on Org A cannot reassign a transaction that belongs to
// Org B — the RPC's own admin check fails on B, full stop. new_user_id must
// also be an ACTIVE member of that same org (RPC-enforced) — reassigning to
// someone off the team is rejected.

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
    const transactionId = body.transaction_id;
    const newUserId = body.new_user_id;
    if (!transactionId) return res.status(400).json({ ok: false, error: 'transaction_id required' });
    if (!newUserId) return res.status(400).json({ ok: false, error: 'new_user_id required' });

    const supabase = getServiceClient();

    const { error } = await supabase.rpc('reassign_transaction', {
      p_transaction_id: transactionId,
      p_new_user_id: newUserId,
      p_acting_user_id: caller.id,
    });
    if (error) {
      console.error('[reassign-transaction] RPC error:', error.message);
      return res.status(400).json({ ok: false, error: error.message });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return sendError(res, err);
  }
};
