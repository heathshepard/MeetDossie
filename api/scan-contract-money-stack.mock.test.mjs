// api/scan-contract-money-stack.mock.test.mjs
//
// Deterministic, no-API-key regression test for the money-stack extraction
// added to api/scan-contract.js (2026-09-29 — 702 Fawndale). Stubs
// @anthropic-ai/sdk's messages.create() with canned responses shaped after
// the REAL Fawndale offer's verbatim paragraph text, so this test proves the
// PARSING code (prompt schema -> deterministic backstops -> moneyStack
// assembly) end to end without needing ANTHROPIC_API_KEY or network access.
//
// It deliberately makes the MODEL's own self-reported values wrong or null
// on several money-stack fields (serviceContractCap, paragraph12Expenses.
// sellerPaysAmount, optionDays) while the verbatim debug* text is correct —
// exactly the real failure mode this whole extension exists for (a model
// missing a filled-in dollar blank) — to prove the deterministic backstops,
// not the model's raw read, are what the API actually returns.
//
// This is NOT a substitute for scan-contract-fawndale.live.test.mjs, which
// runs the real PDF through the real model and is the actual acceptance
// test named in the task. That test requires ANTHROPIC_API_KEY (present in
// Vercel, not in this sandbox by design — see CLAUDE.md "local env mostly
// empty by design").
//
// Run with: node api/scan-contract-money-stack.mock.test.mjs

import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const anthropicSdkPath = require.resolve('@anthropic-ai/sdk');

// The REAL verbatim paragraph shapes we expect the model to return for the
// 702 Fawndale offer, constructed from the task's stated ground truth:
// price 315,000 / concession 5,000 / BAC 3% / service contract 800 /
// closing 10/29/2026 / option 10 days / earnest 3,000 / option fee 100.
const FAWNDALE_EXTRACTED = {
  propertyAddress: '702 Fawndale',
  cityStateZip: 'San Antonio, TX 78228',
  buyerName: 'Test Buyer',
  sellerName: 'Heath Shepard',
  salePrice: 315000,
  salePriceCash: null, // deliberately wrong/missing — backstop parses debugParagraph3C
  salePriceFinanced: null,
  earnestMoney: null, // deliberately wrong — backstop parses debugParagraph5A
  optionFee: null, // deliberately wrong — backstop parses debugParagraph5B
  optionDays: 7, // deliberately WRONG — backstop must correct to 10 from debugParagraph5B
  contractEffectiveDate: '2026-09-19',
  closingDate: '2026-10-29',
  debugParagraph3C: '3A. $ 15,000.00   3B. $ 300,000.00   3C. Sales Price (Sum of A and B): $ 315,000.00',
  debugParagraph5A: 'Buyer shall deposit $ 3,000.00 as earnest money with escrow agent University Title, 123 Main St, San Antonio, TX 78216 no later than 3 days after the effective date.',
  debugParagraph5B: 'Buyer may terminate this contract within 10 days after the Effective Date of this contract (Option Period) by giving notice of termination to Seller. Buyer must pay Seller $ 100.00 (Option Fee) within 3 days after the effective date.',
  debugParagraph6A: "Seller shall furnish to Buyer at [X] Seller's [ ] Buyer's expense an Owner Policy of Title Insurance.",
  debugParagraph6C: '[X] (1) Within 10 days after the Effective Date of this contract, Seller shall furnish to Buyer and Title Company Seller\'s existing survey of the Property. If the Title Company or Buyer\'s lender does not accept the existing survey, Buyer shall obtain a new survey at [ ] Seller\'s [X] Buyer\'s expense no later than 3 days prior to Closing Date.\n[ ] (2) Within _____ days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer\'s expense.\n[ ] (3) Within _____ days after the Effective Date of this contract, Seller, at Seller\'s expense shall furnish a new survey to Buyer.',
  debugParagraph7H: 'Buyer may purchase a residential service contract from a company licensed by TREC. Seller shall pay, at closing, [X] an amount not to exceed $800.00 for such a contract.',
  serviceContractCap: null, // deliberately wrong — backstop parses debugParagraph7H
  paragraph7HomeWarranty: 'Seller to pay up to $800 toward a home warranty Buyer purchases',
  debugParagraph12A: "12A(1)(b) Seller's Expenses (Buyer's Expenses): An amount not to exceed $ 5,000.00 to be applied to Buyer's Expenses.",
  debugParagraph12B: '12B(1) At closing, Seller shall pay Other Broker named in Paragraph 21 a fee of [ ] $_____ or [X] 3.000 % of the Sales Price. 12B(2) At closing, Buyer shall pay Other Broker named in Paragraph 21 a fee of [ ] $_____ or [ ] _____% of the Sales Price.',
  paragraph12Expenses: { sellerPaysAmount: null, sellerPaysPercentage: null, buyerPaysClosingCosts: true }, // deliberately wrong — backstop parses debugParagraph12A
  paragraph12BuyerBrokerComp: { amount: 999999, percentage: 999 }, // deliberately WRONG — must be force-reset then correctly re-derived from debugParagraph12B
  paragraph12SellerBrokerComp: { amount: 1, percentage: 1 }, // deliberately WRONG — must be force-reset to null,null (12B(2) is unchecked)
  titlePolicyPayer: 'Buyer', // deliberately WRONG — must be force-reset then correctly re-derived as 'Seller' from debugParagraph6A
  paragraph11SpecialProvisions: null,
  paragraph5: { earnestMoneyHolder: 'University Title', earnestMoneyDeadlineDays: 3, additionalEarnestMoney: null, additionalEarnestMoneyDate: null },
  paragraph23TerminationOption: { optionDays: 7, optionFee: null, optionFeePayableTo: 'Seller' },
};

