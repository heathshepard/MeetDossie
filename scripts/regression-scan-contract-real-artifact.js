#!/usr/bin/env node
'use strict';

/**
 * scripts/regression-scan-contract-real-artifact.js
 *
 * THE CHECK THAT WOULD HAVE CAUGHT THE 2026-09-29 PRODUCTION REGRESSION.
 *
 * scripts/regression-scan-contract-truncation.js (added the same day as the
 * fix) mocks Messages.prototype.create and proves the JSON-repair /
 * success:false logic is correct in isolation. That is necessary but not
 * sufficient: the actual production failure was that a REAL Anthropic API
 * call against a REAL multi-page PDF truncated mid-JSON at max_tokens=4096
 * — a live model behavior a mock can only simulate by assumption, never
 * discover. Every mock test was green while production returned every
 * field null with ok:true, HTTP 200, no error, no alarm.
 *
 * This script closes that gap: it runs scanContract() — the real function,
 * unmocked — against a real, committed, 12-page synthetic PDF, with a real
 * Anthropic API call, and asserts specific known values landed correctly.
 * An all-null result with success:true FAILS this check. That exact shape
 * is the regression.
 *
 * FIXTURE: scripts/fixtures/synthetic-trec-20-19-money-stack.pdf — a fully
 * SYNTHETIC TREC 20-19 (12 pages, matching the page count that triggered
 * the real truncation) built by
 * scripts/generate-fixture-trec-20-19-money-stack.js using the exact same
 * production fill pipeline (api/_lib/fill-trec-20-19.js's fillTrec2019())
 * that renders real member contracts, seeded onto the blank template asset
 * already committed at api/_assets/trec-resale-20-19-base64.js. Every name,
 * address, and dollar figure in it is invented for this fixture — no real
 * transaction, no personal data. Ground truth lives alongside it in
 * scripts/fixtures/synthetic-trec-20-19-money-stack.expected.json, kept as
 * a separate hand-maintained file (not derived from the same generator
 * inputs) so a bug that mis-sets both the input and the expectation the
 * same wrong way can't silently self-cancel.
 *
 * A synthetic fixture was chosen over the two alternatives Heath asked
 * this file to weigh:
 *   - The real document that surfaced the bug (Heath's own financial data,
 *     .tmp/fixtures/fawndale-offer/contract.pdf) can never be committed —
 *     public repo, GitGuardian — so CI could never run against it at all.
 *   - A private-store-fetched fixture (e.g. a Supabase Storage download at
 *     CI time) would work but adds a second secret + network dependency to
 *     a gate whose whole point is to be simple enough to trust unattended.
 *   A synthetic fixture is committable, deterministic, carries no personal
 *   data, and — because it was built through the SAME production fill
 *   pipeline used for real contracts and render-verified field-by-field
 *   (pdftotext -layout against the output, matching the "read the widget
 *   rect and render the page" rule this codebase already lives by for
 *   AcroForm work) — its ground truth is as trustworthy as a real filed
 *   contract's, without being one.
 *
 * COST / LIVE-CALL DECISION (Heath asked this to be explicit, not buried):
 * this check makes a REAL Anthropic API call every time it runs — Sonnet,
 * ~5-8k output tokens, a few cents. That cost is unavoidable and
 * intentional: a recorded/mocked response CANNOT catch this exact bug
 * class, because the bug only exists in live model behavior (how a real
 * response gets tokenized and where it truncates under a real max_tokens
 * budget) — see regression-scan-contract-truncation.js's own header for
 * what the free, mocked tier already covers. To keep that real cost from
 * being paid on every unrelated merge (cron/social infra, docs, etc.),
 * scripts/auto-merge-test-suite.js only requires this script when the
 * staging/main diff touches the document/extraction pipeline (see
 * api/_lib/auto-merge-risk-gate.js's touchesDocumentPipeline()) — NOT on
 * every daily gate run.
 *
 * WHAT THIS CHECK CATCHES: the extraction schema truncating mid-JSON on
 * Haiku/Sonnet at an insufficient max_tokens (the exact 2026-09-29 shape),
 * any regression that causes scanContract() to silently return
 * success:true with a wiped/all-null extracted object, and any field-level
 * misread of the money-stack fields below on a real multi-page PDF.
 *
 * WHAT THIS CHECK DOES NOT CATCH: it exercises scanContract() directly, not
 * the /api/scan-contract HTTP handler or runFullScan()'s document-type
 * gating/compliance-audit merge logic (regression-scan-contract-
 * truncation.js's runFullScan()/extractionFailed-propagation tests cover
 * that, mocked). It also can't catch a regression that depends on some
 * OTHER real document's specific formatting/handwriting/OCR quirks this
 * synthetic fixture doesn't reproduce — it is one fixture, not a
 * corpus. And because Anthropic model responses are not perfectly
 * deterministic, a genuine (if unlikely) misread on an unrelated field
 * could occasionally cause a false-failure HOLD; that is an accepted
 * cost of testing against a live call at all (see the "recorded response"
 * tradeoff above) — a spurious HOLD costs a day, a false merge can ship a
 * broken document pipeline again.
 *
 * REQUIRES process.env.ANTHROPIC_API_KEY. If it's not set, this script
 * exits non-zero with a clear message — it does NOT skip-as-pass. A merge
 * gate that can't run this check must HOLD, not merge on faith.
 *
 * Run manually:
 *   ANTHROPIC_API_KEY=... node scripts/regression-scan-contract-real-artifact.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const FIXTURE_PDF = path.join(__dirname, 'fixtures', 'synthetic-trec-20-19-money-stack.pdf');
const FIXTURE_EXPECTED = path.join(__dirname, 'fixtures', 'synthetic-trec-20-19-money-stack.expected.json');

function fail(message) {
  console.error(`[regression-scan-contract-real-artifact] FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    // Explicit non-zero exit, explicit message — auto-merge-test-suite.js
    // treats any non-pass verdict here as red, and the gate workflow HOLDS
    // on red. This must never look like a skip or a pass.
    fail(
      'ANTHROPIC_API_KEY is not set in this environment. This check makes a ' +
      'real Anthropic API call and cannot run without it. The gate must ' +
      'HOLD, not merge on an unrun check — add ANTHROPIC_API_KEY as a ' +
      'GitHub Actions repo secret (Settings -> Secrets and variables -> ' +
      'Actions) for the staging-auto-merge-gate workflow.',
    );
    return;
  }

  if (!fs.existsSync(FIXTURE_PDF)) {
    fail(`Fixture PDF missing: ${FIXTURE_PDF}. Regenerate with node scripts/generate-fixture-trec-20-19-money-stack.js`);
    return;
  }
  if (!fs.existsSync(FIXTURE_EXPECTED)) {
    fail(`Fixture ground-truth JSON missing: ${FIXTURE_EXPECTED}`);
    return;
  }

  const pdfBase64 = fs.readFileSync(FIXTURE_PDF).toString('base64');
  const expected = JSON.parse(fs.readFileSync(FIXTURE_EXPECTED, 'utf8'));

  const { scanContract } = require('../api/scan-contract.js');

  console.log('[regression-scan-contract-real-artifact] calling scanContract() with a real Anthropic API call against the synthetic fixture...');
  const start = Date.now();
  const result = await scanContract(pdfBase64);
  const elapsedMs = Date.now() - start;
  console.log(`[regression-scan-contract-real-artifact] response in ${elapsedMs}ms`);

  // ── The regression-shape guard, checked FIRST and explicitly ──────────
  // This is the exact 2026-09-29 production shape: success:true reported
  // while the extraction is entirely empty. Check this before any
  // individual field assertion so the failure message names the actual
  // regression, not just "salePrice mismatch".
  const extracted = result && result.extracted;
  const nonNullFieldCount = extracted
    ? Object.values(extracted).filter((v) => v !== null && v !== undefined && v !== '').length
    : 0;
  if (result && result.success === true && nonNullFieldCount === 0) {
    fail(
      'scanContract() returned success:true with EVERY extracted field null/empty. ' +
      'This is the exact 2026-09-29 production regression shape (truncated/failed ' +
      'model response silently reported as a clean success). See the fix commit ' +
      '(fix(scan-contract): stop returning all-null extraction with ok:true) for ' +
      'the root cause this must never reintroduce.',
    );
    return;
  }

  if (!result || result.success !== true) {
    fail(
      `scanContract() reported success:${result && result.success} — extraction failed or was ` +
      `only partially recovered. warnings: ${JSON.stringify(result && result.warnings)}`,
    );
    return;
  }

  // ── Field-level ground-truth assertions ────────────────────────────────
  const checks = [
    ['salePrice', extracted.salePrice, expected.salePrice],
    ['salePriceCash', extracted.salePriceCash, expected.salePriceCash],
    ['salePriceFinanced', extracted.salePriceFinanced, expected.salePriceFinanced],
    ['earnestMoney', extracted.earnestMoney, expected.earnestMoney],
    ['optionFee', extracted.optionFee, expected.optionFee],
    ['optionDays', extracted.optionDays, expected.optionDays],
    ['closingDate', extracted.closingDate, expected.closingDate],
    ['hasSpecialProvisions', extracted.hasSpecialProvisions, expected.hasSpecialProvisions],
    ['serviceContractCap', extracted.serviceContractCap, expected.serviceContractCap],
    [
      'paragraph12BuyerBrokerComp.percentage',
      extracted.paragraph12BuyerBrokerComp && extracted.paragraph12BuyerBrokerComp.percentage,
      expected.paragraph12BuyerBrokerCompPct,
    ],
  ];

  const failures = [];
  for (const [name, actual, want] of checks) {
    if (actual !== want) {
      failures.push(`  ${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`);
    }
  }

  if (failures.length > 0) {
    fail(`field mismatch(es) against the synthetic fixture's known ground truth:\n${failures.join('\n')}`);
    return;
  }

  console.log('[regression-scan-contract-real-artifact] PASS — all ground-truth fields matched on a real API call.');
  for (const [name, actual] of checks) {
    console.log(`  ${name}: ${JSON.stringify(actual)}`);
  }
}

main().catch((e) => {
  console.error('[regression-scan-contract-real-artifact] unexpected error:', e && e.stack || e);
  process.exit(1);
});
