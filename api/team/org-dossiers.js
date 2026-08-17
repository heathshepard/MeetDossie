// GET /api/team/org-dossiers?org_id=...
// Org-wide dossier (transaction) visibility for a team-lead / brokerage admin.
//
// This is the endpoint that justifies the Team ($129/agent/mo) and Brokerage
// (banded per-agent + $300/mo admin fee) tiers: an org admin can see every
// member's dossiers by name, not just roster/billing/audit-log.
//
// Security model (mirrors roster.js / billing.js exactly):
//   - Caller must present a valid Supabase bearer token (verifyBearer).
//   - Caller must hold an ACTIVE 'admin' role on the org_id requested,
//     checked via the same _mt_user_is_org_admin RPC used by every other
//     /api/team/* endpoint. No admin on org_id => 403, full stop.
//   - All data reads use the service-role client AFTER that check passes —
//     RLS on transactions/documents/action_items already restricts org-admin
//     SELECT to org_id IS NOT NULL AND is_org_admin(org_id) (see
//     20260619163812_multitenant_phase3_org_id_audit_vault.sql), so even a
//     service-role misuse elsewhere could not leak past a non-admin caller
//     reaching this route, because the 403 happens before any data query.
//
// Brokerage roll-up (no schema change): organizations.parent_org_id already
// models Brokerage -> Team nesting (phase1 migration). A Brokerage-tier org's
// admin is checked as direct admin of org_id (the brokerage's own org row);
// once past that gate, we additionally pull every child team org
// (parent_org_id = org_id) and include their rosters + transactions. A
// Team-tier org cannot have children (enforced by trg_enforce_org_parent_tier),
// so a team admin only ever sees their own team — no recursion needed, no new
// table needed.
//
// Returns:
// {
//   ok: true,
//   org: { id, name, tier, parent_org_id },
//   teams: [{ id, name }],   // child team orgs, only populated for brokerage tier
//   members: [{
//     member_id, user_id, email, roles, joined_at, removed_at,
//     org_id, org_name,      // which org (team) this member actually belongs to
//     dossier_count, dossiers: [{
//       id, property_address, transaction_type, stage, status,
//       buyer_name, seller_name, closing_date, option_expiration_date,
//       loan_approval_deadline, appraisal_deadline, survey_deadline,
//       created_at, updated_at, flags: [ 'past_option_expiration', ... ]
//     }]
//   }]
// }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');

const SUMMARY_COLUMNS = [
  'id', 'user_id', 'org_id',
  'property_address', 'transaction_type', 'stage', 'status',
  'buyer_name', 'seller_name',
  'closing_date', 'option_expiration_date', 'loan_approval_deadline',
  'appraisal_deadline', 'survey_deadline',
  'created_at', 'updated_at',
].join(', ');

function computeFlags(tx) {
  const flags = [];
  const today = new Date().toISOString().slice(0, 10);
  if (!tx.property_address) flags.push('missing_address');
  if (tx.status !== 'closed') {
    if (tx.option_expiration_date && tx.option_expiration_date < today) flags.push('past_option_expiration');
    if (tx.loan_approval_deadline && tx.loan_approval_deadline < today) flags.push('past_loan_approval_deadline');
    if (tx.appraisal_deadline && tx.appraisal_deadline < today) flags.push('past_appraisal_deadline');
    if (tx.survey_deadline && tx.survey_deadline < today) flags.push('past_survey_deadline');
    if (tx.closing_date && tx.closing_date < today) flags.push('past_closing_date');
  }
  return flags;
}

