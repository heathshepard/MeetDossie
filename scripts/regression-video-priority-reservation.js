#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-10-01 VIDEO-PRIORITY RESERVATION fix
 * (Heath: "Video is the priority. We should always be doing video moving
 * forward.").
 *
 * THE BUG (measured, 2026-09-28 and 2026-09-30 — see api/_lib/
 * video-reservation.js file header for the full writeup)
 * -------------------------------------------------------------------------
 * posting_schedule.max_per_day is a single cap per (platform, owner),
 * SHARED between api/cron-publish-approved.js (text) and
 * api/cron-post-videos.js (video). Each pipeline enforced the cap
 * independently with no knowledge of the other. Text runs earlier in the
 * day, so on 2026-09-28 two text posts fully consumed Dossie
 * facebook/linkedin's daily cap (2/2) before a 5-platform video row was
 * ever scanned — the video gate-skipped both platforms it most needed.
 *
 * THE FIX
 * -------
 * cron-publish-approved.js's isDueForPublish() now refuses a text post's
 * slot whenever doing so would leave no room for a pending (heath_approved
 * / pending_heath_review) video_library row that targets the same
 * platform+owner today — see api/_lib/video-reservation.js.
 *
 * THIS TEST reproduces the real 9/28 shape end-to-end, through the ACTUAL
 * production handlers (not a reimplementation):
 *   1. Seed one approved text post each for facebook and linkedin, AND one
 *      heath_approved multi-platform video targeting both, all against a
 *      max_per_day=1 schedule (the smallest cap that can even reproduce
 *      contention).
 *   2. Run cron-publish-approved.js's real handler FIRST (text runs earlier
 *      in the day — exactly the real-world ordering).
 *   3. Run cron-post-videos.js's real handler SECOND (the video batch scan
 *      that, pre-fix, found the cap already gone).
 *   4. Assert the video wins both platforms and the text posts yielded.
 *
 * Run TWICE against the same in-memory fixtures/mocks:
 *   - BEFORE: api/cron-publish-approved.js content as it exists on HEAD
 *     (this branch's starting point, i.e. unpatched/current main behavior)
 *     — MUST FAIL (text wins, video gate-skips both platforms, same as the
 *     real 2026-09-28 incident).
 *   - AFTER: the current working-tree content (this fix applied) — MUST
 *     PASS (video wins, text yields).
 *
 * A test that passes both proves nothing — this one is designed to fail on
 * the "BEFORE" content and pass on "AFTER", proving the fix actually
 * changes behavior rather than just existing.
 *
 * Zero production access, zero real posts — local mock PostgREST + Zernio
 * interception, same pattern as scripts/regression-post-videos-schedule-caps.js.
 *
 * Run manually:
 *   node scripts/regression-video-priority-reservation.js
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PUBLISH_APPROVED_PATH = path.join(REPO, 'api', 'cron-publish-approved.js');
const POST_VIDEOS_PATH = path.join(REPO, 'api', 'cron-post-videos.js');
const VIDEO_RESERVATION_PATH = path.join(REPO, 'api', '_lib', 'video-reservation.js');

const VIDEO_ID = 'regr-video-priority-0001';
const FB_POST_ID = 'regr-text-fb-0001';
const LI_POST_ID = 'regr-text-li-0001';

// ─── tiny PostgREST-ish filter matcher ────────────────────────────────────
// Supports: eq, neq, is.null, in.(a,b), gte, lte, gt, lt on repeated/plain
// query params, plus one level of or(...)/and(...) nesting — exactly the
// operators the two real handlers under test actually emit.

function splitTopLevel(str) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

function evalCond(cond, row) {
  const andMatch = cond.match(/^and\((.*)\)$/s);
  if (andMatch) return splitTopLevel(andMatch[1]).every((c) => evalCond(c, row));
  const orMatch = cond.match(/^or\((.*)\)$/s);
  if (orMatch) return splitTopLevel(orMatch[1]).some((c) => evalCond(c, row));
  const m = cond.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\.([a-z]+)\.(.*)$/s);
  if (!m) return true;
  const [, key, op, rawVal] = m;
  const val = decodeURIComponent(rawVal);
  const rowVal = row[key];
  switch (op) {
    case 'eq': return String(rowVal) === val;
    case 'neq': return String(rowVal) !== val;
    case 'is': {
      if (val === 'null') return rowVal === null || rowVal === undefined;
      if (val === 'true') return rowVal === true;
      if (val === 'false') return rowVal === false;
      return true;
    }
    case 'in': {
      const set = val.replace(/^\(/, '').replace(/\)$/, '').split(',');
      return set.includes(String(rowVal));
    }
    case 'gte': return rowVal != null && String(rowVal) >= val;
    case 'lte': return rowVal != null && String(rowVal) <= val;
    case 'gt': return rowVal != null && String(rowVal) > val;
    case 'lt': return rowVal != null && String(rowVal) < val;
    default: return true;
  }
}

