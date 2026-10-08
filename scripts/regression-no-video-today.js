#!/usr/bin/env node
'use strict';

/**
 * Regression test for checkNoVideoScheduledToday() and checkVideoRunwayLow()
 * (api/_lib/silence-alarm.js) — the 2026-10-02 "I had to catch you not
 * posting anything today" incident.
 *
 * Video 7 published 2026-10-01. Video 8 was built and ready. A publishing
 * agent was stopped mid-task and told to reschedule video 8 for 10-02 — it
 * halted before creating any video_library row at all, so nothing was
 * scheduled, and nothing in the system ever asked "is a video going out
 * today?" This pins down the fix: fires when nothing posted or due today,
 * self-heals a deferred-but-approved video back onto today, and stays quiet
 * once a video has actually posted or is due.
 *
 * Real in-memory PostgREST mock over HTTP (supports or=(...) filters and
 * Prefer: return=representation on PATCH, which the shared mocks in
 * scripts/regression-silence-alarm.js and
 * scripts/regression-structurally-unpublishable.js do not) — ZERO
 * production access, no Telegram, no real DB.
 *
 * Run manually:
 *   node scripts/regression-no-video-today.js
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
  if (expr.startsWith('lte.')) return row[key] != null && String(row[key]) <= decodeURIComponent(expr.slice(4));
  if (expr.startsWith('lt.')) return row[key] != null && String(row[key]) < decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  return true;
}

// Minimal or=(col.op.value,col.op.value) support — the only PostgREST
// combinator checkNoVideoScheduledToday() uses (scheduled_for.is.null OR
// scheduled_for.lte.X). Value may itself contain dots (ISO timestamps), so
// only the first two dot-separated segments are column/op; the rest rejoins
// as the value.
function matchOr(row, orExpr) {
  const inner = orExpr.slice(1, -1);
  const clauses = inner.split(',');
  return clauses.some((clause) => {
    const parts = clause.split('.');
    const col = parts[0];
    const op = parts[1];
    const value = parts.slice(2).join('.');
    return matchFilter(row, col, `${op}.${value}`);
  });
}

function startMockSupabase(seed) {
  const db = {
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

      // PostgREST (and this file's own queries — posted_date=gte.X&
      // posted_date=lte.Y) allows the SAME column to appear more than once
      // as an implicit AND. A plain {} built from searchParams would let the
      // second occurrence silently clobber the first, which is exactly the
      // "gte filter disappears" bug this file's own Test 1 caught — so
      // filters are kept as the raw (possibly-repeating) entry list, never
      // collapsed into an object.
      const entries = [...url.searchParams.entries()];
      const reserved = new Set(['select', 'order', 'on_conflict', 'limit']);
      const orEntry = entries.find(([k]) => k === 'or');
      const filterEntries = entries.filter(([k]) => !reserved.has(k) && k !== 'or');
      let matched = rows.filter((r) => filterEntries.every(([k, v]) => matchFilter(r, k, v)) && (orEntry ? matchOr(r, orEntry[1]) : true));

      const orderEntry = entries.find(([k]) => k === 'order');
      if (orderEntry) {
        // Supports a single "col.asc"/"col.desc" — enough for this file's
        // own order=scheduled_for.asc usage. Real multi-key orders (e.g.
        // cron-post-videos.js's nullsfirst) are not needed by this check.
        const [col, dir] = orderEntry[1].split('.');
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? '');
          const bv = String(b[col] ?? '');
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return cmp * (dir === 'desc' ? -1 : 1);
        });
      }
      const limitEntry = entries.find(([k]) => k === 'limit');
      if (limitEntry) matched = matched.slice(0, parseInt(limitEntry[1], 10));

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
        return;
      }

      if (req.method === 'PATCH') {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* noop */ }
        for (const r of matched) Object.assign(r, body);
        // return=representation — echo back the rows actually matched+patched,
        // same as real PostgREST, so checkNoVideoScheduledToday() can tell a
        // real update (non-empty array) from a zero-row no-op.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
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

async function withLib(seed) {
  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));
  return { mock, lib };
}

// Fixed "now" so CT day-boundary math is deterministic across runs —
// 2026-10-02T15:00:00Z is 10:00 CT, the real cron-silence-alarm.js
// schedule.
const NOW = new Date('2026-10-02T15:00:00.000Z');
function isoHoursFromNow(h) {
  return new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();
}

