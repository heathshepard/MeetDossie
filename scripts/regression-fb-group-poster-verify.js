#!/usr/bin/env node
'use strict';

/**
 * Regression test for the false-'posted' fix in scripts/fb-group-poster.js
 * (2026-09-16).
 *
 * THE BUG
 * -------
 * Verified live 2026-09-16: 6 group_posts rows across 5 groups (Founding
 * Files, All about Real Estate Houston, Real Estate in Austin TX x2, Boerne
 * Real Estate, Stone Oak Neighborhood) read status='posted' with nothing on
 * Facebook. Root cause in the old postToGroup(): status='posted' was
 * satisfied by any of
 *   - the composer dialog closing after clicking Post (not proof -- it can
 *     close for reasons other than a successful publish)
 *   - "no error shown within 30s" (absence of evidence != evidence)
 *   - falling back to the bare group_url as "post_url" when no real
 *     /groups/<id>/posts/<id> permalink could be found (this fake URL then
 *     satisfied main()'s old `result.status === 'posted' && result.postUrl`
 *     truthy check)
 * The per-group truth audit (same day) additionally found the outcome needs
 * to be one of FOUR distinguishable statuses, not one generic "failed"
 * bucket: identity_rejected (Founding Files -- Page blocked from joining),
 * not_a_member (Stone Oak -- never joined), pending_admin_approval
 * (Houston/Boerne -- existing 2026-09-14 fix, unchanged), and a genuine
 * failure (Real Estate in Austin TX -- the account WAS a member, no
 * approval gate, and it still silently didn't post -- the primary
 * regression fixture below).
 *
 * THIS TEST PINS DOWN (via scripts/_lib/fb-post-verify-outcome.js, the pure
 * resolver extracted from postToGroup -- unit-testable without a browser)
 * --------------------------------------------------------------------------
 *   1. PRIMARY FIXTURE (Real Estate in Austin TX shape): a submit with the
 *      composer closed, no error banner, no permalink, no feed match --
 *      NEVER resolves to 'posted'. This is the exact bug.
 *   2. A real permalink is sufficient positive evidence -> 'posted'.
 *   3. A feed-text match (no permalink element) is ALSO sufficient positive
 *      evidence -> 'posted' -- the instructions' "or located in the group
 *      feed afterward" clause.
 *   4. pending_admin_approval / identity_rejected / not_a_member each
 *      resolve to their OWN distinguishable status, not a shared 'failed'
 *      bucket, and take priority over a stray error banner.
 *   5. An explicit Facebook error with no evidence -> 'failed' with a
 *      reason recorded (never silently swallowed).
 *   6. Wiring: fb-group-poster.js never fabricates a postUrl from
 *      post.group_url, and main()'s posted-branch check no longer requires
 *      `&& result.postUrl` (the exact gate that let the fake URL through).
 *
 * Run manually:
 *   node scripts/regression-fb-group-poster-verify.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { resolvePostStatus } = require(path.join(__dirname, '_lib', 'fb-post-verify-outcome.js'));

function testNeverPostedWithoutEvidence() {
  // PRIMARY FIXTURE: Real Estate in Austin TX -- a member, no approval
  // gate, composer closed, no error, but nothing rendered.
  const outcome = resolvePostStatus({
    pendingApproval: false,
    identityRejected: false,
    notAMember: false,
    errorShown: false,
    errorText: null,
    permalinkFound: false,
    feedConfirmed: false,
  });
  assert.notStrictEqual(outcome.status, 'posted', 'a submit with no permalink and no feed-confirmation must NEVER resolve to posted');
  assert.strictEqual(outcome.status, 'failed', 'the unconfirmed-submit case is the genuinely-failed bucket');
  assert.ok(outcome.reason && outcome.reason.length > 0, 'a reason must be recorded for the ambiguous outcome');
  assert.ok(/unconfirmed_submit/.test(outcome.reason), 'reason names the unconfirmed-submit case specifically');

  console.log('PASS: no permalink + no feed match never resolves to posted (the Real Estate in Austin TX bug fixture)');
}

function testPermalinkIsSufficientEvidence() {
  const outcome = resolvePostStatus({ permalinkFound: true, feedConfirmed: false });
  assert.strictEqual(outcome.status, 'posted', 'a real captured permalink IS sufficient positive evidence');
  assert.strictEqual(outcome.reason, null, 'no failure reason on a genuinely posted outcome');
  console.log('PASS: a real permalink alone resolves to posted');
}

function testFeedMatchIsSufficientEvidence() {
  const outcome = resolvePostStatus({ permalinkFound: false, feedConfirmed: true });
  assert.strictEqual(outcome.status, 'posted', 'locating the post in the group feed (no permalink element) is ALSO sufficient positive evidence');
  console.log('PASS: a feed-text match with no permalink element still resolves to posted');
}

function testDistinguishableNonPostedStatuses() {
  const pending = resolvePostStatus({ pendingApproval: true, errorShown: true, errorText: 'stray banner' });
  assert.strictEqual(pending.status, 'pending_admin_approval', 'pending-approval takes priority and keeps its own status');

  const identity = resolvePostStatus({ identityRejected: true, errorShown: true });
  assert.strictEqual(identity.status, 'identity_rejected', 'identity-rejected is its own distinguishable status, not lumped into failed');

  const member = resolvePostStatus({ notAMember: true, permalinkFound: false });
  assert.strictEqual(member.status, 'not_a_member', 'not-a-member is its own distinguishable status, not lumped into failed');

  const statuses = new Set([pending.status, identity.status, member.status, 'failed', 'posted']);
  assert.strictEqual(statuses.size, 5, 'all five outcomes are genuinely distinct status strings, not collapsed into one bucket');

  console.log('PASS: pending_admin_approval / identity_rejected / not_a_member are distinguishable from each other and from failed/posted');
}

function testExplicitErrorRecordsReason() {
  const outcome = resolvePostStatus({ errorShown: true, errorText: 'Something went wrong. Please try again.' });
  assert.strictEqual(outcome.status, 'failed');
  assert.ok(outcome.reason.includes('Something went wrong'), 'the actual Facebook error text is preserved in the reason, not swallowed');
  console.log('PASS: an explicit Facebook error resolves to failed with the real error text recorded');
}

function testPosterWiring() {
  const src = fs.readFileSync(path.join(__dirname, 'fb-group-poster.js'), 'utf8');

  // The exact bug: falling back to the group's own URL as a stand-in
  // postUrl must be gone entirely.
  assert.ok(
    !/postUrl = post\.group_url/.test(src),
    'fb-group-poster.js no longer fabricates postUrl from post.group_url (the 2026-09-16 false-posted root cause)',
  );

  // The exact gate that let the fake URL through main()'s branch check.
  assert.ok(
    !src.includes("result.status === 'posted' && result.postUrl"),
    'main() no longer requires a truthy postUrl on top of status===posted (status alone is now the decision)',
  );
  assert.ok(
    src.includes("result && result.status === 'posted'") && !src.includes('&& result.postUrl)'),
    'main() checks status===posted without an additional postUrl truthiness gate',
  );

  // Positive-evidence search actually exists and is used before deciding.
  assert.ok(src.includes('confirmPostInFeed'), 'a feed-text confirmation fallback exists (the "located in the group feed afterward" evidence path)');
  assert.ok(src.includes('resolvePostStatus('), 'postToGroup delegates the final decision to the shared resolver');

  // The old "assume success" fallback must be gone.
  assert.ok(
    !/assuming success/i.test(src),
    'the old "no error after 30s, assume success" fallback is removed',
  );

  // New terminal-status DB writers exist and are wired from main().
  assert.ok(src.includes('async function markUnconfirmed'), 'markUnconfirmed helper exists for the ambiguous-submit case');
  assert.ok(src.includes('async function markTerminal'), 'markTerminal helper exists for identity_rejected/not_a_member');
  assert.ok(src.includes("result.status === 'not_a_member' || result.status === 'identity_rejected'"), 'main() routes those statuses to markTerminal');
  assert.ok(src.includes("await markUnconfirmed(POST_ID"), 'main() routes the ambiguous-submit failed case to markUnconfirmed, not a blind approved-reset');

  // The ambiguous/terminal cases must NOT reset back to 'approved' (that
  // would risk a duplicate real post on retry -- "never retry an
  // unverified send").
  const unconfirmedFn = src.slice(src.indexOf('async function markUnconfirmed'), src.indexOf('async function markUnconfirmed') + 700);
  assert.ok(!/status:\s*'approved'/.test(unconfirmedFn), 'markUnconfirmed does not reset the row back to approved for blind retry');

  console.log('PASS: fb-group-poster.js wiring — no fabricated postUrl, no postUrl-truthy gate, feed-confirm fallback exists, terminal statuses do not silently reset to approved');
}

async function main() {
  testNeverPostedWithoutEvidence();
  testPermalinkIsSufficientEvidence();
  testFeedMatchIsSufficientEvidence();
  testDistinguishableNonPostedStatuses();
  testExplicitErrorRecordsReason();
  testPosterWiring();
  console.log('PASS: fb-group-poster.js false-posted fix — never posted without evidence, 4 distinguishable non-posted statuses, no blind retry on ambiguous submits');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
