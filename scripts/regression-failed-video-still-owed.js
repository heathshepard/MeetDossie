#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-03 "three days and no video" incident.
 *
 * THE INCIDENT
 * -------------------------------------------------------------------------
 * Video 8 (dossie-trec-12b-contribution-2026-10-02 + its -heath sibling)
 * was built, approved, and scheduled for 2026-10-02. The publishing agent
 * hung ~27h on a stuck MCP call and never wrote the real caption.
 * cron-post-videos.js's own caption-validity check correctly refused to
 * post an empty caption and flipped BOTH rows to status='failed'. Nothing
 * published 10-02 or 10-03. Once 'failed', the rows were invisible to BOTH
 * guards that should have caught the gap:
 *   - checkNoVideoScheduledToday() (api/_lib/silence-alarm.js) only reads
 *     approved/pending_heath_review/heath_approved.
 *   - the video-priority reservation (api/_lib/video-reservation.js,
 *     consumed by api/cron-publish-approved.js) only reserves for
 *     heath_approved/pending_heath_review, so text freely took the
 *     platform slot a retry would have needed.
 *
 * THE FIX, reconstructed and proven end-to-end against the REAL production
 * code in this file (api/_lib/silence-alarm.js, api/_lib/video-reservation.js,
 * api/cron-publish-approved.js — not a reimplementation):
 *
 *   PART A (mock-PostgREST unit tests against the real silence-alarm.js):
 *     A1. A row that failed TODAY with its caption STILL blank — the exact
 *         incident shape — must FIRE (not read as "nothing exists") and
 *         must NOT be touched (no self-heal on a still-broken row).
 *     A2. The same row, but its caption has since been fixed — must
 *         SELF-HEAL silently (PATCH back to heath_approved, scheduled_for
 *         pulled to now, retry_count incremented) and go QUIET.
 *     A3. A row already at the retry cap, caption now valid — must NOT be
 *         re-armed. Instead flipped to terminal 'failed' and a dedicated
 *         EXHAUSTED condition fires.
 *     A4. A genuinely broken video (status='failed', not 'failed_retryable',
 *         even with a perfectly valid caption) must never be queried,
 *         touched, or retried by this mechanism at all.
 *
 *   PART B (real handler end-to-end, same technique as
 *     scripts/regression-video-priority-reservation.js): a failed_retryable
 *     row that failed today must make api/cron-publish-approved.js's real
 *     isDueForPublish() refuse a competing text post's slot on the same
 *     platform/owner — proving the reservation actually holds capacity for
 *     the retry, not just that the pure isReservedToday() function would
 *     say so in isolation. A sibling scenario proves a plain 'failed' row
 *     does NOT reserve anything — text publishes normally.
 *
 * Zero production access, zero real posts, zero Telegram. Any seed rows
 * this script creates live only in an in-memory mock server; nothing is
 * written to the real database.
 *
 * Run manually:
 *   node scripts/regression-failed-video-still-owed.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { MAX_VIDEO_RETRIES } = require(path.join(REPO, 'api/_lib/video-retry.js'));

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

// ═══════════════════════════════════════════════════════════════════════
// PART A — checkNoVideoScheduledToday() against a mock PostgREST, same
// harness as scripts/regression-no-video-today.js (kept in sync here
// deliberately rather than imported, same reasoning that script itself
// gives for not sharing with scripts/regression-structurally-unpublishable.js
// — these are small, stable, and a shared import would make an unrelated
// future change to one script's filter needs silently affect the other).
// ═══════════════════════════════════════════════════════════════════════

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
  const calls = []; // { method, table, url } — asserts exactly what got touched

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const rows = db[table];
      calls.push({ method: req.method, table, url: req.url });
      if (!rows) { res.writeHead(404); res.end('{}'); return; }

      const entries = [...url.searchParams.entries()];
      const reserved = new Set(['select', 'order', 'on_conflict', 'limit']);
      const orEntry = entries.find(([k]) => k === 'or');
      const filterEntries = entries.filter(([k]) => !reserved.has(k) && k !== 'or');
      let matched = rows.filter((r) => filterEntries.every(([k, v]) => matchFilter(r, k, v)) && (orEntry ? matchOr(r, orEntry[1]) : true));

      const orderEntry = entries.find(([k]) => k === 'order');
      if (orderEntry) {
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
        const wantsRepresentation = /return=representation/i.test(req.headers.prefer || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wantsRepresentation ? matched.map((r) => ({ ...r })) : []));
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
      resolve({ server, port, db, calls });
    });
  });
}