module.exports = async function handler(req, res) {
  if (preflight(req, res)) return;

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const { user: caller } = await verifyBearer(req);
    const orgId = (req.query && req.query.org_id) || null;
    if (!orgId || typeof orgId !== 'string') {
      return res.status(400).json({ ok: false, error: 'org_id required' });
    }

    const supabase = getServiceClient();

    // Hard gate FIRST, before any data is touched. Same RPC every other
    // /api/team/* admin endpoint uses — a non-admin (or an admin of a
    // different org) gets 403 here and nothing further executes.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[org-dossiers] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    // Org row (also confirms org_id actually exists / isn't archived).
    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, tier, parent_org_id, archived_at')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[org-dossiers] org fetch error:', orgErr.message);
      return res.status(500).json({ ok: false, error: orgErr.message });
    }
    if (!org || org.archived_at) {
      return res.status(404).json({ ok: false, error: 'org not found' });
    }

    // Brokerage roll-up: pull active child team orgs. Team-tier orgs cannot
    // have children (DB trigger), so this is a no-op for a team-tier caller.
    let teams = [];
    let targetOrgIds = [orgId];
    if (org.tier === 'brokerage') {
      const { data: children, error: childErr } = await supabase
        .from('organizations')
        .select('id, name, tier')
        .eq('parent_org_id', orgId)
        .is('archived_at', null);
      if (childErr) {
        console.error('[org-dossiers] child org fetch error:', childErr.message);
        return res.status(500).json({ ok: false, error: childErr.message });
      }
      teams = children || [];
      targetOrgIds = [orgId, ...teams.map((t) => t.id)];
    }

    const orgNameById = { [org.id]: org.name };
    teams.forEach((t) => { orgNameById[t.id] = t.name; });

    // Roster across every target org (own org + child teams if brokerage).
    const { data: members, error: rosterErr } = await supabase
      .from('organization_members_with_roles')
      .select('member_id, org_id, user_id, joined_at, removed_at, roles')
      .in('org_id', targetOrgIds)
      .is('removed_at', null);
    if (rosterErr) {
      console.error('[org-dossiers] roster fetch error:', rosterErr.message);
      return res.status(500).json({ ok: false, error: rosterErr.message });
    }

    // Emails
    const userIds = (members || []).map((m) => m.user_id);
    let emailMap = {};
    if (userIds.length > 0) {
      const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
      if (usersData && usersData.users) {
        emailMap = Object.fromEntries(usersData.users.map((u) => [u.id, u.email]));
      }
    }

    // Dossiers (transactions) for every member across all target orgs.
    const { data: txRows, error: txErr } = await supabase
      .from('transactions')
      .select(SUMMARY_COLUMNS)
      .in('org_id', targetOrgIds)
      .order('updated_at', { ascending: false });
    if (txErr) {
      console.error('[org-dossiers] transactions fetch error:', txErr.message);
      return res.status(500).json({ ok: false, error: txErr.message });
    }

    const dossiersByUser = {};
    (txRows || []).forEach((tx) => {
      const summary = {
        id: tx.id,
        property_address: tx.property_address,
        transaction_type: tx.transaction_type,
        stage: tx.stage,
        status: tx.status,
        buyer_name: tx.buyer_name,
        seller_name: tx.seller_name,
        closing_date: tx.closing_date,
        option_expiration_date: tx.option_expiration_date,
        loan_approval_deadline: tx.loan_approval_deadline,
        appraisal_deadline: tx.appraisal_deadline,
        survey_deadline: tx.survey_deadline,
        created_at: tx.created_at,
        updated_at: tx.updated_at,
        flags: computeFlags(tx),
      };
      if (!dossiersByUser[tx.user_id]) dossiersByUser[tx.user_id] = [];
      dossiersByUser[tx.user_id].push(summary);
    });

    const enrichedMembers = (members || []).map((m) => {
      const dossiers = dossiersByUser[m.user_id] || [];
      return {
        member_id: m.member_id,
        user_id: m.user_id,
        email: emailMap[m.user_id] || null,
        roles: m.roles || [],
        joined_at: m.joined_at,
        removed_at: m.removed_at,
        org_id: m.org_id,
        org_name: orgNameById[m.org_id] || null,
        dossier_count: dossiers.length,
        dossiers,
      };
    });

    return res.status(200).json({
      ok: true,
      org: { id: org.id, name: org.name, tier: org.tier, parent_org_id: org.parent_org_id },
      teams,
      members: enrichedMembers,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
