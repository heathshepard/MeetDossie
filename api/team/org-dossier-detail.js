// GET /api/team/org-dossier-detail?org_id=...&transaction_id=...
//
// Drill-down for a single dossier from the Team Dashboard: real documents +
// action_items for that transaction, admin-gated exactly like org-dossiers.js.
// This is what makes "team lead sees every agent's docs and deal status from
// one screen" literally true — org-dossiers.js only ever returned transaction
// summaries (address/stage/deadlines), never document or action-item rows.
//
// Security model (identical gate to org-dossiers.js):
//   - Caller must present a valid Supabase bearer token.
//   - Caller must hold an ACTIVE 'admin' role on org_id, checked via
//     _mt_user_is_org_admin. No admin on org_id => 403 before any data query.
//   - The requested transaction_id must belong to org_id (or, for a
//     brokerage-tier org_id, to one of its child team orgs) — otherwise 404.
//     This stops an admin of Org A from probing an arbitrary transaction_id
//     that happens to belong to Org B.
//
// Returns:
// {
//   ok: true,
//   transaction: { id, property_address, stage, status, dossier_number },
//   documents: [{ id, document_type, file_name, status, uploaded_at }],
//   action_items: [{ id, description, action_type, status, due_date, overdue }],
//   missing_required: [ 'sellers_disclosure' ]  // required doc types with no row
// }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

// Kept intentionally small: the one required-disclosure check the sales demo
// (and any admin skimming for a stuck file) actually needs. The full
// required-docs rule set lives in dossie-app.jsx's getRequiredDocs() and is
// role/deal-shape dependent — not worth duplicating here for a read-only
// admin summary.
const REQUIRED_DOC_TYPES = [
  { type: 'sellers_disclosure', label: "Seller's Disclosure Notice" },
];

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const orgId = (req.query && req.query.org_id) || null;
    const transactionId = (req.query && req.query.transaction_id) || null;
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }
    if (!transactionId || typeof transactionId !== 'string') {
      return res.status(400).json({ ok: false, error: 'transaction_id required' });
    }

    const supabase = getServiceClient();

    // Hard gate FIRST, before any data is touched — same RPC as org-dossiers.js.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[org-dossier-detail] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, tier, archived_at')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[org-dossier-detail] org fetch error:', orgErr.message);
      return res.status(500).json({ ok: false, error: orgErr.message });
    }
    if (!org || org.archived_at) {
      return res.status(404).json({ ok: false, error: 'org not found' });
    }

    let targetOrgIds = [orgId];
    if (org.tier === 'brokerage') {
      const { data: children } = await supabase
        .from('organizations')
        .select('id')
        .eq('parent_org_id', orgId)
        .is('archived_at', null);
      targetOrgIds = [orgId, ...((children || []).map((c) => c.id))];
    }

    const { data: tx, error: txErr } = await supabase
      .from('transactions')
      .select('id, org_id, property_address, dossier_number, stage, status')
      .eq('id', transactionId)
      .maybeSingle();
    if (txErr) {
      console.error('[org-dossier-detail] transaction fetch error:', txErr.message);
      return res.status(500).json({ ok: false, error: txErr.message });
    }
    if (!tx || !targetOrgIds.includes(tx.org_id)) {
      return res.status(404).json({ ok: false, error: 'dossier not found on this org' });
    }

    const [{ data: documents, error: docErr }, { data: actionItems, error: aiErr }] = await Promise.all([
      supabase
        .from('documents')
        .select('id, document_type, file_name, status, uploaded_at')
        .eq('transaction_id', transactionId)
        .order('uploaded_at', { ascending: false }),
      supabase
        .from('action_items')
        .select('id, description, action_type, status, due_date')
        .eq('transaction_id', transactionId)
        .order('due_date', { ascending: true }),
    ]);
    if (docErr) {
      console.error('[org-dossier-detail] documents fetch error:', docErr.message);
      return res.status(500).json({ ok: false, error: docErr.message });
    }
    if (aiErr) {
      console.error('[org-dossier-detail] action_items fetch error:', aiErr.message);
      return res.status(500).json({ ok: false, error: aiErr.message });
    }

    const today = new Date().toISOString().slice(0, 10);
    const presentDocTypes = new Set((documents || []).map((d) => d.document_type));
    const missingRequired = REQUIRED_DOC_TYPES.filter((r) => !presentDocTypes.has(r.type));

    const enrichedActionItems = (actionItems || []).map((a) => ({
      ...a,
      overdue: a.status !== 'completed' && !!a.due_date && a.due_date < today,
    }));

    return res.status(200).json({
      ok: true,
      transaction: tx,
      documents: documents || [],
      action_items: enrichedActionItems,
      missing_required: missingRequired,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