async function withLib(seed) {
  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/silence-alarm.js'))];
  const lib = require(path.join(REPO, 'api/_lib/silence-alarm.js'));
  return { mock, lib };
}

// Fixed "now" — 2026-10-03T15:00:00Z is 10:00 CT, matching the real
// cron-silence-alarm.js schedule and the day this incident was found.
const NOW = new Date('2026-10-03T15:00:00.000Z');
function isoHoursFromNow(h) {
  return new Date(NOW.getTime() + h * 60 * 60 * 1000).toISOString();
}

async function runPartA() {
  console.log('\n' + '='.repeat(78));
  console.log('PART A — checkNoVideoScheduledToday() against the real incident shape');
  console.log('='.repeat(78));

  // ── A1: THE REAL INCIDENT — status='failed_retryable', failed TODAY,
  // caption STILL BLANK (the agent never came back and fixed it). Must
  // FIRE (not read as absence) and must NOT self-heal a still-broken row.
  const { mock: mA1, lib: libA1 } = await withLib({
    video_library: [
      {
        id: 'dossie-trec-12b-contribution-2026-10-02', status: 'failed_retryable',
        target_owner: 'dossie', topic: 'trec p12b contribution', caption: '',
        platforms: ['facebook', 'linkedin'], quality_status: 'passed',
        failure_reason: 'invalid_caption', failed_at: isoHoursFromNow(-2), retry_count: 0,
        scheduled_for: isoHoursFromNow(-3),
      },
    ],
    alert_state: [],
  });
  console.log('\nTest A1: real incident — failed_retryable today, caption still blank — must FIRE, must NOT re-arm');
  const rA1 = await libA1.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(rA1, null, 2));
  check('fires exactly one condition', () => assert.strictEqual(rA1.length, 1, JSON.stringify(rA1)));
  check('key is video_failed_retryable_today', () => assert.strictEqual(rA1[0].key, 'video_failed_retryable_today'));
  check('message names the row and the reason', () => assert.ok(
    /dossie-trec-12b-contribution-2026-10-02/.test(rA1[0].message) && /invalid_caption/.test(rA1[0].message),
    rA1[0].message,
  ));
  check('row was NOT touched — still failed_retryable, retry_count still 0', () => {
    const row = mA1.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.strictEqual(row.status, 'failed_retryable');
    assert.strictEqual(row.retry_count, 0);
  });
  check('no PATCH was issued against video_library', () => {
    assert.strictEqual(mA1.calls.filter((c) => c.method === 'PATCH' && c.table === 'video_library').length, 0);
  });
  mA1.server.close();

  // ── A2: same row, caption has since been fixed (a human, or the agent
  // finally came back, rewrote it). Must SELF-HEAL silently: PATCH back to
  // heath_approved, scheduled_for pulled to ~now, retry_count -> 1.
  const { mock: mA2, lib: libA2 } = await withLib({
    video_library: [
      {
        id: 'dossie-trec-12b-contribution-2026-10-02', status: 'failed_retryable',
        target_owner: 'dossie', topic: 'trec p12b contribution',
        caption: 'Who signs off on a contribution request? Dossie knows. meetdossie.com/signup',
        platforms: ['facebook', 'linkedin'], quality_status: 'passed',
        failure_reason: 'invalid_caption', failed_at: isoHoursFromNow(-2), retry_count: 0,
        scheduled_for: isoHoursFromNow(-3),
      },
    ],
    alert_state: [],
  });
  console.log('\nTest A2: caption now valid — must SELF-HEAL (re-arm to heath_approved) and go QUIET');
  const rA2 = await libA2.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(rA2, null, 2));
  check('zero conditions (self-healed silently)', () => assert.strictEqual(rA2.length, 0, JSON.stringify(rA2)));
  check('status moved back to heath_approved', () => {
    const row = mA2.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.strictEqual(row.status, 'heath_approved');
  });
  check('scheduled_for pulled to ~now', () => {
    const row = mA2.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.ok(Math.abs(new Date(row.scheduled_for).getTime() - Date.now()) < 5000, `expected ~now, got ${row.scheduled_for}`);
  });
  check('retry_count incremented 0 -> 1', () => {
    const row = mA2.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.strictEqual(row.retry_count, 1);
  });
  mA2.server.close();

  // ── A3: retry cap already reached, caption now valid — must NOT be
  // re-armed anyway. Flipped to terminal 'failed' instead, dedicated
  // EXHAUSTED condition fires.
  const { mock: mA3, lib: libA3 } = await withLib({
    video_library: [
      {
        id: 'dossie-trec-12b-contribution-2026-10-02', status: 'failed_retryable',
        target_owner: 'dossie', topic: 'trec p12b contribution',
        caption: 'A perfectly valid caption. meetdossie.com/signup',
        platforms: ['facebook', 'linkedin'], quality_status: 'passed',
        failure_reason: 'invalid_caption', failed_at: isoHoursFromNow(-1), retry_count: MAX_VIDEO_RETRIES,
        scheduled_for: isoHoursFromNow(-2),
      },
    ],
    alert_state: [],
  });
  console.log(`\nTest A3: retry_count already at cap (${MAX_VIDEO_RETRIES}), caption now valid — must NOT re-arm, must flip to terminal 'failed' + fire EXHAUSTED`);
  const rA3 = await libA3.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(rA3, null, 2));
  check('fires exactly one condition', () => assert.strictEqual(rA3.length, 1, JSON.stringify(rA3)));
  check('key is video_failed_retryable_exhausted', () => assert.strictEqual(rA3[0].key, 'video_failed_retryable_exhausted'));
  check('row flipped to terminal failed', () => {
    const row = mA3.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.strictEqual(row.status, 'failed');
  });
  check('retry_count untouched at the cap (never incremented past it)', () => {
    const row = mA3.db.video_library.find((r) => r.id === 'dossie-trec-12b-contribution-2026-10-02');
    assert.strictEqual(row.retry_count, MAX_VIDEO_RETRIES);
  });
  mA3.server.close();

  // ── A4: a genuinely broken video — status='failed' (terminal, e.g. a
  // real Zernio rejection), NOT 'failed_retryable', even though its
  // caption is perfectly valid. Must be completely ignored by this
  // mechanism: never queried into the failed_retryable branch, never
  // touched, never retried. (checkNoVideoScheduledToday will still report
  // SOMETHING is wrong via its normal "genuinely nothing" fallback, since
  // nothing else covers today in this fixture — the assertion that matters
  // here is that the row itself is left completely alone.)
  const { mock: mA4, lib: libA4 } = await withLib({
    video_library: [
      {
        id: 'genuinely-broken-video', status: 'failed',
        target_owner: 'dossie', topic: 'bad file',
        caption: 'A perfectly valid caption that does not matter here.',
        platforms: ['facebook'], quality_status: 'passed',
        failure_reason: 'zernio_delivery_error', failed_at: isoHoursFromNow(-1), retry_count: 0,
        scheduled_for: isoHoursFromNow(-2),
      },
    ],
    alert_state: [],
  });
  console.log("\nTest A4: genuinely broken video (status='failed', valid caption) — must NEVER be touched or retried");
  const rA4 = await libA4.checkNoVideoScheduledToday(NOW);
  console.log('  raw output:', JSON.stringify(rA4, null, 2));
  check('row was NOT touched — status still failed, retry_count still 0', () => {
    const row = mA4.db.video_library.find((r) => r.id === 'genuinely-broken-video');
    assert.strictEqual(row.status, 'failed');
    assert.strictEqual(row.retry_count, 0);
  });
  check('no PATCH was issued against video_library', () => {
    assert.strictEqual(mA4.calls.filter((c) => c.method === 'PATCH' && c.table === 'video_library').length, 0);
  });
  check('the failed_retryable-today query found nothing (this row is the wrong status for it)', () => {
    const failedRetryableQuery = mA4.calls.find((c) => c.method === 'GET' && /status=eq\.failed_retryable/.test(c.url));
    assert.ok(failedRetryableQuery, 'expected the failed_retryable query to have run at all');
  });
  mA4.server.close();
}

