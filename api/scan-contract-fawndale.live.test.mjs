// api/scan-contract-fawndale.live.test.mjs
//
// THE acceptance test for the money-stack extraction added to
// api/scan-contract.js (2026-09-29) — runs the REAL 702 Fawndale offer PDF
// through the REAL Anthropic model, no mocking. This is what actually proves
// the extraction works against a real document, not just that the parsing
// code is wired correctly (that's api/scan-contract-money-stack.mock.test.mjs).
//
// REQUIRES:
//   1. ANTHROPIC_API_KEY in the environment. Local dev envs are empty by
//      design (CLAUDE.md) — run this against Vercel/CI where the key lives,
//      or export it locally for a one-off run.
//   2. The actual contract PDF at the path below. It is Heath's personal
//      financial document and is NEVER committed to this public repo — copy
//      it in locally before running:
//        mkdir -p .tmp/fixtures/fawndale-offer
//        cp "<path to>/One to Four Family Residential Contract (Resale) (TXR 1601  TREC 20-19) (3).pdf" \
//           .tmp/fixtures/fawndale-offer/contract.pdf
//      .tmp/ is already gitignored (see .gitignore) — nothing here needs a
//      new ignore rule.
//
// Pass criteria — the exact ground truth from the real document: price
// 315,000 / concession 5,000 / BAC 3% / service contract 800 / closing
// 10/29/2026 / option 10 days / earnest 3,000 / option fee 100. Per the task
// this test was written for: "Anything it misses on that document is a
// failure."
//
// Run with:  node api/scan-contract-fawndale.live.test.mjs

import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const handler = require('./scan-contract.js');
const { runFullScan } = handler;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PDF_PATH = resolve(__dirname, '..', '.tmp', 'fixtures', 'fawndale-offer', 'contract.pdf');

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('SKIPPED: ANTHROPIC_API_KEY env var is not set. This test requires the real Anthropic API — see file header for how to run it.');
    process.exit(1);
  }

  try {
    await access(PDF_PATH);
  } catch {
    console.error(`SKIPPED: fixture not found at ${PDF_PATH}. See file header for how to copy it in locally (never committed).`);
    process.exit(1);
  }

  console.log('Reading PDF from:', PDF_PATH);
  const pdfBuffer = await readFile(PDF_PATH);
  const pdfBase64 = pdfBuffer.toString('base64');
  console.log(`PDF loaded: ${pdfBuffer.length} bytes -> ${pdfBase64.length} base64 chars`);

  const startedAt = Date.now();
  const result = await runFullScan(pdfBase64);
  console.log(`Scan completed in ${Date.now() - startedAt}ms`);

  const e = result.extracted || {};
  const ms = e.moneyStack || {};

  console.log('\n----- extracted (money-stack fields) -----');
  console.log(JSON.stringify({
    salePrice: e.salePrice,
    salePriceCash: e.salePriceCash,
    salePriceFinanced: e.salePriceFinanced,
    earnestMoney: e.earnestMoney,
    optionFee: e.optionFee,
    optionDays: e.optionDays,
    closingDate: e.closingDate,
    serviceContractCap: e.serviceContractCap,
    paragraph12Expenses: e.paragraph12Expenses,
    paragraph12BuyerBrokerComp: e.paragraph12BuyerBrokerComp,
    paragraph12SellerBrokerComp: e.paragraph12SellerBrokerComp,
    titlePolicyPayer: e.titlePolicyPayer,
    surveyPayer: e.surveyPayer,
    hasSpecialProvisions: e.hasSpecialProvisions,
  }, null, 2));
  console.log('----- moneyStack -----');
  console.log(JSON.stringify(ms, null, 2));
  console.log('----- end -----\n');

  const checks = [
    ['documentType', result.documentType, 'trec-20-17'],
    ['salePrice', e.salePrice, 315000],
    ['paragraph12Expenses.sellerPaysAmount (¶12A(1)(b) concession)', e.paragraph12Expenses && e.paragraph12Expenses.sellerPaysAmount, 5000],
    ['paragraph12BuyerBrokerComp.percentage (¶12B(1) BAC)', e.paragraph12BuyerBrokerComp && e.paragraph12BuyerBrokerComp.percentage, 3],
    ['serviceContractCap (¶7H)', e.serviceContractCap, 800],
    ['closingDate (¶9A)', e.closingDate, '2026-10-29'],
    ['optionDays', e.optionDays, 10],
    ['earnestMoney', e.earnestMoney, 3000],
    ['optionFee', e.optionFee, 100],
  ];

  const failures = [];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  if (ms.sellerConcessionToBuyerExpenses && ms.sellerConcessionToBuyerExpenses.value) {
    const giveback = ms.sellerConcessionToBuyerExpenses.value
      + (ms.salesPrice.value * ((ms.buyerBrokerCompensation && ms.buyerBrokerCompensation.value || 0) / 100))
      + (ms.residentialServiceContractCap && ms.residentialServiceContractCap.value || 0);
    console.log(`Total seller giveback: $${giveback.toLocaleString()} (expected $15,250)`);
    if (giveback !== 15250) failures.push(`total giveback: expected 15250, got ${giveback}`);
  }

  if (failures.length) {
    console.error('TEST FAILED — anything missed on this real document is a failure per the task spec:');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }

  console.log('TEST PASSED: real 702 Fawndale offer extracted every money-stack figure correctly.');
}

main().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
