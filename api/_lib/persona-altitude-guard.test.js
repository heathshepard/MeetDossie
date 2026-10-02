'use strict';

// api/_lib/persona-altitude-guard.test.js
//
// Fixtures 1 and 2 below are the VERBATIM post_body of the two group_posts
// rows Heath rejected 2026-10-02 (9acc91f0-bc9c-4b33-89f0-a830facc051d and
// a8820c8c-d93b-4d09-8262-95faee3173b7, hook_types
// tracking_question:disclosure_review_habit and
// process_observation:earnest_money_vs_option_fee). They MUST fail
// checkPersonaAltitude() — if either one ever passes again, the gate this
// file exists to prove has regressed.
//
// Run: node --test api/_lib/persona-altitude-guard.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const { checkPersonaAltitude } = require('./persona-altitude-guard');

// Fixture 1 — rejected 9acc91f0-bc9c-4b33-89f0-a830facc051d. Heath's verdict:
// reading the disclosure early is A GIVEN, not a question, and "depending on
// how slammed the week is" makes him look disorganized.
const REJECTED_DISCLOSURE_POST = `Honest question for anyone who's been doing this long enough to have a real habit instead of the textbook one. Do you actually read a seller's disclosure notice line by line before you ever put together an offer, or does the real read happen once you're already in option period and the clock's already moving. I go back and forth depending on how slammed the week is. Reading it early means you walk into the offer knowing exactly what you're dealing with, but you also burn time digging into disclosures on houses that might fall through before you ever write anything. Reading it late means you find out about the foundation repair or the old insurance claim while you're already spending option days on it. Neither one feels like the right answer every time. Curious what everybody's actual process looks like, not the version we'd all say out loud in a CE class.`;

// Fixture 2 — rejected a8820c8c-d93b-4d09-8262-95faee3173b7. Heath's verdict:
// "just as basic a conversation as anyone could have."
const REJECTED_OPTION_FEE_POST = `Had a conversation recently that reminded me how often earnest money and the option fee get lumped together like they're the same check with two different names. They're not. The option fee is what buys the right to walk away during the option period for pretty much any reason, and it's typically gone once you've used that window, doesn't matter if the reason was a bad inspection or just cold feet. Earnest money is different. It's a good faith deposit toward the purchase, and it stays refundable in more situations further down the contract, financing falling through, an appraisal issue, whatever the contract actually spells out. Clients hear "deposit" attached to both and assume one set of rules applies. It doesn't, and nobody notices the gap until they're trying to figure out what they get back and why. Feels like a five minute conversation at contract signing that would save a lot of confusion later. Anyone found a clean way to explain it that actually sticks?`;

// A good example at the right altitude — a process/systems question about
// Paragraph 12.B seller contributions toward buyer-broker compensation,
// verified against scripts/trec-forms/20-19.pdf (see handoff report): the
// contract text itself states contributions "shall not change the parties'
// obligations to pay compensation pursuant to those agreements," so a
// seller contribution short of the buyer-rep fee is a real, verified gap
// the buyer owes directly. No basic-term explainer, no obvious-answer
// question, no disorganization admission.
const GOOD_SELLER_CONTRIBUTION_POST = `Anyone found a clean way to handle it when the seller's 12B contribution comes in short of what the buyer actually owes their own agent under the buyer-rep agreement? The contract language is clear that a seller contribution doesn't change what the buyer agreed to pay their broker, it just gets applied toward it. But I've seen more than one buyer assume the seller's number WAS the number and get surprised at the settlement statement. Curious whether people are catching this at the offer stage, baking a cushion into the ask, or just having the conversation again right before closing.`;

test('rejected disclosure post (9acc91f0) fails the gate', () => {
  const result = checkPersonaAltitude(REJECTED_DISCLOSURE_POST);
  assert.equal(result.pass, false, 'expected the rejected disclosure draft to fail persona-altitude-guard');
  // Both the obvious-answer-question shape AND the disorganization
  // admission are present in this draft — assert both are individually
  // caught, not just that SOMETHING failed.
  assert.ok(
    result.failedRules.includes('no_obvious_answer_question'),
    `expected no_obvious_answer_question to fail, got failedRules=${JSON.stringify(result.failedRules)}`,
  );
  assert.ok(
    result.failedRules.includes('no_disorganization_admission'),
    `expected no_disorganization_admission to fail, got failedRules=${JSON.stringify(result.failedRules)}`,
  );
});

test('rejected option-fee/earnest-money post (a8820c8c) fails the gate', () => {
  const result = checkPersonaAltitude(REJECTED_OPTION_FEE_POST);
  assert.equal(result.pass, false, 'expected the rejected option-fee draft to fail persona-altitude-guard');
  assert.ok(
    result.failedRules.includes('no_basic_term_explainer'),
    `expected no_basic_term_explainer to fail, got failedRules=${JSON.stringify(result.failedRules)}`,
  );
});

test('a good process/systems question at the right altitude passes the gate', () => {
  const result = checkPersonaAltitude(GOOD_SELLER_CONTRIBUTION_POST);
  assert.equal(result.pass, true, `expected the good example to pass, got failedRules=${JSON.stringify(result.failedRules)}`);
});

test('a genuine systems question that happens to mention both option fee and earnest money does NOT trip the explainer rule', () => {
  // Regression guard for a false-positive this gate could easily introduce:
  // mentioning both terms while asking a real tracking/systems question
  // (never defining either one) must not fail just because both strings
  // appear in the body.
  const text = `How do you track option fee and earnest money receipts across a dozen active files so nothing slips when a dispute comes up six weeks later? Spreadsheet, brokerage system, something else?`;
  const result = checkPersonaAltitude(text);
  assert.equal(result.pass, true, `expected a genuine systems question mentioning both terms to pass, got failedRules=${JSON.stringify(result.failedRules)}`);
});

test('a flat statement with no advice framing is not falsely flagged as disorganized', () => {
  const text = `How do you handle amendment cascades across a dozen active files without a TC? I'm less worried about missing one than about an amendment on file three changing something file three's own closing date depended on, and nobody catching the ripple until title calls.`;
  const result = checkPersonaAltitude(text);
  assert.equal(result.pass, true, `expected a clean process question to pass, got failedRules=${JSON.stringify(result.failedRules)}`);
});
