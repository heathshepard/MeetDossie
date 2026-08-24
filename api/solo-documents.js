// GET /api/solo-documents
//
// Compliance Vault for a Solo agent — the personal version of the Team
// compliance vault (api/team/org-documents.js) shipped 2026-08-23, scoped to
// `user_id = the logged-in solo agent` instead of `org_id`, since there's no
// team/org context for a solo account. Same REQUIRED_DOC_TYPES source of
// truth (imported directly from api/_lib/team-risk-rollup.js — never
// duplicated/redefined) and the same present-vs-missing row shape, so the
// UI (SoloDocumentVaultView.jsx) is a near-verbatim reuse of TeamView.jsx's
// DocumentVaultView.
//
// Security model: GATED BEHIND THE COMPLIANCE VAULT ADD-ON ENTITLEMENT
// (subscriptions.compliance_vault_enabled), NOT an org-admin check — this is
// a personal feature, not a team-visibility one. A caller who hasn't paid
// gets 402, not data. This mirrors how api/addon-status.js-gated features
// work for Email Integration (the calling UI checks entitlement before even
// showing the nav item; this endpoint independently re-checks server-side —
// never trusts the client).
//
// Auth: Authorization: Bearer <supabase user JWT>
//
// Returns the same shape as org-documents.js minus org/teams/agents (a solo
// account has exactly one "agent" — themselves):
// {
//   ok: true,
//   required_doc_types: [{ type, label }],
//   document_type_options: [{ type, label, present, missing }],
//   rows: [{ row_key, transaction_id, property_address, dossier_number, stage,
//            transaction_status, document_type, document_type_label,
//            doc_status: 'present'|'missing', document_id, file_name,
//            uploaded_at, fill_status, signature_status }]
// }
//
// Owner: Carter, 2026-08-24 (Compliance Vault add-on for Solo)

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { createClient } = require('@supabase/supabase-js');
const { REQUIRED_DOC_TYPES } = require('./_lib/team-risk-rollup');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Kept identical to api/team/org-documents.js's KNOWN_LABELS/labelFor — same
// document_type vocabulary, same fallback prettifier so a new type never
// renders blank. Not extracted to a shared module in this pass (both files
// are small and independently readable; a shared _lib helper is a safe
// follow-up, not required for correctness).
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
  return String(type).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'GET, OPTIONS', headers: 'Content-Type, Authorization' });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured.' });
  }

  let userId;
  try {
    const auth = await verifySupabaseToken(req);
    userId = auth.userId;
  } catch (err) {
    const status = err instanceof AuthError && err.status ? err.status : 401;
    return res.status(status).json({ ok: false, error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const { data: sub, error: subErr } = await supabase
      .from('subscriptions')
      .select('compliance_vault_enabled')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (subErr) {
      console.error('[solo-documents] subscription check error:', subErr.message);
      return res.status(500).json({ ok: false, error: 'entitlement check failed' });
    }
    if (!sub || !sub.compliance_vault_enabled) {
      return res.status(402).json({ ok: false, error: 'Compliance Vault add-on is not active on your account.' });
    }

    // ALL of the caller's own transactions (open + closed — same archive
    // reasoning as org-documents.js: a compliance vault answers "what do I
    // have on file, ever", not just "what's active right now").
    const { data: txRows, error: txErr } = await supabase
      .from('transactions')
      .select('id, property_address, dossier_number, stage, status')
      .eq('user_id', userId);
    if (txErr) {
      console.error('[solo-documents] transactions fetch error:', txErr.message);
      return res.status(500).json({ ok: false, error: txErr.message });
    }
    const transactions = txRows || [];
    const txById = Object.fromEntries(transactions.map((t) => [t.id, t]));
    const txIds = transactions.map((t) => t.id);

    let documents = [];
    if (txIds.length > 0) {
      const { data: docRows, error: docErr } = await supabase
        .from('documents')
        .select('id, transaction_id, document_type, form_type, file_name, status, signature_status, uploaded_at')
        .in('transaction_id', txIds)
        .order('uploaded_at', { ascending: false });
      if (docErr) {
        console.error('[solo-documents] documents fetch error:', docErr.message);
        return res.status(500).json({ ok: false, error: docErr.message });
      }
      documents = docRows || [];
    }

    const presentTypesByTx = {};
    documents.forEach((d) => {
      if (!presentTypesByTx[d.transaction_id]) presentTypesByTx[d.transaction_id] = new Set();
      presentTypesByTx[d.transaction_id].add(d.document_type);
    });

    const rows = documents.map((d) => {
      const tx = txById[d.transaction_id] || {};
      return {
        row_key: `doc-${d.id}`,
        transaction_id: d.transaction_id,
        property_address: tx.property_address || null,
        dossier_number: tx.dossier_number || null,
        stage: tx.stage || null,
        transaction_status: tx.status || null,
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

    const typeCounts = {};
    rows.forEach((r) => {
      if (!typeCounts[r.document_type]) typeCounts[r.document_type] = { type: r.document_type, label: r.document_type_label, present: 0, missing: 0 };
      if (r.doc_status === 'present') typeCounts[r.document_type].present += 1;
      else typeCounts[r.document_type].missing += 1;
    });
    const documentTypeOptions = Object.values(typeCounts).sort((a, b) => a.label.localeCompare(b.label));

    return res.status(200).json({
      ok: true,
      required_doc_types: REQUIRED_DOC_TYPES,
      document_type_options: documentTypeOptions,
      rows,
    });
  } catch (err) {
    console.error('[solo-documents] unexpected error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
};
