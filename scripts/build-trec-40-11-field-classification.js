#!/usr/bin/env node
/**
 * scripts/build-trec-40-11-field-classification.js
 *
 * TREC 40-11 Third Party Financing Addendum (rev 11-04-2024) — classifies
 * every one of the 64 real AcroForm widgets on the live wired asset
 * (api/_assets/trec-financing-40-11-base64.js) into exactly one bucket,
 * same method as scripts/build-txr-1406-field-classification.js:
 *
 *   - derivable         Dossie already holds the answer on the
 *                        `transactions` row (or a baked default) and can
 *                        prefill it without asking the agent anything new
 *                        for THIS addendum specifically. On this form that
 *                        is the property address header, repeated twice.
 *   - signature_policy   Signature widgets + the buyer/seller initial
 *                        blanks at the bottom of page 1. Not pre-populated
 *                        during a draft fill (see fillFinancingAddendum()'s
 *                        own 2026-07-04 Bug-4 note) — governed by the
 *                        e-sign/initials policy, not duplicated here.
 *   - must_ask           Everything else: loan type, loan amount, rate
 *                        caps, terms, origination charges, and -- per
 *                        feedback_verify-contract-elections-before-
 *                        execution.md (Pfeiffers Gate: ¶7D shipped blank on
 *                        a base contract, nobody caught it) -- every
 *                        "check one box only" election on this form:
 *                        the ¶2.A BUYER APPROVAL pair (IS / is NOT subject
 *                        to Buyer Approval), the ¶2.A termination-days
 *                        blank, and G. OTHER FINANCING's ¶2.B waiver pair.
 *                        These are financing decisions the agent makes
 *                        when preparing THIS addendum -- never auto-
 *                        populated from generic deal intake, even where a
 *                        value happens to also live in a `transactions`
 *                        column (loan_amount, financing_type).
 *
 * SOURCE OF TRUTH FOR SEMANTICS: fillFinancingAddendum() in api/fill-form.js
 * -- its own dated comments (2026-07-04 through 2026-08-25) document a
 * multi-pass, bbox-verified reconciliation of every widget on this exact
 * asset (TREC AcroForm field names lie: several are positionally swapped
 * relative to their own printed name -- see that function's header notes).
 * This script's WIDGET_MEANING table mirrors that already-verified mapping;
 * it does not re-derive it. Cross-checked 2026-10-10 against a live
 * form.getFields() dump of the wired asset (64 fields, matches) and a
 * pdftoppm render of page 2 for the ¶2.A/2.B election language.
 *
 * Run: node scripts/build-trec-40-11-field-classification.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');
const ASSET = path.join(REPO, 'api', '_assets', 'trec-financing-40-11-base64.js');
const OUT = path.join(REPO, 'api', '_lib', 'trec-40-11-field-classification.json');

const SIGNATURE_POLICY_NAMES = new Set([
  'Signature1', 'Signature2', 'Signature3', 'Signature4',
  'Initialed for identification by Buyer', 'undefined_2', 'and Seller', 'undefined_3',
]);

// name -> transactions column. Both widgets carry the full "street + city,
// state, zip" string (fillFinancingAddendum: propertyFull).
const DERIVABLE_BY_NAME = {
  'Street Address and City': 'property_full',
  'Address of Property': 'property_full',
};

// name -> short human label for the must_ask bucket, so the JSON is
// readable without cross-referencing fill-form.js. Verified against
// fillFinancingAddendum()'s own bbox-corrected comments, not the (lying)
// AcroForm field names.
const MUST_ASK_LABEL = {
  'years with interest not to exceed': 'Conventional — principal amount ($)',
  '1 Conventional Financing': 'Loan type checkbox — Conventional',
  '2 Texas Veterans Loan A loans from the Texas Veterans Land Board of': 'Loan type checkbox — Texas Veterans',
  '3 FHA Insured Financing A Section': 'Loan type checkbox — FHA',
  '4 VA Guaranteed Financing A VA guaranteed loan of not less than': 'Loan type checkbox — USDA (mislabeled; verified position)',
  '5 USDA Guaranteed Financing A USDAguaranteed loan of not less than': 'Loan type checkbox — Reverse Mortgage (mislabeled; verified position)',
  'a A first mortgage loan in the principal amount of': 'Conventional — first mortgage checkbox',
  'b A second mortgage loan in the principal amount of': 'Conventional — second mortgage checkbox',
  'any financed PMI premium due in full in 1': 'Conventional 1st mtg — due-in-full years',
  'any financed PMI premium due in full in 2': 'Conventional 1st mtg — interest rate cap (%)',
  'per annum for the first': 'Conventional 1st mtg — rate-cap period (years)',
  'shown on Buyers Loan Estimate for the loan not to exceed': 'Conventional 1st mtg — origination charges cap (%)',
  'excluding': 'Conventional 2nd mtg — principal amount ($)',
  'any financed PMI premium due in full in 1_2': 'Conventional 2nd mtg — due-in-full years',
  'any financed PMI premium due in full in 2_2': 'Conventional 2nd mtg — interest rate cap (%)',
  'per annum for the first_2': 'Conventional 2nd mtg — rate-cap period (years)',
  'shown on Buyers Loan Estimate for the loan not to exceed_2': 'Conventional 2nd mtg — origination charges cap (%)',
  'for a period in the total amount of': 'Texas Veterans — loan amount ($)',
  'years at the interest rate established by the': 'Texas Veterans — loan term (years)',
  'undefined': 'FHA — loan section (e.g. 203(b))',
  'excluding any financed MIP amortizable monthly for not less': 'FHA — loan amount ($)',
  'than': 'FHA — amortization term (years)',
  'years with interest not to exceed_2': 'FHA — interest rate cap (%), VOIDS contingency if blank',
  'Charges as shown on Buyers Loan Estimate for the loan not to exceed': 'USDA — loan amount ($) (verified position)',
  'excluding any financed Funding Fee amortizable monthly for not less than': 'VA — years (verified position)',
  'years': 'USDA — loan term (years) (verified position)',
  'with interest not to exceed': 'USDA — interest rate cap (%) (verified position)',
  'per annum for the first_4': 'Reverse Mortgage — loan amount ($) (verified position)',
  'Origination Charges as shown on Buyers Loan Estimate for the loan not to exceed': 'Reverse Mortgage — origination charges cap (%) (verified position)',
  'any financed PMI premium or other costs with interest not to exceed': 'Reverse Mortgage — interest rate cap (%) (verified position)',
  'Address of Property': 'Property address header, page 2 (see derivable)',
  'This contract is subject to Buyer obtaining Buyer Approval If Buyer cannot obtain Buyer':
    'ELECTION — ¶2.A "contract is NOT subject to Buyer obtaining Buyer Approval" checkbox (mislabeled; verified position)',
  'value of the Property established by the Department of Veterans Affairs': 'FHA/VA — appraised value floor ($)',
  'Text1': 'FHA — rate-cap period (years) (verified position)',
  'for the first': 'Reverse Mortgage — rate-cap period (years) (verified position)',
  'Estimate for the loan not to exceed': 'USDA — origination charges cap (%) (verified position)',
  'will not be an FHA insured loan': 'Reverse Mortgage — "will NOT be FHA insured" checkbox (verified position, swapped w/ "will")',
  'Check Box2': 'ELECTION — ¶2.A "contract IS subject to Buyer obtaining Buyer Approval" checkbox (mislabeled; verified position)',
  'Conversion Mortgage loan in the original principal amount of': 'ELECTION — ¶2.A termination days blank (mislabeled; verified position; code defaults to 21)',
  'not to exceed': 'FHA — origination charges cap (%) (verified position)',
  '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity': 'Loan type checkbox — VA (mislabeled; verified position)',
  'excluding_2': 'VA — loan amount ($) (verified position)',
  'not to exceed_2': 'VA — interest rate cap (%) (verified position)',
  'any financed Funding Fee amortizable monthly for not less than': 'VA — rate-cap period (years) (verified position)',
  'per annum for the first_3': 'G. Other Financing — rate-cap period (years) (verified position)',
  'Text2': 'VA — origination charges cap (%); duplicate-name widget also writes G. Other Financing (see fill-form.js note)',
  '6 Reverse Mortgage Financing A reverse mortgage loan also known as a Home Equity-1': 'Loan type checkbox — G. Other Financing (mislabeled; verified position)',
  'excluding_2-1': 'G. Other Financing — principal amount ($)',
  'not to exceed-1': 'G. Other Financing — interest rate cap (%)',
  'any financed Funding Fee amortizable monthly for not less than-1': 'G. Other Financing — term (years)',
  'not to exceed_2-1': 'G. Other Financing — rate-cap period (years)',
  'per annum for the first_3-1': 'G. Other Financing — origination charges cap (%)',
  'will': 'Reverse Mortgage — "will be FHA insured" checkbox (verified position, swapped w/ "will not...")',
  'will-1': 'ELECTION — G. Other Financing ¶2.B "waives" checkbox',
  'will-2': 'ELECTION — G. Other Financing ¶2.B "does not waive" checkbox',
};

function main() {
  const mod = require(ASSET);
  const b64 = typeof mod === 'string' ? mod : (mod.base64Pdf || mod.base64);
  const bytes = Buffer.from(b64, 'base64');

  return PDFDocument.load(bytes, { ignoreEncryption: true }).then((doc) => {
    const fields = doc.getForm().getFields();
    const derivable = [];
    const signaturePolicy = [];
    const mustAsk = [];

    for (const f of fields) {
      const name = f.getName();
      const type = f.constructor.name.replace('PDF', '');
      const widgets = f.acroField.getWidgets();
      const rect = widgets[0] ? widgets[0].getRectangle() : null;
      // All widgets live on page 1 or 2 of this 2-page form -- infer from Y
      // position isn't reliable across pages, so use the field's own page
      // array index via the AcroForm page refs. Simple + correct: pdf-lib
      // widgets reference their page via P; fall back to null if absent.
      let page = null;
      try {
        const pRef = widgets[0].P();
        const pages = doc.getPages();
        page = pages.findIndex((p) => p.ref === pRef) + 1 || null;
      } catch (e) { /* leave null */ }

      const entry = { name, type, page, rect };

      if (SIGNATURE_POLICY_NAMES.has(name)) {
        signaturePolicy.push(entry);
      } else if (DERIVABLE_BY_NAME[name]) {
        derivable.push({ ...entry, transactionField: DERIVABLE_BY_NAME[name] });
      } else {
        mustAsk.push({ ...entry, label: MUST_ASK_LABEL[name] || '(unlabeled — verify)' });
      }
    }

    const out = {
      generated_at: new Date().toISOString(),
      source: 'api/_assets/trec-financing-40-11-base64.js (live form.getFields() dump)',
      total_widgets: fields.length,
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
    console.log(`derivable=${derivable.length} signature_policy=${signaturePolicy.length} must_ask=${mustAsk.length} total_widgets=${fields.length}`);
    console.log(`Wrote ${OUT}`);
  });
}

if (require.main === module) main();

module.exports = { main };
