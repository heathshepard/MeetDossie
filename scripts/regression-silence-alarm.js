#!/usr/bin/env node
'use strict';

/**
 * Regression test for the silence alarm
 * (api/_lib/silence-alarm.js + api/cron-silence-alarm.js).
 *
 * Heath, 2026-09-12: Instagram hadn't posted in 18 days, TikTok has
 * essentially never posted, and nobody noticed until he said something.
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. Platform silence fires when the last successful post for a
 *      (platform, owner) pair is older than the threshold, AND names the
 *      real backlog reason (not a generic "something's wrong").
 *   2. A pair with NO recent generation activity (genuinely dormant, not
 *      broken) never fires — avoids false alarms on accounts with no
 *      content plan.
 *   3. Dedup: firing once marks alert_state; a second run immediately after
 *      does NOT fire again (suppressed) — "once per condition per day".
 *   4. Stale-approvals / stale-drafts / accumulating-backlog conditions each
 *      fire with an accurate count and are independently dedupable.
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access, no
 * Telegram, no real DB.
 *
 * Run manually:
 *   node scripts/regression-silence-alarm.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr.startsWith('like.')) {
    // Only the `*substring*` shape used by this codebase is supported --
    // strip the wildcards and do a plain (case-sensitive) substring test.
    const pattern = decodeURIComponent(expr.slice(5)).replace(/^\*|\*$/g, '');
    return row[key] != null && String(row[key]).includes(pattern);
  }
  return true;
}

function startMockSupabase(seed) {
  const db = {
    social_posts: (seed.social_posts || []).map((r) => ({ ...r })),
    group_posts: (seed.group_posts || []).map((r) => ({ ...r })),
    video_library: (seed.video_library || []).map((r) => ({ ...r })),
    fb_comment_replies: (seed.fb_comment_replies || []).map((r) => ({ ...r })),
    tc_discovery_responses: (seed.tc_discovery_responses || []).map((r) => ({ ...r })),
    comment_opportunities: (seed.comment_opportunities || []).map((r) => ({ ...r })),
    alert_state: (seed.alert_state || []).map((r) => ({ ...r })),
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const rows = db[table];
      if (!rows) { res.writeHead(404); res.end('{}'); return; }

      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
      let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      if (q.order) {
        const [col, dir] = q.order.split('.');
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return cmp * (dir === 'desc' ? -1 : 1);
        });
      }
      if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
        return;
      }

      if (req.method === 'PATCH') {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* noop */ }
        for (const r of matched) Object.assign(r, body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      if (req.method === 'POST') {
        // alert_state upsert (on_conflict=key, merge-duplicates).
        let body = {};
        try { body = JSON.parse(raw); } catch { /* noop */ }
        const existing = rows.find((r) => r.key === body.key);
        if (existing) Object.assign(existing, body);
        else rows.push({ ...body });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, db });
    });
  });
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
}
function hoursAgo(n) {
  return new Date(Date.now() - n * 60 * 60 * 1000).toISOString();
}

