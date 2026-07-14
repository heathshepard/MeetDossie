// api/_lib/resolve-blank-template-pdf.js
//
// Shared resolver for blank form_template documents.
//
// Background (2026-07-12 ATLAS Simple Send fix, GOLD-2026-07-12-v1):
// When a user attaches a TREC/TAR form via /api/form-templates (action=attach),
// documents.storage_path is stamped as "template/{tmplId}.pdf" — a PLACEHOLDER
// that does NOT exist in Supabase Storage. form_templates.storage_path is also
// null for these library entries. Any downstream endpoint that reads
// documents.storage_path without a fallback crashes when the user never
// filled the template first.
//
// This resolver mirrors dossiesign-prepare.js's SHORT_NAME_TO_FORM_TYPE +
// FORM_B64_MAP so blank templates can be served from the bundled base64
// assets. Callers pass a document row; the resolver returns:
//   { buffer, mimeType, filename }  when the doc is a resolvable blank template
//   null                            for every other case (fall through to
//                                   normal Supabase Storage path)
//
// Keep this file in sync with dossiesign-prepare.js if new form templates
// ship — that file is the canonical map for e-signing.
//
// 2026-07-13 CARTER (Ridge orphan-storage sweep) — extracted from esign-create.js
// so documents.js, detect-form-type.js, send-compliance-packet.js, and
// interactive-editor-init.js can all share the same code path.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const FORM_TEMPLATE_B64 = {
  'resale-contract':       () => require('../_assets/trec-resale-20-19-base64.js'),
  'financing-addendum':    () => require('../_assets/trec-financing-40-11-base64.js'),
  'termination-notice':    () => require('../_assets/trec-termination-base64.js'),
  'wire-fraud-warning':    () => require('../_assets/tar-wire-fraud-base64.js'),
  'hoa-addendum':          () => require('../_assets/trec-hoa-addendum-36-11-base64.js'),
  'lead-paint-addendum':   () => require('../_assets/trec-lead-paint-base64.js'),
  'sellers-disclosure':    () => require('../_assets/trec-sellers-disclosure-55-1-base64.js'),
  'amendment':             () => require('../_assets/trec-amendment-39-11-base64.js'),
  'buyer-rep-agreement':   () => require('../_assets/tar-buyer-rep-base64.js'),
  'appraisal-termination': () => require('../_assets/trec-49-1-base64.js'),
  't47-affidavit':         () => require('../_assets/t47-affidavit-base64.js'),
  'unimproved-property':   () => require('../_assets/trec-unimproved-property-base64.js'),
  'seller-financing':      () => require('../_assets/trec-seller-financing-base64.js'),
  'buyers-temp-lease':     () => require('../_assets/trec-buyers-temp-lease-base64.js'),
  'sellers-temp-lease':    () => require('../_assets/trec-sellers-temp-lease-base64.js'),
  'sale-other-property':   () => require('../_assets/trec-sale-other-property-base64.js'),
  'oil-gas-minerals':      () => require('../_assets/trec-oil-gas-minerals-base64.js'),
  'backup-contract':       () => require('../_assets/trec-backup-contract-11-9-base64.js'),
  'coastal-area':          () => require('../_assets/trec-coastal-area-base64.js'),
  'hydrostatic-testing':   () => require('../_assets/trec-hydrostatic-testing-base64.js'),
  'environmental':         () => require('../_assets/trec-environmental-base64.js'),
  'short-sale':            () => require('../_assets/trec-short-sale-base64.js'),
  'gulf-waterway':         () => require('../_assets/trec-gulf-waterway-base64.js'),
  'propane-gas':           () => require('../_assets/trec-propane-gas-base64.js'),
  'residential-leases':    () => require('../_assets/trec-residential-leases-base64.js'),
  'fixture-leases':        () => require('../_assets/trec-fixture-leases-base64.js'),
  'loan-assumption':       () => require('../_assets/trec-loan-assumption-base64.js'),
  'improvement-district':  () => require('../_assets/trec-improvement-district-base64.js'),
  // 2026-07-14 — Simple Send Phase B revealed missing entries for canonical
  // TREC forms whose base64 assets exist in _assets/ but were never wired.
  // Bugs surfaced 25-17 / 23-20 / 24-20 Simple Send returning
  // "This form template PDF is not available. Please contact support."
  'farm-ranch':            () => require('../_assets/trec-farm-ranch-25-17-base64.js'),
  'new-home-incomplete':   () => require('../_assets/trec-new-home-incomplete-23-20-base64.js'),
  'new-home-complete':     () => require('../_assets/trec-new-home-complete-24-20-base64.js'),
};

