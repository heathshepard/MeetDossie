#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 heartbeat extension to
 * api/_lib/silence-alarm.js + api/cron-silence-alarm.js:
 *   - checkCommentsAwaitingReplyStale (tc_discovery_responses +
 *     social_comment_replies, two separate reply pipelines)
 *   - checkCronSanity wired into runAllChecks
 *   - buildHeartbeatSnapshot() returns a well-formed, always-populated
 *     snapshot (not gated by dedupe) and its video-ready count respects the
 *     video quality gate (quality_status='passed' only — mirrors
 *     api/_lib/verify-video-quality.js's gateBeforePublish() fail-closed
 *     rule).
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access, no
 * Telegram, no real DB.
 *
 * Run manually:
 *   node scripts/regression-silence-alarm-heartbeat.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lte.')) return row[key] != null && String(row[key]) <= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

function startMockSupabase(seed) {
  const db = {};
  for (const [table, rows] of Object.entries(seed)) db[table] = rows.map((r) => ({ ...r }));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      if (!db[table]) db[table] = []; // unseeded table = genuinely empty, not 404 — matches real Postgrest behavior for a real-but-empty table
      const rows = db[table];

      // Real Postgrest allows the SAME column as a query key more than once
      // (e.g. a gte/lt day-range on one column) — keep every [key, expr]
      // pair rather than collapsing into an object, which would silently
      // drop all but the last occurrence.
      const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
      let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      const order = url.searchParams.get('order');
      const limit = url.searchParams.get('limit');
      if (order) {
        const [col, dir] = order.split('.');
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return cmp * (dir === 'desc' ? -1 : 1);
        });
      }
      if (limit) matched = matched.slice(0, parseInt(limit, 10));

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

function daysAgo(n) { return new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString(); }
function hoursAgo(n) { return new Date(Date.now() - n * 60 * 60 * 1000).toISOString(); }
function hoursFromNow(n) { return new Date(Date.now() + n * 60 * 60 * 1000).toISOString(); }

