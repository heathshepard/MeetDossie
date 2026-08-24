// GET /api/team/org-documents?org_id=...
//
// Compliance vault + team-wide document search (Heath approved 2026-08-23
// from real market research: RISMedia/Form Simplicity broker guidance on
// "standardized form packages, review checklists"; a BoldTrail Back Office
// reviewer explicitly wished for "ability to search for specific documents
// rather than scrolling through the full list").
//
// Extends api/_lib/team-risk-rollup.js's existing missing-disclosure
// detection (REQUIRED_DOC_TYPES, imported directly — single source of truth
// so the two views can never drift) to show the FULL picture across the
// whole team: every present document (any type, any agent, any file) PLUS
// every missing required document, in one flat, filterable list. Unlike the
// risk rollup (which deliberately excludes closed files — "act now" only),
// this includes every transaction regardless of status, because a
// compliance vault is an archive question, not a triage one.
//
// Security model — identical gate to org-dossiers.js / org-risk-overview.js:
//   - Caller must present a valid Supabase bearer token.
//   - Caller must hold an ACTIVE 'admin' OR 'tc' role on org_id, checked via
//     _mt_user_is_org_admin_or_tc. No admin/tc on org_id => 403 before any
//     data query.
//
// Filtering: this route returns the full row set (demo/real org scale here
// is dozens of files, not thousands — org-dossiers.js already does the same
// "return everything, filter client-side" for the roster view). document_type,
// user_id, status and a free-text address/file-name search are ALSO accepted
// as query params and applied server-side as a convenience/defense-in-depth,
// but the primary filtering UI (TeamView.jsx's DocumentVaultView) filters the
// already-fetched row set instantly client-side, matching every other view
// built today.
//
// Returns:
// {
//   ok: true,
//   org: { id, name, tier, parent_org_id },
//   teams: [...],
//   required_doc_types: [{ type, label }],
//   document_type_options: [{ type, label, count }],   // every type actually seen + required types with 0
//   agents: [{ user_id, email, full_name }],
//   rows: [{
//     row_key, transaction_id, property_address, dossier_number, stage, transaction_status,
//     user_id, agent_email, agent_name,
//     document_type, document_type_label,
//     doc_status: 'present' | 'missing',
//     document_id, file_name, uploaded_at, fill_status, signature_status,
//   }]
// }

const { preflight, verifyBearer, getServiceClient, sendError } = require('../_lib/team-auth');
const { REQUIRED_DOC_TYPES } = require('../_lib/team-risk-rollup');

// Real document_type values seen in production (probed directly against the
// live documents table, not guessed) don't all have a friendly label yet —
// this only covers the handful with an established display name elsewhere
// in the app; everything else falls through to a generic underscore/hyphen
// -> Title Case prettifier so a new document_type never renders blank.
const KNOWN_LABELS = {
  sellers_disclosure: "Seller's Disclosure Notice",
  'trec-sellers-disclosure': "Seller's Disclosure Notice",
  contract: 'Contract',
  resale_contract: 'Resale Contract',
  title_commitment: 'Title Commitment',
  survey: 'Survey',
  closing_disclosure: 'Closing Disclosure',
  option_agreement: 'Option Agreement',
  inspection_report: 'Inspection Report',
  inspection: 'Inspection',
  'iabs-form': 'IABS Form',
  'trec-listing-agreement': 'Listing Agreement',
  listing_agreement: 'Listing Agreement',
  amendment: 'Amendment',
  deed: 'Deed',
  earnest_receipt: 'Earnest Money Receipt',
  'wire-fraud-warning': 'Wire Fraud Warning',
  'general-info-notice': 'General Information Notice',
  'onsite-sewer-form': 'On-Site Sewer Facility Notice',
};

