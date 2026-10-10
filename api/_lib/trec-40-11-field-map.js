// api/_lib/trec-40-11-field-map.js
//
// TREC 40-11 Third Party Financing Addendum, semantic layer. Pairs
// api/_lib/trec-40-11-field-classification.json (the derivable /
// signature_policy / must_ask split, built by
// scripts/build-trec-40-11-field-classification.js from the real 64-widget
// AcroForm on the live asset) with the actual `transactions` row, so a
// caller can get a ready-to-send { widgetName: value } object for the
// derivable set only -- the property address, the one thing on this form
// that is NOT a financing-specific decision the agent has to make for this
// addendum. The loan type / amount / rate / term / ¶2.A-2.B elections are
// all must_ask -- see getMustAskWidgets() -- financing-addendum's real fill
// logic (fillFinancingAddendum() in api/fill-form.js) reads those off the
// merged fv object (transactions columns + contract_field_drafts['40-11']
// + request field_values), not from this module.

const path = require('path');

const CLASSIFICATION = require(
  path.join(__dirname, 'trec-40-11-field-classification.json')
);

/**
 * Build { widgetName: value } for every TREC 40-11 widget Dossie can
 * answer itself from a transaction row -- today, just the property address
 * header (appears twice: page 1 "Street Address and City", page 2 "Address
 * of Property"). Skips a widget entirely when the transaction has no value.
 */
function resolveDerivableTrec4011Values(transaction) {
  const tx = transaction || {};
  const propertyFull = tx.property_full
    || [tx.property_address, tx.city_state_zip].filter(Boolean).join(', ');
  const out = {};
  if (!propertyFull) return out;
  for (const f of CLASSIFICATION.derivable) {
    out[f.name] = propertyFull;
  }
  return out;
}

/** Widget entries ({name,type,page,rect,label}) the agent must supply when preparing this addendum. */
function getMustAskWidgets() {
  return CLASSIFICATION.must_ask;
}

/** Widget `name`s governed by the signature/initials policy -- not re-decided here. */
function getSignaturePolicyWidgetNames() {
  return CLASSIFICATION.signature_policy.map((f) => f.name);
}

module.exports = {
  CLASSIFICATION,
  resolveDerivableTrec4011Values,
  getMustAskWidgets,
  getSignaturePolicyWidgetNames,
};