async function fakeCreate(params) {
  const content = (params.messages && params.messages[0] && params.messages[0].content) || [];
  const textBlock = Array.isArray(content) ? content.find((c) => c.type === 'text') : null;
  const promptText = textBlock ? textBlock.text : '';

  let responseObj;
  if (/Identify this document type precisely/.test(promptText)) {
    responseObj = { documentType: 'trec-20-17', confidence: 0.97, reasoning: 'Mock: One to Four Family Residential Contract' };
  } else if (/You are extracting structured data/.test(promptText)) {
    responseObj = { extracted: FAWNDALE_EXTRACTED, confidence: {}, warnings: [] };
  } else {
    // auditCompliance call
    responseObj = { passed: true, missingSignatures: [], missingInitials: [], blankRequiredFields: [], checkedAddenda: [], missingAddenda: [], warnings: [], summary: 'mock compliance pass' };
  }
  return { content: [{ type: 'text', text: JSON.stringify(responseObj) }] };
}

class FakeAnthropic {
  constructor() {
    this.messages = { create: fakeCreate };
  }
}

// Inject the fake BEFORE scan-contract.js requires the real SDK.
require.cache[anthropicSdkPath] = {
  id: anthropicSdkPath,
  filename: anthropicSdkPath,
  loaded: true,
  exports: FakeAnthropic,
};

process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-mock-not-a-real-key';

const handler = require('./scan-contract.js');
const { runFullScan } = handler;