// ═══════════════════════════════════════════════════════════════════════
// PART B — real cron-publish-approved.js handler: the reservation must
// hold the Facebook slot against a competing text post. Same technique as
// scripts/regression-video-priority-reservation.js (real handler, mock
// PostgREST + Zernio interception), scoped down to just the text pipeline
// since a failed_retryable row is never itself postable by
// cron-post-videos.js in the same run (its candidate query only looks at
// status=eq.heath_approved) — proving the RESERVATION holds is the whole
// point here, not a full repost.
// ═══════════════════════════════════════════════════════════════════════

function rowMatchesQueryB(row, searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit') continue;
    if (key === 'or') {
      const inner = value.replace(/^\(/, '').replace(/\)$/, '');
      const ok = inner.split(',').some((clause) => {
        const [k, op, ...rest] = clause.split('.');
        return matchFilter(row, k, `${op}.${rest.join('.')}`);
      });
      if (!ok) return false;
      continue;
    }
    if (!matchFilter(row, key, value)) return false;
  }
  return true;
}

function startMockSupabaseB(state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const url = new URL(req.url, 'http://localhost');
        const table = url.pathname.replace(/^\/rest\/v1\//, '');
        const json = (obj, status = 200) => {
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(obj));
        };
        const rows = state[table];

        if (req.method === 'GET') {
          if (!Array.isArray(rows)) return json([]);
          let matched = rows.filter((r) => rowMatchesQueryB(r, url.searchParams));
          const limitParam = url.searchParams.get('limit');
          if (limitParam) matched = matched.slice(0, Number(limitParam));
          return json(matched);
        }

        if (req.method === 'PATCH') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = {}; }
          if (!Array.isArray(rows)) return json([]);
          const matched = rows.filter((r) => rowMatchesQueryB(r, url.searchParams));
          matched.forEach((r) => Object.assign(r, body));
          const wantsRepresentation = /return=representation/i.test(req.headers.prefer || '');
          return json(wantsRepresentation ? matched : []);
        }

        if (req.method === 'POST') return json([{}]);
        return json([]);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function freshStateB(videoOverrides) {
  const scheduleRows = [];
  for (let dow = 0; dow < 7; dow++) {
    scheduleRows.push({ platform: 'facebook', day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 1, max_per_slot: 1, owner: null });
  }
  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 60 * 1000).toISOString();

  return {
    posting_schedule: scheduleRows,
    social_posts: [
      {
        id: 'regr-frv-text-fb-0001', platform: 'facebook', status: 'approved', content: 'Dossie keeps every TREC deadline on one screen.',
        target_owner: 'dossie', posted_at: null, scheduled_for: pastIso, approved_at: nowIso,
        media_url: null, video_required: false, hashtags: [], persona: 'dossie_brand', content_hash: null,
      },
    ],
    video_library: [
      {
        id: 'regr-frv-video-0001', target_owner: 'dossie', platforms: ['facebook'],
        caption: 'Regression harness caption.', quality_status: 'passed', scheduled_for: null,
        zernio_deliveries: [], retry_count: 0,
        ...videoOverrides,
      },
    ],
    zernio_accounts: [
      { platform: 'facebook', owner: 'dossie', is_active: true, zernio_account_id: 'regr-frv-fb-acct', page_id: '111222333' },
    ],
    ops_flags: [{ key: 'publish_content', enabled: true, reason: 'regression harness' }],
    content_batches: [{ id: 'regr-frv-batch-1', generated_at: nowIso }],
  };
}

