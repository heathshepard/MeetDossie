// api/_lib/team-risk-rollup.js
//
// Shared aggregation logic for team-wide risk triage — the rollup layer the
// spec (dossie-agent-capability-spec.md §12, "Team-lead / broker oversight")
// calls for: "a lead doesn't want per-file detail by default, they want
// exceptions surfaced automatically."
//
// Used by two callers:
//   1. GET /api/team/org-risk-overview.js — HTTP endpoint for the Team
//      Dashboard UI (mirrors org-dossiers.js / org-dossier-detail.js).
//   2. api/chat.js — called directly (service-role, no HTTP round trip) to
//      give Dossie's chat real team-wide data when the caller is a team-lead
//      admin, so questions like "which files across my team are at risk"
//      have real facts to answer from instead of hallucinating.
//
// IMPORTANT: this module does NOT do authorization. Every caller MUST verify
// the requesting user is an active admin on org_id (via _mt_user_is_org_admin)
// BEFORE calling buildTeamRiskRollup. This mirrors org-dossiers.js exactly —
// the 403 gate happens in the caller, before any data is touched.

// Kept identical to org-dossier-detail.js's REQUIRED_DOC_TYPES — the one
// required-disclosure check that matters for a read-only admin risk summary.
// Not the full role/deal-shape-dependent rule set from dossie-app.jsx's
// getRequiredDocs() — not worth duplicating here.
const REQUIRED_DOC_TYPES = [
  { type: 'sellers_disclosure', label: "Seller's Disclosure Notice" },
];

function computeDeadlineFlags(tx, today) {
  const flags = [];
  if (tx.status === 'closed') return flags;
  if (tx.option_expiration_date && tx.option_expiration_date < today) flags.push('past_option_expiration');
  if (tx.loan_approval_deadline && tx.loan_approval_deadline < today) flags.push('past_loan_approval_deadline');
  if (tx.appraisal_deadline && tx.appraisal_deadline < today) flags.push('past_appraisal_deadline');
  if (tx.survey_deadline && tx.survey_deadline < today) flags.push('past_survey_deadline');
  if (tx.closing_date && tx.closing_date < today) flags.push('past_closing_date');
  return flags;
}