async function main() {
  // Any string starting with %PDF- and long enough to pass validatePdfBase64
  // — the fake never actually reads it, but validation still runs.
  const fakePdfBytes = Buffer.from('%PDF-1.4\n' + '0'.repeat(200) + '\n%%EOF');
  const pdfBase64 = fakePdfBytes.toString('base64');

  const result = await runFullScan(pdfBase64);
  const e = result.extracted;

  assert.equal(result.documentType, 'trec-20-17', 'documentType');
  assert.ok(e, 'extracted object present');

  const checks = [
    ['salePrice', e.salePrice, 315000],
    ['salePriceCash (backstop from debugParagraph3C)', e.salePriceCash, 15000],
    ['salePriceFinanced (backstop from debugParagraph3C)', e.salePriceFinanced, 300000],
    ['earnestMoney (backstop from debugParagraph5A)', e.earnestMoney, 3000],
    ['optionFee (backstop from debugParagraph5B)', e.optionFee, 100],
    ['optionDays (backstop corrects model\'s wrong 7 -> 10)', e.optionDays, 10],
    ['closingDate', e.closingDate, '2026-10-29'],
    ['serviceContractCap (backstop from debugParagraph7H)', e.serviceContractCap, 800],
    ['paragraph12Expenses.sellerPaysAmount (backstop from debugParagraph12A)', e.paragraph12Expenses.sellerPaysAmount, 5000],
    ['paragraph12BuyerBrokerComp.percentage (¶12B(1), force-reset then re-derived)', e.paragraph12BuyerBrokerComp.percentage, 3],
    ['paragraph12BuyerBrokerComp.amount (must stay null when % is checked)', e.paragraph12BuyerBrokerComp.amount, null],
    ['paragraph12SellerBrokerComp.amount (¶12B(2) unchecked -> force-reset to null)', e.paragraph12SellerBrokerComp.amount, null],
    ['paragraph12SellerBrokerComp.percentage (¶12B(2) unchecked -> force-reset to null)', e.paragraph12SellerBrokerComp.percentage, null],
    ['titlePolicyPayer (force-reset then re-derived from debugParagraph6A)', e.titlePolicyPayer, 'Seller'],
    ['sellerProvidesSurvey (¶6C option 1 checked)', e.sellerProvidesSurvey, true],
    ['hasSpecialProvisions (¶11 blank -> false)', e.hasSpecialProvisions, false],
  ];

  const failures = [];
  for (const [label, actual, expected] of checks) {
    if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }

  // moneyStack assembly — spot-check the fields that matter most, including
  // paragraph citation and a non-zero confidence (deterministic backstops
  // set confidence to 1.0).
  const ms = e.moneyStack;
  if (!ms) failures.push('moneyStack object missing from extracted result');
  else {
    const msChecks = [
      ['moneyStack.salesPrice.value', ms.salesPrice.value, 315000],
      ['moneyStack.salesPrice.paragraph', ms.salesPrice.paragraph, '3C'],
      ['moneyStack.sellerConcessionToBuyerExpenses.value', ms.sellerConcessionToBuyerExpenses.value, 5000],
      ['moneyStack.sellerConcessionToBuyerExpenses.paragraph', ms.sellerConcessionToBuyerExpenses.paragraph, '12A(1)(b)'],
      ['moneyStack.sellerConcessionToBuyerExpenses.confidence', ms.sellerConcessionToBuyerExpenses.confidence, 1.0],
      ['moneyStack.buyerBrokerCompensation.value', ms.buyerBrokerCompensation.value, 3],
      ['moneyStack.buyerBrokerCompensation.mode', ms.buyerBrokerCompensation.mode, 'percent'],
      ['moneyStack.buyerBrokerCompensation.paragraph', ms.buyerBrokerCompensation.paragraph, '12B(1)'],
      ['moneyStack.residentialServiceContractCap.value', ms.residentialServiceContractCap.value, 800],
      ['moneyStack.residentialServiceContractCap.paragraph', ms.residentialServiceContractCap.paragraph, '7H'],
      ['moneyStack.titlePolicyPayer.value', ms.titlePolicyPayer.value, 'Seller'],
      ['moneyStack.closingDate.value', ms.closingDate.value, '2026-10-29'],
      ['moneyStack.specialProvisions.flagged', ms.specialProvisions.flagged, false],
    ];
    for (const [label, actual, expected] of msChecks) {
      if (actual !== expected) failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }

  // The exact arithmetic from the task: 5000 + (3% of 315000 = 9450) + 800 = 15250.
  const giveback = (ms.sellerConcessionToBuyerExpenses.value || 0)
    + (ms.salesPrice.value * (ms.buyerBrokerCompensation.value / 100))
    + (ms.residentialServiceContractCap.value || 0);
  if (giveback !== 15250) failures.push(`total giveback: expected 15250, got ${giveback}`);

  if (failures.length) {
    console.error('TEST FAILED:');
    for (const f of failures) console.error('  -', f);
    console.error('\nFull extracted.moneyStack:', JSON.stringify(ms, null, 2));
    process.exit(1);
  }

  console.log('TEST PASSED: money-stack extraction + deterministic backstops + moneyStack assembly all verified against mocked Fawndale-shaped input.');
  console.log(`Total seller giveback surfaced: $${giveback.toLocaleString()} ($5,000 concession + $9,450 BAC(3%) + $800 service contract)`);
}

main().catch((err) => {
  console.error('TEST CRASHED:', err);
  process.exit(1);
});
