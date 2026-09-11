#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-11 URGENT fix to the social-post
 * approval gate (api/cron-send-for-approval.js + api/cron-auto-approve.js).
 *
 * THE BUG
 * -------
 * A draft social_posts row with requires_approval=true went to Telegram
 * under the header "Auto-posting in 30 min — tap Reject to cancel" with
 * ONLY Reject/Edit buttons — no way to affirmatively approve. 30 minutes
 * later, cron-auto-approve.js silently flipped status='draft' to
 * 'approved' regardless of whether Heath ever saw the message. Silence
 * equalled consent for content posting under Heath's real name and real
 * estate license.
 *
 * THE FIX
 * -------
 * 1. cron-send-for-approval.js's inlineKeyboard() now includes an explicit
 *    "Approve" button (callback_data=approve_<id>) — already fully
 *    supported server-side by api/telegram-webhook.js, just never offered.
 * 2. cron-auto-approve.js NEVER promotes a requires_approval=true draft to
 *    'approved' via a timer. An unanswered draft instead EXPIRES to
 *    status='rejected' (rejection_reason explains why) after
 *    EXPIRE_APPROVAL_HOURS — it never posts.
 * 3. requires_approval=false (veto mode, explicit STOP/PREVIEW keyboard,
 *    10-min window) is UNCHANGED — that is a deliberately different,
 *    already-labeled lower-stakes design, not the reported inversion.
 *
 * TESTS (local mock PostgREST — ZERO production access, ZERO real posts):
 *   1. A requires_approval=true draft's approval message includes an
 *      Approve button and no "Auto-posting" promise.
 *   2. cron-auto-approve NEVER PATCHes a requires_approval=true draft to
 *      status='approved', no matter how old telegram_sent_at is.
 *   3. A requires_approval=true draft older than the expiry window gets
 *      PATCHed to status='rejected' (never 'approved') with a conditional
 *      filter (status=eq.draft) so a genuine human tap always wins a race.
 *   4. requires_approval=false (veto mode) still auto-approves after 10
 *      min silence — unchanged lane, no regression.
 *
 * Run manually:
 *   node scripts/regression-social-post-approval-gate.js
 */

const assert = require('assert');
const http = require('http');
const path = require('path');

const REPO = path.join(__dirname, '..');

