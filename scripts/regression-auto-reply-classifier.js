#!/usr/bin/env node
'use strict';

/**
 * Regression test for the auto-reply-with-veto risk classifier + content
 * gates (scripts/_lib/auto-reply-risk-classifier.js +
 * scripts/_lib/auto-reply-content-gates.js — Heath's explicit approval,
 * 2026-09-16, supabase/migrations/20260916_auto_reply_veto.sql).
 *
 * Pure unit coverage, zero network/DB/browser. Every ESCALATE category from
 * the spec gets a real example, plus a gate failure, plus one real fixture
 * from tc_discovery_responses (the same "TC went dark for 9 days mid-option"
 * comment scripts/regression-tc-reply-approval.js treats as a real harvested
 * row — reused here rather than inventing a new one).
 *
 * Run manually:
 *   node scripts/regression-auto-reply-classifier.js
 */

const assert = require('assert');
const { classifyCommentRisk } = require('./_lib/auto-reply-risk-classifier.js');
const { checkContentGates } = require('./_lib/auto-reply-content-gates.js');

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('auto-reply risk classifier + content gates');

// ─── Escalate categories — every one from the spec, with a real example ────

check('pricing: "what does it cost?" escalates', () => {
  const r = classifyCommentRisk('What does it cost?', 'It runs $29/mo on the founding rate.');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'pricing');
});

check('pricing: "how much do you pay your TC" escalates even with a clean draft', () => {
  const r = classifyCommentRisk('How much do you pay your TC per file?', 'depends on the brokerage honestly');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'pricing');
});

check('demo_request: "can I see a demo" escalates', () => {
  const r = classifyCommentRisk('This sounds cool, can I see a demo?', 'sure, send me your email');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'demo_request');
});

check('demo_request: "can I try it out" escalates', () => {
  const r = classifyCommentRisk('Can I try it out before committing?', 'happy to set that up');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'demo_request');
});

check('complaint: negative sentiment escalates', () => {
  const r = classifyCommentRisk('honestly this whole thing sounds like a scam, my last TC ripped me off', 'sorry to hear that');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'complaint');
});

check('complaint: "this is terrible" escalates', () => {
  const r = classifyCommentRisk('this is terrible advice honestly', 'fair, everyone runs it differently');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'complaint');
});

check('legal_compliance: a TREC question escalates', () => {
  const r = classifyCommentRisk('does TREC require the buyer to sign that same day?', 'good question, I always double check with my broker');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'legal_compliance');
});

check('legal_compliance: liability question escalates', () => {
  const r = classifyCommentRisk('could you be liable if the TC misses that deadline?', 'depends on the E&O policy honestly');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'legal_compliance');
});

check('specific_client: naming a specific transaction escalates', () => {
  const r = classifyCommentRisk('my client at 123 Main Street wants to know how you handled that', 'that sounds like a normal fix honestly');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('contact_request: asking to DM escalates', () => {
  const r = classifyCommentRisk('can you DM me the details?', 'sure thing');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'contact_request');
});

check('contact_request: "reach out" escalates', () => {
  const r = classifyCommentRisk('mind if I reach out directly?', 'go ahead');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'contact_request');
});

check('competitor_mention: naming a known competitor escalates', () => {
  const r = classifyCommentRisk('we switched to dotloop last year, way better', 'good to know, thanks');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'competitor_mention');
});

check('a claim leaking into the DRAFT (not the comment) still escalates', () => {
  const r = classifyCommentRisk('what do you use for TC work?', 'honestly it costs about $30/mo and worth it');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'pricing');
});

// ─── Fail-closed defaults ────────────────────────────────────────────────────

