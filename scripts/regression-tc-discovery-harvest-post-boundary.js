#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-09 STOP-THE-LINE fix to
 * scripts/harvest-tc-discovery-responses.js's scrapeComments():
 * cross-post comment contamination.
 *
 * THE BUG, VERIFIED LIVE
 * -----------------------
 * scrapeComments() queried `document.querySelectorAll('div[role="article"]')`
 * across the WHOLE rendered page, not scoped to the target post's own
 * comment thread. On the DFW Realtors permalink page
 * (facebook.com/groups/531847711158328/posts/1792845771725176/), Facebook
 * renders an unrelated/suggested post further down the same page with its
 * own comment thread. That post's comments got scraped and written to
 * tc_discovery_responses attributed to Heath's TC-discovery post — Heath
 * caught it live: a Telegram card showed "Adrienne Lewis: Wow, belongs in a
 * magazine!" as a reply to a post asking about TC pet peeves.
 *
 * THE FIX: a comment permalink's own /posts/<id> must equal the target
 * post's /posts/<id>. Verified live against the real DFW post: all 5 real
 * commenters (Holly Peery Osborne, Ben Howard, Nicole Roth-Volentine,
 * Chaska Wilkinson, Andy Bearden) carry
 * facebook.com/groups/531847711158328/posts/1792845771725176/?comment_id=...
 * — matches, kept. The contaminating Adrienne Lewis comment carried
 * facebook.com/adrienne.burden?comment_id=<base64> — a PROFILE url with no
 * /posts/<id> segment at all — fails, rejected. This fixture reproduces that
 * exact shape: a target post's own comment thread plus an unrelated second
 * post's comment thread both present in the rendered DOM (as they were on
 * the real permalink page), and asserts only the target's comments survive.
 *
 * Uses a real headless Chromium page (page.setContent) — no live Facebook
 * access, no network. Full detail on the incident: the Carter fix commit
 * message and docs/TC-DISCOVERY-CAMPAIGN.md.
 *
 * Run manually:
 *   node scripts/regression-tc-discovery-harvest-post-boundary.js
 */

const assert = require('assert');
const path = require('path');

const harvester = require(path.join(__dirname, 'harvest-tc-discovery-responses.js'));
const { scrapeComments, extractPostId, permalinkMatchesPost } = harvester;

const TARGET_POST_URL = 'https://www.facebook.com/groups/531847711158328/posts/1792845771725176/';

// Reproduces the live shape: the target post's own real comment thread
// (Ben Howard, Holly Peery Osborne — genuine /posts/<id>/?comment_id=numeric
// permalinks) plus, further down the SAME page, an unrelated second post's
// comment thread (Adrienne Lewis — profile-url permalink, no /posts/ at
// all — exactly what a suggested/related post renders as on a permalink
// page).
const FIXTURE_HTML = `
<!doctype html><html><body>
  <div role="feed">
    <!-- The target post itself (no aria-label match — never picked up as a comment) -->
    <div role="article" aria-label="">
      <div data-ad-preview="message"><div dir="auto">Curious what other agents have run into...</div></div>
    </div>

    <!-- Real comment on the TARGET post -->
    <div role="article" aria-label="Comment by Ben Howard a day ago">
      <a role="link"><span>Ben Howard</span></a>
      <div dir="auto">Ben Howard</div>
      <div dir="auto">I agree with the previous comments. It is all of the multiple form nonsense.</div>
      <div dir="auto">Reply</div>
      <div dir="auto">Share</div>
      <a href="https://www.facebook.com/groups/531847711158328/posts/1792845771725176/?comment_id=1793412315001855&amp;__cft__[0]=xyz">a day ago</a>
    </div>

    <!-- Second real comment on the TARGET post -->
    <div role="article" aria-label="Comment by Holly Peery Osborne 2 days ago">
      <a role="link"><span>Holly Peery Osborne</span></a>
      <div dir="auto">Holly Peery Osborne</div>
      <div dir="auto">Getting the agent on the other side of the deal to copy your emails.</div>
      <div dir="auto">Reply</div>
      <div dir="auto">Share</div>
      <a href="https://www.facebook.com/groups/531847711158328/posts/1792845771725176/?comment_id=1792870721722681&amp;__cft__[0]=xyz">2 days ago</a>
    </div>

    <!-- An UNRELATED second post, rendered further down the SAME permalink
         page (Facebook's "suggested"/related content) — its comment carries
         a PROFILE-url permalink, no /posts/<id> segment. THIS must be
         rejected. -->
    <div role="article" aria-label="">
      <div data-ad-preview="message"><div dir="auto">Check out this gorgeous kitchen remodel!</div></div>
    </div>
    <div role="article" aria-label="Comment by Adrienne Lewis about an hour ago">
      <a role="link"><span>Adrienne Lewis</span></a>
      <div dir="auto">Adrienne Lewis</div>
      <div dir="auto">Wow, belongs in a magazine!</div>
      <div dir="auto">Reply</div>
      <div dir="auto">Share</div>
      <a href="https://www.facebook.com/adrienne.burden?comment_id=Y29tbWVudDoxMDExODM3NzUwMTA2NzQzN18xMTAzMDY3MDQyNjc1NzUy&amp;__cft__[0]=xyz">1h</a>
    </div>
  </div>
</body></html>`;