async function run() {
  // ── Test 1: the actual incident shape — nothing posted today, nothing
  // heath_approved at all. MUST fire 'no_video_today'.
  const { mock: m1, lib: lib1 } = await withLib({
    video_library: [
      // Video 7 — posted yesterday. Must not count as "today".
      { id: 'video-7', status: 'posted', quality_status: 'passed', target_owner: 'dossie', topic: 'video 7', posted_date: isoHoursFromNow(-19) },
    ],
    alert_state: [],
  });
  console.log('\nTest 1: real incident shape — nothing posted/due today, nothing to self-heal — must FIRE');
  const r1 = await lib1.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r1, null, 2));
  check('fires exactly one condition', () => assert.strictEqual(r1.length, 1, JSON.stringify(r1)));
  check('key is no_video_today', () => assert.strictEqual(r1[0].key, 'no_video_today'));
  check('message names the empty pipeline', () => assert.ok(/nothing anywhere in the video pipeline/.test(r1[0].message), r1[0].message));
  m1.server.close();

  // ── Test 2: something already posted today — must go QUIET.
  const { mock: m2, lib: lib2 } = await withLib({
    video_library: [
      { id: 'video-8', status: 'posted', quality_status: 'passed', target_owner: 'dossie', topic: 'video 8', posted_date: isoHoursFromNow(-2) },
    ],
    alert_state: [],
  });
  console.log('\nTest 2: a video already posted today — must go QUIET');
  const r2 = await lib2.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r2, null, 2));
  check('zero conditions', () => assert.strictEqual(r2.length, 0, JSON.stringify(r2)));
  m2.server.close();

  // ── Test 3: nothing posted yet, but a heath_approved+passed row is
  // already due today (scheduled_for NULL) — the ordinary every-20-min
  // cron-post-videos.js run will reach it. Must go QUIET, no PATCH needed.
  const { mock: m3, lib: lib3, } = await withLib({
    video_library: [
      { id: 'video-8', status: 'heath_approved', quality_status: 'passed', target_owner: 'dossie', topic: 'video 8', scheduled_for: null },
    ],
    alert_state: [],
  });
  console.log('\nTest 3: heath_approved+passed, scheduled_for NULL (immediately due) — must go QUIET');
  const r3 = await lib3.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r3, null, 2));
  check('zero conditions', () => assert.strictEqual(r3.length, 0, JSON.stringify(r3)));
  check('did not touch the row (still NULL)', () => assert.strictEqual(m3.db.video_library[0].scheduled_for, null));
  m3.server.close();

  // ── Test 4: SELF-HEAL — a heath_approved+passed row exists but is
  // deferred to tomorrow, and nothing else is due today. Must PATCH its
  // scheduled_for back to "now" and go QUIET (silent self-heal, same
  // convention as checkGoogleTokenHealth's 'healthy' outcome).
  const tomorrow = isoHoursFromNow(30); // well past end of today CT
  const { mock: m4, lib: lib4 } = await withLib({
    video_library: [
      { id: 'video-8-deferred', status: 'heath_approved', quality_status: 'passed', target_owner: 'dossie', topic: 'video 8 deferred', scheduled_for: tomorrow, created_at: isoHoursFromNow(-3) },
    ],
    alert_state: [],
  });
  console.log('\nTest 4: heath_approved+passed row deferred past today — must SELF-HEAL (pull forward) and go QUIET');
  const r4 = await lib4.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r4, null, 2));
  check('zero conditions (self-healed silently)', () => assert.strictEqual(r4.length, 0, JSON.stringify(r4)));
  check('scheduled_for was pulled forward off tomorrow', () => {
    const row = m4.db.video_library.find((r) => r.id === 'video-8-deferred');
    assert.notStrictEqual(row.scheduled_for, tomorrow, 'expected scheduled_for to change, it did not');
    assert.ok(new Date(row.scheduled_for).getTime() <= Date.now() + 5000, `expected scheduled_for pulled to ~now, got ${row.scheduled_for}`);
  });
  check('only touched the heath_approved row (status unchanged — never auto-approves)', () => {
    const row = m4.db.video_library.find((r) => r.id === 'video-8-deferred');
    assert.strictEqual(row.status, 'heath_approved');
  });
  m4.server.close();

  // ── Test 5: status='pending_approval' is a deliberate EXCLUSION — that
  // status is a known dead end nothing re-reads on its own
  // (checkVideoLibraryPendingApprovalStale's header), so a scheduled_for on
  // it must NOT count as "queued", even though it's inside today and
  // quality_status is 'passed'. Must FIRE and never be self-healed (only
  // heath_approved rows are ever touched).
  const { mock: m5, lib: lib5 } = await withLib({
    video_library: [
      { id: 'video-9-deadend', status: 'pending_approval', quality_status: 'passed', target_owner: 'dossie', topic: 'stuck at pending_approval', scheduled_for: isoHoursFromNow(-1) },
    ],
    alert_state: [],
  });
  console.log('\nTest 5: pending_approval (dead-end status) with a scheduled_for must NOT count as queued — must FIRE');
  const r5 = await lib5.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r5, null, 2));
  check('fires (pending_approval does not count as queued)', () => assert.strictEqual(r5.length, 1, JSON.stringify(r5)));
  check('names the pending_approval row in the pipeline summary', () => assert.ok(/1 pending_approval/.test(r5[0].message), r5[0].message));
  check('did not touch the row', () => {
    const row = m5.db.video_library.find((r) => r.id === 'video-9-deadend');
    assert.strictEqual(row.status, 'pending_approval');
    assert.strictEqual(row.scheduled_for, isoHoursFromNow(-1));
  });
  m5.server.close();

  // ── Test 5b: the ACTUAL live shape caught on 2026-10-02 — a row still at
  // status='approved' (not yet heath_approved) but already carrying a real
  // scheduled_for inside today. "Scheduled counts, not just posted" — must
  // go QUIET without touching anything (self-heal only ever acts on
  // heath_approved rows).
  const { mock: m5b, lib: lib5b } = await withLib({
    video_library: [
      { id: 'video-8-approved-today', status: 'approved', quality_status: 'passed', target_owner: 'dossie', topic: 'dossie-trec-12b-contribution', scheduled_for: isoHoursFromNow(8) },
    ],
    alert_state: [],
  });
  console.log('\nTest 5b: real incident shape — status=approved, scheduled_for=today — must go QUIET');
  const r5b = await lib5b.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(r5b, null, 2));
  check('zero conditions', () => assert.strictEqual(r5b.length, 0, JSON.stringify(r5b)));
  check('did not touch the row (still approved, not heath_approved)', () => {
    const row = m5b.db.video_library.find((r) => r.id === 'video-8-approved-today');
    assert.strictEqual(row.status, 'approved');
  });
  m5b.server.close();

  // ── checkVideoRunwayLow() — separate, cheap leading-indicator check.
  console.log('\nTest 6: video runway — below threshold (1 ready) must FIRE');
  const { mock: m6, lib: lib6 } = await withLib({
    video_library: [
      { id: 'ready-1', status: 'heath_approved', quality_status: 'passed' },
      { id: 'not-ready-1', status: 'pending_approval', quality_status: 'unchecked' },
    ],
  });
  const r6 = await lib6.checkVideoRunwayLow(2);
  console.log('  raw output:', JSON.stringify(r6, null, 2));
  check('fires video_runway_low', () => assert.strictEqual(r6.length, 1, JSON.stringify(r6)));
  check('count is 1', () => assert.strictEqual(r6[0].count, 1));
  m6.server.close();

  console.log('\nTest 7: video runway — at threshold (2 ready) must stay QUIET');
  const { mock: m7, lib: lib7 } = await withLib({
    video_library: [
      { id: 'ready-1', status: 'heath_approved', quality_status: 'passed' },
      { id: 'ready-2', status: 'heath_approved', quality_status: 'passed' },
    ],
  });
  const r7 = await lib7.checkVideoRunwayLow(2);
  console.log('  raw output:', JSON.stringify(r7, null, 2));
  check('zero conditions', () => assert.strictEqual(r7.length, 0, JSON.stringify(r7)));
  m7.server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('REGRESSION SCRIPT CRASHED:', err);
  process.exit(1);
});
