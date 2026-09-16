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

// ─── Quinn's QA pass, 2026-09-16 — PERMANENT FIXTURES ──────────────────────
// e4201198 shipped a classifier that let these 5 through as auto-eligible,
// all via the same root defect (positive shapes were "innocent until
// proven guilty" instead of "positively confirmed safe"). Locked in here so
// this exact regression can never recur, plus a harder variant per case
// that changes the wording rather than reusing Quinn's exact strings — the
// point is the ROOT SHAPE is fixed, not these 5 sentences.

check('Quinn case 1 (pricing, indirect — "worth the money"): escalates', () => {
  const r = classifyCommentRisk('Is it worth the money though?', 'yeah honestly it has paid for itself');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'pricing');
});
check('Quinn case 1, harder variant (indirect pricing via "pay for itself"): escalates', () => {
  const r = classifyCommentRisk('Would this pay for itself for someone only doing 3 deals a month?', 'for sure, especially at that volume');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'pricing');
});

check('Quinn case 2 (demo request with no "demo" word — "walk me through... back end"): escalates', () => {
  const r = classifyCommentRisk('Could you walk me through what it actually looks like on the back end?', 'sure, happy to show you sometime');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'demo_request');
});
check('Quinn case 2, harder variant (different indirect demo phrasing — "behind the scenes"): escalates', () => {
  const r = classifyCommentRisk('What happens behind the scenes when a contract comes in?', 'happy to walk through it sometime');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'demo_request');
});

check('Quinn case 3 (backhanded thanks carrying doubt — "thanks, I guess, not sure... though"): escalates', () => {
  const r = classifyCommentRisk('Thanks, I guess, not sure it actually works though', 'fair enough, it works for me');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});
check('Quinn case 3, harder variant (different backhanded phrasing — "appreciate it, but"): escalates', () => {
  const r = classifyCommentRisk("Appreciate you sharing, but I feel like there's got to be a catch.", 'no catch, it really is that simple');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

check('Quinn case 4 (legal/compliance question with no "TREC"/"legal" word — earnest money forfeiture): escalates', () => {
  const r = classifyCommentRisk('If a buyer backs out after the option period ends, is the earnest money automatically forfeited?', 'depends on the contract terms honestly');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'legal_compliance');
});
check('Quinn case 4, harder variant (different phrasing, pronoun instead of "forfeited") escalates', () => {
  const r = classifyCommentRisk('Can the buyer just walk away and keep their earnest money too?', 'not usually, no');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'legal_compliance');
});

check('Quinn case 5 (names a specific client\'s transaction — "for Sarah\'s closing"): escalates', () => {
  const r = classifyCommentRisk("How did you handle it for Sarah's closing?", 'we just extended the option period a few days');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});
check('Quinn case 5, harder variant (different name, different transaction noun — "file"): escalates', () => {
  const r = classifyCommentRisk("What did you end up doing for Marcus's file?", 'ended up pushing the closing date a week');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
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

// ─── Post-Quinn tightening: prove the fix doesn't just re-wire escalate
// keywords, it genuinely requires POSITIVE confirmation ─────────────────────

check('a hedged "thanks" (no escalate keyword at all) still escalates, not just Quinn\'s exact wording', () => {
  const r = classifyCommentRisk('Thanks, kind of makes sense I guess', 'glad it helps');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

check('a question that ends in "?" but does NOT match the safe-question allowlist escalates (no longer eligible by default)', () => {
  const r = classifyCommentRisk('Is that even a real thing that happens?', 'yeah it comes up more than you would think');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

check('a long thanks padded with extra commentary is not "clean" and escalates', () => {
  const r = classifyCommentRisk('Thanks for this, it is genuinely one of the more useful threads I have seen on this whole topic in a long time', 'glad it helped');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'low_confidence');
});

check('"thanks" immediately followed by a live question is not a clean thanks', () => {
  const r = classifyCommentRisk('Thanks — does that happen a lot?', 'more than people expect honestly');
  assert.strictEqual(r.eligible, false);
});

// ─── Quinn's 2nd QA round, 2026-09-16 — PERMANENT FIXTURES ─────────────────
// 22 fresh adversarial cases, 21 escalated correctly, 1 real miss — both
// root causes are SHAPE problems, not string problems:
//   1. AGREEMENT_RE matched the bare word "exactly" anywhere in the
//      comment, even as an ordinary adverb. Fixed by anchoring
//      thanks/agreement to the START of the comment (the actual SHAPE of
//      an agreement, not a word occurring anywhere).
//   2. The named-third-party check only caught "Name's <noun>". It missed
//      the general PERSON-REFERENCE shape: a social-interaction verb next
//      to a capitalized name, in either word order.
// Fixtures below: Quinn's exact case, plus harder variants that change the
// wording entirely (different verb, different name, different sentence
// shape) to prove the fix generalizes rather than pattern-matching one
// reported string.

check('Quinn case (agreement word "exactly" as an adverb mid-sentence, not agreement): escalates via named third party', () => {
  const r = classifyCommentRisk("Sharing this with Miguel since he's been asking about exactly this for his group.", 'happy to chat with him too');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('root-cause isolation: "exactly" as a bare adverb, no third party at all, still does not carry eligibility alone', () => {
  // Deliberately strips the third-party reference to isolate the FIRST
  // root cause on its own: this must not become eligible just because
  // "exactly" appears somewhere in it.
  const r = classifyCommentRisk('It works exactly like you would expect honestly.', 'yeah pretty much');
  assert.notStrictEqual(r.category, 'auto_eligible');
});

check('harder variant, different social verb + different name ("telling Dana about this"): escalates', () => {
  const r = classifyCommentRisk('telling Dana about this later, she is going to want to know', 'sounds good, keep me posted');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('harder variant, name BEFORE the verb ("my buddy Ray asked"): escalates', () => {
  const r = classifyCommentRisk('my buddy Ray asked about this too the other day', 'small world, happens a lot');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('harder variant, "wanted to know" instead of "asked" ("Zoe wanted to know"): escalates', () => {
  const r = classifyCommentRisk('Zoe wanted to know if this happens as often as it sounds', 'more than people think honestly');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('harder variant, forwarding language ("forwarded it to James"): escalates', () => {
  const r = classifyCommentRisk('forwarded it to James since he was dealing with the exact same thing', 'hope it helps him too');
  assert.strictEqual(r.eligible, false);
  assert.strictEqual(r.category, 'specific_client');
});

check('precision check: the common idiom "That said" must NOT trip the named-third-party shape', () => {
  // Guards against an over-broad fix: "That said" is a discourse
  // connective, not a reference to a person named "That". This is the one
  // false-positive class worth explicitly excluding rather than accepting
  // (unlike a day/place name, which is a harmless over-escalate).
  const r = classifyCommentRisk('That said, mine went dark too for a while and it was rough.', 'yeah it happens more than it should');
  assert.notStrictEqual(r.category, 'specific_client');
});

check('precision check: "100% agree with this" still auto-eligible after anchoring the agreement shape', () => {
  // The anchoring fix must not collateral-damage the real, clean agreement
  // case it's supposed to keep working.
  const r = classifyCommentRisk('100% agree with this', 'yeah, same here');
  assert.strictEqual(r.eligible, true);
  assert.strictEqual(r.category, 'auto_eligible');
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