const SHORT_NAME_TO_FORM_TYPE = {
  '1-4 Family Contract':           'resale-contract',
  'Financing Addendum':            'financing-addendum',
  'HOA Addendum':                  'hoa-addendum',
  'OP-L':                          'lead-paint-addendum',
  'Amendment':                     'amendment',
  'TREC 49-1':                     'appraisal-termination',
  'OP-H':                          'sellers-disclosure',
  'Seller Financing':              'seller-financing',
  'Sale of Other Property':        'sale-other-property',
  'Back-Up Contract':              'backup-contract',
  'Seller Disclosure':             'sellers-disclosure',
  'T-47':                          't47-affidavit',
  'TREC 9':                        'unimproved-property',
  'Buyer Rep Agreement':           'buyer-rep-agreement',
  'TAR 1501':                      'buyer-rep-agreement',
  'TAR 2001':                      'residential-leases',
  'TAR 2517':                      'wire-fraud-warning',
  // 2026-07-14 — Wire canonical TREC forms whose short_names existed in
  // form_templates but had no SHORT_NAME_TO_FORM_TYPE mapping. Every mapping
  // has a corresponding FORM_TEMPLATE_B64 entry.
  'TREC 25':                       'farm-ranch',
  'New Home Contract':             'new-home-incomplete',
  'New Home Completed':            'new-home-complete',
};

function supa(path) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
}

// Returns true when this document row looks like a blank form_template
// placeholder — either the document_type/status combo says so, or the
// storage_path uses the placeholder shape written by /api/form-templates.
function isBlankTemplateDoc(doc) {
  if (!doc) return false;
  if (doc.document_type === 'form_template' && doc.status === 'blank') return true;
  if (typeof doc.storage_path === 'string' && /^template\//.test(doc.storage_path)) return true;
  return false;
}

// Resolve the underlying blank-template PDF bytes for a documents row.
//
// Signature: resolveBlankTemplatePdf(doc)
//   doc — a documents table row. Must include `form_template_id`; benefits
//         from having `document_type`, `status`, `storage_path`, `file_name`.
//
// Returns { buffer: Buffer, mimeType: 'application/pdf', filename: string }
// when the doc is a blank template AND the base64 asset was found.
// Returns null in every other case (caller should fall through to its normal
// Supabase Storage path).
async function resolveBlankTemplatePdf(doc) {
  if (!doc) return null;
  if (!isBlankTemplateDoc(doc)) return null;
  if (!doc.form_template_id) return null;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;

  let shortName = null;
  let templateName = null;
  try {
    const r = await supa(
      `form_templates?id=eq.${encodeURIComponent(doc.form_template_id)}&is_active=eq.true&select=short_name,name`
    );
    if (!r.ok) return null;
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    shortName = rows[0].short_name;
    templateName = rows[0].name;
  } catch (err) {
    console.warn('[resolve-blank-template-pdf] form_templates fetch failed:', err && err.message);
    return null;
  }

  const slug = SHORT_NAME_TO_FORM_TYPE[shortName] || null;
  if (!slug) {
    console.warn(`[resolve-blank-template-pdf] short_name="${shortName}" has no SHORT_NAME_TO_FORM_TYPE mapping.`);
    return null;
  }
  const loader = FORM_TEMPLATE_B64[slug];
  if (!loader) {
    console.warn(`[resolve-blank-template-pdf] slug="${slug}" has no FORM_TEMPLATE_B64 loader.`);
    return null;
  }

  let buffer;
  try {
    const b64 = loader();
    if (!b64 || typeof b64 !== 'string') return null;
    buffer = Buffer.from(b64, 'base64');
  } catch (err) {
    console.warn(`[resolve-blank-template-pdf] loader failed for slug="${slug}":`, err && err.message);
    return null;
  }

  const filename = doc.file_name
    || (templateName ? `${templateName}.pdf` : `${slug}.pdf`);

  return { buffer, mimeType: 'application/pdf', filename };
}

module.exports = {
  resolveBlankTemplatePdf,
  isBlankTemplateDoc,
  // Exposed for tests + esign-create.js which still needs the maps directly.
  FORM_TEMPLATE_B64,
  SHORT_NAME_TO_FORM_TYPE,
};
