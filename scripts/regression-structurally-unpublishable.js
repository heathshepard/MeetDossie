#!/usr/bin/env node
'use strict';

/**
 * Regression test for checkStructurallyUnpublishablePosts()
 * (api/_lib/silence-alarm.js) — the linkedin_personal incident, 2026-09-30.
 *
 * Real in-memory PostgREST mock over HTTP — ZERO production access, no
 * Telegram, no real DB.
 *
 * Run manually:
 *   node scripts/regression-structurally-unpublishable.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('gt.')) return row[key] != null && String(row[key]) > decodeURIComponent(expr.slice(3));
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
    posting_schedule: (seed.posting_schedule || []).map((r) => ({ ...r })),
    zernio_accounts: (seed.zernio_accounts || []).map((r) => ({ ...r })),
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

function minutesAgo(n) {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${label}\n        ${err.message}`);
    failed++;
  }
}

async function run() {
  // ── Positive case: linkedin_personal/dossie — exactly the incident shape.
  // No posting_schedule row at all, no zernio_accounts row at all, one
  // approved post 90 minutes past scheduled_for (> the 30min threshold).
  const positiveSeed = {
    social_posts: [
      {
        id: 'sp-linkedin-personal-stale', platform: 'linkedin_personal', target_owner: 'dossie',
        status: 'approved', scheduled_for: minutesAgo(90), error_message: null,
      },
      // A healthy 'linkedin' (not linkedin_personal) row in the same run —
      // proves the check scopes to the actual broken platform, not every
      // approved row.
      {
        id: 'sp-linkedin-healthy', platform: 'linkedin', target_owner: 'dossie',
        status: 'approved', scheduled_for: minutesAgo(90), error_message: null,
      },
      // A linkedin_personal row that hasn't hit the staleness threshold yet
      // — must NOT fire regardless of the missing destination.
      {
        id: 'sp-linkedin-personal-fresh', platform: 'linkedin_personal', target_owner: 'dossie',
        status: 'approved', scheduled_for: minutesAgo(5), error_message: null,
      },
    ],
    posting_schedule: [
      // linkedin (not linkedin_personal) IS wired — Mon-Fri 07:00, active.
      { platform: 'linkedin', owner: null, day_of_week: 1, is_active: true, time_slots: ['07:00:00'], max_per_day: 2 },
    ],
    zernio_accounts: [
      { platform: 'linkedin', owner: 'dossie', is_active: true },
    ],
    alert_state: [],
  };

  const posMock = await startMockSupabase(positiveSeed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${posMock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const posLib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('\nTest 1: structurally unpublishable — fires for linkedin_personal/dossie, not linkedin/dossie');
  const posResults = await posLib.checkStructurallyUnpublishablePosts(30);
  console.log('  raw output:', JSON.stringify(posResults, null, 2));

  const lpCondition = posResults.find((c) => c.key === 'structurally_unpublishable:linkedin_personal/dossie');
  check('linkedin_personal/dossie condition fired', () => assert.ok(lpCondition, `expected a condition, got keys: ${JSON.stringify(posResults.map((c) => c.key))}`));
  check('count is 1 (only the stale row, not the fresh one)', () => assert.strictEqual(lpCondition.count, 1));
  check('names both missing pieces', () => {
    assert.ok(/no active posting_schedule row/.test(lpCondition.message), `expected schedule gap in message, got: ${lpCondition.message}`);
    assert.ok(/no active zernio_accounts row/.test(lpCondition.message), `expected zernio gap in message, got: ${lpCondition.message}`);
  });
  check('names the platform', () => assert.ok(lpCondition.message.includes("platform 'linkedin_personal'"), lpCondition.message));
  check('healthy linkedin/dossie pair does NOT fire (has schedule + zernio, just old)', () => {
    assert.ok(!posResults.find((c) => c.key.startsWith('structurally_unpublishable:linkedin/')), `did not expect linkedin/dossie to fire, got: ${JSON.stringify(posResults.map((c) => c.key))}`);
  });
  check('fresh linkedin_personal row (5min < 30min threshold) does not inflate the count', () => {
    assert.strictEqual(lpCondition.count, 1, `expected count 1, got ${lpCondition.count}`);
  });

  // ── Negative case: a platform WITH both a schedule row and a zernio row,
  // sitting well past scheduled_for (e.g. cap reached / waiting its slot) —
  // this is completely normal and MUST NOT fire.
  const negativeSeed = {
    social_posts: [
      {
        id: 'sp-facebook-waiting-cap', platform: 'facebook', target_owner: 'dossie',
        status: 'approved', scheduled_for: minutesAgo(120), error_message: null,
      },
    ],
    posting_schedule: [
      { platform: 'facebook', owner: null, day_of_week: new Date().getUTCDay(), is_active: true, time_slots: ['07:00:00'], max_per_day: 1 },
    ],
    zernio_accounts: [
      { platform: 'facebook', owner: 'dossie', is_active: true },
    ],
    alert_state: [],
  };

  const negMock = await startMockSupabase(negativeSeed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${negMock.port}`;
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const negLib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));

  console.log('\nTest 2: healthy, fully-wired platform sitting past scheduled_for — must NOT fire');
  const negResults = await negLib.checkStructurallyUnpublishablePosts(30);
  console.log('  raw output:', JSON.stringify(negResults, null, 2));
  check('no condition fires for a platform with both an active schedule and zernio row', () => {
    assert.strictEqual(negResults.length, 0, `expected zero conditions, got: ${JSON.stringify(negResults.map((c) => c.key))}`);
  });

  posMock.server.close();
  negMock.server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('REGRESSION SCRIPT CRASHED:', err);
  process.exit(1);
});