function startMockSupabase(socialPosts) {
  const patches = [];
  const gets = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const table = url.pathname.split('/').pop();
      const q = url.search || '';

      if (req.method === 'PATCH') {
        let body = null;
        try { body = JSON.parse(raw); } catch { body = raw; }
        patches.push({ table, query: q, body });
        // Apply status filter semantics loosely: if the query contains
        // status=eq.draft and the fixture no longer has status draft for
        // that id, simulate PostgREST's zero-row match (still 200/ok, but
        // we don't need real conditional semantics for this test — we just
        // record what cron code SENT, which is the thing we're asserting on).
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{}]');
        return;
      }

      if (req.method === 'GET') {
        gets.push({ table, query: q });
        if (table === 'social_posts') {
          let rows = socialPosts.slice();
          if (q.includes('requires_approval=eq.false')) {
            rows = rows.filter((r) => r.requires_approval === false);
          } else if (q.includes('requires_approval=eq.true')) {
            rows = rows.filter((r) => r.requires_approval === true);
          }
          if (q.includes('status=eq.draft')) {
            rows = rows.filter((r) => r.status === 'draft');
          }
          // Real PostgREST semantics for telegram_sent_at=lte.<cutoff> —
          // required so the test actually exercises the 24h expiry boundary
          // instead of matching every fixture regardless of age.
          const lteMatch = q.match(/telegram_sent_at=lte\.([^&]+)/);
          if (lteMatch) {
            const cutoff = new Date(decodeURIComponent(lteMatch[1])).getTime();
            rows = rows.filter((r) => r.telegram_sent_at && new Date(r.telegram_sent_at).getTime() <= cutoff);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(rows.map((r) => ({ id: r.id }))));
          return;
        }
        // fb_comment_replies, comment_drafts, cron_runs, etc — empty is fine.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }

      if (req.method === 'POST') {
        // cron_runs upsert (telemetry) etc.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[{}]');
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, patches, gets });
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

  // ── Test 1: inlineKeyboard offers Approve ─────────────────────────────
  console.log('\nTest 1: cron-send-for-approval inlineKeyboard includes Approve');
  delete require.cache[require.resolve(path.join(REPO, 'api/cron-send-for-approval.js'))];
  // Load the module source directly to inspect the built keyboard without
  // standing up a full handler run (keeps this test fast and dependency-free).
  const sendForApprovalSrc = require('fs').readFileSync(path.join(REPO, 'api/cron-send-for-approval.js'), 'utf8');
  check('inlineKeyboard() callback_data includes approve_${postId}', () => {
    assert.ok(/approve_\$\{postId\}/.test(sendForApprovalSrc), 'no approve_${postId} callback_data found in inlineKeyboard()');
  });
  check('needsApproval branch no longer promises "Auto-posting in 30 min"', () => {
    const needsApprovalBlock = sendForApprovalSrc.split("} else if (needsApproval) {")[1] || '';
    assert.ok(!/Auto-posting in 30 min/.test(needsApprovalBlock.split('} else {')[0]), 'still promises auto-posting for requires_approval=true');
  });

  // ── Test 2 + 3: cron-auto-approve never approves, expires instead ──────
  console.log('\nTest 2+3: cron-auto-approve never flips requires_approval=true to approved; expires unanswered drafts');
  const now = Date.now();
  const fixtures = [
    // A requires_approval=true draft sent 40 min ago — old enough for the
    // OLD 30-min bug to have auto-approved it. Must NOT be approved.
    { id: 'appr-40min', status: 'draft', requires_approval: true, telegram_sent_at: new Date(now - 40 * 60 * 1000).toISOString() },
    // A requires_approval=true draft sent 25 hours ago — past the new 24h
    // expiry window. Must be marked rejected (expired), never approved.
    { id: 'appr-25h', status: 'draft', requires_approval: true, telegram_sent_at: new Date(now - 25 * 60 * 60 * 1000).toISOString() },
    // A veto-mode draft sent 15 min ago — past the unchanged 10-min veto
    // window. Must still auto-approve (no regression on the existing lane).
    { id: 'veto-15min', status: 'draft', requires_approval: false, telegram_sent_at: new Date(now - 15 * 60 * 1000).toISOString() },
  ];

  const mock = await startMockSupabase(fixtures);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.TELEGRAM_CRON_NOTIFICATIONS = 'off'; // suppress any real-looking sends

  delete require.cache[require.resolve(path.join(REPO, 'api/cron-auto-approve.js'))];
  const handler = require(path.join(REPO, 'api/cron-auto-approve.js'));

  const req = { headers: { 'x-vercel-cron': '1' } };
  let statusCode = null;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(body) { jsonBody = body; return this; },
  };

  await handler(req, res);

  check('handler responded 200', () => assert.strictEqual(statusCode, 200));

  const patchedIds = mock.patches.map((p) => {
    const idMatch = p.query.match(/id=eq\.([^&]+)/);
    return idMatch ? decodeURIComponent(idMatch[1]) : null;
  });

  check('appr-40min was NEVER patched to approved (only conditional GETs use 30min-style window; no approve patch)', () => {
    const patch = mock.patches.find((p) => p.table === 'social_posts' && p.query.includes('id=eq.appr-40min'));
    assert.ok(!patch, 'appr-40min should not have been touched at all — not old enough to expire (24h), and requires_approval=true is never auto-approved by a timer');
  });

  check('appr-25h was patched to status=rejected (expired), never approved', () => {
    const patch = mock.patches.find((p) => p.table === 'social_posts' && p.query.includes('id=eq.appr-25h'));
    assert.ok(patch, 'expected a PATCH for appr-25h');
    assert.strictEqual(patch.body.status, 'rejected', `expected status='rejected', got ${JSON.stringify(patch.body)}`);
    assert.ok(/expired/i.test(patch.body.rejection_reason || ''), 'rejection_reason should explain the expiry');
    assert.ok(patch.query.includes('status=eq.draft'), 'expire PATCH must be conditional on status=eq.draft so a human tap always wins a race');
  });

  check('no PATCH anywhere ever sets status=approved for a requires_approval=true row', () => {
    const badPatch = mock.patches.find((p) =>
      p.table === 'social_posts'
      && p.body && p.body.status === 'approved'
      && (p.query.includes('appr-40min') || p.query.includes('appr-25h')));
    assert.ok(!badPatch, `found a forbidden auto-approve patch: ${JSON.stringify(badPatch)}`);
  });

  check('veto-15min still auto-approved (unchanged lane)', () => {
    const patch = mock.patches.find((p) => p.table === 'social_posts' && p.query.includes('id=eq.veto-15min') && p.body && p.body.status === 'approved');
    assert.ok(patch, 'expected veto-15min to be auto-approved after its 10-min window — this lane must be unaffected by the fix');
  });

  mock.server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Regression test crashed:', err);
  process.exit(1);
});
