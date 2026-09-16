#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/cron-weekly-content-scheduler.js (Carter,
 * 2026-09-16 — "consistent posting" structural fix #1).
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. IDEMPOTENCY: running the scheduler twice never double-generates a
 *      day that already has content, and (since generation is the only
 *      thing this cron does — it never calls Zernio) that's sufficient to
 *      prove it can never cause a duplicate Zernio post.
 *   2. GAP REPORTING: heath-realtor days are NEVER sent to the generator
 *      (no automated generator exists for that owner — see
 *      cron-daily-listing-posts.js's 2026-09-11 disable), and are reported
 *      as a real gap with the real reason, not silently skipped or
 *      fabricated.
 *   3. rust is reported as "not wired" (no zernio_accounts row), not
 *      queried per-day.
 *   4. Video (Pipeline B) inventory respects the quality gate — same
 *      assertion style as regression-silence-alarm-heartbeat.js.
 *
 * Mock server serves BOTH the Supabase REST surface (social_posts,
 * zernio_accounts, video_library) AND the internal self-call target
 * (/api/cron-generate-posts?target_date=...) on the same origin, so a
 * simulated "generate" call actually inserts rows the next REST query sees
 * — the same idempotency loop the real system runs, without a real DB.
 *
 * Run manually:
 *   node scripts/regression-weekly-content-scheduler.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('gte.')) return row[key] != null && String(row[key]) >= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lte.')) return row[key] != null && String(row[key]) <= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  return true;
}

function startMockServer() {
  const db = { social_posts: [], zernio_accounts: [], video_library: [] };
  const generateCalls = []; // records every ?target_date= call made to /api/cron-generate-posts

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const json = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      // The self-call cron-weekly-content-scheduler.js makes to advance-fill
      // a missing day. Simulate cron-generate-posts.js's real behavior
      // (from this test's perspective): insert N rows for that date, return
      // { ok:true, inserted:N }.
      if (url.pathname === '/api/cron-generate-posts') {
        const targetDate = url.searchParams.get('target_date');
        generateCalls.push(targetDate);
        const rowsToInsert = ['facebook', 'twitter', 'linkedin'].map((platform, i) => ({
          post_id: `${targetDate}-dossie-${platform}-${i}`,
          platform,
          target_owner: 'dossie',
          status: 'draft',
          generated_at: `${targetDate}T12:00:00.000Z`,
        }));
        db.social_posts.push(...rowsToInsert);
        return json({ ok: true, inserted: rowsToInsert.length, generated: rowsToInsert.length, target_date: targetDate, advance_fill: true });
      }

      const table = url.pathname.split('/').pop();
      const rows = db[table] || [];
      // Real Postgrest allows the SAME column as a query key more than once
      // (e.g. `?generated_at=gte.X&generated_at=lte.Y` for a day-range) — do
      // NOT collapse into a plain object first, that silently drops all but
      // the last occurrence. Keep every [key, expr] pair, AND them all.
      const filters = [...url.searchParams].filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
      const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      if (req.method === 'GET') return json(matched);
      json([]);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, db, generateCalls });
    });
  });
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

  const mock = await startMockServer();
  const origin = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_URL = origin;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.SELF_BASE_URL = origin;
  process.env.CRON_SECRET = 'test-cron-secret';
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_MARKETING_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;

  delete require.cache[require.resolve(path.join(REPO, 'api/cron-weekly-content-scheduler.js'))];
  const mod = require(path.join(REPO, 'api/cron-weekly-content-scheduler.js'));

  console.log('Test 1: first run — dossie has zero existing rows, generates all 7 days; heath-realtor never calls the generator');
  const run1 = await mod.runWeeklyScheduler({});
  check('dossie: all 7 days generated this run', () => {
    const generated = run1.perOwner.dossie.filter((d) => d.action === 'generated');
    assert.strictEqual(generated.length, 7, `expected 7 generated days, got: ${JSON.stringify(run1.perOwner.dossie)}`);
  });
  check('exactly 7 self-calls to cron-generate-posts were made (one per missing day, no extras)', () => {
    assert.strictEqual(mock.generateCalls.length, 7, `expected 7 generate calls, got ${mock.generateCalls.length}: ${JSON.stringify(mock.generateCalls)}`);
  });
  check('heath-realtor: all 7 days reported as gap_no_generator, ZERO generate calls attempted for it', () => {
    const gaps = run1.perOwner['heath-realtor'].filter((d) => d.action === 'gap_no_generator');
    assert.strictEqual(gaps.length, 7, `expected 7 gap days for heath-realtor, got: ${JSON.stringify(run1.perOwner['heath-realtor'])}`);
    assert.ok(gaps.every((d) => /listing-marketing-generate-live|no automated generator/.test(d.reason)), 'expected the real disclosed reason, not a generic one');
  });
  check('rust reported as not wired (no zernio_accounts row), not queried per-day', () => {
    assert.strictEqual(run1.rust.wired, false);
  });

  console.log('\nTest 2: second run (same "day") — every dossie day already has rows -> IDEMPOTENT, zero additional generate calls');
  const callsBeforeRun2 = mock.generateCalls.length;
  const run2 = await mod.runWeeklyScheduler({});
  check('dossie: all 7 days now report already_filled, none generated again', () => {
    const alreadyFilled = run2.perOwner.dossie.filter((d) => d.action === 'already_filled');
    assert.strictEqual(alreadyFilled.length, 7, `expected 7 already_filled days on rerun, got: ${JSON.stringify(run2.perOwner.dossie)}`);
  });
  check('NO new self-calls to cron-generate-posts on the idempotent rerun (proves it can never double-post to Zernio)', () => {
    assert.strictEqual(mock.generateCalls.length, callsBeforeRun2, `expected no new generate calls, went from ${callsBeforeRun2} to ${mock.generateCalls.length}`);
  });

  console.log('\nTest 3: video (Pipeline B) inventory respects the quality gate');
  mock.db.video_library.push(
    { id: 'v1', status: 'heath_approved', quality_status: 'passed' },
    { id: 'v2', status: 'heath_approved', quality_status: 'failed' },
    { id: 'v3', status: 'heath_approved', quality_status: null },
  );
  const run3 = await mod.runWeeklyScheduler({ dryRun: true });
  check('only the quality_status=passed row counts as ready (1, not 3)', () => {
    assert.strictEqual(run3.video.ready, 1, `expected 1 ready video, got ${run3.video.ready}`);
  });

  console.log('\nTest 4: dry_run never calls the generator, even for a genuinely empty day');
  mock.db.social_posts = []; // wipe supply again
  mock.generateCalls.length = 0;
  const run4 = await mod.runWeeklyScheduler({ dryRun: true });
  check('dry_run reports would_generate_dry_run, makes zero real generate calls', () => {
    const wouldGenerate = run4.perOwner.dossie.filter((d) => d.action === 'would_generate_dry_run');
    assert.strictEqual(wouldGenerate.length, 7);
    assert.strictEqual(mock.generateCalls.length, 0);
  });

  mock.server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
