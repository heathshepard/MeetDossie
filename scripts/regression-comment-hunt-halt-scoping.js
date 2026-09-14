#!/usr/bin/env node
'use strict';

/**
 * Regression test for the PER-GROUP circuit breaker
 * (scripts/_lib/comment-hunt-halt.js + scripts/fb-comment-hunt-daily.js +
 * scripts/fb-comment-opp-poster.js).
 *
 * THE INCIDENT THIS PINS DOWN (2026-09-10 -> 2026-09-14)
 * --------------------------------------------------------
 * A human moderator removed one comment Heath posted in "Transaction
 * Coordinators and Admins for Real Estate" (TC-only group, Rule 1 excludes
 * realtors). The old halt module had exactly ONE global switch, so that
 * single removal in one group halted ALL scanning and ALL posting across
 * every group for three days — zero distribution output over one strict
 * moderator, with no account-level signal anywhere (FB violations page
 * clean, Account Quality clean, no checkpoint).
 *
 * THE FIX BEING PINNED DOWN
 * --------------------------
 * 1. A single group's removed comment pauses THAT GROUP only — every other
 *    group (and the group-post queues sharing this file) keep running.
 * 2. A checkpoint / login redirect / account restriction is ALWAYS global —
 *    that IS an account-level signal.
 * 3. Comment removals across 2+ DISTINCT groups auto-escalate to a global
 *    halt — a pattern across groups is a real signal, one strict mod in one
 *    group is not.
 * 4. Global and per-group halts clear independently (clearHalt() only
 *    touches global; clearGroupHalt() only touches one group).
 * 5. fb-comment-opp-poster.js's queue skips ONLY the rows targeting a
 *    paused group — an approved comment for a different, unpaused group
 *    still posts in the same run.
 *
 * Runs against the REAL scripts/_lib/comment-hunt-halt.js module, pointed at
 * a scratch file via COMMENT_HUNT_HALT_FILE (never touches the real
 * scripts/.comment-hunt-halt.json production state).
 *
 * Run manually:
 *   node scripts/regression-comment-hunt-halt-scoping.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Point the halt module at a scratch file BEFORE requiring it.
const SCRATCH_HALT_FILE = path.join(os.tmpdir(), `comment-hunt-halt-regression-${process.pid}-${Date.now()}.json`);
process.env.COMMENT_HUNT_HALT_FILE = SCRATCH_HALT_FILE;

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-key-not-real';

function cleanup() {
  try { if (fs.existsSync(SCRATCH_HALT_FILE)) fs.unlinkSync(SCRATCH_HALT_FILE); } catch (e) { /* non-fatal */ }
}
cleanup(); // in case a previous crashed run left it behind

const halt = require(path.join(__dirname, '_lib', 'comment-hunt-halt.js'));
assert.strictEqual(halt.HALT_FILE, SCRATCH_HALT_FILE, 'halt module is actually using the scratch file, not production state');

const poster = require(path.join(__dirname, 'fb-comment-opp-poster.js'));
const caps = require(path.join(__dirname, '_lib', 'comment-caps.js'));

const quietLog = { log: () => {}, warn: () => {}, error: () => {} };

