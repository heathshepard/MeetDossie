#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/ops-policy.js — the standing-authority
 * policy (Heath, 2026-09-17): "what can act without me" as one explicit,
 * enforced policy over public.ops_flags, with an audit trail.
 *
 * THE RISKS BEING PINNED DOWN
 * ---------------------------
 *   1. ALWAYS_HEATH capabilities (money, real client, irreversible/public,
 *      pricing/demo/complaint, new account/credential) are blocked
 *      UNCONDITIONALLY — even if a crafted/compromised ops_flags row claims
 *      enabled=true under that name, checkCapability() never even looks.
 *   2. An unknown/typo'd capability key fails closed, never silently grants
 *      autonomy.
 *   3. A real autonomous capability with its ops_flags row enabled=true is
 *      allowed; enabled=false, or a missing/unreadable row, is blocked
 *      (fail-closed default, same contract as every other switch in this
 *      codebase).
 *   4. Every check — allowed or blocked — is logged to ops_action_log with
 *      the capability, decision, and (when allowed) the gates it passed,
 *      so a wrong call is diagnosable after the fact.
 *
 * All against an in-memory PostgREST mock — ZERO production access.
 */

const assert = require('assert');
const path = require('path');

const policy = require(path.join(__dirname, '..', 'api', '_lib', 'ops-policy.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    console.error(`  FAIL - ${name}\n    ${err.stack || err.message}`);
    process.exitCode = 1;
  }
}

// ─── In-memory PostgREST mock ──────────────────────────────────────────────
function makeDb() {
  return { ops_flags: [], ops_action_log: [] };
}

function makeSbFetch(db) {
  return async function sbFetch(urlPath, init = {}) {
    const [pathname, qs] = urlPath.split('?');
    const table = pathname.replace('/rest/v1/', '');
    const rows = db[table];
    if (!rows) return { ok: false, status: 404, data: null };
    const method = (init.method || 'GET').toUpperCase();

    if (method === 'GET') {
      const params = new URLSearchParams(qs || '');
      const keyEq = params.get('key');
      let matched = rows;
      if (keyEq && keyEq.startsWith('eq.')) {
        const wanted = keyEq.slice(3);
        matched = rows.filter((r) => r.key === wanted);
      }
      return { ok: true, status: 200, data: matched.map((r) => ({ ...r })) };
    }
    if (method === 'POST') {
      const payload = JSON.parse(init.body);
      const row = { id: rows.length + 1, ...payload };
      rows.push(row);
      return { ok: true, status: 201, data: [row] };
    }
    return { ok: false, status: 405, data: null };
  };
}

// A crafted/compromised sbFetch that ALWAYS claims enabled=true, for ANY
// key, including one of the reserved ALWAYS_HEATH names — proves the
// block does not depend on what the DB says.
async function alwaysTrueSbFetch() {
  return { ok: true, status: 200, data: [{ enabled: true, reason: 'compromised row' }] };
}

