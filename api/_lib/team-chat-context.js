// api/_lib/team-chat-context.js
//
// Gives api/chat.js's action-mode assistant real team-wide data when the
// caller is a team-lead / broker-owner (an active 'admin' member of a
// non-archived org) — the missing piece flagged in
// dossie-agent-capability-spec.md §12: "the missing piece is a team-wide
// rollup layer plus giving Dossie's chat context the awareness that it's
// talking to a team-lead account so it reaches for team-scoped answers
// instead of defaulting to 'which of your own files.'"
//
// A solo agent (no admin membership on any org) gets `null` back here and
// api/chat.js's prompt is byte-identical to before this change — this only
// activates for a real team-lead account.

const { createClient } = require('@supabase/supabase-js');
const { buildTeamRiskRollup } = require('./team-risk-rollup');

function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

// Caps keep the injected JSON small and cheap — a team lead asking "what's
// at risk" needs the worst offenders, not an unbounded dump. Oldest-overdue
// and every missing disclosure are already the highest-signal rows, so the
// cap only matters for orgs much larger than today's real customer base.
const MAX_ROWS = 40;

/**
 * @param {string} userId
 * @returns {Promise<null | { org: {id,name,tier}, missing_disclosures: object[],
 *   overdue_action_items: object[], deadline_flags: object[], agents: object[] }>}
 */
async function getTeamChatContext(userId) {
  if (!userId) return null;
  const supabase = getServiceClient();
  if (!supabase) return null;

  try {
    const { data: rows, error } = await supabase
      .from('organization_members_with_roles')
      .select(`
        member_id, org_id, user_id, roles, removed_at,
        organizations:org_id ( id, name, tier, archived_at )
      `)
      .eq('user_id', userId)
      .is('removed_at', null);

    if (error || !rows) return null;

    const adminRow = rows.find((r) => {
      const roles = Array.isArray(r.roles) ? r.roles : [];
      return roles.includes('admin') && r.organizations && !r.organizations.archived_at;
    });
    if (!adminRow) return null; // solo agent, or a non-admin team member — no team context

    const rollup = await buildTeamRiskRollup(supabase, adminRow.org_id);
    if (!rollup.ok) {
      console.error('[team-chat-context] rollup failed:', rollup.error);
      return null;
    }

    return {
      org: rollup.org,
      missing_disclosures: rollup.missing_disclosures.slice(0, MAX_ROWS),
      overdue_action_items: rollup.overdue_action_items.slice(0, MAX_ROWS),
      deadline_flags: rollup.deadline_flags.slice(0, MAX_ROWS),
      agents: rollup.agents,
    };
  } catch (err) {
    console.error('[team-chat-context] error:', err && err.message);
    return null;
  }
}

module.exports = { getTeamChatContext };
