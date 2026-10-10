#!/usr/bin/env node
/**
 * scripts/build-trec-39-11-field-classification.js
 *
 * TREC 39-11 Amendment (rev 05-04-2026) — classifies every one of the 51
 * real AcroForm widgets on the live wired asset
 * (api/_assets/trec-amendment-39-11-base64.js) into exactly one bucket,
 * same method as scripts/build-txr-1406-field-classification.js /
 * scripts/build-trec-40-11-field-classification.js:
 *
 *   - derivable         Property address header ("Street Address and
 *                        City"). Everything else on this form is either a
 *                        signature or a per-deal election.
 *   - signature_policy   The 4 signature widgets (Signature3/5/7/8).
 *   - must_ask           Every numbered-paragraph election (1-10) AND the
 *                        3-widget EXECUTED/final-acceptance date block
 *                        ("DATE OF FINAL ACCEPTANCE" / "20_4" / "BROKER
 *                        FILL IN THE" — day/month/2-digit-year respectively,
 *                        see executed_block:true below). The EXECUTED block
 *                        is agent-supplied like everything else in
 *                        must_ask, but per
 *                        trec-executed-date-block-needs-a-field.md it is
 *                        UNCONDITIONALLY required on every amendment (see
 *                        fill-form-required-fields.js's 'amendment' entry)
 *                        while the numbered paragraphs are each
 *                        independently optional (which ones apply is the
 *                        agent's per-deal choice).
 *
 * ⚠️ IMPORTANT — WIDGET NAMES LIE ON THIS FORM, SEVERELY.
 * scripts/send-trec-amendment.js's own header already warns "TREC AcroForm
 * field names lie — on 39-11 the checkbox names are shifted by one from
 * item (5) down." Verified 2026-10-10 against a real pdftotext -bbox extract
 * of the wired asset cross-referenced with form.getFields() rectangles: the
 * mismatch is WORSE than a one-item checkbox shift — it also affects several
 * TEXT fields and spans paragraphs 1, 2, 5, 6, and 7, not just the item-5-
 * down checkbox numbering. Concretely (bottom-origin rect y, page 1 of 1):
 *   - fillAmendment()'s PARAGRAPH-1 block (api/fill-form.js) targets fields
 *     'will' (DOES NOT EXIST on this asset — silent no-op) and 'will not'
 *     (y=468, which by position is actually item (5)'s "Buyer will pay —
 *     % of Sales Price" checkbox) for the old "price credited?" sub-choice.
 *     The current rev restructured item (1) entirely into an A/B/C cash-
 *     portion/financing/total breakdown (fields 'undefined'/'undefined_2'/
 *     'undefined_3', y=639/627/616) with NO will/will-not sub-choice at
 *     all — so PARAGRAPH-1's code also writes a dollar amount into field
 *     'be credited to the Sales Price' (y=400, by position item (7)'s
 *     "on or before 5:00 p.m. on ___" date blank) and a 2-digit value into
 *     '20_2' (y=400, item (7)'s matching 2-digit-year blank).
 *   - fillAmendment()'s PARAGRAPH-5 block ("LENDER REPAIRS") targets field
 *     '5 The cost of lender required repairs...' — which by POSITION
 *     (y=497.8, directly below item (4)'s checkbox at y=513.8) is actually
 *     item (5)'s OUTER checkbox ("The amounts in Paragraph 12B... are
 *     changed"), not item (6)'s lender-repairs-cost paragraph.
 *   - This script does NOT attempt to re-wire fillAmendment() paragraph-by-
 *     paragraph (that is a dedicated reconciliation on the scale of the
 *     TREC 40-11 multi-pass bbox audit already in fill-form.js, out of
 *     scope for a single classification pass) — it labels every widget
 *     from VERIFIED POSITION, not the field's own name or the existing
 *     (partially wrong) header comment, and flags the open defect above so
 *     it is not lost. The ONE fix made alongside this classification is the
 *     narrow, high-stakes EXECUTED-block value-type bug (see fillAmendment
 *     in api/fill-form.js, 2026-10-10 CARTER comment) — day/month/2-digit-
 *     year were being written to the right 3 fields but as the WRONG value
 *     shape (e.g. a full formatted date into a single-day-number blank).
 *
 * Run: node scripts/build-trec-39-11-field-classification.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const REPO = path.resolve(__dirname, '..');
const ASSET = path.join(REPO, 'api', '_assets', 'trec-amendment-39-11-base64.js');
const OUT = path.join(REPO, 'api', '_lib', 'trec-amendment-39-11-field-classification.json');

const SIGNATURE_POLICY_NAMES = new Set(['Signature3', 'Signature5', 'Signature7', 'Signature8']);

const DERIVABLE_BY_NAME = {
  'Street Address and City': 'property_full',
};

// EXECUTED/final-acceptance date block — verified 2026-10-10 via
// pdftotext -bbox against the real printed "EXECUTED the ___ day of
// ______________, 20___. (BROKER: FILL IN THE DATE OF FINAL ACCEPTANCE.)"
// line: day blank x~123-165pt matches field "DATE OF FINAL ACCEPTANCE",
// month-name blank x~203-373pt matches field "20_4", year blank x~396-433pt
// matches field "BROKER FILL IN THE". All three sit on ONE printed line
// (the EXECUTED paragraph), not the form's header date fields their names
// suggest.
const EXECUTED_BLOCK_NAMES = new Set(['DATE OF FINAL ACCEPTANCE', '20_4', 'BROKER FILL IN THE']);

const MUST_ASK_LABEL = {
  'Street Address and City': 'Property address header (see derivable)',
  'DATE OF FINAL ACCEPTANCE': 'EXECUTED block — day-of-month blank (verified position; field name is stale, does not sit on a separate "date of final acceptance" line)',
  '20_4': 'EXECUTED block — month-name blank (verified position; field name is stale)',
  'BROKER FILL IN THE': 'EXECUTED block — 2-digit-year blank (verified position; field name is stale)',
  '1 The Sales Price in Paragraph 3 of the contract is': 'ELECTION — ¶(1) Sales Price change checkbox',
  'undefined': '¶(1)A — cash portion of Sales Price at closing ($) (verified position)',
  'undefined_2': '¶(1)B — sum of financing described in contract ($) (verified position)',
  'undefined_3': '¶(1)C — Sales Price, sum of A+B ($) (verified position)',
  '2 In addition to any repairs and treatments otherwise required by the contract Seller at Sellers': 'ELECTION — ¶(2) Repairs checkbox',
  '3 The date in Paragraph 9 of the contract is changed to': 'ELECTION — ¶(3) Closing date change checkbox',
  'date 5': '¶(3) — new closing date (verified position; NOT the termination deadline the old field name suggests)',
  '20_25': '¶(3) — new closing date, 2-digit year (verified position)',
  '4 The amount in Paragraph 12A1b of the contract is changed to': 'ELECTION — ¶(4) Seller concession (12A(1)(b)) checkbox',
  'undefined_4': '¶(4) — new ¶12A(1)(b) amount ($)',
  '5 The cost of lender required repairs and treatment as itemized on the attached list will be paid':
    'ELECTION — ¶(5) outer checkbox, "amounts in ¶12B changed" (mislabeled; verified position — NOT ¶(6) lender repairs)',
  'will5': 'ELECTION — ¶(5)(1) "Seller will pay" row-enable checkbox (verified position)',
  'will6': '¶(5)(1) — Seller pays, "$" choice checkbox (verified position)',
  '203': '¶(5)(1) — Seller pays, $ amount (verified position)',
  'will not7': '¶(5)(1) — Seller pays, "%" choice checkbox (verified position)',
  'undefined_8': '¶(5)(1) — Seller pays, % of Sales Price (verified position)',
  'will9': 'ELECTION — ¶(5)(2) "Buyer will pay" row-enable checkbox (verified position)',
  'will10': '¶(5)(2) — Buyer pays, "$" choice checkbox (verified position)',
  '20': '¶(5)(2) — Buyer pays, $ amount (verified position)',
  'will not': '¶(5)(2) — Buyer pays, "%" choice checkbox (verified position — NOT the price-credit toggle the old code targets)',
  'undefined_5': '¶(5)(2) — Buyer pays, % of Sales Price (verified position)',
  '6 Buyer has paid Seller an additional Option Fee of': 'ELECTION — ¶(6) outer checkbox, lender-required-repairs cost split (field name echoes ¶(7)\'s text from a prior revision; the leading digit in the field NAME is reliable, the descriptive suffix is not — verified position)',
  'as follows': '¶(6) — lender-repair cost paid by Seller ($) (verified position)',
  'for an extension of the': '¶(6) — lender-repair cost paid by Buyer ($) (verified position — NOT an extension date; corrected from an earlier pass that matched on the field\'s misleading name)',
  'contract': '¶(7) — additional option fee amount ($) (verified position — NOT "option period days" the field name suggests)',
  '7 Buyer waives the unrestricted right to terminate the contract for which the Option Fee was paid':
    'ELECTION — ¶(7) outer checkbox, additional option fee for extension (field name echoes ¶(8)\'s text from a prior revision — verified position)',
  'be credited to the Sales Price': '¶(7) — "on or before 5:00 p.m. on ___" expiration date text (field name is stale/misleading — verified position, NOT a sales-price credit amount)',
  '20_2': '¶(7) — expiration date, 2-digit year (verified position)',
  'Fee': 'ELECTION — ¶(7) "additional option fee WILL be credited to Sales Price" checkbox (verified position)',
  'Fee 2': 'ELECTION — ¶(7) "additional option fee will NOT be credited" checkbox (verified position)',
  '8 The date for Buyer to give written notice to Seller that Buyer cannot obtain Buyer Approval as':
    'ELECTION — ¶(8) outer checkbox, Buyer waives unrestricted option-termination right (field name echoes ¶(9)\'s text from a prior revision — verified position)',
  '9 Other Modifications Insert only factual statements and business details applicable to this sale':
    'ELECTION — ¶(9) outer checkbox, Buyer-Approval notice date change (field name echoes ¶(10)\'s text from a prior revision — verified position)',
  'Text6': '¶(9) — new Buyer-Approval notice date, free text (verified position)',
  '20_3': '¶(9) — new Buyer-Approval notice date, 2-digit year (verified position)',
  '10': 'ELECTION — ¶(10) Other Modifications outer checkbox (reliable — bare "10", no stale descriptive suffix)',
  'Text3.1': '¶(10) Other Modifications — free-text line 1 (verified position)',
  'Text4.1': '¶(10) Other Modifications — free-text line 2 (verified position)',
  'Text5.1': '¶(10) Other Modifications — free-text line 3 (verified position)',
  'Text7 1': '¶(10) Other Modifications — free-text line 4 (verified position)',
  'Text1': '¶(2) — repairs/treatments description, free-text line 1 (verified position — NOT an "Other Modifications" line as fillAmendment()\'s current code assumes)',
  'Text 8': '¶(2) — repairs/treatments description, free-text line 2 (verified position)',
  'Text 9': '¶(2) — repairs/treatments description, free-text line 3 (verified position)',
  'Text 10': '¶(2) — repairs/treatments description, free-text line 4 (verified position)',
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
      const entry = { name, type, rect };

      if (SIGNATURE_POLICY_NAMES.has(name)) {
        signaturePolicy.push(entry);
      } else if (DERIVABLE_BY_NAME[name]) {
        derivable.push({ ...entry, transactionField: DERIVABLE_BY_NAME[name] });
      } else {
        mustAsk.push({
          ...entry,
          label: MUST_ASK_LABEL[name] || '(unlabeled — verify)',
          executed_block: EXECUTED_BLOCK_NAMES.has(name),
        });
      }
    }

    const out = {
      generated_at: new Date().toISOString(),
      source: 'api/_assets/trec-amendment-39-11-base64.js (live form.getFields() dump)',
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
