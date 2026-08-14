#!/usr/bin/env node
// Decision-logic tests for verifyExecutedPdf() in api/_lib/signature-verifier.js.
//
// Stubs the vision layer so the combination rules are testable offline and
// deterministically. What this proves:
//   - a "completed" document with blank signature lines returns verdict 'blank'
//     and safeToFileAsExecuted=false  (the failure this feature exists for)
//   - structural evidence can NEVER upgrade a visually-blank document
//   - when the visual layer is unavailable we return 'unverifiable', never
//     'signed' — no silent pass
//   - a missing expected signer downgrades 'signed' to 'partially_signed'
//
// Usage: node scripts/carter-esign-verdict-logic-test.js

'use strict';

const fs = require('fs');
const path = require('path');
const { verifyExecutedPdf } = require('../api/_lib/signature-verifier');

const realFetch = global.fetch;

function stubVision(payload, { fail = false } = {}) {
  global.fetch = async (url) => {
    if (String(url).includes('api.anthropic.com')) {
      if (fail) return { ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: JSON.stringify(payload) }] }),
      };
    }
    return realFetch(url);
  };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${extra !== undefined ? `  -> ${JSON.stringify(extra)}` : ''}`); }
}

(async () => {
  const fixture = path.join(__dirname, '..', '.tmp', 'esign-verify-fixtures', 'completed-but-blank.pdf');
  if (!fs.existsSync(fixture)) {
    console.error('Missing fixture. Run: node scripts/carter-signature-verifier-structural-test.js');
    process.exit(1);
  }
  const blankPdf = fs.readFileSync(fixture);

  const realPath = path.join(__dirname, '..', '.tmp', 'wildcherry-amendment', 'Amendment #1 - 526.pdf');
  const realPdf = fs.existsSync(realPath) ? fs.readFileSync(realPath) : blankPdf;

  // --- THE FAILURE CASE: provider says complete, page is blank ---------------
  stubVision({
    signature_blocks_found: 2,
    signatures_visibly_present: 0,
    blank_signature_lines: 2,
    signer_names_seen: [],
    dates_seen: [],
    blank_date_or_other_lines: ['EXECUTED the ___ day of ___'],
    verdict: 'blank',
    detail: 'Both seller signature lines are empty.',
  });
  const blankResult = await verifyExecutedPdf({
    buffer: blankPdf, apiKey: 'test-key', providerStatus: 'completed',
  });
  check('blank doc -> verdict "blank"', blankResult.verdict === 'blank', blankResult.verdict);
  check('blank doc -> NOT safe to file as executed', blankResult.safeToFileAsExecuted === false);
  check('blank doc -> raises a loud problem',
    blankResult.problems.some((p) => /no signature marks/i.test(p)), blankResult.problems);
  check('blank doc -> empty-form failure also surfaced',
    blankResult.problems.some((p) => /every one of the .* form fields .* is empty/i.test(p)), blankResult.problems);
  check('blank doc -> sha256 recorded', typeof blankResult.sha256 === 'string' && blankResult.sha256.length === 64);

  // --- structural evidence must NOT rescue a blank render -------------------
  stubVision({
    signature_blocks_found: 2, signatures_visibly_present: 0, blank_signature_lines: 2,
    signer_names_seen: [], verdict: 'blank', detail: 'blank',
  });
  const cryptoButBlank = await verifyExecutedPdf({
    buffer: realPdf, apiKey: 'test-key', providerStatus: 'completed',
  });
  check('crypto-signed but visually blank -> still "blank"', cryptoButBlank.verdict === 'blank', cryptoButBlank.verdict);
  check('crypto-signed but visually blank -> not safe to file', cryptoButBlank.safeToFileAsExecuted === false);

  // --- happy path: the Wild Cherry case ------------------------------------
  stubVision({
    signature_blocks_found: 2,
    signatures_visibly_present: 2,
    blank_signature_lines: 0,
    signer_names_seen: ['Thomas Linton', 'Carol Linton'],
    dates_seen: ['08/13/2026'],
    blank_date_or_other_lines: ['EXECUTED the ___ day of ___, needs broker final-acceptance date'],
    verdict: 'signed',
    detail: 'Both sellers signed.',
  });
  const signed = await verifyExecutedPdf({
    buffer: realPdf, expectedSigners: ['Thomas Linton', 'Carol Linton'],
    apiKey: 'test-key', providerStatus: 'completed',
  });
  check('fully signed -> verdict "signed"', signed.verdict === 'signed', signed.verdict);
  check('fully signed -> safe to file', signed.safeToFileAsExecuted === true);
  check('fully signed -> both signer names captured',
    signed.signerNamesSeen.length === 2, signed.signerNamesSeen);
  check('fully signed -> still reports the remaining blank EXECUTED date line',
    signed.problems.some((p) => /still blank/i.test(p)), signed.problems);

  // --- expected signer missing downgrades the verdict -----------------------
  stubVision({
    signature_blocks_found: 2, signatures_visibly_present: 1, blank_signature_lines: 0,
    signer_names_seen: ['Thomas Linton'], verdict: 'signed', detail: 'One signature.',
  });
  const missingSigner = await verifyExecutedPdf({
    buffer: realPdf, expectedSigners: ['Thomas Linton', 'Carol Linton'],
    apiKey: 'test-key', providerStatus: 'completed',
  });
  check('missing expected signer -> downgraded to partially_signed',
    missingSigner.verdict === 'partially_signed', missingSigner.verdict);
  check('missing expected signer -> names the missing party',
    missingSigner.problems.some((p) => /Carol Linton/.test(p)), missingSigner.problems);
  check('missing expected signer -> not safe to file', missingSigner.safeToFileAsExecuted === false);

  // --- partial signing ------------------------------------------------------
  stubVision({
    signature_blocks_found: 2, signatures_visibly_present: 1, blank_signature_lines: 1,
    signer_names_seen: ['Thomas Linton'], verdict: 'partially_signed', detail: 'One left.',
  });
  const partial = await verifyExecutedPdf({ buffer: realPdf, apiKey: 'test-key' });
  check('partial -> verdict "partially_signed"', partial.verdict === 'partially_signed', partial.verdict);
  check('partial -> not safe to file', partial.safeToFileAsExecuted === false);

  // --- vision unavailable must NOT pass as signed ---------------------------
  stubVision(null, { fail: true });
  const noVision = await verifyExecutedPdf({ buffer: realPdf, apiKey: 'test-key', providerStatus: 'completed' });
  check('vision failure -> "unverifiable", never "signed"', noVision.verdict === 'unverifiable', noVision.verdict);
  check('vision failure -> not safe to file', noVision.safeToFileAsExecuted === false);
  check('vision failure -> explains that provider status is not proof',
    noVision.problems.some((p) => /not proof/i.test(p)), noVision.problems);

  // --- no API key at all ----------------------------------------------------
  global.fetch = realFetch;
  const noKey = await verifyExecutedPdf({ buffer: realPdf, apiKey: null, providerStatus: 'completed' });
  check('no API key -> "unverifiable", never "signed"', noKey.verdict === 'unverifiable', noKey.verdict);
  check('no API key -> not safe to file', noKey.safeToFileAsExecuted === false);

  // --- not a PDF ------------------------------------------------------------
  const notPdf = await verifyExecutedPdf({ buffer: Buffer.from('<html>login</html>'), apiKey: 'test-key' });
  check('non-PDF input -> "unverifiable"', notPdf.verdict === 'unverifiable', notPdf.verdict);
  check('non-PDF input -> not safe to file', notPdf.safeToFileAsExecuted === false);

  console.log(`\n${fail === 0 ? 'ALL VERDICT-LOGIC TESTS PASSED' : 'VERDICT-LOGIC TESTS FAILED'}  (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