async function main() {
  console.log('ops-policy: standing-authority capability policy + audit log\n');

  // ── 1. ALWAYS_HEATH is unconditional ──────────────────────────────────
  for (const key of Object.keys(policy.ALWAYS_HEATH)) {
    await checkAsync(`ALWAYS_HEATH '${key}' blocks even with a crafted ops_flags row claiming enabled=true`, async () => {
      const result = await policy.checkCapability(key, alwaysTrueSbFetch);
      assert.strictEqual(result.allowed, false);
      assert.strictEqual(result.decision, 'blocked_always_heath');
      assert.ok(result.reason && result.reason.length > 0);
    });
  }

  // ── 2. Unknown capability fails closed ────────────────────────────────
  await checkAsync('an unknown/typo\'d capability key fails closed, never grants autonomy', async () => {
    const result = await policy.checkCapability('publish_contnet_TYPO', alwaysTrueSbFetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'blocked_flag_off');
  });

  // ── 3. A real autonomous capability with its flag ON is allowed ──────
  await checkAsync('publish_content is allowed when its ops_flags row is enabled=true', async () => {
    const db = makeDb();
    db.ops_flags.push({ key: 'publish_content', enabled: true, reason: 'seeded' });
    const sbFetch = makeSbFetch(db);
    const result = await policy.checkCapability('publish_content', sbFetch);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(result.decision, 'autonomous');
  });

  // ── 4. Flag OFF blocks it ─────────────────────────────────────────────
  await checkAsync('publish_content is blocked when its ops_flags row is enabled=false', async () => {
    const db = makeDb();
    db.ops_flags.push({ key: 'publish_content', enabled: false, reason: 'Heath turned it off' });
    const sbFetch = makeSbFetch(db);
    const result = await policy.checkCapability('publish_content', sbFetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'blocked_flag_off');
    assert.strictEqual(result.reason, 'Heath turned it off');
  });

  // ── 5. Missing/unreadable row fails closed ────────────────────────────
  await checkAsync('a missing ops_flags row fails closed (disabled), never fails open', async () => {
    const db = makeDb(); // no row at all for schedule_week_ahead
    const sbFetch = makeSbFetch(db);
    const result = await policy.checkCapability('schedule_week_ahead', sbFetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'blocked_flag_off');
  });

  await checkAsync('an unreachable ops_flags table (network error) fails closed', async () => {
    const brokenSbFetch = async () => { throw new Error('network down'); };
    const result = await policy.checkCapability('harvest_and_draft', brokenSbFetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'blocked_flag_off');
  });

  // ── 6. logAutonomousAction writes a real, complete audit row ─────────
  await checkAsync('logAutonomousAction writes capability/decision/gates/ref to ops_action_log', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const res = await policy.logAutonomousAction({
      capability: 'publish_content',
      decision: 'autonomous',
      action: 'published facebook post',
      firedBy: 'cron-publish-approved',
      gatesPassed: ['schedule', 'dedup', 'caption_sanitizer'],
      refTable: 'social_posts',
      refId: 'post-123',
    }, sbFetch);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(db.ops_action_log.length, 1);
    const row = db.ops_action_log[0];
    assert.strictEqual(row.capability, 'publish_content');
    assert.strictEqual(row.decision, 'autonomous');
    assert.deepStrictEqual(row.gates_passed, ['schedule', 'dedup', 'caption_sanitizer']);
    assert.strictEqual(row.ref_table, 'social_posts');
    assert.strictEqual(row.ref_id, 'post-123');
  });

  await checkAsync('logAutonomousAction with missing required fields refuses to log garbage, never throws', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const res = await policy.logAutonomousAction({ capability: 'publish_content' }, sbFetch);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(db.ops_action_log.length, 0);
  });

  // ── 7. checkAndLog logs BOTH real firings and blocked attempts ───────
  await checkAsync('checkAndLog logs a blocked_always_heath attempt with the block reason in metadata', async () => {
    const db = makeDb();
    const sbFetch = makeSbFetch(db);
    const result = await policy.checkAndLog({
      capability: 'contact_real_client',
      action: 'tried to DM a lead automatically',
      firedBy: 'test-caller',
      refTable: 'leads',
      refId: 'lead-1',
    }, sbFetch);
    assert.strictEqual(result.allowed, false);
    assert.strictEqual(result.decision, 'blocked_always_heath');
    assert.strictEqual(db.ops_action_log.length, 1);
    assert.strictEqual(db.ops_action_log[0].decision, 'blocked_always_heath');
    assert.ok(db.ops_action_log[0].metadata && db.ops_action_log[0].metadata.blocked_reason);
  });

  await checkAsync('checkAndLog logs a real autonomous firing with its gates', async () => {
    const db = makeDb();
    db.ops_flags.push({ key: 'harvest_and_draft', enabled: true, reason: 'seeded' });
    const sbFetch = makeSbFetch(db);
    const result = await policy.checkAndLog({
      capability: 'harvest_and_draft',
      action: 'harvested comments',
      firedBy: 'test-caller',
      gatesPassed: ['read_only_scrape'],
    }, sbFetch);
    assert.strictEqual(result.allowed, true);
    assert.strictEqual(db.ops_action_log[0].decision, 'autonomous');
    assert.deepStrictEqual(db.ops_action_log[0].gates_passed, ['read_only_scrape']);
  });

  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
  if (!process.exitCode) console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exitCode = 1;
});
