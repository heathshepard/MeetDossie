// api/_lib/merge-contract-field-drafts.js
//
// 2026-09-01 CARTER — Defect A2 fix
// (docs/DOSSIE-DOCUSEAL-INTEGRATION-PLAN-2026-09-01.md §4, Fix 2).
//
// The Interactive Editor autosaves every non-canonical field edit into
// transactions.contract_field_drafts['20-19'] (interactive-editor-save.js),
// and interactive-editor-init.js reads them back so the editor UI shows
// them — but the FILL pipeline (fill-form.js, and dossiesign-prepare.js's
// preview filler) built its field values from canonical transactions
// columns only. A member's saved edits reached the editor screen and the
// editor's own preview, then silently vanished from every PDF the fill
// pipeline produced. ~170 orphaned draft fields existed across 3 live
// transactions when this was diagnosed.
//
// This module is the single choke point: merge the stored drafts on top of
// the canonical base values (member's explicit edits win), translated
// through the exact same functions interactive-editor-download-pdf.js uses
// for previews (trec-20-19-editor-field-translate.js), so preview and
// sent/filled PDFs can never disagree about what a draft means:
//   1. translateSnapshotAddressFields() on the DRAFTS ONLY (the editor's
//      property_address is the full "known as" string; moving it to
//      property_full prevents the duplicated-city bug fixed 2026-08-25).
//   2. Empty draft values ('' / null) are skipped — same semantics as
//      download-pdf's mergeFieldValues, so a cleared editor field falls
//      back to the canonical column exactly like the preview does.
//   3. translateEditorFieldNames() on the merged result (editor legacy key
//      names -> the keys fill-trec-20-19.js reads; gap-fill only).
//
// Precedence: canonical/base values < stored drafts < caller-supplied
// field_values (an explicit request override is fresher than an autosave).

const {
  translateEditorFieldNames,
  translateSnapshotAddressFields,
} = require('./trec-20-19-editor-field-translate');

// contract_field_drafts is keyed by TREC form number. Map fill-form
// form_type -> draft key (mirrors FORM_TYPE_TO_FORM_NUMBER in
// interactive-editor-update-field.js, which writes these).
const DRAFT_KEY_BY_FORM_TYPE = {
  'resale-contract':     '20-19',
  'financing-addendum':  '40-11',
  'hoa-addendum':        '36-11',
  'lead-paint-addendum': 'OP-L',
};

function hasValue(v) {
  return v != null && v !== '';
}

// Returns the cleaned drafts object for this form type, or null when there
// is nothing to merge. The 20-19 address translation (editor sends the full
// "known as" string as property_address) applies only to resale-contract —
// the only form with a live Interactive Editor emitting that shape.
function extractContractFieldDrafts(tx, formType) {
  const draftKey = DRAFT_KEY_BY_FORM_TYPE[formType];
  if (!draftKey) return null;
  const all = tx && tx.contract_field_drafts;
  const drafts = (all && typeof all === 'object' && all[draftKey] && typeof all[draftKey] === 'object')
    ? all[draftKey]
    : null;
  if (!drafts) return null;
  const cleaned = {};
  for (const [k, v] of Object.entries(drafts)) {
    if (hasValue(v)) cleaned[k] = v;
  }
  if (Object.keys(cleaned).length === 0) return null;
  return formType === 'resale-contract' ? translateSnapshotAddressFields(cleaned) : cleaned;
}

// The choke-point merge. Behavior is byte-identical to the old
// Object.assign({}, baseValues, callerValues) when no drafts exist for this
// form type, so non-editor forms and draft-less transactions are untouched.
function mergeContractFieldDrafts({ tx, formType, baseValues, callerValues }) {
  const base = Object.assign({}, baseValues || {}, callerValues || {});
  const drafts = extractContractFieldDrafts(tx, formType);
  if (!drafts) return base;
  const merged = Object.assign({}, baseValues || {}, drafts, callerValues || {});
  // Editor legacy key-name translation is 20-19-specific (gap-fill only).
  const translated = formType === 'resale-contract' ? translateEditorFieldNames(merged) : merged;
  console.log(
    '[merge-contract-field-drafts] applied %d saved draft value(s) for %s on tx %s',
    Object.keys(drafts).length, formType, tx && tx.id
  );
  return translated;
}

module.exports = { mergeContractFieldDrafts, extractContractFieldDrafts, DRAFT_KEY_BY_FORM_TYPE };