function rowMatchesQuery(row, searchParams) {
  for (const [key, value] of searchParams.entries()) {
    if (key === 'select' || key === 'order' || key === 'limit') continue;
    if (key === 'or') {
      if (!evalCond(`or(${value.replace(/^\(/, '').replace(/\)$/, '')})`, row)) return false;
      continue;
    }
    if (!evalCond(`${key}.${value}`, row)) return false;
  }
  return true;
}

// ─── fixture builders ─────────────────────────────────────────────────────

function freshState() {
  const scheduleRows = [];
  for (let dow = 0; dow < 7; dow++) {
    scheduleRows.push(
      { platform: 'facebook', day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 1, max_per_slot: 1, owner: null },
      { platform: 'linkedin', day_of_week: dow, time_slots: ['00:00:00'], timezone: 'America/Chicago', is_active: true, max_per_day: 1, max_per_slot: null, owner: null },
    );
  }

  const nowIso = new Date().toISOString();
  // Already-past scheduled_for (not null) — a null scheduled_for gets
  // rewritten by assignFreshScheduleForOrphans() to a FUTURE slot before the
  // approved-and-due queue is even fetched, which would make both text
  // posts invisible to this run instead of exercising the cap/reservation
  // gate this test targets. A past timestamp satisfies the queue's own
  // `scheduled_for.lte.now` due-check without tripping the orphan backfill
  // (which only touches scheduled_for IS NULL rows).
  const pastIso = new Date(Date.now() - 60 * 1000).toISOString();

  return {
    posting_schedule: scheduleRows,
    social_posts: [
      {
        id: FB_POST_ID, platform: 'facebook', status: 'approved', content: 'Dossie keeps every TREC deadline on one screen.',
        target_owner: 'dossie', posted_at: null, scheduled_for: pastIso, approved_at: nowIso,
        media_url: null, video_required: false, hashtags: [], persona: 'dossie_brand', content_hash: null,
      },
      {
        id: LI_POST_ID, platform: 'linkedin', status: 'approved', content: 'Dossie cites the paragraph, not just the deadline.',
        target_owner: 'dossie', posted_at: null, scheduled_for: pastIso, approved_at: nowIso,
        media_url: null, video_required: false, hashtags: [], persona: 'dossie_brand', content_hash: null,
      },
    ],
    video_library: [
      {
        id: VIDEO_ID, status: 'heath_approved', topic: 'video-priority regression harness',
        platforms: ['facebook', 'linkedin'], caption: 'Regression harness caption for video-priority reservation.',
        supabase_url: 'https://example.com/storage/v1/object/public/videos/regr-priority.mp4',
        target_owner: 'dossie', quality_status: 'passed', scheduled_for: null, zernio_deliveries: [],
      },
    ],
    zernio_accounts: [
      { platform: 'facebook', owner: 'dossie', is_active: true, zernio_account_id: 'regr-fb-acct', page_id: '111222333' },
      { platform: 'linkedin', owner: 'dossie', is_active: true, zernio_account_id: 'regr-li-acct' },
    ],
    ops_flags: [
      { key: 'publish_content', enabled: true, reason: 'regression harness' },
    ],
    content_batches: [
      { id: 'regr-batch-1', generated_at: nowIso },
    ],
  };
}

