#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-29 extraction truncation regression AND
 * the 2026-10-05 compliance-audit truncation regression (same root cause,
 * same file, hit auditCompliance() six weeks after it was fixed in
 * scanContract()).
 *
 * 2026-09-29 (extraction): POST /api/scan-contract returned EVERY extracted
 * field as null with ok:true for any real multi-page TREC contract. The
 * extraction schema grew to ~90 fields the same day (money-stack fields),
 * and scanContract() ran it on Haiku at MAX_TOKENS=4096 — the JSON response
 * truncated mid-object, JSON.parse threw, and the catch fell through to
 * emptyResult(), which wipes the ENTIRE extracted object to null while the
 * handler still returned ok:true.
 *
 * Mirroring the model/token bump alone was not sufficient: verified live
 * against a real 12-page contract (2026-09-29) that claude-sonnet-5 also
 * auto-enables extended thinking, and thinking tokens draw from the SAME
 * max_tokens budget as the visible text — at 6144 with thinking left on,
 * the model spent the entire budget thinking and emitted ZERO characters
 * of JSON (stop_reason:max_tokens, thinking_tokens:6144, no text block at
 * all) — a worse truncation than the original bug, since there wasn't even
 * partial text to repair. The fix was `thinking: { type: 'disabled' }` plus
 * EXTRACT_MAX_TOKENS=8192 (verified live: end_turn, 5178 output tokens on
 * the real fixture, well under budget).
 *
 * 2026-10-05 (compliance audit): auditCompliance()'s trec-20-17 call (Sonnet,
 * 6144 max_tokens) was never updated to disable thinking when the identical
 * bug was fixed in scanContract() above — it hit the exact same pathology.
 * Reproduced live against production: 2 of 5 real scans of
 * generated-docs/sample-resale-contract.pdf came back with an unparsable
 * response, falling through to emptyComplianceReport(). Fixed the same way
 * (`thinking: { type: 'disabled' }`, budget raised to 8192) plus added a
 * repairTruncatedJson() fallback (previously audit had none — any parse
 * failure discarded the whole report) that recovers findings emitted before
 * a cutoff while forcing passed:false/auditNotPerformed:true regardless of
 * what the model said before truncating, so the 2026-10-01 false-pass
 * incident cannot reappear through this path.
 *
 * This test does not call the live Anthropic API (no cost, deterministic,
 * safe for CI) — it monkey-patches Messages.prototype.create on the same
 * @anthropic-ai/sdk class instance scan-contract.js uses (Node's module
 * cache guarantees the class is shared) to return canned responses that
 * reproduce each failure mode, then asserts against the real
 * scanContract()/runFullScan()/auditCompliance() code paths.
 *
 * Covers (extraction, scanContract()):
 *   1. A fully successful, well-formed response -> success:true, all real
 *      fields populated (not the false-negative case).
 *   2. Thinking exhausts the entire token budget, zero text emitted (the
 *      exact 2026-09-29 shape) -> success:false, NOT a silent all-null
 *      success. The response must be visibly marked failed.
 *   3. A response truncated mid-JSON-object with SOME real fields already
 *      emitted (the classic max_tokens-cutoff shape) -> success:false, but
 *      the fields that were fully emitted before the cutoff are PRESERVED,
 *      not discarded wholesale (the "silent failure is the enemy" fix —
 *      partial data must survive).
 *   4. A response that is not JSON at all (garbage/empty) -> success:false,
 *      every field genuinely null (nothing to recover), never ok:true.
 *   5-6. runFullScan()'s extractionFailed flag: true when trec-20-17
 *      extraction fails, false/absent for every other document type (where
 *      extraction never runs — not a failure, expected behavior).
 * Covers (compliance audit, auditCompliance()):
 *   7. A fully successful, well-formed response -> real findings,
 *      auditNotPerformed:false.
 *   8. Thinking exhausts the entire token budget, zero text emitted (the
 *      2026-10-05 shape) -> auditNotPerformed:true, passed:false, never a
 *      silent pass.
 *   9. A response truncated mid-JSON-object with some findings already
 *      emitted -> those findings survive, but passed/auditNotPerformed are
 *      FORCED to false/true regardless of what the model emitted before the
 *      cutoff — a partial read is never a confirmed-clean contract.
 *   10. A response that is not JSON at all -> empty report, never a pass.
 *
 * Run manually:
 *   node scripts/regression-scan-contract-truncation.js
 */

const assert = require('assert');
const path = require('path');

const SCAN_CONTRACT_PATH = path.resolve(__dirname, '..', 'api', 'scan-contract.js');

