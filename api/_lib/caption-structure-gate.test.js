// api/_lib/caption-structure-gate.test.js
//
// Run with: node --test api/_lib/caption-structure-gate.test.js
//
// Regression for the exact live defect (Heath, 2026-09-29): a caption that
// opened with "Paragraph 7.I:", used "--" instead of an em dash, and
// promised "Comment WATER and I'll DM you..." with nothing wired behind it.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkCaptionStructure,
  extractCommentCtaKeyword,
  checkDmFieldsForCaption,
} = require('./caption-structure-gate.js');

const LIVE_BROKEN_CAPTION =
  "Paragraph 7.I: if the Seller's Water Disclosure never goes out, the buyer's right to walk " +
  "doesn't end at the option period -- it can run all the way to closing. Comment WATER and " +
  "I'll DM you the one-pager on all 6 changes.";

const CORRECTED_CAPTION =
  "Your buyer can still walk the day before closing — and take the earnest money.\n\n" +
  "If the Seller's Water Disclosure never went out, the right to terminate doesn't end when " +
  "the option period does. It runs all the way to closing. That's paragraph 7.I in the new " +
  "TREC 20-19 contract.\n\nComment WATER and I'll DM you the one-pager on all 6 changes.";

test('checkCaptionStructure flags the live broken caption on both counts', () => {
  const r = checkCaptionStructure(LIVE_BROKEN_CAPTION);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /paragraph.*number/.test(v)));
  assert.ok(r.violations.some((v) => /em dash/.test(v)));
});

test('checkCaptionStructure passes the corrected structure', () => {
  const r = checkCaptionStructure(CORRECTED_CAPTION);
  assert.deepEqual(r, { ok: true, violations: [] });
});

test('a bare form-number or paragraph-label opening is rejected in either form', () => {
  assert.equal(checkCaptionStructure('20-19 changed how commission works.').ok, false);
  assert.equal(checkCaptionStructure('12.B: read this before your next contract.').ok, false);
  assert.equal(checkCaptionStructure('¶7.I is the one buyers miss.').ok, false);
});

test('a citation NOT in the opening position is fine — credibility, just not first', () => {
  const r = checkCaptionStructure('Your buyer can still walk. That is ¶7.I in TREC 20-19.');
  assert.equal(r.ok, true);
});

test('a real em dash never trips the "--" check', () => {
  const r = checkCaptionStructure('Your buyer can still walk — and take the earnest money.');
  assert.equal(r.ok, true);
});

test('extractCommentCtaKeyword pulls the keyword, case-insensitively on the verb', () => {
  assert.equal(extractCommentCtaKeyword('comment WATER and I will DM you'), 'WATER');
  assert.equal(extractCommentCtaKeyword('Comment disclose for the one-pager'), 'disclose');
  assert.equal(extractCommentCtaKeyword('no CTA in this one'), null);
});

test('checkDmFieldsForCaption is a no-op when the caption has no Comment CTA', () => {
  const r = checkDmFieldsForCaption({ caption: 'Just a caption, no CTA here.' });
  assert.deepEqual(r, { ok: true, violations: [], ctaKeyword: null });
});

test('checkDmFieldsForCaption refuses a Comment-CTA caption with zero DM fields set', () => {
  const r = checkDmFieldsForCaption({ caption: LIVE_BROKEN_CAPTION });
  assert.equal(r.ok, false);
  assert.equal(r.ctaKeyword, 'WATER');
  assert.equal(r.violations.length, 3); // keyword, asset_url, message all missing
});

test('checkDmFieldsForCaption refuses a keyword MISMATCH between caption and dm_keyword', () => {
  const r = checkDmFieldsForCaption({
    caption: LIVE_BROKEN_CAPTION,
    dm_keyword: 'DISCLOSE', // wrong word — caption says WATER
    dm_asset_url: 'https://example.com/onepager.pdf',
    dm_message: 'here you go',
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => /does not match/.test(v)));
});

test('checkDmFieldsForCaption passes when all three fields are set and match', () => {
  const r = checkDmFieldsForCaption({
    caption: LIVE_BROKEN_CAPTION,
    dm_keyword: 'WATER',
    dm_asset_url: 'https://example.com/onepager.pdf',
    dm_message: 'here you go',
  });
  assert.deepEqual(r, { ok: true, violations: [], ctaKeyword: 'WATER' });
});