function daysBetween(earlierISO, laterISO) {
  const a = new Date(earlierISO).getTime();
  const b = new Date(laterISO).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase service-role client
 * @param {string} orgId the org the caller is confirmed admin of
 * @returns {Promise<{ok:true, org:object, teams:object[], generated_at:string,
 *   missing_disclosures:object[], overdue_action_items:object[],
 *   deadline_flags:object[], agents:object[]} | {ok:false, status:number, error:string}>}
 */
async function buildTeamRiskRollup(supabase, orgId) {
  const { data: org, error: orgErr } = await supabase
    .from('organizations')
    .select('id, name, tier, parent_org_id, archived_at')
    .eq('id', orgId)
    .maybeSingle();
  if (orgErr) return { ok: false, status: 500, error: orgErr.message };
  if (!org || org.archived_at) return { ok: false, status: 404, error: 'org not found' };

  // Brokerage roll-up — identical pattern to org-dossiers.js. Team-tier orgs
  // cannot have children (DB trigger), so this is a no-op for team-tier.
  let teams = [];
  let targetOrgIds = [orgId];
  if (org.tier === 'brokerage') {
    const { data: children, error: childErr } = await supabase
      .from('organizations')
      .select('id, name, tier')
      .eq('parent_org_id', orgId)
      .is('archived_at', null);
    if (childErr) return { ok: false, status: 500, error: childErr.message };
    teams = children || [];
    targetOrgIds = [orgId, ...teams.map((t) => t.id)];
  }

  const { data: members, error: rosterErr } = await supabase
    .from('organization_members_with_roles')
    .select('member_id, org_id, user_id, joined_at, removed_at, roles')
    .in('org_id', targetOrgIds)
    .is('removed_at', null);
  if (rosterErr) return { ok: false, status: 500, error: rosterErr.message };

  const userIds = (members || []).map((m) => m.user_id);
  let emailMap = {};
  let nameMap = {};
  if (userIds.length > 0) {
    const { data: usersData } = await supabase.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (usersData && usersData.users) {
      emailMap = Object.fromEntries(usersData.users.map((u) => [u.id, u.email]));
    }
    const { data: profileRows } = await supabase
      .from('profiles')
      .select('id, full_name')
      .in('id', userIds);
    if (profileRows) {
      nameMap = Object.fromEntries(profileRows.map((p) => [p.id, p.full_name]));
    }
  }

  const { data: txRows, error: txErr } = await supabase
    .from('transactions')
    .select([
      'id', 'user_id', 'org_id', 'dossier_number',
      'property_address', 'transaction_type', 'stage', 'status',
      'buyer_name', 'seller_name',
      'closing_date', 'option_expiration_date', 'loan_approval_deadline',
      'appraisal_deadline', 'survey_deadline',
      'created_at', 'updated_at',
    ].join(', '))
    .in('org_id', targetOrgIds)
    .order('updated_at', { ascending: false });
  if (txErr) return { ok: false, status: 500, error: txErr.message };

  const transactions = txRows || [];
  const txIds = transactions.map((t) => t.id);
  const txById = Object.fromEntries(transactions.map((t) => [t.id, t]));

  // Documents (for missing-disclosure detection) + action_items (for
  // overdue detection), across every transaction on the roster in two
  // queries rather than per-transaction round trips.
  let documents = [];
  let actionItems = [];
  if (txIds.length > 0) {
    const [{ data: docRows, error: docErr }, { data: aiRows, error: aiErr }] = await Promise.all([
      supabase.from('documents').select('transaction_id, document_type').in('transaction_id', txIds),
      supabase.from('action_items').select('id, transaction_id, description, action_type, status, due_date').in('transaction_id', txIds),
    ]);
    if (docErr) return { ok: false, status: 500, error: docErr.message };
    if (aiErr) return { ok: false, status: 500, error: aiErr.message };
    documents = docRows || [];
    actionItems = aiRows || [];
  }

  const docTypesByTx = {};
  documents.forEach((d) => {
    if (!docTypesByTx[d.transaction_id]) docTypesByTx[d.transaction_id] = new Set();
    docTypesByTx[d.transaction_id].add(d.document_type);
  });

  const today = new Date().toISOString().slice(0, 10);

  const agentLabel = (userId) => ({
    user_id: userId,
    agent_email: emailMap[userId] || null,
    agent_name: nameMap[userId] || null,
  });

  // 1. Missing required disclosures — non-closed transactions only. A
  // closed deal missing a doc type is a compliance-archive question, not a
  // "needs your attention right now" one; scoping that way keeps this list
  // an accurate "act now" list rather than noisy historical debt.
  const missingDisclosures = [];
  transactions.forEach((tx) => {
    if (tx.status === 'closed') return;
    const present = docTypesByTx[tx.id] || new Set();
    const missing = REQUIRED_DOC_TYPES.filter((r) => !present.has(r.type)).map((r) => r.type);
    if (missing.length > 0) {
      missingDisclosures.push({
        transaction_id: tx.id,
        property_address: tx.property_address,
        stage: tx.stage,
        status: tx.status,
        ...agentLabel(tx.user_id),
        missing_doc_types: missing,
      });
    }
  });

  // 2. Overdue action items, oldest due_date first (team-wide).
  const overdueActionItems = actionItems
    .filter((a) => a.status !== 'completed' && a.due_date && a.due_date < today)
    .map((a) => {
      const tx = txById[a.transaction_id] || {};
      return {
        action_item_id: a.id,
        transaction_id: a.transaction_id,
        property_address: tx.property_address || null,
        description: a.description,
        action_type: a.action_type,
        due_date: a.due_date,
        days_overdue: daysBetween(a.due_date, today),
        ...agentLabel(tx.user_id),
      };
    })
    .sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));

  // 3. Deadline drift flags (option/loan/appraisal/survey/closing dates in
  // the past on a still-open file) — same computeFlags family as
  // org-dossiers.js, team-wide instead of per-agent.
  const deadlineFlags = [];
  transactions.forEach((tx) => {
    const flags = computeDeadlineFlags(tx, today);
    if (flags.length > 0) {
      deadlineFlags.push({
        transaction_id: tx.id,
        property_address: tx.property_address,
        stage: tx.stage,
        status: tx.status,
        ...agentLabel(tx.user_id),
        flags,
      });
    }
  });

  // 4. Per-agent activity summary — active file count + days since last
  // touch (max transactions.updated_at across that agent's roster). This is
  // a transaction-level "touch," not document/action-item level — matches
  // what's actually queried here without an extra join.
  const txByUser = {};
  transactions.forEach((tx) => {
    if (!txByUser[tx.user_id]) txByUser[tx.user_id] = [];
    txByUser[tx.user_id].push(tx);
  });
  const agents = (members || []).map((m) => {
    const userTx = txByUser[m.user_id] || [];
    const activeCount = userTx.filter((t) => t.status !== 'closed').length;
    const lastTouchAt = userTx.reduce((latest, t) => {
      if (!t.updated_at) return latest;
      return (!latest || t.updated_at > latest) ? t.updated_at : latest;
    }, null);
    return {
      ...agentLabel(m.user_id),
      roles: m.roles || [],
      active_file_count: activeCount,
      total_file_count: userTx.length,
      last_touch_at: lastTouchAt,
      days_since_last_touch: lastTouchAt ? daysBetween(lastTouchAt, new Date().toISOString()) : null,
    };
  });

  return {
    ok: true,
    org: { id: org.id, name: org.name, tier: org.tier, parent_org_id: org.parent_org_id },
    teams,
    generated_at: new Date().toISOString(),
    missing_disclosures: missingDisclosures,
    overdue_action_items: overdueActionItems,
    deadline_flags: deadlineFlags,
    agents,
  };
}

module.exports = { buildTeamRiskRollup, REQUIRED_DOC_TYPES };