async function main() {
  // ── Pure unit coverage: extractPostId / permalinkMatchesPost ─────────────
  assert.strictEqual(
    extractPostId('https://www.facebook.com/groups/531847711158328/posts/1792845771725176/?comment_id=1'),
    '1792845771725176',
    'extractPostId pulls the numeric id out of a group post permalink',
  );
  assert.strictEqual(
    extractPostId('https://www.facebook.com/adrienne.burden?comment_id=abc123'),
    null,
    'extractPostId returns null for a profile-based url with no /posts/ segment',
  );
  assert.strictEqual(
    permalinkMatchesPost(
      'https://www.facebook.com/groups/531847711158328/posts/1792845771725176/?comment_id=999&reply_comment_id=1000',
      TARGET_POST_URL,
    ),
    true,
    'a nested reply permalink on the SAME post id matches',
  );
  assert.strictEqual(
    permalinkMatchesPost('https://www.facebook.com/adrienne.burden?comment_id=abc', TARGET_POST_URL),
    false,
    'a profile-url permalink never matches',
  );
  assert.strictEqual(
    permalinkMatchesPost('https://www.facebook.com/groups/999/posts/1111111111111111/?comment_id=1', TARGET_POST_URL),
    false,
    'a permalink for a DIFFERENT post id never matches',
  );
  assert.strictEqual(
    permalinkMatchesPost(null, TARGET_POST_URL),
    false,
    'a missing permalink is a reject, never a guessed match',
  );

  // ── DOM-fixture coverage: scrapeComments() end to end ────────────────────
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(FIXTURE_HTML, { waitUntil: 'domcontentloaded' });

  const comments = await scrapeComments(page, TARGET_POST_URL);
  await browser.close();

  assert.strictEqual(comments.length, 2, 'ONLY the two real target-post comments are captured — the contaminating unrelated-post comment is rejected');
  const authors = comments.map((c) => c.author).sort();
  assert.deepStrictEqual(authors, ['Ben Howard', 'Holly Peery Osborne'], 'exactly the two genuine DFW commenters, no one else');
  assert.ok(!comments.some((c) => c.author === 'Adrienne Lewis'), 'Adrienne Lewis (cross-post contamination) must NEVER appear');
  assert.ok(comments.every((c) => /\/posts\/1792845771725176\//.test(c.permalink)), 'every surviving comment permalink is scoped to the target post');

  console.log('PASS: tc-discovery harvest post-boundary gate (cross-post contamination rejected, target-post comments captured, 5 assertion groups)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
