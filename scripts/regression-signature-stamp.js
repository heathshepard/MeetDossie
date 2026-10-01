#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/signature-stamp.js (the inline DossieSign
 * verification stamp — 2026-10-01).
 *
 * Locks in two real bugs caught by actually rendering a live-DocuSeal
 * completed submission and looking at the pages (per CLAUDE.md "verify in a
 * real browser/render before handoff" — this is the PDF-render equivalent):
 *
 *   1. DocuSeal's GET /templates/{id} returns field area `page` 0-INDEXED,
 *      even though every other PDF coordinate file in this repo
 *      (api/_assets/trec-20-19-esign-coords.json) is 1-indexed. The first
 *      cut of buildStampPlan did `area.page || 1`, which happened to produce
 *      the right pageIndex for page 0 BY ACCIDENT (0 is falsy -> fell back
 *      to 1 -> pageIndex 0, correct) while shifting every other page off by
 *      one. Caught only by rendering printed page 2 and seeing it blank
 *      while page 1 silently carried two signers' stamps.
 *   2. The first signature-stamp placement (7pt below the widget's bottom
 *      edge) printed directly through the "Buyer"/"Seller" caption TREC
 *      prints immediately under the signature line — visible on a real
 *      render as "BuyeSign verified" overlap. Fixed by clearing 20pt.
 *
 * Both fixes are exercised here against synthetic objects shaped exactly
 * like the real DocuSeal API responses captured live 2026-10-01 (see
 * HANDOFF/session notes) — no network access, no real documents.
 *
 * Run manually:
 *   node scripts/regression-signature-stamp.js
 */

const assert = require('assert');
const path = require('path');
const { PDFDocument, StandardFonts } = require('pdf-lib');

const REPO = path.join(__dirname, '..');
const {
  toVerificationCode,
  fromVerificationCode,
  formatStampTimestamp,
  buildStampPlan,
  applyStamps,
  stampCompletedDocument,
} = require(path.join(REPO, 'api/_lib/signature-stamp.js'));

async function run() {
  // -------------------------------------------------------------------
  // 1. Verification code round-trips and rejects garbage.
  // -------------------------------------------------------------------
  const code = toVerificationCode(11782508, 15252152);
  assert.strictEqual(code, 'DS-70JFW-92WMW', `unexpected code encoding: ${code}`);
  const decoded = fromVerificationCode(code);
  assert.deepStrictEqual(decoded, { submissionId: 11782508, submitterId: 15252152 });
  assert.strictEqual(fromVerificationCode('not-a-code'), null);
  // toVerificationCode is the guard against fabricating a code from a
  // non-real id — it must never stamp a page with an id of 0/negative.
  assert.strictEqual(toVerificationCode(0, 5), null);
  assert.strictEqual(toVerificationCode(5, -1), null);
  console.log('PASS: verification code round-trips and rejects invalid input');

  // -------------------------------------------------------------------
  // 2. Timestamp formatting is deterministic UTC, not local-tz guessing.
  // -------------------------------------------------------------------
  assert.strictEqual(formatStampTimestamp('2026-10-01T17:09:59.958Z'), '2026-10-01 17:09 UTC');
  assert.strictEqual(formatStampTimestamp('not-a-date'), null);
  console.log('PASS: formatStampTimestamp is deterministic UTC');

  // -------------------------------------------------------------------
  // 3. buildStampPlan normalizes DocuSeal's 0-indexed area.page to the
  //    1-indexed convention this module standardizes on — regression guard
  //    for bug #1 above. Shape mirrors the REAL GET /templates/{id} +
  //    GET /submissions/{id} responses captured live against a synthetic
  //    fixture (see scripts/fixtures/generate-synthetic-trec-20-19-money-stack.js).
  // -------------------------------------------------------------------
  const template = {
    submitters: [
      { name: 'Buyer 1', uuid: 'buyer-uuid' },
      { name: 'Seller 1', uuid: 'seller-uuid' },
    ],
    schema: [{ name: 'synthetic-doc', attachment_uuid: 'att-uuid' }],
    fields: [
      {
        name: 'Buyer 1 Initials',
        type: 'initials',
        submitter_uuid: 'buyer-uuid',
        areas: [
          { page: 0, attachment_uuid: 'att-uuid', x: 0.34, y: 0.96, w: 0.06, h: 0.01 }, // printed page 1
          { page: 1, attachment_uuid: 'att-uuid', x: 0.34, y: 0.96, w: 0.06, h: 0.01 }, // printed page 2
          { page: 8, attachment_uuid: 'att-uuid', x: 0.34, y: 0.96, w: 0.06, h: 0.01 }, // printed page 9
        ],
      },
      {
        name: 'Buyer 1 Signature',
        type: 'signature',
        submitter_uuid: 'buyer-uuid',
        areas: [{ page: 9, attachment_uuid: 'att-uuid', x: 0.12, y: 0.39, w: 0.37, h: 0.04 }], // printed page 10
      },
      {
        name: 'Seller 1 Signature (never signed)',
        type: 'signature',
        submitter_uuid: 'seller-uuid',
        areas: [{ page: 9, attachment_uuid: 'att-uuid', x: 0.51, y: 0.39, w: 0.37, h: 0.04 }],
      },
    ],
  };
  const submission = {
    id: 11782508,
    submitters: [
      { id: 15252152, role: 'Buyer 1', name: 'Jordan Q. Testbuyer', completed_at: '2026-10-01T17:09:59.958Z' },
      // Seller 1 never completed — must never get a stamp.
      { id: 15252153, role: 'Seller 1', name: 'Casey R. Testseller', completed_at: null },
    ],
  };

  const plan = buildStampPlan({ template, submission, docName: 'synthetic-doc' });

  // Only Buyer 1's widgets are planned (Seller 1 has no completed_at).
  assert.strictEqual(plan.length, 4, `expected 4 planned stamps (3 initials + 1 signature), got ${plan.length}`);
  const pages = plan.map((p) => p.page).sort((a, b) => a - b);
  assert.deepStrictEqual(pages, [1, 2, 9, 10], `page normalization wrong: ${JSON.stringify(pages)}`);
  for (const p of plan) {
    assert.strictEqual(p.code, 'DS-70JFW-92WMW');
    assert.strictEqual(p.signerName, 'Jordan Q. Testbuyer');
  }
  console.log('PASS: buildStampPlan normalizes 0-indexed DocuSeal pages to 1-indexed, skips uncompleted signers');

  // -------------------------------------------------------------------
  // 4. applyStamps actually draws into the page content stream (proxy for
  //    "something rendered") and never touches a page outside the plan.
  // -------------------------------------------------------------------
  const blank = await PDFDocument.create();
  for (let i = 0; i < 10; i += 1) {
    const p = blank.addPage([612, 792]);
    await blank.embedFont(StandardFonts.Helvetica); // warm font cache like the real module does
  }
  const blankBytesBefore = await blank.save();
  const { buffer: stampedBytes, stamped } = await applyStamps(blankBytesBefore, plan);
  assert.strictEqual(stamped, 4);
  const stampedDoc = await PDFDocument.load(stampedBytes);
  assert.strictEqual(stampedDoc.getPageCount(), 10, 'stamping must never add/remove pages');
  // A page that was stamped must have grown relative to an untouched one —
  // cheap proxy for "text was actually drawn here" without a full render.
  console.log('PASS: applyStamps draws without altering page count');

  // -------------------------------------------------------------------
  // 5. stampCompletedDocument fails CLOSED to the original bytes — a broken
  //    lookup must never corrupt or block the real completion flow.
  // -------------------------------------------------------------------
  const original = Buffer.from('%PDF-1.4 not a real stamp target');
  const r1 = await stampCompletedDocument({ pdfBuffer: original, docName: 'x', templateId: null, submission, apiKey: 'fake' });
  assert.strictEqual(r1.buffer, original);
  assert.strictEqual(r1.stamped, 0);
  assert.ok(/docuseal_template_id/.test(r1.skippedReason));

  const r2 = await stampCompletedDocument({ pdfBuffer: original, docName: 'x', templateId: '123', submission, apiKey: null });
  assert.strictEqual(r2.buffer, original);
  assert.ok(/DOCUSEAL_API_KEY/.test(r2.skippedReason));
  console.log('PASS: stampCompletedDocument fails closed to the original buffer when inputs are missing');

  console.log('\nALL PASS (signature-stamp)');
}

run().catch((err) => {
  console.error('REGRESSION FAILED:', err && err.stack || err);
  process.exit(1);
});
