#!/usr/bin/env node
'use strict';

// scripts/regression-zernio-comment-engine.js
//
// Regression coverage for the Zernio comment engine. No network, no database:
// global.fetch is stubbed so every assertion is deterministic.
//
// The cases here are not hypotheticals. Each one is a failure that either
// already happened in this codebase or is a live trap in the Zernio API,
// verified 2026-09-25:
//
//   1. The API IGNORES isActive:false on create. An automation is born LIVE.
//   2. If we cannot CONFIRM it went paused, we must delete it, not keep it.
//   3. Facebook caps inline replies at 10 and flags repliesHasMore. Not
//      paging that loses comments silently, which breaks "nothing is lost".
//   4. Our own comments must not be ingested as inbound work.
//   5. A keyword claimed by two videos must be REFUSED, never overwritten.
//   6. The reply cap key must exist, or canComment() fails closed forever.
//
// Run: node scripts/regression-zernio-comment-engine.js

process.env.ZERNIO_API_KEY = process.env.ZERNIO_API_KEY || 'test-key-not-real';

const assert = require('assert');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passed += 1; console.log(`  PASS  ${name}`); },
        (e) => { failed += 1; console.log(`  FAIL  ${name}\n        ${e.message}`); },
      );
    }
    passed += 1;
    console.log(`  PASS  ${name}`);
    return Promise.resolve();
  } catch (e) {
    failed += 1;
    console.log(`  FAIL  ${name}\n        ${e.message}`);
    return Promise.resolve();
  }
}

/** Minimal fetch stub. routes: [{ match(url, init), status, body }] */
function stubFetch(routes) {
  const calls = [];
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase(), body: init.body ? JSON.parse(init.body) : null });
    for (const r of routes) {
      if (r.match(u, init)) {
        const payload = typeof r.body === 'function' ? r.body(u, init) : r.body;
        return {
          ok: (r.status || 200) < 400,
          status: r.status || 200,
          headers: { get: (h) => (h.toLowerCase() === 'x-ratelimit-remaining' ? '599' : null) },
          text: async () => JSON.stringify(payload),
        };
      }
    }
    throw new Error(`unstubbed fetch: ${(init.method || 'GET')} ${u}`);
  };
  return calls;
}

