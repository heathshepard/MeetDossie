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

  // ── 3b. Short REAL comments (Cole's explicit ask, 2026-09-09): a short,
  //    low-unique-token reply is a completely normal thing to actually leave
  //    on a Facebook post. These must NOT trip the dominant-token-ratio or
  //    low-unique-ratio checks just for being short. Verified live: this
  //    exact set of shapes (or near-identical) actually appeared as real
  //    extracted comments in the 2026-09-09 DOM-extraction fix verification
  //    run against tc_vas / DFW Realtors - Network & Collaborate. ─────────────
  const shortRealComments = ['same here', 'yes!!', 'Hi', 'Up!', 'Interested', 'Yes', 'Following along! I have the same questions', 'same same same problem here honestly'];
  for (const c of shortRealComments) {
    assert.ok(!isJunkText(c).junk, `short real comment "${c}" must NOT be rejected as junk`);
  }

  // A short comment that IS actually a repeated-word spam pattern (not a
  // real reply) must still be caught — the guard isn't disabled for short
  // strings, only tuned so genuine short replies survive.
  assert.ok(isJunkText('lol lol lol lol lol lol').junk, 'repeated-word spam in a short string is still rejected');

  // ── 3c. REAL INCIDENT #2 (found 2026-09-11 auditing a 92% comment-reject
  //    rate): a retroactive sweep on 2026-09-09 used isJunkText() to kill
  //    FOUR already-scored (62-72), already-drafted candidates purely
  //    because every scrape from this source carries the same ~33x
  //    "Facebook" loading-skeleton prefix, real content or not. A repeated
  //    chrome-word run wrapping real content is NOT the same failure mode
  //    as the Christina Morgan incident (nothing else in the string at
  //    all) and must not be rejected the same way. These 4 strings are the
  //    real post_text values pulled from comment_opportunities (author
  //    names/identifiers kept, rest verbatim). ──────────────────────────────
  const NOISE_WRAPPED_REAL_POSTS = [
    // DFW Realtors -- landlord/bank-statement thread. Real scored 72,
    // real comment_draft. Wrongly killed by the 2026-09-09 sweep.
    'Facebook\n'.repeat(33)
      + 'DiEma Hicks\n \n·\nFollow\n·\nLandlords and property managers, I need your expertise!\n'
      + 'I have a client who is 1099. Her income started in April of this year, so she hasn’t filed taxes yet '
      + 'and doesn’t have a return to show.\nShe also doesn’t have pay stubs since she pays herself. '
      + 'I’ve advised her to start doing that going forward, but that doesn’t help her right now.\nSee more\n'
      + '1\n22\nView more comments\nTina Griffith\n \n·\n2d\nIn this case I would not rent to any one that didn’t '
      + 'have 12 months of bank statements, good credit and reserves. Also, I woul… See more\nReply\nShare\n3\n'
      + 'Tasia Russell\n \n·\n2d\nBank statement loan, what is her credit score?\nReply\nShare\n1\n\n\n\n\nComment as Heath\n'
      + 'Facebook\n'.repeat(11),
    // TC VAs -- new-TC welcome thread. Real scored 62, real comment_draft.
    'Facebook\n'.repeat(33)
      + 'Christina Morgan\n \n·\nNew TC here!\nHey TC friends! I’ve just started TC work.\n'
      + 'I have a history of administrative work, and needed to make a career change. So I’ve started '
      + 'learning TC work with my mom, who is an RE Agent. After I get it down, I’ll be adding agents, '
      + 'but I need some input so I can set it up correctly.\nSee more\n2\n5\nView more answers\n'
      + 'Lauren Heier\n \n·\n1h\nFollowing along! I have the same questions \nReply\nShare\n1\n'
      + 'Lisa Huck\n \n·\n2h\nHi \nReply\nShare\n1\nView 2 replies\n\n\n\n\nAnswer as Heath\n'
      + 'Facebook\n'.repeat(11),
  ];
  for (const [i, text] of NOISE_WRAPPED_REAL_POSTS.entries()) {
    const verdict = isJunkText(text);
    assert.ok(!verdict.junk, `noise-wrapped REAL post #${i} must survive the guard (got: ${JSON.stringify(verdict)})`);
  }
  // Sanity: these strings DO trip the repeated-token-run condition -- the
  // fix is that real content downstream saves them, not that the run
  // detection stopped firing.
  assert.ok(
    NOISE_WRAPPED_REAL_POSTS.every((t) => /(?:facebook\s*){5,}/i.test(t)),
    'sanity: the test fixtures actually contain a >=5 repeated-token run',
  );

  // The Christina Morgan incident itself must NOT be "fixed" into passing --
  // it is nothing BUT the repeated run, no real content survives stripping it.
  assert.ok(isJunkText(CHRISTINA_MORGAN_JUNK).junk, 'pure noise with nothing else must still be rejected after the fix');

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
