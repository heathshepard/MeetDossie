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
  return true;
}

function startMockSupabase(seed) {
  const db = {
    social_posts: (seed.social_posts || []).map((r) => ({ ...r })),
    group_posts: (seed.group_posts || []).map((r) => ({ ...r })),
    video_library: (seed.video_library || []).map((r) => ({ ...r })),
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
    group_posts: [],
    video_library: [
      { id: 'vid-1', status: 'pending_heath_review', topic: 'feature-demo-x', platforms: ['tiktok', 'instagram'], created_at: hoursAgo(96) },
    ],
    alert_state: [],
  };

  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

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