// Must be set before requiring scan-contract.js so `new Anthropic({...})`
// at module scope doesn't hit a real, unset key — value is never used
// since every messages.create() call below is mocked.
if (!process.env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = 'test-key-not-used-mocked-below';

const Anthropic = require('@anthropic-ai/sdk');

// A minimal, realistic slice of the real extraction schema — enough to
// exercise money-stack fields without carrying the full ~90-field object
// into this test file.
const GOOD_EXTRACTED = {
  salePrice: 315000,
  salePriceCash: 63000,
  salePriceFinanced: 252000,
  earnestMoney: 3000,
  optionFee: 100,
  optionDays: 10,
  closingDate: '2026-10-29',
  hasSpecialProvisions: false,
};

function textResponse(jsonObj, opts) {
  const o = opts || {};
  return {
    stop_reason: o.stop_reason || 'end_turn',
    usage: { output_tokens: o.output_tokens || 1000, output_tokens_details: { thinking_tokens: 0 } },
    content: [{ type: 'text', text: typeof jsonObj === 'string' ? jsonObj : JSON.stringify(jsonObj) }],
  };
}

function thinkingOnlyResponse() {
  // The exact 2026-09-29 failure shape: thinking consumed the whole budget,
  // no text block emitted at all.
  return {
    stop_reason: 'max_tokens',
    usage: { output_tokens: 6144, output_tokens_details: { thinking_tokens: 6144 } },
    content: [{ type: 'thinking', thinking: '(ran out of budget before answering)' }],
  };
}

// 2026-10-05 — auditCompliance() now also sets `thinking: { type: 'disabled' }`
// (the compliance-audit truncation fix), so `params.thinking` can no longer
// distinguish the extraction call from the audit call the way it used to —
// both disable thinking now. Match on the prompt text itself instead: the
// extraction prompt's opening line is unique to that call.
function isExtractionCall(params) {
  const content = params && params.messages && params.messages[0] && params.messages[0].content;
  const textBlock = Array.isArray(content) ? content.find((b) => b.type === 'text') : null;
  return !!(textBlock && typeof textBlock.text === 'string' && textBlock.text.includes('extracting structured data'));
}

// Installs a mock messages.create keyed by a discriminator so identify /
// compliance / extraction calls (all routed through the same anthropic
// client inside scan-contract.js) can be answered differently. Returns a
// restore function.
function mockAnthropicCreate(router) {
  const proto = Object.getPrototypeOf(new Anthropic({ apiKey: 'x' }).messages);
  const original = proto.create;
  proto.create = async function mockedCreate(params) {
    return router(params);
  };
  return () => { proto.create = original; };
}

async function main() {
  console.log('scan-contract truncation regression — production 2026-09-29 all-fields-null bug');
  console.log('=========================================================================================');

  const scanner = require(SCAN_CONTRACT_PATH);
  assert.strictEqual(typeof scanner.scanContract, 'function', 'scanContract must be exported');
  assert.strictEqual(typeof scanner.runFullScan, 'function', 'runFullScan must be exported');
  assert.strictEqual(typeof scanner.repairTruncatedJson, 'function', 'repairTruncatedJson must be exported');

  // validatePdfBase64() requires >100 chars and a decoded %PDF- header —
  // pad well past the minimum with filler bytes.
  const dummyPdf = Buffer.from('%PDF-1.4\n' + '0'.repeat(200)).toString('base64');

  // --- 1. Clean, well-formed response -> success:true, real data --------------
  {
    const restore = mockAnthropicCreate((params) => {
      // The extraction call is the only one that disables thinking — see
      // EXTRACT_MAX_TOKENS comment in scan-contract.js.
      if (params.thinking && params.thinking.type === 'disabled') {
        return textResponse({ extracted: GOOD_EXTRACTED, confidence: {}, warnings: [] });
      }
      return textResponse({ documentType: 'trec-20-17', confidence: 0.99 });
    });
    try {
      const result = await scanner.scanContract(dummyPdf);
      assert.strictEqual(result.success, true, 'clean parse must report success:true');
      assert.strictEqual(result.extracted.salePrice, 315000);
      assert.strictEqual(result.extracted.earnestMoney, 3000);
      assert.strictEqual(result.extracted.closingDate, '2026-10-29');
      console.log('  [PASS] clean response -> success:true, fields populated');
    } finally {
      restore();
    }
  }

  // --- 2. Thinking exhausts the whole budget, zero text (2026-09-29 shape) ----
  {
    const restore = mockAnthropicCreate(() => thinkingOnlyResponse());
    try {
      const result = await scanner.scanContract(dummyPdf);
      assert.strictEqual(result.success, false, 'zero-text response must report success:false, never a silent success');
      assert.strictEqual(result.extracted.salePrice, null, 'no data was ever emitted — must be null, not a guess');
      assert.strictEqual(result.extracted.earnestMoney, null);
      assert.ok(
        result.warnings.some((w) => /could not be parsed as JSON/i.test(w)),
        'warnings must explain the failure for the caller/UI to surface'
      );
      console.log('  [PASS] thinking-exhausted-budget (zero text) -> success:false, all null, warning present — THE EXACT 2026-09-29 BUG, now caught');
    } finally {
      restore();
    }
  }

  // --- 3. Mid-object truncation with real data already emitted ----------------
  {
    // Mirrors the real production warning preview verbatim: partial fields
    // present, then the response is cut off before the object closes.
    const truncatedJson = '{"extracted": {"salePrice": 315000, "salePriceCash": 63000, '
      + '"salePriceFinanced": 252000, "earnestMoney": 3000, "closingDate": "2026-10-29", "ea';
    const restore = mockAnthropicCreate((params) => {
      if (params.thinking && params.thinking.type === 'disabled') {
        return textResponse(truncatedJson, { stop_reason: 'max_tokens' });
      }
      return textResponse({ documentType: 'trec-20-17', confidence: 0.99 });
    });
    try {
      const result = await scanner.scanContract(dummyPdf);
      assert.strictEqual(result.success, false, 'a repaired/partial parse must still report success:false — it is not a confirmed-complete read');
      // The whole point of the fix: fields emitted before the cutoff must
      // SURVIVE, not be discarded to null along with the truncated tail.
      assert.strictEqual(result.extracted.salePrice, 315000, 'real data before the cutoff must be preserved, not wiped to null');
      assert.strictEqual(result.extracted.salePriceCash, 63000);
      assert.strictEqual(result.extracted.salePriceFinanced, 252000);
      assert.strictEqual(result.extracted.earnestMoney, 3000);
      assert.strictEqual(result.extracted.closingDate, '2026-10-29');
      assert.ok(
        result.warnings.some((w) => /truncated/i.test(w)),
        'a warning must flag that this was a repaired/partial read, not a clean one'
      );
      console.log('  [PASS] mid-object truncation -> success:false but real pre-cutoff fields preserved (not discarded wholesale)');
    } finally {
      restore();
    }
  }

  // --- 4. Not JSON at all -> success:false, nothing to recover ----------------
  {
    const restore = mockAnthropicCreate((params) => {
      if (params.thinking && params.thinking.type === 'disabled') {
        return textResponse('Sorry, I cannot process this document.', { stop_reason: 'end_turn' });
      }
      return textResponse({ documentType: 'trec-20-17', confidence: 0.99 });
    });
    try {
      const result = await scanner.scanContract(dummyPdf);
      assert.strictEqual(result.success, false);
      assert.strictEqual(result.extracted.salePrice, null);
      console.log('  [PASS] non-JSON response -> success:false, all fields genuinely null');
    } finally {
      restore();
    }
  }

  // --- 5. runFullScan() surfaces extractionFailed for trec-20-17 only ---------
  // 300, not 200 — identifyDocument's real budget since the 2026-10-01 fix
  // (was a stale 200 here, which meant this branch never matched and the
  // identify call fell through to the audit-shaped response below,
  // silently passing this test for the wrong reason until the
  // isExtractionCall() split above made the bug visible).
  {
    const restore = mockAnthropicCreate((params) => {
      if (params.max_tokens === 300) {
        return textResponse({ documentType: 'trec-20-17', confidence: 0.99 }); // identify
      }
      if (isExtractionCall(params)) {
        return thinkingOnlyResponse(); // extraction fails
      }
      return textResponse({ passed: true, missingSignatures: [], missingInitials: [], blankRequiredFields: [], checkedAddenda: [], missingAddenda: [], extractedFields: {}, warnings: [], summary: 'ok' }); // audit
    });
    try {
      const result = await scanner.runFullScan(dummyPdf);
      assert.strictEqual(result.documentType, 'trec-20-17');
      assert.strictEqual(result.extractionFailed, true, 'extraction failure on a trec-20-17 must be visible on the top-level result, not just buried in warnings');
      console.log('  [PASS] runFullScan() sets extractionFailed:true when extraction fails on a trec-20-17');
    } finally {
      restore();
    }
  }
  {
    const restore = mockAnthropicCreate((params) => {
      if (params.max_tokens === 300) {
        return textResponse({ documentType: 'iabs-form', confidence: 0.95 }); // identify — not trec-20-17
      }
      return textResponse({ passed: true, missingSignatures: [], missingInitials: [], blankRequiredFields: [], checkedAddenda: [], missingAddenda: [], extractedFields: {}, warnings: [], summary: 'ok' }); // audit
    });
    try {
      const result = await scanner.runFullScan(dummyPdf);
      assert.strictEqual(result.documentType, 'iabs-form');
      assert.strictEqual(result.extractionFailed, false, 'extraction never runs for non-trec-20-17 docs — that is expected, not a failure');
      console.log('  [PASS] runFullScan() leaves extractionFailed:false for a document type extraction never applies to');
    } finally {
      restore();
    }
  }

  // --- 7. auditCompliance(): clean response -> real findings, not a truncation ---
  {
    const restore = mockAnthropicCreate(() => textResponse({
      passed: false,
      missingSignatures: ['Buyer signature missing on signature page'],
      missingInitials: ['page 3 - seller initials missing'],
      blankRequiredFields: ['Option Fee (Paragraph 23)'],
      checkedAddenda: ['Third Party Financing Addendum'],
      missingAddenda: [],
      warnings: [],
      summary: 'Missing buyer signature and option fee.',
    }));
    try {
      const report = await scanner.auditCompliance(dummyPdf, 'trec-20-17');
      assert.strictEqual(report.auditNotPerformed, false, 'a clean, fully-parsed response is a completed audit');
      assert.strictEqual(report.passed, false);
      assert.strictEqual(report.missingSignatures.length, 1);
      assert.strictEqual(report.blankRequiredFields.length, 1);
      console.log('  [PASS] auditCompliance() clean response -> real findings, auditNotPerformed:false');
    } finally {
      restore();
    }
  }

  // --- 8. auditCompliance(): thinking exhausts the whole budget, zero text ----
  // THE 2026-10-05 BUG: this call never disabled thinking, so claude-sonnet-5
  // could spend the entire max_tokens budget reasoning and emit no JSON at
  // all — reproduced live 2 of 5 real runs against production. Must never
  // render as a pass.
  {
    const restore = mockAnthropicCreate(() => thinkingOnlyResponse());
    try {
      const report = await scanner.auditCompliance(dummyPdf, 'trec-20-17');
      assert.strictEqual(report.passed, false, 'a response with zero parseable JSON must never report passed:true');
      assert.strictEqual(report.auditNotPerformed, true, 'the audit did not complete — it must say so, not render a quiet pass');
      assert.strictEqual(report.missingSignatures.length, 0);
      console.log('  [PASS] auditCompliance() thinking-exhausted-budget (zero text) -> auditNotPerformed:true, never a pass — THE 2026-10-05 BUG, now caught');
    } finally {
      restore();
    }
  }

  // --- 9. auditCompliance(): mid-object truncation with real findings emitted -
  // Mirrors the real production shape: some arrays made it through fully
  // before the cutoff. Those findings must survive (not be discarded
  // wholesale), but the report as a whole must still never claim to have
  // passed — a partial read is not a confirmed-clean contract.
  {
    const truncatedJson = '{"passed": true, "missingSignatures": ["Buyer signature missing on signature page"], '
      + '"missingInitials": ["page 3 - seller initials missing", "page 4 - buyer initials mis';
    const restore = mockAnthropicCreate(() => textResponse(truncatedJson, { stop_reason: 'max_tokens' }));
    try {
      const report = await scanner.auditCompliance(dummyPdf, 'trec-20-17');
      assert.strictEqual(report.passed, false, 'passed must be forced false on a truncated response, even though the model emitted "passed": true before the cutoff');
      assert.strictEqual(report.auditNotPerformed, true, 'a truncated audit is an incomplete audit — must say so');
      assert.strictEqual(report.missingSignatures.length, 1, 'the one fully-emitted finding before the cutoff must survive');
      assert.strictEqual(report.missingSignatures[0], 'Buyer signature missing on signature page');
      assert.ok(
        report.warnings.some((w) => /cut short|incomplete/i.test(w)),
        'a warning must tell the member this audit did not finish'
      );
      console.log('  [PASS] auditCompliance() mid-object truncation -> findings before cutoff preserved, but never a pass');
    } finally {
      restore();
    }
  }

  // --- 10. auditCompliance(): not JSON at all -> empty report, never a pass ---
  {
    const restore = mockAnthropicCreate(() => textResponse('Sorry, I cannot process this document.', { stop_reason: 'end_turn' }));
    try {
      const report = await scanner.auditCompliance(dummyPdf, 'trec-20-17');
      assert.strictEqual(report.passed, false);
      assert.strictEqual(report.auditNotPerformed, true);
      console.log('  [PASS] auditCompliance() non-JSON response -> empty report, auditNotPerformed:true, never a pass');
    } finally {
      restore();
    }
  }

  console.log('=========================================================================================');
  console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FAIL:', err && err.stack || err);
  process.exit(1);
});
