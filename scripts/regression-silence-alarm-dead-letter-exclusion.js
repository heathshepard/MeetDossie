#!/usr/bin/env node
'use strict';

/**
 * Regression test: api/_lib/silence-alarm.js's checkAccumulatingBacklog()
 * must NEVER count a row that has been terminally marked ('rejected' with a
 * rejection_reason) after the 2026-09-16 backlog cleanup.
 *
 * THE BUG THIS GUARDS AGAINST
 * ----------------------------
 * cron-generate-posts.js generated instagram/tiktok social_posts rows
 * against a per-post Creatomate video path retired 2026-09-09. With no
 * card fallback and no video source, ~70 rows piled up permanently stuck at
 * status='pending_video'/'video_failed' — the exact pattern
 * checkAccumulatingBacklog() (threshold=5) is built to catch, and it did:
 * this is what the first real silence-alarm firing (2026-09-16) surfaced.
 * The fix is a one-time DB cleanup marking every existing dead row
 * status='rejected' (never deleted — reason preserved in
 * rejection_reason). This test pins down that the alarm actually stops
 * counting them afterward, not just that the generator stopped making new
 * ones (api/cron-generate-posts.js's own 2026-09-15 fix, unrelated file).
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access, no
 * real DB.
 *
 * Run manually:
 *   node scripts/regression-silence-alarm-dead-letter-exclusion.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

function startMockSupabase(seedRows) {
  const social_posts = seedRows.map((r) => ({ ...r }));
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      if (table !== 'social_posts') { res.writeHead(404); res.end('{}'); return; }

      const q = {};
      for (const [k, v] of url.searchParams) q[k] = v;
      const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'limit'].includes(k));
      const matched = social_posts.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
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

  // Before cleanup: 14 instagram pending_video, 23 instagram video_failed —
  // both over the threshold=5, both must fire.
  const before = [];
  for (let i = 0; i < 14; i++) before.push({ id: `ig-pv-${i}`, platform: 'instagram', target_owner: 'dossie', status: 'pending_video', created_at: daysAgo(10) });
  for (let i = 0; i < 23; i++) before.push({ id: `ig-vf-${i}`, platform: 'instagram', target_owner: 'dossie', status: 'video_failed', created_at: daysAgo(10) });
  // A few HEALTHY rows on other statuses/platforms that must never be swept up.
  before.push({ id: 'ig-posted-1', platform: 'instagram', target_owner: 'dossie', status: 'posted', created_at: daysAgo(1) });
  before.push({ id: 'tw-draft-1', platform: 'twitter', target_owner: 'dossie', status: 'draft', created_at: daysAgo(1) });

  {
    const mock = await startMockSupabase(before);
    process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
    const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

    console.log('\nTest 1: BEFORE cleanup — both dead-letter conditions fire with real counts');
    const backlog = await lib.checkAccumulatingBacklog(5);
    check('instagram:pending_video fires with count 14', () => {
      const c = backlog.find((x) => x.key === 'backlog:instagram:pending_video');
      assert.ok(c, `expected backlog:instagram:pending_video to fire, got: ${JSON.stringify(backlog.map((x) => x.key))}`);
      assert.strictEqual(c.count, 14);
    });
    check('instagram:video_failed fires with count 23', () => {
      const c = backlog.find((x) => x.key === 'backlog:instagram:video_failed');
      assert.ok(c, 'expected backlog:instagram:video_failed to fire');
      assert.strictEqual(c.count, 23);
    });
    mock.server.close();
  }

  // After cleanup: every pending_video/video_failed row flipped to
  // status='rejected' with a rejection_reason — the exact one-time DB
  // action api/admin-fix-silence-backlog-2026-09-16.js performs. Healthy
  // rows (posted, draft) are untouched.
  const after = before.map((r) => {
    if (r.status === 'pending_video' || r.status === 'video_failed') {
      return { ...r, status: 'rejected', rejection_reason: 'retired per-post Creatomate path (2026-09-09) — dead-lettered 2026-09-16, never had a real video source' };
    }
    return r;
  });

  {
    const mock = await startMockSupabase(after);
    process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
    const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

    console.log('\nTest 2: AFTER cleanup — dead-letter conditions no longer fire at all');
    const backlog = await lib.checkAccumulatingBacklog(5);
    check('instagram:pending_video no longer fires', () => {
      assert.ok(!backlog.find((x) => x.key === 'backlog:instagram:pending_video'), `should not fire, got: ${JSON.stringify(backlog.map((x) => x.key))}`);
    });
    check('instagram:video_failed no longer fires', () => {
      assert.ok(!backlog.find((x) => x.key === 'backlog:instagram:video_failed'));
    });
    check('no new condition invented for the rejected rows (0 backlog conditions total)', () => {
      assert.strictEqual(backlog.length, 0, `expected zero backlog conditions post-cleanup, got: ${JSON.stringify(backlog)}`);
    });

    console.log('\nTest 3: healthy rows untouched by the cleanup (sanity check on the fixture itself)');
    const stillPosted = after.find((r) => r.id === 'ig-posted-1');
    const stillDraft = after.find((r) => r.id === 'tw-draft-1');
    check('posted row untouched', () => assert.strictEqual(stillPosted.status, 'posted'));
    check('draft row untouched', () => assert.strictEqual(stillDraft.status, 'draft'));

    mock.server.close();
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'} — ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err && err.message);
  console.error(err && err.stack);
  process.exit(1);
});
