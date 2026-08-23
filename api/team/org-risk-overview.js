// GET /api/team/org-risk-overview?org_id=...
//
// Team-wide risk rollup for a team-lead / brokerage admin — the aggregation
// layer the spec calls for (dossie-agent-capability-spec.md §12): "a lead
// doesn't want per-file detail by default, they want exceptions surfaced
// automatically." Where org-dossiers.js/org-dossier-detail.js answer "show
// me everything" or "show me this one file," this answers "what needs my
// attention right now" across every agent's dossiers at once:
//   - every non-closed file missing a required disclosure/signature
//   - every overdue action item team-wide, oldest first
//   - deadline-drift flags (past option/loan/appraisal/survey/closing dates)
//   - per-agent activity summary (active file count, days since last touch)
//
// Security model — identical gate to org-dossiers.js / org-dossier-detail.js:
//   - Caller must present a valid Supabase bearer token.
//   - Caller must hold an ACTIVE 'admin' role on org_id, checked via
//     _mt_user_is_org_admin. No admin on org_id => 403 before any data query.
//   - RLS on transactions/documents/action_items independently restricts
//     org-admin SELECT the same way org-dossiers.js documents.
//
// The actual aggregation lives in ../_lib/team-risk-rollup.js — shared with
// api/chat.js so the chat assistant's team-lead answers and this endpoint's
// UI answers can never diverge.

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { buildTeamRiskRollup } = require('../_lib/team-risk-rollup');

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

    // Hard gate FIRST, before any data is touched.
    const { data: isAdmin, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[org-risk-overview] admin check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdmin) {
      return res.status(403).json({ ok: false, error: 'not an admin on this org' });
    }

    const rollup = await buildTeamRiskRollup(supabase, orgId);
    if (!rollup.ok) {
      return res.status(rollup.status || 500).json({ ok: false, error: rollup.error });
    }

    return res.status(200).json(rollup);
  } catch (err) {
    return sendError(res, err);
  }
};
