// api/_lib/trec-amendment-39-11-field-map.js
//
// TREC 39-11 Amendment, semantic layer. Pairs
// api/_lib/trec-amendment-39-11-field-classification.json (the derivable /
// signature_policy / must_ask split, built by
// scripts/build-trec-39-11-field-classification.js from the real 51-widget
// AcroForm on the live asset) with the actual `transactions` row.
//
// Two derivable things this form needs, always, regardless of which
// numbered paragraphs the agent invokes: the property address, and the
// EXECUTED/final-acceptance date block. The EXECUTED block is technically
// agent-SUPPLIED (the date of final acceptance isn't known until the last
// party signs) rather than transaction-DERIVED like the address — it is
// exposed here as its own helper (getExecutedBlockWidgets()) rather than
// folded into resolveDerivableTrecAmendment3911Values() for that reason.
// See trec-executed-date-block-needs-a-field.md and
// fill-form-required-fields.js's 'amendment' entry.

const path = require('path');

const CLASSIFICATION = require(
  path.join(__dirname, 'trec-amendment-39-11-field-classification.json')
);

/** Build { widgetName: value } for the property-address widget only. */
function resolveDerivableTrecAmendment3911Values(transaction) {
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

/** The 3 widgets making up the EXECUTED/final-acceptance date block (day/month/2-digit-year). */
function getExecutedBlockWidgets() {
  return CLASSIFICATION.must_ask.filter((f) => f.executed_block);
}

/** Every election widget (numbered-paragraph checkboxes + their blanks) the agent must supply, excluding the EXECUTED block. */
function getMustAskWidgets() {
  return CLASSIFICATION.must_ask.filter((f) => !f.executed_block);
}

/** Widget `name`s governed by the signature policy — not re-decided here. */
function getSignaturePolicyWidgetNames() {
  return CLASSIFICATION.signature_policy.map((f) => f.name);
}

module.exports = {
  CLASSIFICATION,
  resolveDerivableTrecAmendment3911Values,
  getExecutedBlockWidgets,
  getMustAskWidgets,
  getSignaturePolicyWidgetNames,
};
