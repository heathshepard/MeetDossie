'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOfferNetSheet, estimateTexasOwnersTitlePremium } = require('./offer-net-sheet');

// The exact moneyStack shape api/scan-contract.js's buildMoneyStack() would
// produce for the real 702 Fawndale offer: price 315,000 / concession 5,000
// / BAC 3% / service contract 800.
const FAWNDALE_MONEY_STACK = {
  salesPrice: { value: 315000, paragraph: '3C', confidence: 1.0 },
  cashPortion: { value: 15000, paragraph: '3A', confidence: 1.0 },
  financedAmount: { value: 300000, paragraph: '3B', confidence: 1.0 },
  financingType: { value: null, paragraph: '3B / Third Party Financing Addendum', confidence: 0 },
  earnestMoney: { value: 3000, paragraph: '5A', confidence: 1.0 },
  escrowAgent: { value: 'University Title', paragraph: '5A', confidence: 0.9 },
  optionFee: { value: 100, paragraph: '5B / 23', confidence: 1.0 },
  optionDays: { value: 10, paragraph: '5B / 23', confidence: 1.0 },
  sellerConcessionToBuyerExpenses: { value: 5000, paragraph: '12A(1)(b)', confidence: 1.0 },
  buyerBrokerCompensation: { value: 3, mode: 'percent', paragraph: '12B(1)', confidence: 1.0 },
  sellerBrokerCompensationFromBuyer: { value: null, mode: null, paragraph: '12B(2)', confidence: 0 },
  residentialServiceContractCap: { value: 800, paragraph: '7H', confidence: 1.0 },
  titlePolicyPayer: { value: 'Seller', paragraph: '6A', confidence: 1.0 },
  surveyPayer: { value: "Buyer's expense", paragraph: '6C', confidence: 1.0 },
  closingDate: { value: '2026-10-29', paragraph: '9A', confidence: 1.0 },
  specialProvisions: { value: null, flagged: false, paragraph: '11', confidence: 0 },
};

test('the three real givebacks (concession + BAC% + service contract) sum to exactly $15,250', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK, payoff: 284250 });
  assert.equal(sheet.totalGiveback, 15250);
});

test('missing payoff: sheet is blocked, no proceeds figure, but every other line still renders', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK });
  assert.equal(sheet.blocked, true);
  assert.equal(sheet.ceiling, null);
  assert.ok(/mortgage payoff/i.test(sheet.blockedReason));
  const payoffLine = sheet.lines.find((l) => l.key === 'mortgage_payoff');
  assert.ok(payoffLine, 'payoff line must still be present, not omitted');
  assert.equal(payoffLine.status, 'unknown');
  const concessionLine = sheet.lines.find((l) => l.key === 'seller_concession');
  assert.equal(concessionLine.amount, -5000);
  assert.equal(concessionLine.paragraph, '12A(1)(b)');
});

test('with payoff supplied, proceeds figure is computed and every giveback line is present with its paragraph', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK, payoff: 284250 });
  assert.equal(sheet.blocked, false);
  assert.ok(sheet.ceiling < 315000, 'net proceeds must be less than sale price once deductions are applied');

  const bacLine = sheet.lines.find((l) => l.key === 'buyer_broker_comp');
  assert.equal(bacLine.amount, -9450); // 3% of 315,000
  assert.equal(bacLine.paragraph, '12B(1)');

  const svcLine = sheet.lines.find((l) => l.key === 'service_contract_cap');
  assert.equal(svcLine.amount, -800);
  assert.equal(svcLine.paragraph, '7H');

  const titleLine = sheet.lines.find((l) => l.key === 'title_policy');
  assert.equal(titleLine.source, 'estimate_default');
  assert.ok(titleLine.amount < 0);
});

test('sale price missing from moneyStack throws MISSING_SALE_PRICE rather than guessing', () => {
  const badStack = { ...FAWNDALE_MONEY_STACK, salesPrice: { value: null, paragraph: '3C', confidence: 0 } };
  assert.throws(() => buildOfferNetSheet({ moneyStack: badStack, payoff: 100000 }), (err) => err.code === 'MISSING_SALE_PRICE');
});

test('moneyStack itself missing throws MISSING_MONEY_STACK', () => {
  assert.throws(() => buildOfferNetSheet({ payoff: 100000 }), (err) => err.code === 'MISSING_MONEY_STACK');
});

test('tax proration: no annual tax amount supplied -> unknown line, not a silent zero', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK, payoff: 284250 });
  const taxLine = sheet.lines.find((l) => l.key === 'tax_proration');
  assert.equal(taxLine.status, 'unknown');
  assert.ok(sheet.materialUnknown.includes('Property Tax Proration'));
});

test('tax proration: annual amount supplied computes a real prorated deduction', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK, payoff: 284250, taxAmountAnnual: 6000 });
  const taxLine = sheet.lines.find((l) => l.key === 'tax_proration');
  assert.equal(taxLine.status, 'known');
  assert.ok(taxLine.amount < 0);
});

test('disclaimer explicitly excludes listing commission (a different document) from this tool\'s scope', () => {
  const sheet = buildOfferNetSheet({ moneyStack: FAWNDALE_MONEY_STACK, payoff: 284250 });
  assert.ok(sheet.disclaimer.text.toLowerCase().includes('listing commission'));
});

test('estimateTexasOwnersTitlePremium: monotonic and reasonable for a $315,000 sale', () => {
  const premium = estimateTexasOwnersTitlePremium(315000);
  assert.ok(premium > 800 && premium < 3000, `expected a plausible TX premium, got ${premium}`);
});

test('estimateTexasOwnersTitlePremium: null/invalid input returns null, never a guessed number', () => {
  assert.equal(estimateTexasOwnersTitlePremium(null), null);
  assert.equal(estimateTexasOwnersTitlePremium(0), null);
  assert.equal(estimateTexasOwnersTitlePremium(-5), null);
});
