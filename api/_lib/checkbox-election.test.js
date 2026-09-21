'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCheckedOption } = require('./checkbox-election');

// The real verbatim shape captured off 23 Nopalito's actual executed
// contract (¶6C, page 3 of the TREC 20-19) — box (1) is checked, confirmed
// by rendering the page directly, not inferring from a field name.
const NOPALITO_PARAGRAPH_6C = `[X] (1) Within 14 days after the Effective Date of this contract, Seller shall furnish to Buyer and Title Company Seller's existing survey of the Property and a Residential Real Property Affidavit or Declaration promulgated by the Texas Department of Insurance (T-47 Affidavit or T-47.1 Declaration). Buyer shall obtain a new survey at Seller's expense no later than 3 days prior to Closing Date if Seller fails to furnish within the time prescribed both: (i) existing survey; and (ii) affidavit or declaration. If the Title Company or Buyer's lender does not accept the existing survey, or the affidavit or declaration, Buyer shall obtain a new survey at [ ] Seller's [X] Buyer's expense no later than 3 days prior to Closing Date.
[ ] (2) Within _____ days after the Effective Date of this contract, Buyer may obtain a new survey at Buyer's expense.
[ ] (3) Within _____ days after the Effective Date of this contract, Seller, at Seller's expense shall furnish a new survey to Buyer.`;

test('23 Nopalito real ¶6C text: option (1) is correctly identified as checked', () => {
  assert.equal(parseCheckedOption(NOPALITO_PARAGRAPH_6C), '1');
});

test('does not get confused by the SECOND [X] inside option (1)\'s own fallback clause ("[ ] Seller\'s [X] Buyer\'s expense") — that fallback is nested inside (1), not a competing top-level option', () => {
  // The nested [X] has no "(\d)" immediately after it, so the (\d) capture
  // group in the regex cannot match it — this test exists to guard that
  // property explicitly, since a naive "find any [X]" scan would find two.
  const matches = [...NOPALITO_PARAGRAPH_6C.matchAll(/\[X\]\s*\((\d)\)/gi)];
  assert.equal(matches.length, 1, 'only the top-level (1)/(2)/(3) marks should match, not the nested Seller/Buyer fallback');
});

test('option (2) checked', () => {
  const text = '[ ] (1) Within 14 days... [X] (2) Within 10 days after the Effective Date, Buyer may obtain a new survey at Buyer\'s expense. [ ] (3) ...';
  assert.equal(parseCheckedOption(text), '2');
});

test('option (3) checked', () => {
  const text = '[ ] (1) ... [ ] (2) ... [X] (3) Within 10 days, Seller, at Seller\'s expense shall furnish a new survey.';
  assert.equal(parseCheckedOption(text), '3');
});

test('nothing checked (a blank paragraph, e.g. an unfilled ¶7D) — returns null, never guesses', () => {
  const text = '[ ] (1) Within 14 days... [ ] (2) Within 10 days... [ ] (3) Within 10 days...';
  assert.equal(parseCheckedOption(text), null);
});

test('more than one box marked (a contradictory capture) — returns null rather than guessing the first match', () => {
  const text = '[X] (1) Within 14 days... [X] (2) Within 10 days...';
  assert.equal(parseCheckedOption(text), null);
});

test('null/empty/non-string input never throws, returns null', () => {
  assert.equal(parseCheckedOption(null), null);
  assert.equal(parseCheckedOption(undefined), null);
  assert.equal(parseCheckedOption(''), null);
  assert.equal(parseCheckedOption(42), null);
});