function labelFor(type) {
  if (!type) return 'Unlabeled document';
  if (KNOWN_LABELS[type]) return KNOWN_LABELS[type];
  return String(type)
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
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

    const { data: isAdminOrTc, error: adminErr } = await supabase.rpc('_mt_user_is_org_admin_or_tc', {
      p_user_id: caller.id,
      p_org_id: orgId,
    });
    if (adminErr) {
      console.error('[org-documents] admin/tc check error:', adminErr.message);
      return res.status(500).json({ ok: false, error: 'authorization check failed' });
    }
    if (!isAdminOrTc) {
      return res.status(403).json({ ok: false, error: 'not an admin or TC on this org' });
    }

    const { data: org, error: orgErr } = await supabase
      .from('organizations')
      .select('id, name, tier, parent_org_id, archived_at')
      .eq('id', orgId)
      .maybeSingle();
    if (orgErr) {
      console.error('[org-documents] org fetch error:', orgErr.message);
      return res.status(500).json({ ok: false, error: orgErr.message });
    }
    if (!org || org.archived_at) {
      return res.status(404).json({ ok: false, error: 'org not found' });
    }

    let teams = [];
    let targetOrgIds = [orgId];
    if (org.tier === 'brokerage') {
      const { data: children, error: childErr } = await supabase
        .from('organizations')
        .select('id, name, tier')
        .eq('parent_org_id', orgId)
        .is('archived_at', null);
      if (childErr) {
        console.error('[org-documents] child org fetch error:', childErr.message);
        return res.status(500).json({ ok: false, error: childErr.message });
      }
      teams = children || [];
      targetOrgIds = [orgId, ...teams.map((t) => t.id)];
    }

    // Roster (for agent name/email enrichment — same source as org-dossiers.js).
    const { data: members, error: rosterErr } = await supabase
      .from('organization_members_with_roles')
      .select('member_id, org_id, user_id, roles')
      .in('org_id', targetOrgIds)
      .is('removed_at', null);
    if (rosterErr) {
      console.error('[org-documents] roster fetch error:', rosterErr.message);
      return res.status(500).json({ ok: false, error: rosterErr.message });
    }

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
    const agentLabel = (userId) => ({
      user_id: userId,
      agent_email: emailMap[userId] || null,
      agent_name: nameMap[userId] || null,
    });

    // ALL transactions (open + closed — a compliance vault is an archive
    // view, unlike the risk rollup which deliberately excludes closed files).
    const { data: txRows, error: txErr } = await supabase
      .from('transactions')
      .select('id, user_id, org_id, property_address, dossier_number, stage, status')
      .in('org_id', targetOrgIds);
    if (txErr) {
      console.error('[org-documents] transactions fetch error:', txErr.message);
      return res.status(500).json({ ok: false, error: txErr.message });
    }
    const transactions = txRows || [];
    const txById = Object.fromEntries(transactions.map((t) => [t.id, t]));
    const txIds = transactions.map((t) => t.id);

    // Real documents for every transaction on the roster. Deliberately NOT
    // filtered by documents.org_id — that column is largely unbackfilled on
    // existing rows (confirmed via a live probe), same reason
    // org-dossier-detail.js already scopes by transaction_id instead.
    let documents = [];
    if (txIds.length > 0) {
      const { data: docRows, error: docErr } = await supabase
        .from('documents')
        .select('id, transaction_id, document_type, form_type, file_name, status, signature_status, uploaded_at')
        .in('transaction_id', txIds)
        .order('uploaded_at', { ascending: false });
      if (docErr) {
        console.error('[org-documents] documents fetch error:', docErr.message);
        return res.status(500).json({ ok: false, error: docErr.message });
      }
      documents = docRows || [];
    }

    const presentTypesByTx = {};
    documents.forEach((d) => {
      if (!presentTypesByTx[d.transaction_id]) presentTypesByTx[d.transaction_id] = new Set();
      presentTypesByTx[d.transaction_id].add(d.document_type);
    });

    // ── Present rows — one per real document, any type. ────────────────────
    const rows = documents.map((d) => {
      const tx = txById[d.transaction_id] || {};
      return {
        row_key: `doc-${d.id}`,
        transaction_id: d.transaction_id,
        property_address: tx.property_address || null,
        dossier_number: tx.dossier_number || null,
        stage: tx.stage || null,
        transaction_status: tx.status || null,
        ...agentLabel(tx.user_id),
        document_type: d.document_type,
        document_type_label: labelFor(d.document_type),
        doc_status: 'present',
        document_id: d.id,
        file_name: d.file_name,
        uploaded_at: d.uploaded_at,
        fill_status: d.status || null,
        signature_status: d.signature_status || null,
      };
    });

    // ── Missing rows — required types only, every transaction that lacks
    // them (present + missing is the "full picture" the vault is for). ─────
    transactions.forEach((tx) => {
      const present = presentTypesByTx[tx.id] || new Set();
      REQUIRED_DOC_TYPES.forEach((req) => {
        if (present.has(req.type)) return;
        rows.push({
          row_key: `missing-${tx.id}-${req.type}`,
          transaction_id: tx.id,
          property_address: tx.property_address || null,
          dossier_number: tx.dossier_number || null,
          stage: tx.stage || null,
          transaction_status: tx.status || null,
          ...agentLabel(tx.user_id),
          document_type: req.type,
          document_type_label: req.label,
          doc_status: 'missing',
          document_id: null,
          file_name: null,
          uploaded_at: null,
          fill_status: null,
          signature_status: null,
        });
      });
    });

    // document_type_options — every type actually seen, data-driven (never
    // guessed), plus required types so they always appear as filter options
    // even on an org with zero uploads of that type yet.
    const typeCounts = {};
    rows.forEach((r) => {
      if (!typeCounts[r.document_type]) typeCounts[r.document_type] = { type: r.document_type, label: r.document_type_label, present: 0, missing: 0 };
      if (r.doc_status === 'present') typeCounts[r.document_type].present += 1;
      else typeCounts[r.document_type].missing += 1;
    });
    const documentTypeOptions = Object.values(typeCounts).sort((a, b) => a.label.localeCompare(b.label));

    const agents = (members || []).map((m) => ({
      user_id: m.user_id,
      email: emailMap[m.user_id] || null,
      full_name: nameMap[m.user_id] || null,
    }));

    return res.status(200).json({
      ok: true,
      org: { id: org.id, name: org.name, tier: org.tier, parent_org_id: org.parent_org_id },
      teams,
      required_doc_types: REQUIRED_DOC_TYPES,
      document_type_options: documentTypeOptions,
      agents,
      rows,
    });
  } catch (err) {
    return sendError(res, err);
  }
};