function writeTmpVercelJson(crons) {
  const p = path.join(os.tmpdir(), `vercel-heartbeat-test-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify({ crons }));
  return p;
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
      { id: 'fb-1', platform: 'facebook', target_owner: 'dossie', status: 'posted', posted_at: hoursAgo(5), created_at: hoursAgo(5) },
      { id: 'li-1', platform: 'linkedin', target_owner: 'dossie', status: 'approved', scheduled_for: hoursFromNow(20), created_at: hoursAgo(2) },
      { id: 'draft-1', platform: 'twitter', target_owner: 'dossie', status: 'draft', created_at: hoursAgo(1) },
      { id: 'appr-old-1', platform: 'facebook', target_owner: 'dossie', status: 'approved', created_at: daysAgo(3) },
      { id: 'pv-1', platform: 'tiktok', target_owner: 'dossie', status: 'pending_video', created_at: hoursAgo(10) },
    ],
    group_posts: [
      { id: 'gp-1', status: 'pending_admin_approval', posted_at: hoursAgo(4) },
    ],
    video_library: [
      // Only THIS row should count as "ready" — passed the quality gate.
      { id: 'vid-ready', status: 'heath_approved', quality_status: 'passed', target_owner: 'dossie' },
      // Approved but never passed the gate (or failed it) -> must NOT count as ready.
      { id: 'vid-not-passed', status: 'heath_approved', quality_status: 'failed', target_owner: 'dossie' },
      { id: 'vid-unchecked', status: 'heath_approved', quality_status: null, target_owner: 'dossie' },
      { id: 'vid-hold', status: 'quality_hold', quality_status: 'failed', target_owner: 'dossie' },
      { id: 'vid-posted', status: 'posted', quality_status: 'passed', posted_date: hoursAgo(3), platforms: ['tiktok', 'instagram'], target_owner: 'dossie' },
    ],
    // Two separate reply pipelines — comments awaiting reply.
    tc_discovery_responses: [
      { id: 'tc-1', reply_status: 'notified', commenter_name: 'Jane', created_at: hoursAgo(30) }, // stale (>24h)
      { id: 'tc-2', reply_status: 'notified', commenter_name: 'Bob', created_at: hoursAgo(2) }, // fresh, not stale
      { id: 'tc-3', reply_status: 'approved', commenter_name: 'Already handled', created_at: hoursAgo(40) }, // not awaiting
    ],
    social_comment_replies: [
      { id: 'sc-1', reply_status: 'draft', created_at: hoursAgo(30) }, // stale
      { id: 'sc-2', reply_status: 'posted', created_at: hoursAgo(50) }, // already posted, not awaiting
    ],
    alert_state: [],
  };

  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('Test 1: checkCommentsAwaitingReplyStale — two pipelines, only stale rows counted');
  const stale = await lib.checkCommentsAwaitingReplyStale(24);
  check('tc_discovery stale condition fires with count 1 (only tc-1, not tc-2 fresh or tc-3 approved)', () => {
    const c = stale.find((x) => x.key === 'comments_awaiting_reply:tc_discovery');
    assert.ok(c, `expected comments_awaiting_reply:tc_discovery to fire, got: ${JSON.stringify(stale.map((x) => x.key))}`);
    assert.strictEqual(c.count, 1);
  });
  check('social comment-reply stale condition fires with count 1 (only sc-1, not sc-2 posted)', () => {
    const c = stale.find((x) => x.key === 'comments_awaiting_reply:social');
    assert.ok(c, 'expected comments_awaiting_reply:social to fire');
    assert.strictEqual(c.count, 1);
  });

  console.log('\nTest 2: checkCronSanity wired into runAllChecks — a synthetic issue fires');
  const vercelJsonPath = writeTmpVercelJson([
    { path: '/api/cron-generate-posts', schedule: '0 0 1 1 *' },
  ]);
  const runResult = await lib.runAllChecks({ cronSanityScanOpts: { vercelJsonPath, apiDir: path.join(REPO, 'api') } });
  check('a near-never schedule surfaces as a fired cron_sanity condition', () => {
    const c = runResult.fired.find((x) => String(x.key || '').startsWith('cron_sanity:'));
    assert.ok(c, `expected a cron_sanity condition to fire, got: ${JSON.stringify(runResult.fired.map((x) => x.key))}`);
  });
  fs.unlinkSync(vercelJsonPath);

  console.log('\nTest 3: buildHeartbeatSnapshot — well-formed, always-populated, video quality gate respected');
  const snapshot = await lib.buildHeartbeatSnapshot();
  check('posted_last_24h includes the facebook post AND the posted video (folded into one list)', () => {
    const fb = snapshot.posted_last_24h.by_platform_owner.find((r) => r.platform === 'facebook' && r.target_owner === 'dossie');
    assert.ok(fb, `expected a facebook/dossie entry, got: ${JSON.stringify(snapshot.posted_last_24h.by_platform_owner)}`);
    const tiktok = snapshot.posted_last_24h.by_platform_owner.find((r) => r.platform === 'tiktok');
    assert.ok(tiktok, 'expected the posted video to fold tiktok into posted_last_24h');
  });
  check('scheduled_next_7d picks up the approved+scheduled linkedin row', () => {
    const li = snapshot.scheduled_next_7d.by_platform_owner.find((r) => r.platform === 'linkedin');
    assert.ok(li, `expected a linkedin scheduled entry, got: ${JSON.stringify(snapshot.scheduled_next_7d.by_platform_owner)}`);
  });
  check('video_ready_to_post counts ONLY the quality_status=passed + heath_approved row (1, not 3)', () => {
    assert.strictEqual(snapshot.scheduled_next_7d.video_ready_to_post, 1, `expected exactly 1 ready video (quality gate must exclude failed/unchecked), got: ${snapshot.scheduled_next_7d.video_ready_to_post}`);
  });
  check('stuck.approved_unposted counts both approved rows (li-1 + appr-old-1)', () => {
    assert.strictEqual(snapshot.stuck.approved_unposted, 2);
  });
  check('stuck.pending_video / pending_admin_approval / video_quality_hold all populated (not null)', () => {
    assert.strictEqual(snapshot.stuck.pending_video, 1);
    assert.strictEqual(snapshot.stuck.pending_admin_approval, 1);
    assert.strictEqual(snapshot.stuck.video_quality_hold, 1);
  });
  check('comments_awaiting_reply counts ALL notified/draft rows (not just stale ones — heartbeat shows current state)', () => {
    assert.strictEqual(snapshot.comments_awaiting_reply.tc_discovery_notified, 2); // tc-1 + tc-2
    assert.strictEqual(snapshot.comments_awaiting_reply.social_draft, 1); // sc-1
  });
  check('platform_status covers every TRACKED_PAIRS entry, healthy pairs included', () => {
    assert.strictEqual(snapshot.platform_status.length, lib.TRACKED_PAIRS.length);
    const fb = snapshot.platform_status.find((p) => p.platform === 'facebook' && p.target_owner === 'dossie');
    assert.ok(fb && fb.last_posted_at, 'expected facebook/dossie to show a real last_posted_at');
  });
  check('cron_sanity is present and well-formed on the live repo scan', () => {
    assert.strictEqual(snapshot.cron_sanity.ok, true);
    assert.ok(Array.isArray(snapshot.cron_sanity.issues));
  });

  mock.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
