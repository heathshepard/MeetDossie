#!/usr/bin/env node
'use strict';

/**
 * Regression test for the "pending admin approval" fix
 * (scripts/_lib/fb-pending-approval-detect.js + scripts/fb-group-poster.js +
 * scripts/fb-group5-post-queue.js + scripts/fb-listing-group-post-queue.js).
 *
 * THE 2026-09-14 INCIDENT
 * ------------------------
 * group_posts row a44e8758 (23 Nopalito listing, "Realtors San Antonio,
 * Boerne, Bulverde, New Braunfels") submitted fine, but that group requires
 * admin approval on every post. Facebook's own "sent to admins for review"
 * notice got caught by the generic role="alert" error scan in
 * fb-group-poster.js, which threw a posting error. The queue-runner re-read
 * the row, saw it was NOT status='posted', and tripped the SHARED circuit
 * breaker (scripts/_lib/comment-hunt-halt.js) -- silently halting comment +
 * reply posting for ~24h on a completely healthy account. A live check the
 * next day showed the post just sitting in the group's normal moderation
 * queue.
 *
 * THIS TEST PINS DOWN
 * --------------------
 *   1. DETECTION: matchesPendingApproval recognizes Facebook's real range of
 *      "sent to admins" phrasing, and does NOT fire on an unrelated error
 *      banner (so a real failure still throws / still halts).
 *   2. WIRING: fb-group-poster.js checks pending-approval BEFORE the generic
 *      error-alert throw (order matters -- the alert-scan is what caused the
 *      false positive), uses the extracted shared module (not a private
 *      re-implementation), and writes status='pending_admin_approval' with
 *      posted_at stamped / post_url left null (no live permalink yet).
 *   3. QUEUE-RUNNER BEHAVIOR (both fb-group5-post-queue.js and
 *      fb-listing-group-post-queue.js, in-memory mocks, zero network/browser):
 *      - a 'pending_admin_approval' outcome counts as posted (budget
 *        consumed, spacing gap respects it) and does NOT set the halt.
 *      - a REAL failure (row reverted to 'approved' by markFailed, as it
 *        always has been) STILL halts -- this fix must not make the breaker
 *        blind to actual problems (checkpoint, removed content, no submit).
 *
 * Run manually:
 *   node scripts/regression-group-post-pending-approval.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';

// ─── 1. Pure detection logic ──────────────────────────────────────────────────

const { matchesPendingApproval, PENDING_APPROVAL_PATTERNS } = require(
  path.join(__dirname, '_lib', 'fb-pending-approval-detect.js'),
);

function testDetection() {
  const positives = [
    'Your post has been sent to the admins for approval.',
    'This post is pending admin approval and will be visible once approved.',
    'Your post is awaiting admin approval before it appears in the group.',
    'Post will be visible after an admin reviews it.',
    'Group admins have to approve posts before they show up here.',
    'Waiting for a group admin to review your post.',
  ];
  for (const text of positives) {
    assert.strictEqual(matchesPendingApproval(text), true, `should detect pending-approval phrasing: "${text}"`);
  }

  const negatives = [
    'Something went wrong. Please try again.',
    "We couldn't post your update. Try again later.",
    'Your session has expired, please log in again.',
    '', null, undefined,
  ];
  for (const text of negatives) {
    assert.strictEqual(matchesPendingApproval(text), false, `must NOT flag a real error/unrelated text as pending-approval: "${text}"`);
  }

  assert.ok(PENDING_APPROVAL_PATTERNS.length >= 5, 'more than one phrasing variant is covered (Facebook copy is not fixed)');

  console.log('PASS: matchesPendingApproval detects the real "sent to admins" range and stays silent on unrelated errors');
}

// ─── 2. fb-group-poster.js wiring (static source checks — this file runs
//        main() at import time, so it can't be safely require()'d) ───────────

function testPosterWiring() {
  const src = fs.readFileSync(path.join(__dirname, 'fb-group-poster.js'), 'utf8');

  assert.ok(
    src.includes("require('./_lib/fb-pending-approval-detect')"),
    'fb-group-poster.js uses the extracted shared detector, not a private re-implementation',
  );

  // Order matters: the pending-approval check must run BEFORE the generic
  // role="alert" scan inside the confirmation poll loop, or the false
  // positive that caused the 2026-09-14 halt reproduces immediately.
  const pendingIdx = src.indexOf('await detectPendingApproval(page)');
  const errorAlertIdx = src.indexOf("page.locator('[data-testid=\"error-message\"], [role=\"alert\"]')");
  assert.ok(pendingIdx > -1, 'postToGroup calls detectPendingApproval inside the confirmation poll');
  assert.ok(errorAlertIdx > -1, 'the generic error-alert scan still exists (real failures must still be caught)');
  assert.ok(pendingIdx < errorAlertIdx, 'pending-approval check runs BEFORE the generic error-alert scan, not after');

  // 2026-09-16 refactor: the status decision moved into the shared, unit-
  // tested resolver (scripts/_lib/fb-post-verify-outcome.js) so the
  // false-'posted' fix has a pure function backing it. Verify the wiring
  // (postToGroup calls the resolver for this outcome) AND the resolver
  // itself still produces this status.
  assert.ok(
    src.includes("require('./_lib/fb-post-verify-outcome')"),
    'fb-group-poster.js uses the shared resolvePostStatus resolver',
  );
  assert.ok(
    src.includes('resolvePostStatus({ pendingApproval: true })'),
    'postToGroup resolves the pending-approval outcome via the shared resolver',
  );
  const resolverSrc = fs.readFileSync(path.join(__dirname, '_lib', 'fb-post-verify-outcome.js'), 'utf8');
  assert.ok(resolverSrc.includes("status: 'pending_admin_approval'"), 'resolvePostStatus can return status pending_admin_approval');
  assert.ok(src.includes('async function markPendingApproval'), 'markPendingApproval helper exists');

  const markFn = src.slice(src.indexOf('async function markPendingApproval'), src.indexOf('async function markPendingApproval') + 800);
  assert.ok(/status:\s*'pending_admin_approval'/.test(markFn), 'markPendingApproval writes status=pending_admin_approval');
  assert.ok(/posted_at:\s*now/.test(markFn), 'markPendingApproval stamps posted_at (a real submit happened)');
  assert.ok(/post_url:\s*null/.test(markFn), 'markPendingApproval leaves post_url null (no live permalink to watch/comment on yet)');

  // A pending-approval outcome must exit 0 (queue-runner success path), not
  // fall into the markFailed/exit(1) branch.
  assert.ok(
    src.includes("result.status === 'pending_admin_approval'") && src.includes('await markPendingApproval('),
    'main() routes a pending_admin_approval result to markPendingApproval, not markFailed',
  );

  // No watchlist registration for a pending post — there is no live post to
  // watch for comments on yet.
  const pendingBranch = src.slice(
    src.indexOf("result.status === 'pending_admin_approval'"),
    src.indexOf('} else {', src.indexOf("result.status === 'pending_admin_approval'")),
  );
  assert.ok(!pendingBranch.includes('registerGroupPostWatch'), 'pending-approval branch does not register a comment watchlist entry (nothing live to watch)');

  console.log('PASS: fb-group-poster.js checks pending-approval before the generic error scan and routes it to a non-failure status');
}

// ─── 3. Queue-runner behavior (in-memory PostgREST mock, same pattern as
//        regression-group-post-pipeline.js) ───────────────────────────────────

const db = { group_posts: [], comment_caps_state: [] };

function matchFilter(row, key, expr) {
  if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
  if (expr.startsWith('in.(')) {
    const vals = expr.slice(4, -1).split(',').map(decodeURIComponent);
    return vals.includes(String(row[key]));
  }
  if (expr === 'is.null') return row[key] === null || row[key] === undefined;
  if (expr === 'not.is.null') return row[key] !== null && row[key] !== undefined;
  return true;
}

let nextId = 1;
async function mockSbFetch(urlPath, init = {}) {
  const [pathname, qs] = urlPath.split('?');
  const table = pathname.replace('/rest/v1/', '');
  const rows = db[table];
  if (!rows) return { ok: false, status: 404, data: null };
  const q = {};
  for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
  const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'on_conflict', 'limit'].includes(k));
  let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
  if (q.order) {
    const [col, dir] = q.order.split('.');
    matched = [...matched].sort((a, b) => {
      const av = a[col]; const bv = b[col];
      const cmp = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
      return cmp * (dir === 'desc' ? -1 : 1);
    });
  }
  if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));

  const method = (init.method || 'GET').toUpperCase();
  if (method === 'GET') return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
  if (method === 'POST') {
    const payload = JSON.parse(init.body);
    const arr = Array.isArray(payload) ? payload : [payload];
    const inserted = [];
    for (const r of arr) {
      const row = { id: `id-${nextId++}`, ...r };
      rows.push(row);
      inserted.push(row);
    }
    return { ok: true, status: 201, data: inserted };
  }
  if (method === 'PATCH') {
    const patch = JSON.parse(init.body);
    for (const r of matched) {
      const real = rows.find((x) => x.id === r.id) || r;
      Object.assign(real, patch);
    }
    return { ok: true, status: 204, data: null };
  }
  return { ok: false, status: 405, data: null };
}

function makeHaltState() {
  let entry = null;
  return {
    isHalted: () => entry !== null,
    setHalt: (reason, detail) => { entry = { reason, ...detail }; return entry; },
    getHalt: () => entry,
    clearHalt: () => { entry = null; },
  };
}

const quietLog = { log: () => {}, warn: () => {}, error: () => {} };
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));

async function testQueueRunner(label, queueMod, runFn, pipeline, gapMinutes) {
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;

  // ── A. pending_admin_approval is NOT a failure: no halt, budget consumed ──
  const row1 = { id: 'pa-1', pipeline, status: 'approved', group_name: 'Realtors SA/Boerne/Bulverde/NB', post_body: 'x', approved_at: new Date(Date.now() - 1000).toISOString() };
  db.group_posts.push(row1);

  const pendingSpawn = async (postId) => {
    // Simulates fb-group-poster.js's markPendingApproval effect.
    const row = db.group_posts.find((r) => r.id === postId);
    row.status = 'pending_admin_approval';
    row.posted_at = new Date().toISOString();
    row.post_url = null;
    return { exitCode: 0 };
  };

  let haltState = makeHaltState();
  const r1 = await runFn({ sbFetch: mockSbFetch, caps, spawnPoster: pendingSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes });
  assert.strictEqual(r1.posted, 1, `${label}: pending_admin_approval counts as a successful run`);
  assert.strictEqual(r1.halted, false, `${label}: pending_admin_approval does not report halted`);
  assert.strictEqual(haltState.isHalted(), false, `${label}: pending_admin_approval never sets the shared halt`);
  assert.strictEqual(db.group_posts.find((r) => r.id === 'pa-1').status, 'pending_admin_approval', `${label}: row keeps pending_admin_approval, not reset/lost`);
  assert.strictEqual(db.comment_caps_state.length, 1, `${label}: budget IS consumed for a pending-approval submit (a real keystroke action happened)`);

  // ── B. Spacing gap respects a pending_admin_approval posted_at (can't spam
  //       the same profile again inside the floor just because the row isn't
  //       literally status='posted' yet) ────────────────────────────────────
  const row2 = { id: 'pa-2', pipeline, status: 'approved', group_name: 'Second Group', post_body: 'y', approved_at: new Date().toISOString() };
  db.group_posts.push(row2);
  let spawnCalls = 0;
  const neverSpawn = async () => { spawnCalls++; return { exitCode: 0 }; };
  const r2 = await runFn({ sbFetch: mockSbFetch, caps, spawnPoster: neverSpawn, notify: async () => {}, log: quietLog, haltState, gapMinutes });
  assert.strictEqual(spawnCalls, 0, `${label}: a recent pending_admin_approval submit still blocks the next post inside the spacing floor`);
  assert.strictEqual(r2.queuedForCap, 1, `${label}: the second approved row stays queued behind the gap`);

  // ── C. A REAL failure still halts (fix must not blind the breaker) ────────
  db.group_posts.length = 0;
  db.comment_caps_state.length = 0;
  haltState = makeHaltState();
  const row3 = { id: 'pa-3', pipeline, status: 'approved', group_name: 'Old Enough Group', post_body: 'z', approved_at: new Date(Date.now() - 500).toISOString() };
  db.group_posts.push(row3);
  const failingSpawn = async (postId) => {
    const row = db.group_posts.find((r) => r.id === postId);
    row.status = 'approved'; // fb-group-poster.js's real markFailed reset behavior
    return { exitCode: 1, error: 'Facebook redirected to login from persistent Chrome profile' };
  };
  const notifications = [];
  const r3 = await runFn({ sbFetch: mockSbFetch, caps, spawnPoster: failingSpawn, notify: async (t) => notifications.push(t), log: quietLog, haltState, gapMinutes });
  assert.strictEqual(r3.failed, 1, `${label}: a genuine failure is still counted as failed`);
  assert.strictEqual(r3.halted, true, `${label}: a genuine failure (checkpoint/no-submit) STILL halts the pipeline`);
  assert.ok(haltState.isHalted(), `${label}: halt state is actually set on a real failure`);
  assert.ok(notifications.some((t) => /HALTED/i.test(t)), `${label}: Heath is alerted on a real halt`);

  console.log(`PASS: ${label} — pending_admin_approval is a success (no halt, budget+spacing respected), real failures still halt`);
}

async function main() {
  testDetection();
  testPosterWiring();

  const group5Queue = require(path.join(__dirname, 'fb-group5-post-queue.js'));
  await testQueueRunner('fb-group5-post-queue', group5Queue, group5Queue.runGroup5PostQueue, 'daily5', 18);

  const listingQueue = require(path.join(__dirname, 'fb-listing-group-post-queue.js'));
  await testQueueRunner('fb-listing-group-post-queue', listingQueue, listingQueue.runListingGroupPostQueue, 'listing-groups', 30);

  console.log('PASS: pending-admin-approval fix — detection, poster wiring, and both queue-runners');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