function startMockSupabase(state) {
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
          let matched = rows.filter((r) => rowMatchesQuery(r, url.searchParams));
          const limitParam = url.searchParams.get('limit');
          if (limitParam) matched = matched.slice(0, Number(limitParam));
          return json(matched);
        }

        if (req.method === 'PATCH') {
          let body = null;
          try { body = JSON.parse(raw); } catch { body = {}; }
          if (!Array.isArray(rows)) return json([]);
          const matched = rows.filter((r) => rowMatchesQuery(r, url.searchParams));
          matched.forEach((r) => Object.assign(r, body));
          const wantsRepresentation = /return=representation/i.test(req.headers.prefer || '');
          return json(wantsRepresentation ? matched : []);
        }

        if (req.method === 'POST') {
          // Inserts (e.g. telemetry/action-log tables this test doesn't model)
          // — accept and discard, never block the handler under test.
          return json([{}]);
        }

        return json([]);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function fakeReqRes(query = {}) {
  const req = { headers: { 'x-vercel-cron': '1' }, query };
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

// Clear every cached module under api/ — not just the two handlers. Several
// api/_lib/*.js modules (e.g. ops-policy.js) capture process.env.SUPABASE_URL
// into a top-level const AT REQUIRE TIME. Between the BEFORE and AFTER runs
// this harness spins up a brand-new mock server on a new port each time; if
// a module stays cached from the first run, it keeps pointing at the first
// run's (now-closed) server and every Supabase call it makes fails closed.
const API_DIR = path.join(REPO, 'api') + path.sep;
function clearModuleCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(API_DIR)) delete require.cache[key];
  }
}

async function runScenario(label) {
  const state = freshState();
  const server = await startMockSupabase(state);
  const port = server.address().port;

  delete process.env.TELEGRAM_CRON_NOTIFICATIONS;
  process.env.SUPABASE_URL = `http://127.0.0.1:${port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'regr-dummy-key';
  process.env.ZERNIO_API_KEY = 'regr-dummy-zernio-key';
  process.env.TELEGRAM_BOT_TOKEN = 'regr-dummy-token';
  process.env.TELEGRAM_CHAT_ID = '111111';
  process.env.CRON_SECRET = 'regr-dummy-secret';

  clearModuleCache();
  const publishApproved = require(PUBLISH_APPROVED_PATH);
  const postVideos = require(POST_VIDEOS_PATH);

  const zernioCalls = []; // { platform, url }
  const underlyingFetch = globalThis.fetch;
  globalThis.fetch = async function interceptedFetch(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('zernio.com')) {
      let payload = null;
      try { payload = JSON.parse(init && init.body); } catch { payload = null; }
      const platform = payload && payload.platforms && payload.platforms[0] && payload.platforms[0].platform;
      zernioCalls.push({ platform, payload });
      return new Response(JSON.stringify({
        post: { _id: `zn-${zernioCalls.length}`, platforms: [{ platformPostUrl: `https://example.com/${platform}/zn-${zernioCalls.length}` }] },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('api.telegram.org')) {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return underlyingFetch(input, init);
  };

  // --- STEP A: text pipeline runs first (matches real-world ordering) ---
  const { req: textReq, res: textRes } = fakeReqRes();
  await publishApproved(textReq, textRes);
  const textResult = textRes.result.jsonBody || {};
  const zernioCallsAfterText = zernioCalls.map((c) => c.platform);

  // --- STEP B: video batch scan runs second ---
  const { req: vidReq, res: vidRes } = fakeReqRes();
  await postVideos(vidReq, vidRes);
  const videoResult = vidRes.result.jsonBody || {};
  const zernioCallsAfterVideo = zernioCalls.map((c) => c.platform);

  globalThis.fetch = underlyingFetch;
  server.close();

  const videoRow = state.video_library.find((r) => r.id === VIDEO_ID);
  const fbPost = state.social_posts.find((r) => r.id === FB_POST_ID);
  const liPost = state.social_posts.find((r) => r.id === LI_POST_ID);

  return {
    label,
    textResult,
    videoResult,
    zernioCallsAfterText,
    zernioCallsAfterVideo,
    videoRowFinalStatus: videoRow.status,
    fbPostFinalStatus: fbPost.status,
    liPostFinalStatus: liPost.status,
    skips: textResult.skips || [],
  };
}

