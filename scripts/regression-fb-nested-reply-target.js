#!/usr/bin/env node
'use strict';

// scripts/regression-fb-nested-reply-target.js
//
// Pins the reply-target selection that broke on 2026-10-01, when a reply to a
// nested reply in "Transaction Coordinators and Virtual Assistants for Real
// Estate" failed with `could not locate Reply button for comment by 2w` and the
// pipeline asked Heath to post it by hand.
//
// No browser and no network: the fragile decision ("which comment do we reply
// to, and whose Reply button do we click") is a pure function in
// scripts/_lib/fb-comment-identity.js. The article descriptors below mirror how
// Facebook actually renders the real thread — in particular that a reply's
// div[role="article"] sits INSIDE its parent comment's article, so the parent's
// innerText contains the child's words.
//
// Run: node scripts/regression-fb-nested-reply-target.js

const {
  looksLikeHarvestArtifactName,
  isRelativeTimestampLike,
  pickAuthorName,
  extractCommentAnchorId,
  isNestedReplyPermalink,
  chooseReplyTarget,
} = require('./_lib/fb-comment-identity');

let pass = 0;
let fail = 0;
const failures = [];

function check(name, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) { pass++; console.log(`  PASS  ${name}`); } else {
    fail++;
    failures.push(name);
    console.log(`  FAIL  ${name}\n          got:  ${g}\n          want: ${w}`);
  }
}
function section(t) { console.log(`\n── ${t}`); }

// ─── The real thread, as Facebook renders it ────────────────────────────────
// https://www.facebook.com/groups/transactioncoordinatorsandvirtualassistants/
//   posts/1377239757730412/?comment_id=1377246844396370
//                          &reply_comment_id=1377253981062323
const PARENT_ID = '1377246844396370';
const TARGET_ID = '1377253981062323';
const TARGET_TEXT = 'TaupeGrape5949 are you located in US or outside of US?';
// Synthetic stand-in. The real parent comment is a job applicant's email
// address + experience; no third-party contact details belong in this repo.
const PARENT_TEXT = 'applicant@example.com 6+ years experience';

// idx 0 is the post itself: no "Comment by" aria-label, must be ignored.
// idx 1 is the top-level comment. idx 2 is the nested reply, DOM-nested inside
// idx 1, which is why idx 1's articleText contains idx 2's words.
function realThread(overrides = {}) {
  // NOTE ON LABEL FORMAT — this is the crux of the bug. Facebook SPELLS OUT the
  // time in aria-label ("2 weeks ago"), while the visible permalink link text is
  // the compact "2w". The existing harvester comment documents the same thing:
  // "Live labels look like 'Comment by Chaska Wilkinson about an hour ago' /
  // '... 36 minutes ago'". So the harvester stored the LINK text ("2w") as the
  // name, and the old locator then tested whether the aria-label contained
  // "2w" — against a label reading "...2 weeks ago", which it never does.
  const parent = {
    idx: 1,
    depth: 0,
    ariaLabel: 'Comment by TaupeGrape5949 2 weeks ago',
    ownAnchorIds: [PARENT_ID],
    ownText: PARENT_TEXT,
    articleText: `TaupeGrape5949 ${PARENT_TEXT} Like Reply 2w ${TARGET_TEXT} Like Reply 2w`,
    hasOwnReplyButton: true,
    ancestorArticleIdxs: [],
  };
  const child = {
    idx: 2,
    depth: 1,
    // The harvester stored commenter_name "2w" for THIS article. Its real
    // aria-label still carries the author's name.
    ariaLabel: 'Reply by Example Author 2 weeks ago',
    ownAnchorIds: [TARGET_ID],
    ownText: TARGET_TEXT,
    articleText: `Example Author ${TARGET_TEXT} Like Reply 2w`,
    hasOwnReplyButton: true,
    ancestorArticleIdxs: [1],
    ...overrides,
  };
  return [
    { idx: 0, depth: 0, ariaLabel: '', ownAnchorIds: [], ownText: '', articleText: 'Looking for a TC', hasOwnReplyButton: false, ancestorArticleIdxs: [] },
    parent,
    child,
  ];
}

// ─── 1. Why it failed ───────────────────────────────────────────────────────
section('1. The stored commenter_name was a timestamp, not a person');
check('"2w" reads as a relative timestamp', isRelativeTimestampLike('2w'), true);
check('"2w" is not a trustworthy name', looksLikeHarvestArtifactName('2w'), true);
check('"1d"/"22h"/"1w" likewise (the other 5 affected rows)',
  ['1d', '22h', '1w', '2d', '23h'].map(looksLikeHarvestArtifactName), [true, true, true, true, true]);
