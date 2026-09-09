#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/_lib/junk-text-guard.js.
 *
 * REAL INCIDENT (2026-09-09): scripts/fb-comment-hunt-daily.js scraped
 * "Facebook" repeated 20+ times as a "post" attributed to Christina Morgan
 * in "Transaction Coordinators and Virtual Assistants for Real Estate". It
 * scored 62 in api/cron-comment-opp-approval.js (MIN_SCORE 55) and a full
 * reply was drafted and sent to Heath for approval. This pins down that the
 * exact string, and realistic variants of the same DOM-junk failure mode,
 * are rejected before scoring/drafting ever runs — and that genuine posts
 * and comments still pass.
 *
 * Pure unit test, zero network/DB/browser.
 *
 * Run manually:
 *   node scripts/regression-junk-text-guard.js
 */

const assert = require('assert');
const { isJunkText } = require('./_lib/junk-text-guard');
const { prefilterPost } = require('./fb-comment-hunt-daily');

async function main() {
  // ── 1. The exact live incident string ──────────────────────────────────
  const CHRISTINA_MORGAN_JUNK =
    'Facebook Facebook Facebook Facebook Facebook Facebook Facebook Facebook '
    + 'Facebook Facebook Facebook Facebook Facebook Facebook Facebook Facebook '
    + 'Facebook Facebook Facebook Facebook Facebook Facebook Face';
  const r1 = isJunkText(CHRISTINA_MORGAN_JUNK);
  assert.ok(r1.junk, 'the exact live Christina Morgan junk string must be rejected');

  // ── 2. Realistic variants of the same DOM-noise failure mode ──────────────
  assert.ok(isJunkText('Like Reply Share Like Reply Share Like Reply Share Comment').junk,
    'repeated UI-chrome-word cluster rejected');
  assert.ok(isJunkText('Comment Comment Comment Comment Comment Comment').junk,
    'a different single repeated chrome word rejected');
  assert.ok(isJunkText('See more See more See more See more See more See more').junk,
    'repeated "See more" control-label noise rejected');
  assert.ok(isJunkText('Like Reply Share Write a public comment Top comments Most relevant').junk,
    'pure UI chrome vocabulary with no real content rejected');
  assert.ok(isJunkText('asdf asdf qwer asdf qwer asdf qwer asdf qwer asdf qwer asdf').junk,
    'alternating low-variety token noise (no sentence structure) rejected');
  assert.ok(isJunkText('').junk, 'empty text rejected');
  assert.ok(isJunkText('   ').junk, 'whitespace-only text rejected');

  // ── 3. Genuine content must still pass ─────────────────────────────────────
  const genuine1 = isJunkText(
    'New TC here, two weeks in and drowning. How do you all keep deadlines straight across 6 files? '
    + 'I keep losing track of option periods and it is stressing me out.'
  );
  assert.ok(!genuine1.junk, 'a genuine new-TC question must pass');

  const genuine2 = isJunkText(
    'Noticed appraisers in our market are getting way more conservative this quarter. Curious if '
    + 'others are seeing the same on the north side deals, especially anything financed conventional.'
  );
  assert.ok(!genuine2.junk, 'a genuine market observation must pass');

  // Short genuine congratulatory posts with a naturally-repeated word must
  // NOT false-positive (run of 3 "congrats" is below the repeated-run
  // threshold and the token count is too low for the dominant-token check).
  const genuine3 = isJunkText('Congrats congrats congrats!!! So happy for you, well deserved after everything this year.');
  assert.ok(!genuine3.junk, 'short genuine post with mild word repetition must pass');

  // A real post that happens to mention "Facebook" or "Like" once must not
  // be flagged just for using the word.
  const genuine4 = isJunkText(
    'Someone in this group recommended a great title company last week on Facebook — anyone remember who '
    + 'that was? Trying to get a second closing scheduled before month end.'
  );
  assert.ok(!genuine4.junk, 'a real post mentioning "Facebook" once must not be flagged');

  // ── 4. Integration: the exact incident is rejected at prefilterPost() —
  //    the real ingest point in scripts/fb-comment-hunt-daily.js, not just
  //    the standalone helper. ──────────────────────────────────────────────
  const verdict = prefilterPost({
    postUrl: 'https://www.facebook.com/groups/transactioncoordinatorsandvirtualassistants/posts/1370622871725434/',
    authorName: 'Christina Morgan',
    age: '3h',
    text: CHRISTINA_MORGAN_JUNK,
  });
  assert.ok(!verdict.keep, 'prefilterPost rejects the live junk incident');
  assert.ok(/junk_text/.test(verdict.reason || ''), 'rejection reason attributes it to the junk guard');

  // A genuine post through the same real entry point still survives.
  const verdictGenuine = prefilterPost({
    postUrl: 'https://www.facebook.com/groups/g/posts/1',
    authorName: 'Jane',
    age: '3h',
    text: 'New TC here, two weeks in and drowning. How do you all keep deadlines straight across 6 files?',
  });
  assert.ok(verdictGenuine.keep, 'prefilterPost still keeps a genuine post');

  console.log('PASS: junk-text-guard regression (incident string + variants rejected, genuine content passes)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
