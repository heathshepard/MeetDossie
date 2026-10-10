#!/usr/bin/env node
/**
 * scripts/build-txr-1406-field-classification.js
 *
 * Phase 2(a)/(b) of the TXR-1406 Carter audit (2026-10-09). Classifies every
 * widget in api/_assets/field-maps/txr-1406-sellers-disclosure-docuseal-fields.json
 * (287 fields -- the real, collision-proven DocuSeal widget list, see
 * scripts/regression-txr-1406-field-overlay.js) into exactly one bucket:
 *
 *   - derivable        Dossie already holds the answer on the `transactions`
 *                       row (or, for the broker/agent block, `profiles` --
 *                       NOT APPLICABLE on this form, see note below) and can
 *                       prefill it. Carries `transactionField` naming the
 *                       real column.
 *   - signature_policy  Signature / initials / date widgets. Required-ness
 *                       for these is already centralized in
 *                       api/_lib/esign-field-required-policy.js
 *                       (dsFieldRequired, INITIALS_REQUIRED_FORMS has
 *                       'sellers-disclosure-txr-1406'). Not duplicated here.
 *   - must_ask          The seller's own knowledge of the property's
 *                       condition (the Y/N/U disclosure grid, explain boxes,
 *                       and utility-provider contact info on page 7 -- none
 *                       of which lives in `transactions`). Dossie must ask
 *                       the seller for these; they are never derived.
 *
 * NOTE on the broker/agent block: the real printed TXR-1406 form (verified
 * via pdftotext against api/_assets/txr-1406-sellers-disclosure-base64.js,
 * 2026-10-09) carries NO broker-identity widgets at all -- no broker name,
 * license number, or office phone field exists anywhere in the 287-field
 * DocuSeal map or the printed form text (only the generic phrase "the
 * broker(s)" appears, twice, as static printed text). The audit item asking
 * for a "broker/agent block" mapping does not apply to this form -- that
 * block exists on IABS (see memory heath-broker-info-block-correct-values.md),
 * not TXR-1406. Confirmed, not derived from a template assumption.
 *
 * Property address is intentionally NOT one of the 287 widgets -- it is
 * baked as literal PDF text on every page via the pre-existing
 * api/_assets/field-maps/txr-1406-address-coords.json + bakeAddress() step
 * in scripts/build-txr-1406-packet.js. Listed here anyway (as a synthetic
 * entry) so the single classification file is the one place that answers
 * "is this field derivable" for the whole form.
 *
 * Run: node scripts/build-txr-1406-field-classification.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'api', '_assets', 'field-maps', 'txr-1406-sellers-disclosure-docuseal-fields.json');
// Lives in api/_lib/ (not api/_assets/field-maps/) -- this is a semantic
// classification, not field geometry, and scripts/regression-esign-field-maps.js
// check 8(b) assumes every *.json directly inside field-maps/ has a flat
// `fields: {name: {...}}` shape (coordinate maps), which this file is not.
const OUT = path.join(__dirname, '..', 'api', '_lib', 'txr-1406-field-classification.json');

const src = JSON.parse(fs.readFileSync(SRC, 'utf8'));

// name (exact, case-sensitive match against the docuseal-fields.json 'name'
// property) -> transactions column that feeds it.
const DERIVABLE_BY_NAME = {
  'Seller 1 Printed Name': 'seller_name',
  'Seller 2 Printed Name': 'seller2_name',
  'HOA - Name of association': 'hoa_name',
  "HOA - Manager's name": 'hoa_management_company',
  'HOA - Manager phone': 'hoa_phone',
};

const SIGNATURE_POLICY_TYPES = new Set(['signature', 'date', 'initials']);

const derivable = [];
const signaturePolicy = [];
const mustAsk = [];

for (const f of src.fields) {
  const entry = {
    name: f.name,
    type: f.type,
    role: f.role,
    page: f.page,
  };
  if (SIGNATURE_POLICY_TYPES.has(f.type)) {
    signaturePolicy.push(entry);
  } else if (DERIVABLE_BY_NAME[f.name]) {
    derivable.push({ ...entry, transactionField: DERIVABLE_BY_NAME[f.name] });
  } else {
    mustAsk.push(entry);
  }
}

// Synthetic entry — baked as PDF text, not a DocuSeal widget. See header note.
derivable.unshift({
  name: 'Property address (all 7 pages, "Concerning the Property at ___")',
  type: 'baked_text',
  role: null,
  page: 'all',
  transactionField: 'property_address + city_state_zip',
  mechanism: 'api/_assets/field-maps/txr-1406-address-coords.json via bakeAddress()',
});

const out = {
  generated_at: new Date().toISOString(),
  source: 'api/_assets/field-maps/txr-1406-sellers-disclosure-docuseal-fields.json',
  total_widgets: src.fields.length,
  counts: {
    derivable: derivable.length,
    signature_policy: signaturePolicy.length,
    must_ask: mustAsk.length,
  },
  derivable,
  signature_policy: signaturePolicy,
  must_ask: mustAsk,
};

fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(`derivable=${derivable.length} signature_policy=${signaturePolicy.length} must_ask=${mustAsk.length} total_widgets=${src.fields.length}`);
console.log(`Wrote ${OUT}`);
