#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/fb-comment-hunt-daily.js's extractVisible()
 * (the 2026-09-09 DOM-extraction rewrite).
 *
 * PRECISE FAILURE THIS PINS DOWN
 * -------------------------------
 * Live inspection (2026-09-09) of the tc_vas group feed showed:
 *   - div[aria-posinset] (the OLD extraction boundary) is a virtualized
 *     list-item SIZING WRAPPER. Its own .innerText read back either EMPTY
 *     (virtualization placeholder — the large majority of wrappers) or, for
 *     the currently-in-viewport ones, a repeated "Facebook" placeholder
 *     string that lives INSIDE the wrapper but is NOT the post.
 *   - The real, clean post body for those SAME wrappers lives in a nested
 *     [data-ad-preview="message"] element — verified live: Christina
 *     Morgan's actual post ("New TC here! Hey TC friends! I've just started
 *     TC work...") was sitting right there the whole time, one selector
 *     away from what the old code was reading.
 * This fixture reproduces that exact DOM shape (wrapper text = junk,
 * nested [data-ad-preview="message"] = the real post) plus a nested inline
 * comment (div[role="article"] aria-label="Comment by X"), and asserts the
 * NEW extractVisible() pulls the real author/body/comments as separate
 * clean fields while ignoring the wrapper-level noise entirely.
 *
 * Uses a real headless Chromium page (page.setContent) — no live Facebook
 * access, no network.
 *
 * Run manually:
 *   node scripts/regression-comment-hunt-dom-extraction.js
 */

const assert = require('assert');
const path = require('path');

const hunt = require(path.join(__dirname, 'fb-comment-hunt-daily.js'));

// Reproduces the live DOM shape found 2026-09-09: an aria-posinset wrapper
// whose OWN innerText is repeated "Facebook" chrome noise (simulating the
// lazy-loading placeholder text that sits alongside the real post), with the
// real post isolated in a nested [data-ad-preview="message"] element, an
// author link, a permalink, an age link, and one nested inline comment.
const FIXTURE_HTML = `
<!doctype html><html><body>
  <div role="feed">
    <div aria-posinset="1" style="height:400px">
      <span>${'Facebook '.repeat(30)}</span>
      <h3><a href="/christina.morgan">Christina Morgan</a></h3>
      <a href="/groups/transactioncoordinatorsandvirtualassistants/posts/1370622871725434/?__cft__=1">17h</a>
      <div data-ad-preview="message">
        <div dir="auto">New TC here! Hey TC friends! I've just started TC work. I have a history of administrative work, and needed to make a career change.</div>
      </div>
      <div role="article" aria-label="Comment by Lauren Heier about an hour ago">
        <a role="link"><span>Lauren Heier</span></a>
        <div dir="auto">Lauren Heier</div>
        <div dir="auto">Following along! I have the same questions</div>
        <div dir="auto">Reply</div>
        <div dir="auto">Share</div>
        <div dir="auto">1h</div>
      </div>
    </div>

    <!-- A second, ordinary post with no comments, real body, real permalink -->
    <div aria-posinset="2" style="height:250px">
      <span>${'Facebook '.repeat(25)}</span>
      <h3><a href="/joseph.vanwagner">Joseph Van Wagner</a></h3>
      <a href="/groups/transactioncoordinatorsandvirtualassistants/posts/1370972168357171/">5h</a>
      <div data-ad-preview="message">
        <div dir="auto">HIRING: Guest Operations VA for a US short term rental company. Philippines based, long term, full time.</div>
      </div>
    </div>

    <!-- A pure virtualization placeholder: no readable text anywhere, must
         be skipped entirely (not turned into a candidate at all). -->
    <div aria-posinset="3" style="height:600px"></div>

    <!-- A post whose body legitimately trails "... See more" — the literal
         expand-affordance text must be stripped from the extracted body. -->
    <div aria-posinset="4" style="height:200px">
      <h3><a href="/strategic.support">Strategic Support Partners LLC</a></h3>
      <a href="/groups/531847711158328/posts/999999999999999/">2d</a>
      <div data-ad-preview="message">
        <div dir="auto">Tuesday System Spotlight: Email Marketing and Automation Systems, how many of your follow ups still depend on someone remembering to send them… See more</div>
      </div>
    </div>
  </div>
</body></html>`;

async function main() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setContent(FIXTURE_HTML, { waitUntil: 'domcontentloaded' });

  const posts = await hunt.extractVisible(page);
  await browser.close();

  // ── Exactly 3 real candidates extracted (the 4th, pure-empty wrapper, is
  //    correctly skipped rather than turned into a junk row). ──────────────
  assert.strictEqual(posts.length, 3, `expected 3 extracted candidates (empty wrapper skipped), got ${posts.length}: ${JSON.stringify(posts.map((p) => p.text.slice(0, 40)))}`);

  const christina = posts.find((p) => p.authorName === 'Christina Morgan');
  assert.ok(christina, 'Christina Morgan post extracted with a real author name');

  // ── THE precise defect, pinned: the wrapper-level "Facebook" noise must
  //    NEVER appear in the extracted body. ──────────────────────────────────
  assert.ok(!/Facebook/i.test(christina.text), 'the repeated "Facebook" wrapper noise must NOT appear in the extracted post body');
  assert.ok(christina.text.includes('New TC here'), 'the real post body was extracted, not the wrapper chrome');
  assert.strictEqual(christina.postUrl, 'https://www.facebook.com/groups/transactioncoordinatorsandvirtualassistants/posts/1370622871725434/', 'permalink extracted and query string stripped');
  assert.strictEqual(christina.age, '17h', 'age extracted');

  // ── Comments extracted as a SEPARATE field, not folded into post body. ────
  assert.ok(Array.isArray(christina.comments), 'comments is an array field, separate from the post body');
  assert.strictEqual(christina.comments.length, 1, 'exactly one nested comment extracted');
  assert.strictEqual(christina.comments[0].author, 'Lauren Heier', 'comment author extracted cleanly');
  assert.strictEqual(christina.comments[0].text, 'Following along! I have the same questions', 'comment text extracted cleanly, UI chrome (Reply/Share/1h) stripped');
  assert.ok(!christina.text.includes('Following along'), 'comment text must not leak into the post body field');

  const joseph = posts.find((p) => p.authorName === 'Joseph Van Wagner');
  assert.ok(joseph, 'second post extracted');
  assert.ok(joseph.text.includes('HIRING: Guest Operations VA'), 'second post body extracted cleanly');
  assert.strictEqual(joseph.comments.length, 0, 'post with no nested comments returns an empty comments array, not undefined');

  const strategic = posts.find((p) => p.authorName === 'Strategic Support Partners LLC');
  assert.ok(strategic, 'fourth post extracted');
  assert.ok(!/see more$/i.test(strategic.text.trim()), 'trailing "See more" expand-affordance stripped from the extracted body');
  assert.ok(strategic.text.includes('Email Marketing and Automation Systems'), 'body content around the stripped "See more" survives intact');

  console.log('PASS: comment-hunt DOM extraction (real author/body/comments as separate fields; wrapper-level "Facebook" chrome never leaks into body; empty virtualization placeholder skipped; trailing "See more" stripped)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message); process.exit(1); });
