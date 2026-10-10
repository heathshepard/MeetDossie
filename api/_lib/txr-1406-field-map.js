// api/_lib/txr-1406-field-map.js
//
// Phase 2(a)/(b) — TXR-1406 Seller's Disclosure Notice, semantic layer.
// Pairs api/_assets/field-maps/txr-1406-field-classification.json (the
// derivable / signature_policy / must_ask split, built by
// scripts/build-txr-1406-field-classification.js from the real 287-widget
// DocuSeal map) with the actual `transactions` row values, so a caller can
// get a ready-to-send { role: { widgetName: value } } object for the
// DocuSeal submission's default_value prefill, without touching anything
// the seller must answer live (the disclosure grid) or anything the
// signature-required policy already owns (signature/date/initials — see
// api/_lib/esign-field-required-policy.js).
//
// Property address is NOT in this widget-prefill object — it was never a
// DocuSeal field on this flat PDF; it's baked as real PDF text on every
// page via the pre-existing api/_assets/field-maps/txr-1406-address-coords.json
// mechanism in scripts/build-txr-1406-packet.js (bakeAddress()). Callers
// that need the address requirement should go through
// getMissingRequiredFields('sellers-disclosure', transaction) below, which
// does cover it.

const path = require('path');

const CLASSIFICATION = require(
  path.join(__dirname, 'txr-1406-field-classification.json')
);

// Widget `name` values that are genuinely derivable, each naming the real
// `transactions` column that feeds it. Kept as its own list (rather than
// re-deriving from CLASSIFICATION.derivable each call) so this file is the
// single source of truth for a widget-name -> column pairing a caller can
// grep for directly.
const DERIVABLE_WIDGETS = CLASSIFICATION.derivable.filter((f) => f.type !== 'baked_text');

/**
 * Build { role: { widgetName: value } } for every TXR-1406 widget Dossie
 * can answer itself from a transaction row. Skips a widget entirely when
 * the transaction has no value for its column (DocuSeal then renders that
 * widget blank/live for the seller, same as if it were never derivable).
 */
function resolveDerivableTxr1406Values(transaction) {
  const tx = transaction || {};
  const byRole = {};

  for (const f of DERIVABLE_WIDGETS) {
    const value = tx[f.transactionField];
    if (value === null || value === undefined || value === '') continue;
    const role = f.role || 'Seller 1';
    if (!byRole[role]) byRole[role] = {};
    byRole[role][f.name] = String(value);
  }

  return byRole;
}

/**
 * Widget `name`s the seller must answer live at signing — the disclosure
 * grid, its explain boxes, and the page-7 utility provider/phone list.
 * Nothing in `transactions` holds these; never attempt to derive them.
 */
function getMustAskWidgetNames() {
  return CLASSIFICATION.must_ask.map((f) => f.name);
}

/**
 * Widget `name`s governed by the signature/date/initials policy in
 * api/_lib/esign-field-required-policy.js — not re-decided here.
 */
function getSignaturePolicyWidgetNames() {
  return CLASSIFICATION.signature_policy.map((f) => f.name);
}

module.exports = {
  CLASSIFICATION,
  DERIVABLE_WIDGETS,
  resolveDerivableTxr1406Values,
  getMustAskWidgetNames,
  getSignaturePolicyWidgetNames,
};