async function run() {
  let pass = 0;
  let fail = 0;
  function check(name, fn) {
    try {
      fn();
      console.log(`  PASS: ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL: ${name}\n    ${err.message}`);
      fail++;
    }
  }

  const seed = {
    social_posts: [
      // instagram/dossie: recent activity, but last real post 18 days ago —
      // matches the real Heath complaint exactly. Must fire.
      { id: 'ig-1', platform: 'instagram', target_owner: 'dossie', status: 'draft', telegram_sent_at: hoursAgo(23), created_at: daysAgo(1) },
      { id: 'ig-2', platform: 'instagram', target_owner: 'dossie', status: 'video_failed', created_at: daysAgo(2) },
      { id: 'ig-3', platform: 'instagram', target_owner: 'dossie', status: 'posted', posted_at: daysAgo(18), created_at: daysAgo(18) },
      // facebook/dossie: posted yesterday — must NOT fire.
      { id: 'fb-1', platform: 'facebook', target_owner: 'dossie', status: 'posted', posted_at: hoursAgo(20), created_at: hoursAgo(20) },
      // tiktok/heath-realtor: no rows at all -> no recent activity -> must NOT fire (dormant pair, not broken).
      // (no fixture rows needed — absence is the point)
      // stale approval: approved 72h ago, still not posted.
      { id: 'stale-appr-1', platform: 'linkedin', target_owner: 'dossie', status: 'approved', approved_at: hoursAgo(72), created_at: daysAgo(4) },
      // stale draft: created 30h ago, never sent to telegram.
      { id: 'stale-draft-1', platform: 'twitter', target_owner: 'dossie', status: 'draft', telegram_sent_at: null, created_at: hoursAgo(30) },
    ],
    group_posts: [
      // In the 48h hot window, real permalink, but no harvest in >24h — must fire tc_harvest_hot_window_stale.
      { id: 'gp-hot-stale', group_name: 'DFW Realtors', category: 'tc_discovery_research', status: 'posted', post_url: 'https://www.facebook.com/groups/1/posts/111/', posted_at: hoursAgo(30), last_harvested_at: hoursAgo(28), harvest_count: 3 },
      // Never-harvested, real permalink, >3h old -> scope-gap fires (this is the exact 2026-09-15 bug: category filter excluded it).
      { id: 'gp-scope-gap', group_name: 'Stone Oak Neighborhood', category: 'listing-groups', status: 'posted', post_url: 'https://www.facebook.com/groups/2/posts/222/', posted_at: hoursAgo(10), last_harvested_at: null, harvest_count: 0 },
      // Never-harvested, NO real permalink (group-URL fallback) -> separate no-permalink condition, not scope-gap.
      { id: 'gp-no-permalink', group_name: 'Realtors SA Boerne', category: 'listing-groups', status: 'posted', post_url: 'https://www.facebook.com/groups/999999/', posted_at: hoursAgo(10), last_harvested_at: null, harvest_count: 0 },
    ],
    video_library: [
      { id: 'vid-1', status: 'pending_heath_review', topic: 'feature-demo-x', platforms: ['tiktok', 'instagram'], created_at: hoursAgo(96) },
    ],
    fb_comment_replies: [
      // Stale unverified submit (2026-09-17 fix) -- must fire.
      { id: 'reply-unverified-stale', reply_author: 'Jane Doe', status: 'failed', reply_error: 'unconfirmed_submit: composer closed / no error shown, but no permalink captured and no feed match found', posted_at: hoursAgo(30) },
      // Same shape but recent -- inside the threshold, must NOT fire yet.
      { id: 'reply-unverified-fresh', reply_author: 'Fresh Fresh', status: 'failed', reply_error: 'unconfirmed_submit: composer closed / no error shown, but no permalink captured and no feed match found', posted_at: hoursAgo(2) },
      // Genuinely posted -- must never be counted.
      { id: 'reply-posted', reply_author: 'Posted Person', status: 'posted', reply_error: null, posted_at: hoursAgo(30), verified_at: hoursAgo(30) },
      // Pre-submit failure reset to approved for retry -- different status entirely, must never be counted.
      { id: 'reply-retryable', reply_author: 'Retry Me', status: 'approved', reply_error: 'could not locate Reply button for the comment', posted_at: null },
    ],
    tc_discovery_responses: [
      // Stale unverified submit on the LIVE tc-reply-queue pipeline -- must fire.
      { id: 'tc-unverified-stale', commenter_name: 'John Q', reply_status: 'post_failed', reply_error: 'submitted but verification could not find the reply in the re-rendered thread', updated_at: hoursAgo(30) },
      // A clean pre-submit failure (nothing typed) -- must NOT be counted as "unverified", different reason prefix.
      { id: 'tc-not-submitted', commenter_name: 'Clean Fail', reply_status: 'post_failed', reply_error: 'not_submitted: could not locate Reply button', updated_at: hoursAgo(30) },
    ],
    // The 2026-09-15 -> 2026-09-17 comment-opportunity pipeline gap: real
    // history (every found_at older than the 24h window) so the scanner
    // fires as silent, plus one approved row that never posted.
    comment_opportunities: [
      { id: 'co-old-1', group_name: 'DFW Realtors', found_at: hoursAgo(50), status: 'rejected' },
      { id: 'co-old-2', group_name: 'Keller Williams Real Estate Group', found_at: hoursAgo(40), status: 'posted' },
      { id: 'co-approved-stale', group_name: 'DFW Realtors', found_at: hoursAgo(60), status: 'approved', approved_at: hoursAgo(30) },
    ],
    alert_state: [],
  };

  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  let lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('\nTest 1: platform silence — fires for instagram/dossie, names the real reason');
  const silence = await lib.checkPlatformSilence(3);
  const igCondition = silence.find((c) => c.key === 'silence:instagram:dossie');
  check('instagram/dossie condition fired', () => assert.ok(igCondition, `expected a silence condition for instagram/dossie, got: ${JSON.stringify(silence.map((s) => s.key))}`));
  check('message names days silent (18)', () => assert.ok(/18 days/.test(igCondition.message), `expected "18 days" in message, got: ${igCondition.message}`));
  check('message names the real backlog reason (draft/video_failed counts)', () => {
    assert.ok(/video_failed/.test(igCondition.message) && /draft/.test(igCondition.message), `expected backlog composition in message, got: ${igCondition.message}`);
  });
  check('facebook/dossie (posted 20h ago) does NOT fire', () => assert.ok(!silence.find((c) => c.key === 'silence:facebook:dossie')));
  check('tiktok/heath-realtor (no activity at all) does NOT fire — dormant, not broken', () => assert.ok(!silence.find((c) => c.key === 'silence:tiktok:heath-realtor')));

  console.log('\nTest 2: stale approvals / stale drafts / video_library pending review');
  const approvals = await lib.checkStaleApprovals(48);
  check('stale approval on linkedin fires with count 1', () => {
    const c = approvals.find((x) => x.key === 'approvals_stale:social_posts');
    assert.ok(c, 'expected approvals_stale:social_posts to fire');
    assert.strictEqual(c.count, 1);
  });

  const drafts = await lib.checkStaleDrafts(24);
  check('stale draft on twitter fires with count 1', () => {
    const c = drafts.find((x) => x.key === 'drafts_stale:social_posts');
    assert.ok(c, 'expected drafts_stale:social_posts to fire');
    assert.strictEqual(c.count, 1);
  });

  const videoReview = await lib.checkVideoLibraryPendingReview(48);
  check('video_library pending review fires and names target platforms', () => {
    assert.strictEqual(videoReview.length, 1);
    assert.ok(/tiktok/.test(videoReview[0].message) && /instagram/.test(videoReview[0].message), `expected platforms named, got: ${videoReview[0].message}`);
  });

  console.log('\nTest 2b: TC-discovery host-comment harvest staleness + scope-gap (2026-09-15)');
  const hotStale = await lib.checkTcHarvestHotWindowStale(24, 48);
  check('hot-window post with no harvest in >24h fires tc_harvest_hot_window_stale', () => {
    const c = hotStale.find((x) => x.key === 'tc_harvest_hot_window_stale');
    assert.ok(c, `expected tc_harvest_hot_window_stale to fire, got: ${JSON.stringify(hotStale.map((x) => x.key))}`);
    // Both gp-hot-stale (last harvested 28h ago) AND gp-scope-gap (posted
    // 10h ago, never harvested) are within the 48h hot window with no
    // harvest inside the last 24h — count covers every eligible row, not
    // just the one that triggered the check.
    assert.strictEqual(c.count, 2);
  });

  const scopeGap = await lib.checkTcHarvestScopeGap(3);
  check('never-harvested row with a real permalink fires tc_harvest_scope_gap', () => {
    const c = scopeGap.find((x) => x.key === 'tc_harvest_scope_gap');
    assert.ok(c, `expected tc_harvest_scope_gap to fire, got: ${JSON.stringify(scopeGap.map((x) => x.key))}`);
    assert.ok(/Stone Oak Neighborhood/.test(c.message), `expected the scope-gap post named, got: ${c.message}`);
    assert.ok(!/Realtors SA Boerne/.test(c.message), 'the no-permalink row must NOT be counted as a scope gap');
  });
  check('never-harvested row with NO real permalink fires the separate tc_harvest_no_permalink condition', () => {
    const c = scopeGap.find((x) => x.key === 'tc_harvest_no_permalink');
    assert.ok(c, `expected tc_harvest_no_permalink to fire, got: ${JSON.stringify(scopeGap.map((x) => x.key))}`);
    assert.ok(/Realtors SA Boerne/.test(c.message), `expected the no-permalink post named, got: ${c.message}`);
  });

  console.log('\nTest 2c: legitimate long-tail silence (past the 48h hot window) does NOT fire — avoids false alarms');
  const quietSeed = [{ id: 'gp-long-tail', group_name: 'Texas Realtors', category: 'tc_discovery_research', status: 'posted', post_url: 'https://www.facebook.com/groups/3/posts/333/', posted_at: daysAgo(6), last_harvested_at: daysAgo(3), harvest_count: 8 }];
  const quietMock = await startMockSupabase({ ...seed, group_posts: quietSeed });
  process.env.SUPABASE_URL = `http://127.0.0.1:${quietMock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const quietLib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));
  const quietHotStale = await quietLib.checkTcHarvestHotWindowStale(24, 48);
  check('a post 6 days old, last harvested 3 days ago (legit long-tail cadence) does NOT fire hot-window-stale', () => {
    assert.strictEqual(quietHotStale.length, 0, `expected no hot-window alert for a long-tail-only post, got: ${JSON.stringify(quietHotStale)}`);
  });
  quietMock.server.close();
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('\nTest 2d: unverified reply submits (2026-09-17 fix) — stuck, never auto-retried, must surface');
  const unverifiedReplies = await lib.checkUnverifiedRepliesStuck(24);
  check('fb_comment_replies: stale unconfirmed submit fires', () => {
    const c = unverifiedReplies.find((x) => x.key === 'unverified_reply_stuck:fb_comment_replies');
    assert.ok(c, `expected unverified_reply_stuck:fb_comment_replies to fire, got: ${JSON.stringify(unverifiedReplies.map((x) => x.key))}`);
    assert.strictEqual(c.count, 1, 'the fresh (2h old) unconfirmed row must not be counted yet');
    assert.ok(/Jane Doe/.test(c.message));
  });
  check('tc_discovery_responses: stale unconfirmed submit fires, separately from fb_comment_replies', () => {
    const c = unverifiedReplies.find((x) => x.key === 'unverified_reply_stuck:tc_discovery_responses');
    assert.ok(c, `expected unverified_reply_stuck:tc_discovery_responses to fire, got: ${JSON.stringify(unverifiedReplies.map((x) => x.key))}`);
    assert.strictEqual(c.count, 1, 'the not_submitted row must not be counted as unverified');
    assert.ok(/John Q/.test(c.message));
  });
  check('a genuinely posted reply is never counted', () => {
    for (const c of unverifiedReplies) assert.ok(!/Posted Person/.test(c.message));
  });
  check('a pre-submit failure reset to approved (safe retry) is never counted as unverified', () => {
    for (const c of unverifiedReplies) assert.ok(!/Retry Me/.test(c.message));
  });
  check('a clean not_submitted failure is never counted as unverified', () => {
    for (const c of unverifiedReplies) assert.ok(!/Clean Fail/.test(c.message));
  });

  console.log('\nTest 2e: comment-opportunity pipeline silence (2026-09-17: the 2-day dark halt)');
  const scannerSilent = await lib.checkCommentOppScannerSilence(24);
  check('scanner fires when every found_at is older than the window, despite real history', () => {
    assert.strictEqual(scannerSilent.length, 1, `expected exactly one condition, got: ${JSON.stringify(scannerSilent)}`);
    assert.strictEqual(scannerSilent[0].key, 'comment_opp_scanner_silent');
    assert.ok(/24h/.test(scannerSilent[0].message));
  });

  const approvedStale = await lib.checkCommentOppApprovedStale(24);
  check('approved-stale fires with the right count and names the group', () => {
    const c = approvedStale.find((x) => x.key === 'comment_opp_approved_stale');
    assert.ok(c, `expected comment_opp_approved_stale to fire, got: ${JSON.stringify(approvedStale.map((x) => x.key))}`);
    assert.strictEqual(c.count, 1);
    assert.ok(/DFW Realtors/.test(c.message));
  });

  // Healthy pipeline: something found inside the window -> scanner must NOT fire.
  const healthyMock = await startMockSupabase({
    ...seed,
    comment_opportunities: [
      ...seed.comment_opportunities,
      { id: 'co-fresh', group_name: 'Texas Real Estate Agents', found_at: hoursAgo(2), status: 'found' },
    ],
  });
  process.env.SUPABASE_URL = `http://127.0.0.1:${healthyMock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const healthyLib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));
  const healthyScanner = await healthyLib.checkCommentOppScannerSilence(24);
  check('a fresh found_at inside the window means the scanner is healthy — no false alarm', () => {
    assert.strictEqual(healthyScanner.length, 0, `expected no scanner-silent alert, got: ${JSON.stringify(healthyScanner)}`);
  });
  healthyMock.server.close();

  // Never-used pipeline (no rows at all): must NOT fire — dormant, not broken.
  const neverUsedMock = await startMockSupabase({ comment_opportunities: [], alert_state: [] });
  process.env.SUPABASE_URL = `http://127.0.0.1:${neverUsedMock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const neverUsedLib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));
  const neverUsedScanner = await neverUsedLib.checkCommentOppScannerSilence(24);
  check('a pipeline with zero rows ever (never turned on) does NOT fire — avoids alarming forever on something never started', () => {
    assert.strictEqual(neverUsedScanner.length, 0, `expected no alert for a never-used pipeline, got: ${JSON.stringify(neverUsedScanner)}`);
  });
  neverUsedMock.server.close();
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('\nTest 3: dedupe — fires once, second run within cooldown is suppressed');
  const run1 = await lib.runAllChecks({ silenceDays: 3, approvalStaleHours: 48, draftStaleHours: 24, videoReviewStaleHours: 48 });
  check('run1 fired at least the instagram silence condition', () => assert.ok(run1.fired.some((c) => c.key === 'silence:instagram:dossie')));

  const run2 = await lib.runAllChecks({ silenceDays: 3, approvalStaleHours: 48, draftStaleHours: 24, videoReviewStaleHours: 48 });
  check('run2 fires NOTHING (all conditions already alerted within cooldown)', () => assert.strictEqual(run2.fired.length, 0, `expected 0 fired on immediate re-run, got: ${JSON.stringify(run2.fired.map((c) => c.key))}`));
  check('run2 reports the same conditions as suppressed', () => assert.ok(run2.suppressed.some((c) => c.key === 'silence:instagram:dossie')));

  mock.server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