check('a real name IS trustworthy', looksLikeHarvestArtifactName('Example Author'), false);
check('an anonymous group handle IS trustworthy', looksLikeHarvestArtifactName('TaupeGrape5949'), false);
check('a name containing digits is still trustworthy', looksLikeHarvestArtifactName('By Ian TC Solutions 2'), false);

section('2. Harvest no longer lets the timestamp link overwrite the author');
check('timestamp link candidate loses to aria-label (THE harvest bug)',
  pickAuthorName('Reply by Example Author 2 weeks ago', '2w'), 'Example Author');
check('also with a compact label, in case FB changes format',
  pickAuthorName('Reply by Example Author 2w', '2w'), 'Example Author');
check('a real profile link still wins',
  pickAuthorName('Comment by Example Author 2 weeks ago', 'Example Author'), 'Example Author');
check('anonymous handle survives', pickAuthorName('Comment by TaupeGrape5949 2 weeks ago', 'TaupeGrape5949'), 'TaupeGrape5949');
check('"Reply by" labels parse, not just "Comment by"',
  pickAuthorName('Reply by Katie Swank 5h', null), 'Katie Swank');
check('"about an hour ago" phrasing stripped',
  pickAuthorName('Comment by Chaska Wilkinson about an hour ago', null), 'Chaska Wilkinson');

section('3. The permalink points at the reply, not its parent');
const PERMALINK = `https://www.facebook.com/groups/transactioncoordinatorsandvirtualassistants/posts/1377239757730412/?comment_id=${PARENT_ID}&reply_comment_id=${TARGET_ID}`;
check('anchor id is the reply_comment_id', extractCommentAnchorId(PERMALINK), TARGET_ID);
check('recognised as a nested reply', isNestedReplyPermalink(PERMALINK), true);
const TOP_PERMALINK = `https://www.facebook.com/groups/x/posts/1377239757730412/?comment_id=${PARENT_ID}`;
check('a top-level permalink yields comment_id', extractCommentAnchorId(TOP_PERMALINK), PARENT_ID);
check('top-level is not flagged nested', isNestedReplyPermalink(TOP_PERMALINK), false);

// ─── 4. The nested reply (the case that failed in production) ───────────────
section('4. NESTED REPLY resolves, with commenter_name still the bogus "2w"');
const nested = chooseReplyTarget(realThread(), {
  anchorId: TARGET_ID,
  commenterName: '2w',            // exactly what the DB holds
  snippet: TARGET_TEXT.slice(0, 80),
});
console.log(`        -> ${JSON.stringify(nested)}`);
check('resolves', nested.ok, true);
check('matched on the comment id', nested.tier, 'comment_id');
check('picked the nested reply (idx 2)', nested.idx, 2);
check('at depth 1', nested.depth, 1);
check('clicks its OWN Reply button', [nested.replyButtonFrom, nested.buttonSource], [2, 'own']);
check('and knew the name was untrustworthy', nested.nameTrusted, false);
check('exactly one article matched', nested.matchCount, 1);

// ─── 5. The top-level comment still works ──────────────────────────────────
section('5. TOP-LEVEL comment resolves (no regression)');
const top = chooseReplyTarget(realThread(), {
  anchorId: PARENT_ID,
  commenterName: 'TaupeGrape5949',
  snippet: PARENT_TEXT.slice(0, 80),
});
console.log(`        -> ${JSON.stringify(top)}`);
check('resolves', top.ok, true);
check('matched on the comment id', top.tier, 'comment_id');
check('picked the top-level comment (idx 1), NOT its nested child', top.idx, 1);
check('at depth 0', top.depth, 0);
check('clicks its own Reply button', [top.replyButtonFrom, top.buttonSource], [1, 'own']);
check('name was trusted here', top.nameTrusted, true);

// ─── 6. The nesting trap ───────────────────────────────────────────────────
section('6. Text-only match must pick the child, never the parent that contains it');
const noAnchor = chooseReplyTarget(realThread(), {
  anchorId: null,                 // permalink missing / malformed
  commenterName: '2w',
  snippet: TARGET_TEXT.slice(0, 80),
});
console.log(`        -> ${JSON.stringify(noAnchor)}`);
check('resolves without an anchor id', noAnchor.ok, true);
check('via the comment\'s OWN text', noAnchor.tier, 'own_text');
check('picked the nested reply, not the parent', noAnchor.idx, 2);

// Force the legacy whole-article tier: own text unavailable.
const legacy = chooseReplyTarget(realThread({ ownText: '' }), {
  anchorId: null, commenterName: '2w', snippet: TARGET_TEXT.slice(0, 80),
});
console.log(`        -> ${JSON.stringify(legacy)}`);
check('falls back to whole-article text', legacy.tier, 'article_text');
check('deepest-wins still beats the containing parent', legacy.idx, 2);