check('an ambiguous off-topic comment with no positive shape escalates as low_confidence', () => {
  const r = classifyCommentRisk('anyway, hope everyone has a good weekend', 'you too');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

check('an empty draft never auto-posts', () => {
  const r = classifyCommentRisk('thanks!', '');
  assert.strictEqual(r.eligible, false);
});

check('an overlong/rambling comment escalates regardless of shape', () => {
  const longComment = 'thanks so much for this, '.repeat(15);
  const r = classifyCommentRisk(longComment, 'no problem');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

// ─── Auto-eligible archetypes ────────────────────────────────────────────────

check('thanks is auto-eligible', () => {
  const r = classifyCommentRisk('Thanks, that helps a lot!', 'anytime');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.category, 'auto_eligible');
});

check('agreement is auto-eligible', () => {
  const r = classifyCommentRisk('100% agree with this', 'yeah, same here');
  assert.strictEqual(r.eligible, true);
});

check('a neutral follow-up question is auto-eligible', () => {
  const r = classifyCommentRisk('did you have to switch title companies too?', 'no, kept the same one the whole time');
  assert.strictEqual(r.eligible, true);
});

check('a factual TC/transaction answer is auto-eligible', () => {
  const r = classifyCommentRisk('what tripped mine up was the option period deadline', 'yeah that one gets people every time');
  assert.strictEqual(r.eligible, true);
});

// ─── Real fixture: the exact row scripts/regression-tc-reply-approval.js
// treats as a real harvested tc_discovery_responses comment ─────────────────

check('real fixture ("TC went dark for 9 days mid-option") is auto-eligible with a clean, verified-story-matching draft', () => {
  const realComment = 'Communication. My last TC went dark for 9 days mid-option.';
  const cleanDraft = 'yeah, mine went dark on me too once mid-option. built in a backup contact after that.';
  const r = classifyCommentRisk(realComment, cleanDraft);
  assert.strictEqual(r.eligible, true, `expected eligible, got category=${r.category} reason=${r.reason}`);
  const gates = checkContentGates(cleanDraft);
  assert.strictEqual(gates.pass, true, `expected gates to pass, got failures=${JSON.stringify(gates.failures)}`);
});

check('real fixture with an UNVERIFIED anecdote fails the war-story gate even though the comment itself is low-risk', () => {
  const realComment = 'Communication. My last TC went dark for 9 days mid-option.';
  const fabricatedDraft = 'ha, reminds me of a client of mine who waived the option period and hit a foundation issue in the hill country.';
  const r = classifyCommentRisk(realComment, fabricatedDraft);
  // Classifier alone doesn't know about story fabrication -- the gate does.
  const gates = checkContentGates(fabricatedDraft);
  assert.strictEqual(gates.pass, false);
  assert.ok(gates.failures.some((f) => f.code === 'unverified_war_story'));
});

// ─── Content gates, one failure per gate ────────────────────────────────────

check('gate: pricing figure in the draft fails', () => {
  const g = checkContentGates('it runs $7.50/mo on the founding rate');
  assert.strictEqual(g.pass, false);
  assert.ok(g.failures.some((f) => f.code === 'pricing_figure'));
});

check('gate: unverified capability claim fails', () => {
  const g = checkContentGates('yeah she pulls comps straight from MLS for you');
  assert.strictEqual(g.pass, false);
  assert.ok(g.failures.some((f) => f.code === 'unverified_capability_claim'));
});

check('gate: AI-tell opener fails (reuses heath-voice-guard)', () => {
  const g = checkContentGates('Haha love that, such a great point!');
  assert.strictEqual(g.pass, false);
  assert.ok(g.failures.some((f) => f.code === 'voice_violation'));
});

check('gate: too-long draft fails length', () => {
  const g = checkContentGates('this is a very long draft. '.repeat(20));
  assert.strictEqual(g.pass, false);
  assert.ok(g.failures.some((f) => f.code === 'length_out_of_range'));
});

check('gate: a short, clean, on-voice draft passes every gate', () => {
  const g = checkContentGates('yeah, same. built in a backup contact after that.');
  assert.strictEqual(g.pass, true, JSON.stringify(g.failures));
});

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
if (!process.exitCode) console.log('ALL PASS');