(async () => {
  console.log('\nZERNIO COMMENT ENGINE REGRESSION\n');

  const zc = require('../api/_lib/zernio-comments.js');
  const caps = require('./_lib/comment-caps.js');
  const monitor = require('../api/cron-comment-monitor.js');

  // ── 1 + 2. The create-is-always-live trap ──────────────────────────────
  await test('createAutomation pauses an automation the API returned as ACTIVE', async () => {
    let active = true;
    const calls = stubFetch([
      {
        match: (u, i) => u.endsWith('/comment-automations') && (i.method || '').toUpperCase() === 'POST',
        // The real API's documented-but-false behaviour: isActive:false in,
        // isActive:true out.
        body: { success: true, automation: { id: 'auto1', isActive: true } },
      },
      {
        match: (u, i) => u.includes('/comment-automations/auto1') && (i.method || '').toUpperCase() === 'PATCH',
        body: () => { active = false; return { success: true, automation: { id: 'auto1', isActive: false } }; },
      },
      {
        match: (u, i) => u.includes('/comment-automations/auto1') && (i.method || 'GET').toUpperCase() === 'GET',
        body: () => ({ success: true, automation: { id: 'auto1', isActive: active } }),
      },
    ]);

    const r = await zc.createAutomation({
      profileId: 'p', accountId: 'a', platformPostId: 'post1',
      name: 'dossie-video:v1', keywords: ['TREC'], dmMessage: 'hi', activate: false,
    });
    assert.strictEqual(r.ok, true, 'expected success');
    assert.strictEqual(r.automation.isActive, false, 'must report the automation as paused');
    assert.ok(calls.some((c) => c.method === 'PATCH'), 'must PATCH isActive false after create');
    assert.ok(calls.filter((c) => c.method === 'GET').length >= 1, 'must re-read to confirm, not trust the write');
  });

  await test('createAutomation DELETES the automation when it cannot confirm it is paused', async () => {
    const calls = stubFetch([
      {
        match: (u, i) => u.endsWith('/comment-automations') && (i.method || '').toUpperCase() === 'POST',
        body: { success: true, automation: { id: 'auto2', isActive: true } },
      },
      {
        match: (u, i) => u.includes('/comment-automations/auto2') && (i.method || '').toUpperCase() === 'PATCH',
        body: { success: true, automation: { id: 'auto2', isActive: true } }, // pause did NOT take
      },
      {
        match: (u, i) => u.includes('/comment-automations/auto2') && (i.method || 'GET').toUpperCase() === 'GET',
        body: { success: true, automation: { id: 'auto2', isActive: true } },
      },
      {
        match: (u, i) => u.includes('/comment-automations/auto2') && (i.method || '').toUpperCase() === 'DELETE',
        body: { success: true },
      },
    ]);

    const r = await zc.createAutomation({
      profileId: 'p', accountId: 'a', platformPostId: 'post1',
      name: 'dossie-video:v1', keywords: ['TREC'], dmMessage: 'hi', activate: false,
    });
    assert.strictEqual(r.ok, false, 'must report failure when the paused state is unproven');
    assert.strictEqual(r.automation, null);
    assert.ok(calls.some((c) => c.method === 'DELETE'), 'an automation we cannot prove is off must be deleted');
  });

  // ── 3. Facebook's 10-inline-reply cap ──────────────────────────────────
  await test('getPostComments pages past the 10-inline-reply cap (repliesHasMore)', async () => {
    stubFetch([
      {
        match: (u) => u.includes('/inbox/comments/p1') && u.includes('commentId=c1'),
        body: {
          status: 'success',
          comments: [{ id: 'r11', message: 'eleventh reply', from: { id: 'u11', name: 'Deep' } }],
          pagination: { hasMore: false },
        },
      },
      {
        match: (u) => u.includes('/inbox/comments/p1'),
        body: {
          status: 'success',
          comments: [{
            id: 'c1',
            message: 'top level',
            from: { id: 'u1', name: 'Asker' },
            repliesHasMore: true,
            replies: [{ id: 'r1', message: 'inline reply', from: { id: 'u2', name: 'Other' } }],
          }],
          pagination: { hasMore: false },
        },
      },
    ]);

    const { comments } = await zc.getPostComments({ postId: 'p1', accountId: 'a1', platform: 'facebook' });
    const ids = comments.map((c) => c.id);
    assert.ok(ids.includes('c1'), 'top-level comment');
    assert.ok(ids.includes('r1'), 'inline reply');
    assert.ok(ids.includes('r11'), 'reply past the inline cap must be fetched, not silently lost');
    assert.strictEqual(comments.find((c) => c.id === 'r1').parentId, 'c1', 'reply must carry its parent');
  });

  // ── 4. Our own comments are not inbound work ───────────────────────────
  await test('toRow maps a comment to a replyable row, carrying account_id', () => {
    const row = monitor.toRow(
      {
        id: 'cmt1',
        message: 'how much is it',
        createdTime: '2026-09-25T13:00:00Z',
        from: { id: 'u9', name: 'Antonio Edwards', username: 'antoniojedwards' },
        url: 'https://x/comment',
        parentId: null,
      },
      { id: 'post9', accountId: 'acct9', platform: 'linkedin', permalink: 'https://x/post', content: 'post body' },
    );
    // account_id is the field whose absence made every previously-ingestable
    // row unreplyable: every comment read AND write needs it.
    assert.strictEqual(row.account_id, 'acct9');
    assert.strictEqual(row.external_post_id, 'post9');
    assert.strictEqual(row.comment_external_id, 'cmt1');
    assert.strictEqual(row.reply_status, 'new');
    assert.strictEqual(row.thread_status, 'open');
    assert.strictEqual(row.commenter_handle, 'antoniojedwards');
  });

  // ── 5. Keyword collisions ──────────────────────────────────────────────
  await test('syncVideoAutomations REFUSES a keyword claimed by two videos', async () => {
    const vca = require('../api/_lib/video-comment-automations.js');
    stubFetch([
      { match: (u) => u.includes('/ops_flags'), body: [{ enabled: false }] },
      {
        match: (u) => u.includes('/video_library'),
        body: [
          { id: 'vid-a', status: 'posted', dm_keyword: 'TREC', dm_asset_url: 'https://x/a.pdf', zernio_deliveries: [{ zernio_post_id: 'z1' }] },
          { id: 'vid-b', status: 'posted', dm_keyword: 'trec', dm_asset_url: 'https://x/b.pdf', zernio_deliveries: [{ zernio_post_id: 'z2' }] },
        ],
      },
      { match: (u) => u.includes('/video_comment_automations'), body: [] },
      { match: (u) => u.includes('/comment-automations'), body: { success: true, automations: [] } },
    ]);

    const r = await vca.syncVideoAutomations({ supabaseUrl: 'https://sb', serviceKey: 'k', dryRun: true });
    assert.strictEqual(r.collisions.length, 1, 'the collision must be reported');
    assert.deepStrictEqual(r.collisions[0].videos.sort(), ['vid-a', 'vid-b']);
    // Case-insensitive: 'TREC' and 'trec' are the SAME attribution token.
    assert.strictEqual(r.plan.filter((p) => p.action === 'create').length, 0, 'neither video may arm');
    assert.ok(r.plan.every((p) => p.action !== 'update'), 'a collision must never overwrite the existing owner');
  });

  await test('an unreachable asset URL blocks arming instead of promising a dead link', async () => {
    const vca = require('../api/_lib/video-comment-automations.js');
    stubFetch([
      { match: (u) => u.includes('/ops_flags'), body: [{ enabled: false }] },
      {
        match: (u) => u.includes('/video_library'),
        body: [{ id: 'vid-c', status: 'posted', dm_keyword: 'GUIDE', dm_asset_url: 'https://x/missing.pdf', zernio_deliveries: [{ zernio_post_id: 'z3' }] }],
      },
      { match: (u) => u.includes('/video_comment_automations'), body: [] },
      { match: (u) => u === 'https://x/missing.pdf', status: 404, body: {} },
      { match: (u) => u.includes('/comment-automations'), body: { success: true, automations: [] } },
    ]);
    const r = await vca.syncVideoAutomations({ supabaseUrl: 'https://sb', serviceKey: 'k', dryRun: true });
    const skip = r.plan.find((p) => p.video === 'vid-c');
    assert.strictEqual(skip.action, 'skip');
    assert.ok(String(skip.reason).startsWith('asset_http_404'), `expected an asset failure, got ${skip.reason}`);
  });

  await test('a retracted video plans a RETIRE, never a create', async () => {
    const vca = require('../api/_lib/video-comment-automations.js');
    stubFetch([
      { match: (u) => u.includes('/ops_flags'), body: [{ enabled: false }] },
      {
        match: (u) => u.includes('/video_library'),
        body: [{ id: 'vid-d', status: 'rejected', retracted_at: '2026-09-25T00:00:00Z', dm_keyword: 'PULLED', dm_asset_url: 'https://x/a.pdf', zernio_deliveries: [{ zernio_post_id: 'z4' }] }],
      },
      {
        match: (u) => u.includes('/video_comment_automations'),
        body: [{ id: 'led1', video_library_id: 'vid-d', account_id: 'acct1', keyword: 'PULLED', status: 'armed', zernio_automation_id: 'autoX' }],
      },
      { match: (u) => u.includes('/comment-automations'), body: { success: true, automations: [] } },
    ]);
    const r = await vca.syncVideoAutomations({ supabaseUrl: 'https://sb', serviceKey: 'k', dryRun: true });
    const act = r.plan.find((p) => p.video === 'vid-d');
    assert.strictEqual(act.action, 'retire', 'a pulled video must not keep DMing people');
    assert.strictEqual(act.reason, 'video_retracted');
  });

  // ── 6. The cap key must exist ──────────────────────────────────────────
  await test('the zernio_comment_reply cap key exists and is counted', () => {
    assert.ok('zernio_comment_reply' in caps.PLATFORM_DAILY_CAPS, 'missing key means canComment fails closed forever');
    assert.ok(caps.MIN_GAP_MINUTES.zernio_comment_reply > 0, 'a missing gap silently falls back to 8 min');
    const sum = Object.values(caps.PLATFORM_DAILY_CAPS).reduce((a, b) => a + b, 0);
    assert.strictEqual(
      caps.TOTAL_DAILY_CAP, sum,
      `TOTAL_DAILY_CAP (${caps.TOTAL_DAILY_CAP}) must equal the sum of the per-platform caps (${sum}) or the new budget starves an existing pipeline`,
    );
  });

  await test('the sync never touches an automation it did not create', async () => {
    const vca = require('../api/_lib/video-comment-automations.js');
    stubFetch([
      { match: (u) => u.includes('/ops_flags'), body: [{ enabled: true }] },
      { match: (u) => u.includes('/video_library'), body: [] },
      { match: (u) => u.includes('/video_comment_automations'), body: [] },
      {
        match: (u) => u.includes('/comment-automations'),
        body: {
          success: true,
          automations: [
            { id: 'manual1', name: 'Heath made this by hand', keywords: ['X'], isActive: true },
            { id: 'ours1', name: `${vca.NAME_PREFIX}vid-z`, keywords: ['Y'], isActive: true },
          ],
        },
      },
    ]);
    const r = await vca.syncVideoAutomations({ supabaseUrl: 'https://sb', serviceKey: 'k', dryRun: true });
    const ids = r.orphans.map((o) => o.automationId);
    assert.ok(ids.includes('ours1'), 'our own orphan must be reported');
    assert.ok(!ids.includes('manual1'), 'an automation made by hand in the Zernio UI must never be touched');
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
