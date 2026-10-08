#!/usr/bin/env node
'use strict';

/**
 * Regression test for the zernio_post_id write-back gap (Atlas 2026-09-30).
 *
 * Root cause: api/cron-verify-posts.js's own pushToZernio() had a narrower
 * post-id extraction fallback chain than api/cron-publish-approved.js's,
 * and never checked `data.post._id` — the actual shape Zernio returns for
 * a publishNow response (verified against real production logs for posts
 * a277a0cb-0dd0-48b7-aaa0-0602390fbdaa and 819c86d1-f6ab-478b-b15f-e6be715ff5bb,
 * both `{"post":{"_id":"..."}}`). This pins down:
 *
 *   1. The real Zernio response shape extracts correctly (regression guard
 *      against the exact bug that shipped).
 *   2. A 2xx with NO extractable id is flagged unverified, not silently
 *      treated as a clean 'posted'.
 *   3. Every known response shape both pushToZernio() implementations
 *      (cron-publish-approved.js and cron-verify-posts.js) claim to support
 *      actually extracts to the same value from each.
 *
 * Pure-function test — duplicates the extraction expression rather than
 * importing the module (both files wrap it inside a network call), so this
 * intentionally must be kept in sync by hand if either extraction chain
 * changes. Network-free, no env vars required.
 */

function extractNarrow(data) {
  // cron-verify-posts.js's chain, pre-fix (kept here to prove OLD behavior
  // really did fail on the real shape — do not "fix" this copy).
  return data?.id || data?.post_id || data?.postId || data?.data?.id || null;
}

function extractFull(data) {
  // Shared chain now used by BOTH cron-publish-approved.js's pushToZernio()
  // and cron-verify-posts.js's pushToZernio() post-fix.
  return (
    data?.id ||
    data?.post_id ||
    data?.postId ||
    data?.post?._id ||
    data?.data?.id ||
    data?.data?.post_id ||
    data?.data?.postId ||
    (Array.isArray(data?.posts) && data.posts[0]?.id) ||
    (Array.isArray(data?.results) && data.results[0]?.id) ||
    (Array.isArray(data?.data?.posts) && data.data.posts[0]?.id) ||
    (data?.post?.platforms && Array.isArray(data.post.platforms) && data.post.platforms[0]?._id) ||
    null
  );
}

let pass = 0;
let fail = 0;
function check(label, cond) {
  if (cond) { pass++; console.log(`  PASS: ${label}`); }
  else { fail++; console.error(`  FAIL: ${label}`); }
}

console.log('Test 1: the real production response shape (a277a0cb, linkedin retry, 2026-09-30)');
{
  // Captured verbatim from Vercel prod logs, [cron-verify-posts] Zernio
  // retry response for a277a0cb-0dd0-48b7-aaa0-0602390fbdaa.
  const realResponse = { post: { _id: '6abd1263aa259c6d642a19d3', userId: '69f153b46a7884e8dce101ee', title: '', content: '...' } };
  check('OLD narrow chain fails to extract (proves the bug was real)', extractNarrow(realResponse) === null);
  check('NEW full chain extracts the real id', extractFull(realResponse) === '6abd1263aa259c6d642a19d3');
}

console.log('\nTest 2: the real production response shape (819c86d1, facebook retry, 2026-09-30)');
{
  const realResponse = { post: { _id: '6abd206f093f02b17213fbb7', userId: '69f153b46a7884e8dce101ee', title: '', content: '...' } };
  check('OLD narrow chain fails to extract (proves the bug was real)', extractNarrow(realResponse) === null);
  check('NEW full chain extracts the real id', extractFull(realResponse) === '6abd206f093f02b17213fbb7');
}

console.log('\nTest 3: other known shapes still extract correctly (no regression on prior fixes)');
{
  check('bare {id}', extractFull({ id: 'abc' }) === 'abc');
  check('{post_id}', extractFull({ post_id: 'abc' }) === 'abc');
  check('{data:{id}}', extractFull({ data: { id: 'abc' } }) === 'abc');
  check('{posts:[{id}]} fan-out', extractFull({ posts: [{ id: 'abc' }] }) === 'abc');
  check('{post:{platforms:[{_id}]}} nested fallback', extractFull({ post: { platforms: [{ _id: 'abc' }] } }) === 'abc');
}

console.log('\nTest 4: a genuinely empty/unrecognized response is null, not a fabricated id');
{
  check('empty object', extractFull({}) === null);
  check('null data', extractFull(null) === null);
  check('unrelated shape', extractFull({ foo: 'bar' }) === null);
}

console.log('\nTest 5: the write-back decision itself can never produce status=posted with no id');
{
  // Mirrors the exact decision expression now used in both
  // cron-publish-approved.js and cron-verify-posts.js:
  //   const unverified = !!result.unverified || !result.zernio_post_id;
  //   status: unverified ? 'posted_unverified' : 'posted'
  function decideStatus(result) {
    const unverified = !!result.unverified || !result.zernio_post_id;
    return { status: unverified ? 'posted_unverified' : 'posted', zernio_post_id: result.zernio_post_id || null };
  }

  const noId = decideStatus({ ok: true, zernio_post_id: null });
  check('no id -> posted_unverified, never posted', noId.status === 'posted_unverified');
  check('no id -> zernio_post_id stays null (not fabricated)', noId.zernio_post_id === null);

  const explicitUnverified = decideStatus({ ok: true, zernio_post_id: 'something', unverified: true });
  check('explicit unverified flag always wins even if an id slipped through', explicitUnverified.status === 'posted_unverified');

  const realId = decideStatus({ ok: true, zernio_post_id: '6abd1263aa259c6d642a19d3' });
  check('a real id -> posted (verified)', realId.status === 'posted');
  check('a real id is preserved on the row', realId.zernio_post_id === '6abd1263aa259c6d642a19d3');

  // Exhaustive: for a large random sample, status='posted' NEVER coexists
  // with zernio_post_id=null — the invariant this whole fix exists for.
  let violations = 0;
  for (let i = 0; i < 1000; i++) {
    const hasId = Math.random() > 0.5;
    const unverifiedFlag = Math.random() > 0.8;
    const r = decideStatus({ ok: true, zernio_post_id: hasId ? `id-${i}` : null, unverified: unverifiedFlag });
    if (r.status === 'posted' && !r.zernio_post_id) violations++;
  }
  check('1000-sample fuzz: zero (posted + null id) violations', violations === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