(async () => {
  const fixedContent = fs.readFileSync(PUBLISH_APPROVED_PATH, 'utf8');
  let originContent;
  try {
    originContent = require('child_process')
      .execSync('git show HEAD:api/cron-publish-approved.js', { cwd: REPO })
      .toString();
  } catch (err) {
    console.error('Could not read HEAD content of api/cron-publish-approved.js — aborting:', err.message);
    process.exit(1);
  }

  const results = {};
  try {
    console.log('='.repeat(78));
    console.log('RUN 1/2 — BEFORE (api/cron-publish-approved.js as committed on HEAD,');
    console.log('          i.e. current/unpatched behavior — this run is EXPECTED TO FAIL)');
    console.log('='.repeat(78));
    fs.writeFileSync(PUBLISH_APPROVED_PATH, originContent);
    results.before = await runScenario('BEFORE (HEAD, unpatched)');

    console.log('\n' + '='.repeat(78));
    console.log('RUN 2/2 — AFTER (working-tree content, video-priority fix applied —');
    console.log('          this run is EXPECTED TO PASS)');
    console.log('='.repeat(78));
    fs.writeFileSync(PUBLISH_APPROVED_PATH, fixedContent);
    results.after = await runScenario('AFTER (working tree, fixed)');
  } finally {
    // Always restore the real working-tree file, even if an assertion throws.
    fs.writeFileSync(PUBLISH_APPROVED_PATH, fixedContent);
    clearModuleCache();
  }

  function report(r) {
    console.log(`\n--- ${r.label} ---`);
    console.log(`text pipeline: published=${r.textResult.published} skips=${JSON.stringify(r.skips)}`);
    console.log(`Zernio calls after text step:  [${r.zernioCallsAfterText.join(', ') || '(none)'}]`);
    console.log(`Zernio calls after video step: [${r.zernioCallsAfterVideo.join(', ') || '(none)'}]`);
    console.log(`video row final status: ${r.videoRowFinalStatus}`);
    console.log(`fb text post final status: ${r.fbPostFinalStatus} | linkedin text post final status: ${r.liPostFinalStatus}`);
  }
  report(results.before);
  report(results.after);

  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  console.log('\n' + '='.repeat(78));
  console.log('ASSERTIONS — must demonstrate BEFORE fails, AFTER passes');
  console.log('='.repeat(78));

  console.log('\nBEFORE (HEAD, unpatched) — reproduces the real 2026-09-28 bug:');
  check('BEFORE: text published to BOTH facebook and linkedin (consumed the only slot)', () => {
    assert.strictEqual(results.before.textResult.published, 2,
      `expected both text posts to publish pre-fix, got published=${results.before.textResult.published}`);
  });
  check('BEFORE: video gate-skipped BOTH facebook and linkedin (the bug)', () => {
    const videoOnlyCalls = results.before.zernioCallsAfterVideo.slice(results.before.zernioCallsAfterText.length);
    assert.deepStrictEqual(videoOnlyCalls, [],
      `expected the video step to make ZERO new Zernio calls (both platforms capped out by text), got: ${JSON.stringify(videoOnlyCalls)}`);
  });
  check("BEFORE: video row ends status='posted_partial' or worse (never fully delivered)", () => {
    assert.notStrictEqual(results.before.videoRowFinalStatus, 'posted',
      `expected the video to NOT cleanly post pre-fix, got status='${results.before.videoRowFinalStatus}'`);
  });

  console.log('\nAFTER (working tree, fixed) — video must now win the contested slot:');
  check('AFTER: text YIELDED on at least one platform (reservation held a slot for video)', () => {
    assert.ok(results.after.textResult.published < 2,
      `expected the fix to block at least one text post for video reservation, got published=${results.after.textResult.published}`);
  });
  check('AFTER: at least one text skip reason explicitly cites the video reservation', () => {
    const cited = results.after.skips.some((s) => /reserved for pending video/i.test(s.reason || ''));
    assert.ok(cited, `expected a skip reason mentioning the video reservation, got: ${JSON.stringify(results.after.skips)}`);
  });
  check('AFTER: video step posted to BOTH facebook and linkedin', () => {
    const videoOnlyCalls = results.after.zernioCallsAfterVideo.slice(results.after.zernioCallsAfterText.length);
    assert.deepStrictEqual([...videoOnlyCalls].sort(), ['facebook', 'linkedin'],
      `expected the video step to call Zernio for exactly [facebook, linkedin], got: ${JSON.stringify(videoOnlyCalls)}`);
  });
  check("AFTER: video row ends status='posted' (fully delivered, not partial)", () => {
    assert.strictEqual(results.after.videoRowFinalStatus, 'posted',
      `expected the video to cleanly post after the fix, got status='${results.after.videoRowFinalStatus}'`);
  });

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    process.exit(1);
  }
  console.log('RESULT: PASS — BEFORE reproduces the 2026-09-28 bug, AFTER proves the fix.');
  process.exit(0);
})().catch((err) => {
  // The try/finally inside the IIFE already restores api/cron-publish-
  // approved.js to its real working-tree content before any error can
  // propagate out here — nothing left to clean up.
  console.error('Harness error:', err);
  process.exit(1);
});