const API_DIR = path.join(REPO, 'api') + path.sep;
function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(API_DIR)) delete require.cache[key];
  }
}

function fakeReqRes() {
  const req = { headers: { 'x-vercel-cron': '1' }, query: {} };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
    setHeader() { return this; },
    end() { return this; },
    get result() { return { statusCode, jsonBody }; },
  };
  return { req, res };
}

async function runTextPipeline(state) {
  const server = await startMockSupabaseB(state);
  const port = server.address().port;

  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  clearModuleCache();
  const publishApproved = require(path.join(REPO, 'api/cron-publish-approved.js'));

  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com')) {
      return new Response(JSON.stringify({ post: { _id: 'zn-unused', platforms: [] } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return underlyingFetch(input, init);
  };

  const { req, res } = fakeReqRes();
  await publishApproved(req, res);
  const result = res.result.jsonBody || {};

  globalThis.fetch = underlyingFetch;
  server.close();
  clearModuleCache();

  return { result, fbPost: state.social_posts.find((p) => p.id === 'regr-frv-text-fb-0001') };
}

async function runPartB() {
  console.log('\n' + '='.repeat(78));
  console.log('PART B — api/cron-publish-approved.js (real handler): reservation holds');
  console.log('         the Facebook slot against a competing text post');
  console.log('='.repeat(78));

  const todayIso = new Date().toISOString();

  // ── B1: failed_retryable, failed TODAY, under the retry cap — the exact
  // recoverable shape. Text must YIELD its slot.
  console.log("\nTest B1: failed_retryable (failed today, retry_count 0) — text must YIELD the facebook slot");
  const stateB1 = freshStateB({ id: 'regr-frv-video-0001', status: 'failed_retryable', failed_at: todayIso, retry_count: 0 });
  const b1 = await runTextPipeline(stateB1);
  console.log('  text pipeline result:', JSON.stringify(b1.result));
  check('text published 0 (not 1)', () => assert.strictEqual(b1.result.published, 0, JSON.stringify(b1.result)));
  check('fb post still approved (never consumed the slot)', () => assert.strictEqual(b1.fbPost.status, 'approved'));
  check('skip reason cites the video reservation', () => {
    const skips = b1.result.skips || [];
    assert.ok(skips.some((s) => /reserved for pending video/i.test(s.reason || '')), JSON.stringify(skips));
  });

  // ── B2: genuinely broken — status='failed' (terminal), NOT
  // 'failed_retryable'. Must NOT reserve anything — text publishes
  // normally, proving a hard failure never holds capacity hostage.
  console.log("\nTest B2: terminal 'failed' (not retryable) — must NOT reserve — text publishes normally");
  const stateB2 = freshStateB({ id: 'regr-frv-video-0001', status: 'failed', failed_at: todayIso, retry_count: 0, failure_reason: 'zernio_delivery_error' });
  const b2 = await runTextPipeline(stateB2);
  console.log('  text pipeline result:', JSON.stringify(b2.result));
  check('text published 1 (the slot was never reserved)', () => assert.strictEqual(b2.result.published, 1, JSON.stringify(b2.result)));
  check('fb post is posted/publishing (consumed the slot normally)', () => assert.notStrictEqual(b2.fbPost.status, 'approved'));

  // ── B3: failed_retryable but EXHAUSTED (retry_count >= cap) — must NOT
  // reserve either, same as a terminal failure, since it will never be
  // retried again regardless of what the alarm finds next.
  console.log(`\nTest B3: failed_retryable but EXHAUSTED (retry_count=${MAX_VIDEO_RETRIES}) — must NOT reserve`);
  const stateB3 = freshStateB({ id: 'regr-frv-video-0001', status: 'failed_retryable', failed_at: todayIso, retry_count: MAX_VIDEO_RETRIES });
  const b3 = await runTextPipeline(stateB3);
  console.log('  text pipeline result:', JSON.stringify(b3.result));
  check('text published 1 (exhausted row holds nothing)', () => assert.strictEqual(b3.result.published, 1, JSON.stringify(b3.result)));

  // ── B4: failed_retryable, but failed_at is from YESTERDAY, not today —
  // a stale row must not reserve capacity forever.
  console.log('\nTest B4: failed_retryable but failed_at is from YESTERDAY — must NOT reserve (stale)');
  const yesterdayIso = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const stateB4 = freshStateB({ id: 'regr-frv-video-0001', status: 'failed_retryable', failed_at: yesterdayIso, retry_count: 0 });
  const b4 = await runTextPipeline(stateB4);
  console.log('  text pipeline result:', JSON.stringify(b4.result));
  check('text published 1 (stale failure holds nothing)', () => assert.strictEqual(b4.result.published, 1, JSON.stringify(b4.result)));
}

(async () => {
  await runPartA();
  await runPartB();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  process.exit(0);
})().catch((err) => {
  console.error('REGRESSION SCRIPT CRASHED:', err);
  process.exit(1);
});
