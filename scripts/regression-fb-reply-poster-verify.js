#!/usr/bin/env node
'use strict';

/**
 * Regression test for the false-'posted' fix in scripts/fb-reply-poster.js
 * (2026-09-17).
 *
 * THE BUG
 * -------
 * scripts/fb-reply-poster.js's old postReply() typed the approved draft,
 * pressed Enter, waited 3s, logged "reply posted successfully", and
 * returned -- with NO check that the reply actually rendered anywhere.
 * main() then called markPosted() (status='posted') on ANY non-throwing
 * return. Same false-positive shape as the group-poster bug fixed
 * 2026-09-16 (see scripts/regression-fb-group-poster-verify.js), but worse
 * here: auto-reply is live in production
 * (api/cron-auto-approve.js auto-approves fb_comment_replies after a
 * 10-minute veto window), so a reply the system believes it answered but
 * never actually posted is never retried -- it silently looks done.
 *
 * THIS TEST PINS DOWN
 * --------------------
 *   1. A submit with no visible comment afterward (no permalink, no feed/
 *      thread match) NEVER resolves to 'posted' -- via the shared resolver
 *      (scripts/_lib/fb-post-verify-outcome.js), reused rather than
 *      duplicated.
 *   2. 'blocked' is a real, generalized outcome distinct from a generic
 *      'failed' (the 2026-09-17 generalization of resolvePostStatus).
 *   3. detectBlocked() correctly matches known FB block/removal phrasing
 *      and ignores unrelated page text.
 *   4. Wiring: fb-reply-poster.js reuses postReplyToComment/verifyReplyPosted
 *      from fb-group-commenter.js instead of a second parallel DOM
 *      automation; runReplyFlow's outcome branches never let an unconfirmed
 *      submit satisfy 'posted'.
 *   5. End-to-end (mocked poster/verifier, no real browser): a submit that
 *      verification can't find in the thread returns status='failed', NOT
 *      'posted' -- and the DB writer for that outcome (markUnconfirmed)
 *      never resets status back to 'approved', so it is not retried
 *      automatically.
 *
 * Run manually:
 *   node scripts/regression-fb-reply-poster-verify.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { resolvePostStatus } = require(path.join(__dirname, '_lib', 'fb-post-verify-outcome.js'));
const {
  runReplyFlow,
  detectBlocked,
  BLOCKED_PATTERNS,
} = require(path.join(__dirname, 'fb-reply-poster.js'));

function testNeverPostedWithoutEvidence() {
  const outcome = resolvePostStatus({
    blocked: false,
    errorShown: false,
    permalinkFound: false,
    feedConfirmed: false,
  });
  assert.notStrictEqual(outcome.status, 'posted', 'a submit with no thread match must NEVER resolve to posted');
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(/unconfirmed_submit/.test(outcome.reason), 'reason names the unconfirmed-submit case');
  console.log('PASS: submitted-but-not-found never resolves to posted');
}

function testVerifiedFeedMatchIsPosted() {
  const outcome = resolvePostStatus({ feedConfirmed: true });
  assert.strictEqual(outcome.status, 'posted');
  console.log('PASS: a verified thread match resolves to posted');
}

function testBlockedIsDistinguishable() {
  const outcome = resolvePostStatus({ blocked: true, blockedReason: 'temporarily blocked' });
  assert.strictEqual(outcome.status, 'blocked');
  assert.strictEqual(outcome.posted, false);
  assert.ok(outcome.reason.includes('temporarily blocked'));

  const statuses = new Set([
    outcome.status,
    resolvePostStatus({ feedConfirmed: true }).status,
    resolvePostStatus({}).status,
    resolvePostStatus({ identityRejected: true }).status,
    resolvePostStatus({ notAMember: true }).status,
    resolvePostStatus({ pendingApproval: true }).status,
  ]);
  assert.strictEqual(statuses.size, 6, 'blocked is a genuinely distinct status, not lumped into failed');
  console.log('PASS: blocked is its own distinguishable outcome, generalized onto the shared resolver');
}

async function testDetectBlockedMatchesKnownPhrasing() {
  const blockedPage = { locator: () => ({ innerText: async () => "You're temporarily blocked from commenting on this post." }) };
  const hit = await detectBlocked(blockedPage);
  assert.ok(hit, 'known blocking phrasing is detected');

  const cleanPage = { locator: () => ({ innerText: async () => 'Reply from Jane Doe: thanks so much!' }) };
  const miss = await detectBlocked(cleanPage);
  assert.strictEqual(miss, null, 'unrelated page text is never misread as a block');

  assert.ok(Array.isArray(BLOCKED_PATTERNS) && BLOCKED_PATTERNS.length > 0);
  console.log('PASS: detectBlocked matches known block/removal phrasing and nothing else');
}

async function testRunReplyFlowNeverMarksPostedWithoutVerification() {
  // Mocked: a submit "succeeds" (Enter pressed) but the re-rendered thread
  // never shows the reply -- the exact real-world shape of the bug.
  const closed = { called: false };
  const outcome = await runReplyFlow({ commenter_name: 'Jane Doe', comment_text: 'need a tc', post_url: 'https://facebook.com/groups/x/posts/1' }, 'draft text', {
    launch: async () => ({ context: { close: async () => { closed.called = true; } }, page: {} }),
    poster: async () => ({ submitted: true }),
    blockedDetector: async () => null,
    verifier: async () => false, // could not find it in the thread
  });

  assert.strictEqual(outcome.status, 'failed', 'submitted-but-unverified must resolve to failed, never posted');
  assert.notStrictEqual(outcome.status, 'posted');
  assert.ok(closed.called, 'the browser context is always closed, even on an ambiguous outcome');
  console.log('PASS: runReplyFlow — submitted with no visible comment afterward never records posted');
}

async function testRunReplyFlowPostedRequiresVerification() {
  const outcome = await runReplyFlow({ commenter_name: 'Jane Doe', comment_text: 'need a tc', post_url: 'x' }, 'draft text', {
    launch: async () => ({ context: { close: async () => {} }, page: {} }),
    poster: async () => ({ submitted: true }),
    blockedDetector: async () => null,
    verifier: async () => true, // found in the re-rendered thread
  });
  assert.strictEqual(outcome.status, 'posted');
  console.log('PASS: runReplyFlow — a verified thread match resolves to posted');
}

async function testRunReplyFlowPreSubmitFailureIsNotUnconfirmed() {
  // Nothing was typed/submitted (couldn't find the Reply button) -- this
  // must be distinguishable from a real submit that couldn't be verified.
  const outcome = await runReplyFlow({ commenter_name: 'Jane Doe', comment_text: 'need a tc', post_url: 'x' }, 'draft text', {
    launch: async () => ({ context: { close: async () => {} }, page: {} }),
    poster: async () => { throw new Error('could not locate Reply button'); },
    blockedDetector: async () => null,
    verifier: async () => true,
  });
  assert.strictEqual(outcome.status, 'not_submitted');
  console.log('PASS: runReplyFlow — a pre-submit failure is its own distinct outcome, not conflated with an unconfirmed submit');
}

async function testRunReplyFlowBlockedDetected() {
  const outcome = await runReplyFlow({ commenter_name: 'Jane Doe', comment_text: 'need a tc', post_url: 'x' }, 'draft text', {
    launch: async () => ({ context: { close: async () => {} }, page: {} }),
    poster: async () => ({ submitted: true }),
    blockedDetector: async () => "you're temporarily blocked from commenting",
    verifier: async () => { throw new Error('verifier must not run once blocked is detected'); },
  });
  assert.strictEqual(outcome.status, 'blocked');
  console.log('PASS: runReplyFlow — a post-submit block signal short-circuits to blocked, skips verification');
}

function testPosterWiring() {
  const src = fs.readFileSync(path.join(__dirname, 'fb-reply-poster.js'), 'utf8');

  // Reuses the already-verified automation instead of a second parallel one.
  assert.ok(src.includes("require('./fb-group-commenter.js')"), 'fb-reply-poster.js reuses fb-group-commenter.js rather than a parallel DOM implementation');
  assert.ok(src.includes('postReplyToComment') && src.includes('verifyReplyPosted'), 'both the proven poster and verifier are reused');
  assert.ok(src.includes("require('./_lib/fb-post-verify-outcome.js')"), 'the reply poster reuses the shared outcome resolver, not a parallel decision function');

  // The exact bug: no unconditional markPosted after a bare submit.
  assert.ok(!/posted successfully['"];?\s*\n\s*\}\s*finally/.test(src), 'no bare "posted successfully" log with no verification before closing the browser');
  assert.ok(src.includes('resolvePostStatus('), 'the outcome is resolved through the shared decision function, not inferred from a non-throw');

  // Terminal, unverified outcome must not reset to 'approved' for blind
  // retry (Heath's "never retry an unverified send" rule).
  const unconfirmedFn = src.slice(src.indexOf('async function markUnconfirmed'), src.indexOf('async function markBlocked'));
  assert.ok(!/status:\s*'approved'/.test(unconfirmedFn), 'markUnconfirmed does not reset the row back to approved for blind retry');
  assert.ok(unconfirmedFn.includes("status: 'failed'"), 'markUnconfirmed writes the terminal failed status');

  // Pre-submit failures ARE safe to retry, and must stay distinguishable
  // from the unconfirmed-submit terminal case.
  const preSubmitFn = src.slice(src.indexOf('async function markPreSubmitFailed'), src.indexOf('async function markUnconfirmed'));
  assert.ok(preSubmitFn.includes("status: 'approved'"), 'markPreSubmitFailed resets to approved (nothing was submitted, safe to retry)');

  console.log('PASS: fb-reply-poster.js wiring — reuses proven automation + shared resolver, no bare-success posted write, unconfirmed submits never silently retried');
}

async function main() {
  testNeverPostedWithoutEvidence();
  testVerifiedFeedMatchIsPosted();
  testBlockedIsDistinguishable();
  await testDetectBlockedMatchesKnownPhrasing();
  await testRunReplyFlowNeverMarksPostedWithoutVerification();
  await testRunReplyFlowPostedRequiresVerification();
  await testRunReplyFlowPreSubmitFailureIsNotUnconfirmed();
  await testRunReplyFlowBlockedDetected();
  testPosterWiring();
  console.log('PASS: fb-reply-poster.js false-posted fix — never posted without evidence, blocked is distinguishable, unconfirmed submits are never silently retried');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
