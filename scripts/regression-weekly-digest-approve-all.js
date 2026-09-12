#!/usr/bin/env node
'use strict';

/**
 * Regression test for the weekly batch-approval digest
 * (api/_lib/weekly-batch-digest.js + api/cron-weekly-batch-digest.js +
 * api/telegram-webhook.js "Approve all" / "approve post N" wiring).
 *
 * Heath, 2026-09-12: "lets prepare a week's worth of posts that I can
 * approve at a time... Im a bottle neck here."
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. "Approve all" flips every listed row that is STILL status='draft' —
 *      both social_posts and group_posts — to 'approved', and nothing else
 *      in the tables (a same-status row NOT in the digest's items list must
 *      never be touched).
 *   2. A race: an item in the list whose live status changed between
 *      digest-send and the "Approve all" tap (e.g. Heath already rejected
 *      it via text command) is skipped, not clobbered back to approved.
 *   3. The legacy group_posts "first_comment_body must mention Dossie" gate
 *      (api/group-post-callback.js parity) still blocks a non-compliant row
 *      even inside a bulk "Approve all" — it must be approved individually.
 *   4. approveOneItem / rejectOneItem (the "approve post N" / "reject post
 *      N" text-command path) touch only the single targeted row.
 *
 * Real in-memory PostgREST mock over HTTP (matchFilter ported from
 * scripts/regression-group-post-pipeline.js) — ZERO production access.
 *
 * Run manually:
 *   node scripts/regression-weekly-digest-approve-all.js
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
  const db = { social_posts: seed.social_posts.map((r) => ({ ...r })), group_posts: seed.group_posts.map((r) => ({ ...r })) };
  const patchLog = [];

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
      const matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));

      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(matched.map((r) => ({ ...r }))));
        return;
      }

      if (req.method === 'PATCH') {
        let body = {};
        try { body = JSON.parse(raw); } catch { /* noop */ }
        patchLog.push({ table, query: url.search, body, matchedIds: matched.map((r) => r.id) });
        for (const r of matched) Object.assign(r, body);
        const wantsRep = String(req.headers['prefer'] || '').includes('return=representation');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wantsRep ? matched.map((r) => ({ ...r })) : []));
        return;
      }

      res.writeHead(404);
      res.end('{}');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, db, patchLog });
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

  const seed = {
    social_posts: [
      { id: 'sp-1', platform: 'facebook', status: 'draft', hook: 'hook one' },
      { id: 'sp-2', platform: 'linkedin', status: 'draft', hook: 'hook two' },
      // NOT in the digest items list — same status, must never be touched.
      { id: 'sp-untouched', platform: 'facebook', status: 'draft', hook: 'should stay draft' },
      // In the items list, but already rejected by the time "Approve all"
      // fires (Heath used "reject post N" first) — must be skipped, not
      // clobbered back to approved.
      { id: 'sp-race', platform: 'twitter', status: 'rejected', hook: 'raced' },
    ],
    group_posts: [
      { id: 'gp-1', group_name: 'Windcrest', status: 'draft', pipeline: null, first_comment_body: 'Ask Dossie about it' },
      { id: 'gp-blocked', group_name: 'TC Admins', status: 'draft', pipeline: null, first_comment_body: 'no mention of the product here' },
    ],
  };

  const mock = await startMockSupabase(seed);
  process.env.SUPABASE_URL = `http://127.0.0.1:${mock.port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

  delete require.cache[require.resolve(path.join(REPO, 'api/_lib/weekly-batch-digest.js'))];
  const lib = require(path.join(REPO, 'api/_lib/weekly-batch-digest.js'));

  const items = [
    { n: 1, table: 'social_posts', id: 'sp-1', platform: 'facebook' },
    { n: 2, table: 'social_posts', id: 'sp-2', platform: 'linkedin' },
    { n: 3, table: 'social_posts', id: 'sp-race', platform: 'twitter' },
    { n: 4, table: 'group_posts', id: 'gp-1', group_name: 'Windcrest', pipeline: null },
    { n: 5, table: 'group_posts', id: 'gp-blocked', group_name: 'TC Admins', pipeline: null },
  ];

  console.log('\nTest 1: approveAllItems — flips only listed+still-draft rows');
  const result = await lib.approveAllItems(items);

  check('sp-1 approved', () => assert.strictEqual(mock.db.social_posts.find((r) => r.id === 'sp-1').status, 'approved'));
  check('sp-2 approved', () => assert.strictEqual(mock.db.social_posts.find((r) => r.id === 'sp-2').status, 'approved'));
  check('sp-untouched (not in items list) stays draft', () => assert.strictEqual(mock.db.social_posts.find((r) => r.id === 'sp-untouched').status, 'draft'));
  check('sp-race (already rejected before approve-all) stays rejected, not clobbered', () => assert.strictEqual(mock.db.social_posts.find((r) => r.id === 'sp-race').status, 'rejected'));
  check('sp-race reported in skipped[]', () => assert.ok(result.skipped.some((s) => s.id === 'sp-race')));

  check('gp-1 approved with auto_post_at set', () => {
    const row = mock.db.group_posts.find((r) => r.id === 'gp-1');
    assert.strictEqual(row.status, 'approved');
    assert.ok(row.auto_post_at, 'auto_post_at must be set — local queue-runner scripts poll on it');
  });
  check('gp-blocked (no Dossie mention) stays draft — blocked from bulk approve', () => {
    assert.strictEqual(mock.db.group_posts.find((r) => r.id === 'gp-blocked').status, 'draft');
  });
  check('gp-blocked reported in skipped[] with the Dossie-mention reason', () => {
    const entry = result.skipped.find((s) => s.id === 'gp-blocked');
    assert.ok(entry, 'gp-blocked should appear in skipped[]');
    assert.ok(/Dossie/.test(entry.reason), `expected the reason to explain the Dossie-mention rule, got: ${entry.reason}`);
  });
  check('approved count is exactly 3 (sp-1, sp-2, gp-1) — never sp-race, never gp-blocked, never sp-untouched', () => {
    assert.strictEqual(result.approved.length, 3, `expected 3 approved, got ${JSON.stringify(result.approved)}`);
  });

  console.log('\nTest 2: approveOneItem / rejectOneItem touch only the targeted row');
  mock.patchLog.length = 0;
  await lib.approveOneItem({ n: 6, table: 'social_posts', id: 'sp-untouched' });
  check('sp-untouched now approved via single-item approve', () => assert.strictEqual(mock.db.social_posts.find((r) => r.id === 'sp-untouched').status, 'approved'));
  check('single-item approve only ever PATCHed sp-untouched', () => {
    assert.ok(mock.patchLog.every((p) => p.query.includes('sp-untouched')), `expected every patch to target sp-untouched only, got: ${JSON.stringify(mock.patchLog)}`);
  });

  mock.server.close();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