async function main() {
  // ── 1. Clean slate ─────────────────────────────────────────────────────
  assert.strictEqual(halt.getHalt(), null, 'clean slate: no halt');
  assert.strictEqual(halt.isHalted(), false, 'clean slate: not halted');

  // ── 2. A SINGLE group's removed comment pauses only that group ─────────
  halt.setHalt('posted comment removed by moderation', {
    group: 'TC Admins Group', post_url: 'https://fb/x', scope: 'group',
  });
  assert.strictEqual(halt.isHalted('TC Admins Group'), true, 'the paused group reports halted');
  assert.strictEqual(halt.isHalted('DFW Realtors'), false, 'a DIFFERENT group is untouched by a single-group pause');
  assert.strictEqual(halt.isHalted(), false, 'bare isHalted() (global-only) is false — a single-group removal is NOT a global halt');
  assert.strictEqual(halt.getGlobalHalt(), null, 'no global halt entry exists yet');
  assert.ok(halt.getGroupHalt('TC Admins Group'), 'the group itself has a halt entry');
  assert.deepStrictEqual(Object.keys(halt.listPausedGroups()), ['TC Admins Group'], 'exactly one group paused');

  // ── 3. A SECOND distinct group's removal escalates to GLOBAL ───────────
  halt.setHalt('posted comment removed by moderation', {
    group: 'Some Other Group', post_url: 'https://fb/y', scope: 'group',
  });
  assert.strictEqual(halt.isHalted(), true, '2 distinct group removals escalate to a GLOBAL halt');
  assert.ok(halt.getGlobalHalt(), 'global halt entry now exists');
  assert.ok(Array.isArray(halt.getGlobalHalt().groups) && halt.getGlobalHalt().groups.length === 2,
    'global halt names both groups that triggered the escalation');
  assert.strictEqual(halt.isHalted('A Third Group That Was Never Touched'), true,
    'once escalated, EVERY group reports halted — even one that never had a removal');

  // ── 4. Global and per-group halts clear INDEPENDENTLY ──────────────────
  const clearedGlobal = halt.clearHalt();
  assert.strictEqual(clearedGlobal, true, 'clearHalt() reports it cleared something');
  assert.strictEqual(halt.getGlobalHalt(), null, 'global halt is gone');
  assert.strictEqual(halt.isHalted('TC Admins Group'), true, 'TC Admins Group is STILL paused — clearing global did not touch it');
  assert.strictEqual(halt.isHalted('Some Other Group'), true, 'Some Other Group is STILL paused too');
  assert.strictEqual(halt.isHalted('A Third Group That Was Never Touched'), false,
    'the untouched group is no longer swept up now that the global escalation is cleared');

  const clearedOne = halt.clearGroupHalt('TC Admins Group');
  assert.strictEqual(clearedOne, true, 'clearGroupHalt() reports it cleared something');
  assert.strictEqual(halt.isHalted('TC Admins Group'), false, 'TC Admins Group is clear');
  assert.strictEqual(halt.isHalted('Some Other Group'), true, 'Some Other Group is UNTOUCHED by clearing a different group');

  halt.clearAll();
  assert.strictEqual(halt.getHalt(), null, 'clearAll() resets everything');
  assert.deepStrictEqual(halt.listPausedGroups(), {}, 'no groups paused after clearAll()');

  // ── 5. Checkpoint / login redirect / account restriction is ALWAYS global,
  //      even with only ONE event (never needs a second one to escalate) ──
  halt.setHalt('facebook login/checkpoint redirect during scan', { group: 'DFW Realtors' });
  assert.strictEqual(halt.isHalted(), true, 'a checkpoint halts GLOBALLY off a single event, unlike a comment removal');
  assert.strictEqual(halt.isHalted('A Group That Never Saw The Checkpoint'), true,
    'checkpoint halt blocks every group immediately, not just the one it was detected in');
  halt.clearAll();

  // ── 6. INTEGRATION: fb-comment-opp-poster.js skips only the paused
  //      group's rows and still posts an approved comment in a different,
  //      unpaused group in the SAME run ─────────────────────────────────
  const db = { comment_opportunities: [], comment_watchlist: [], comment_caps_state: [] };
  let nextId = 1;
  function matchFilter(row, key, expr) {
    if (expr.startsWith('eq.')) return String(row[key]) === decodeURIComponent(expr.slice(3));
    if (expr === 'is.null') return row[key] === null || row[key] === undefined;
    return true;
  }
  async function mockSbFetch(urlPath, init = {}) {
    const [pathname, qs] = urlPath.split('?');
    const table = pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return { ok: false, status: 404, data: null };
    const q = {};
    for (const [k, v] of new URLSearchParams(qs || '')) q[k] = v;
    const filters = Object.entries(q).filter(([k]) => !['select', 'order', 'limit'].includes(k));
    let matched = rows.filter((r) => filters.every(([k, v]) => matchFilter(r, k, v)));
    if (q.order) {
      const [col, dir] = q.order.split('.');
      matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (dir === 'desc' ? -1 : 1));
    }
    if (q.limit) matched = matched.slice(0, parseInt(q.limit, 10));
    const method = (init.method || 'GET').toUpperCase();
    if (method === 'GET') return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      for (const r of matched) Object.assign(rows.find((x) => x.id === r.id) || r, patch);
      const wantsRep = String((init.headers || {}).Prefer || '').includes('return=representation');
      return { ok: true, status: wantsRep ? 200 : 204, data: wantsRep ? matched.map((r) => ({ ...rows.find((x) => x.id === r.id) })) : null };
    }
    if (method === 'POST') {
      const payload = JSON.parse(init.body);
      const arr = Array.isArray(payload) ? payload : [payload];
      const inserted = arr.map((r) => { const row = { id: `id-${nextId++}`, ...r }; rows.push(row); return row; });
      return { ok: true, status: 201, data: inserted };
    }
    return { ok: false, status: 405, data: null };
  }
  function seedOpp(over = {}) {
    const row = {
      id: `opp-${nextId++}`, group_name: 'DFW Realtors', post_url: `https://fb/${nextId}`,
      comment_final: 'A real, substantive comment with plenty of content in it for the run.',
      status: 'approved', approved_at: new Date().toISOString(), watchlist_id: null, error: null,
      ...over,
    };
    db.comment_opportunities.push(row);
    return row;
  }

  // Pause ONE group before the run starts.
  halt.setHalt('posted comment removed by moderation', { group: 'TC Admins Group', scope: 'group' });

  const pausedRow = seedOpp({ group_name: 'TC Admins Group', comment_final: 'This must NOT post — its group is paused.' });
  const liveRow = seedOpp({ group_name: 'DFW Realtors', comment_final: 'This SHOULD post — its group is not paused.' });

  let posted = [];
  const result = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps,
    poster: async (row, text) => { posted.push(row.group_name); return { submitted: true }; },
    verifier: async () => true,
    notify: async () => {}, log: quietLog, haltState: halt, gapMinutes: 45,
  });

  assert.strictEqual(posted.length, 1, 'exactly one row was actually posted this run');
  assert.strictEqual(posted[0], 'DFW Realtors', 'the row posted was for the UNPAUSED group, not the paused one');
  assert.strictEqual(pausedRow.status, 'approved', 'the paused group\'s row was left untouched (still approved, not claimed/finalized)');
  assert.strictEqual(liveRow.status, 'posted', 'the unpaused group\'s row was claimed and posted');
  assert.strictEqual(result.posted, 1, 'runOppQueue reports one posted');

  halt.clearAll();

  // ── 7. A GLOBAL halt still blocks everything up front (no row fetch at all) ─
  halt.setHalt('facebook login/checkpoint redirect while posting', {});
  db.comment_opportunities.length = 0;
  seedOpp({ group_name: 'DFW Realtors' });
  let posterCalls2 = 0;
  const result2 = await poster.runOppQueue({
    sbFetch: mockSbFetch, caps,
    poster: async () => { posterCalls2++; return { submitted: true }; },
    verifier: async () => true,
    notify: async () => {}, log: quietLog, haltState: halt, gapMinutes: 45,
  });
  assert.strictEqual(result2.halted, true, 'a global halt is reported');
  assert.strictEqual(posterCalls2, 0, 'a global halt blocks the poster entirely — never even reaches row selection');
  halt.clearAll();

  // ── 8. Static guards: the actual call sites use the scoping this test
  //      exercises, not just the module's own logic in isolation ─────────
  const huntSrc = fs.readFileSync(path.join(__dirname, 'fb-comment-hunt-daily.js'), 'utf8');
  assert.ok(/scope:\s*'group'/.test(huntSrc), 'fb-comment-hunt-daily.js uses scope:\'group\' for the comment-removed halt');
  assert.ok(huntSrc.includes("'post_unavailable'"), 'fb-comment-hunt-daily.js distinguishes post_unavailable...');
  assert.ok(huntSrc.includes("'comment_removed'"), '...from comment_removed — the two must never collapse into one boolean again');
  assert.ok(huntSrc.includes('halt.isHalted(group.name)'), 'the group-scan loop checks per-group halt before spending a visit on a paused group');
  assert.ok(huntSrc.includes('halt.isHalted(row.group_name)'), 'the reverify loop skips re-checking an already-paused group');
  // Checkpoint call sites must NOT opt into group scope — they stay global.
  const checkpointCallMatch = huntSrc.match(/halt\.setHalt\('facebook login\/checkpoint redirect during scan',\s*\{[^}]*\}\)/);
  assert.ok(checkpointCallMatch, 'checkpoint halt call site found');
  assert.ok(!/scope/.test(checkpointCallMatch[0]), 'the checkpoint halt call does NOT pass scope — stays global by default');

  const posterSrc = fs.readFileSync(path.join(__dirname, 'fb-comment-opp-poster.js'), 'utf8');
  assert.ok(posterSrc.includes('haltState.isHalted(row.group_name)'), 'the poster row loop skips rows in a paused group');

  console.log('PASS: per-group circuit breaker (single-group removal isolates, checkpoint always global, 2+ groups escalate, independent clearing, poster skips only the paused group)');
}

main()
  .then(() => { cleanup(); process.exit(0); })
  .catch((err) => {
    cleanup();
    console.error('FAIL:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