// ─── 7. Name is a tiebreak, never a gate ───────────────────────────────────
section('7. A wrong-but-trustworthy name cannot block a comment-id match');
const wrongName = chooseReplyTarget(realThread(), {
  anchorId: TARGET_ID,
  commenterName: 'Someone Else Entirely',   // trustworthy shape, matches nothing
  snippet: TARGET_TEXT.slice(0, 80),
});
check('still resolves', wrongName.ok, true);
check('still the right article', wrongName.idx, 2);
check('no name narrowing applied (single match)', wrongName.narrowedByName, false);

section('8. A trustworthy name DOES disambiguate duplicates');
const dupThread = [
  { idx: 1, depth: 0, ariaLabel: 'Comment by Alice Adams 2 weeks ago', ownAnchorIds: ['111'], ownText: 'same words here', articleText: 'same words here', hasOwnReplyButton: true, ancestorArticleIdxs: [] },
  { idx: 2, depth: 0, ariaLabel: 'Comment by Bob Brown 2 weeks ago', ownAnchorIds: ['222'], ownText: 'same words here', articleText: 'same words here', hasOwnReplyButton: true, ancestorArticleIdxs: [] },
];
const dis = chooseReplyTarget(dupThread, { anchorId: null, commenterName: 'Bob Brown', snippet: 'same words here' });
check('narrowed by name', dis.narrowedByName, true);
check('picked Bob', dis.idx, 2);
const ambiguous = chooseReplyTarget(dupThread, { anchorId: null, commenterName: '2w', snippet: 'same words here' });
check('an untrustworthy name does NOT narrow', ambiguous.narrowedByName, false);
check('and it still resolves deterministically (document order)', ambiguous.idx, 1);

// ─── 9. Nested reply with no Reply button of its own ───────────────────────
section('9. Deeply nested reply falls back to the ancestor\'s Reply button');
const noBtn = chooseReplyTarget(realThread({ hasOwnReplyButton: false }), {
  anchorId: TARGET_ID, commenterName: '2w', snippet: TARGET_TEXT.slice(0, 80),
});
console.log(`        -> ${JSON.stringify(noBtn)}`);
check('still resolves', noBtn.ok, true);
check('target is still the nested reply', noBtn.idx, 2);
check('but the button comes from the parent', [noBtn.replyButtonFrom, noBtn.buttonSource], [1, 'ancestor']);

// ─── 10. Honest failures ───────────────────────────────────────────────────
section('10. Genuine misses report WHY, and never throw');
const miss = chooseReplyTarget(realThread(), { anchorId: '999999', commenterName: '2w', snippet: 'not in this thread at all' });
check('reports no match', [miss.ok, miss.reason], [false, 'no_article_match']);
check('and how many comment articles it saw', miss.candidateCount, 2);
const empty = chooseReplyTarget([], { anchorId: TARGET_ID, commenterName: 'x', snippet: 'y' });
check('empty page reports no comment articles', [empty.ok, empty.reason], [false, 'no_comment_articles']);
const noButtons = chooseReplyTarget(
  [{ idx: 1, depth: 0, ariaLabel: 'Comment by Alice Adams 2 weeks ago', ownAnchorIds: ['111'], ownText: 'hello', articleText: 'hello', hasOwnReplyButton: false, ancestorArticleIdxs: [] }],
  { anchorId: '111', commenterName: 'Alice Adams', snippet: 'hello' },
);
check('no button anywhere is its own distinct reason', [noButtons.ok, noButtons.reason], [false, 'no_reply_button']);

// ─── 11. The old locator would still fail (guards the regression) ──────────
section('11. The OLD name-gated locator fails this thread — proving the fix matters');
function oldLocator(candidates, { commenterName, snippet }) {
  // Verbatim logic of the pre-fix locator: aria-label must contain the stored
  // name, whole-article text must contain the snippet, first Reply button wins.
  for (const c of candidates) {
    if (!/^(Comment|Reply) by /i.test(c.ariaLabel)) continue;
    if (!c.ariaLabel.toLowerCase().includes(String(commenterName).toLowerCase())) continue;
    if (!c.articleText.includes(snippet)) continue;
    return { ok: true, idx: c.idx };
  }
  return { ok: false };
}
const oldResult = oldLocator(realThread(), { commenterName: '2w', snippet: TARGET_TEXT.slice(0, 80) });
check('old locator finds nothing (the production failure)', oldResult.ok, false);
check('new locator finds it', chooseReplyTarget(realThread(), { anchorId: TARGET_ID, commenterName: '2w', snippet: TARGET_TEXT.slice(0, 80) }).ok, true);

console.log(`\n${'='.repeat(64)}`);
console.log(`${pass} passed, ${fail} failed`);
if (fail) { console.log(`FAILED: ${failures.join(', ')}`); process.exit(1); }
console.log('ALL GREEN');
