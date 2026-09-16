#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/listing-marketing-generate-live.js.
 *
 * WHY THIS EXISTS
 * ----------------
 * api/cron-daily-listing-posts.js was disabled 2026-09-11 after it
 * advertised 23 Nopalito at a stale $1,195,000 while the live MLS price
 * was $999,000 -- Vercel serverless can't hold a connectMLS session, so
 * it generated content off a cached DB snapshot that had gone stale. The
 * ONLY safe generator is listing-marketing-generate-live.js, which does a
 * live connectMLS read and generation in the same process. This test pins
 * down the hard rule that made that fix real: a failed/stale live read
 * must NEVER produce a post, must always alert Heath, and a good read
 * must actually pass live values through to the generator untouched.
 *
 * WHAT THIS PINS DOWN (all via injected fakes -- ZERO Playwright,
 * connectMLS, Supabase, or Telegram access)
 * -----------------------------------------------------------------------
 *   1. Live read throws (dead connectMLS session) -> zero posts, the
 *      generator is never even called, exactly one Telegram alert fires.
 *   2. Live read resolves but verifies ZERO listings -> zero posts, the
 *      generator is never called, exactly one alert fires.
 *   3. Live read succeeds with real values -> the generator IS called
 *      with exactly those live values (address/price), a draft comes
 *      back, and NO alert fires.
 *   4. Partial failure (one listing fails, one succeeds) -> the generator
 *      is called with ONLY the verified listing (the failed one is never
 *      passed through), and an alert still fires naming the failure.
 *   5. Once-per-day gate: a second call on the same simulated day is
 *      skipped without touching the live read at all; --force bypasses it.
 *
 * Run manually:
 *   node scripts/regression-listing-marketing-generate-live.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { main } = require(path.join(REPO, 'scripts/listing-marketing-generate-live.js'));

async function run() {
  let pass = 0;
  let fail = 0;
  async function check(name, fn) {
    try {
      await fn();
      console.log(`  PASS: ${name}`);
      pass++;
    } catch (err) {
      console.error(`  FAIL: ${name}\n    ${err.message}`);
      fail++;
    }
  }

  function freshState() {
    return { store: {} };
  }
  function stateHarness() {
    const s = freshState();
    return {
      state: {},
      saveState: (next) => { s.store = next; },
      readSaved: () => s.store,
    };
  }
  function notifyHarness() {
    const calls = [];
    return {
      notifyHeath: async (text) => { calls.push(text); return { ok: true }; },
      calls,
    };
  }

  console.log('\nTest 1: live read throws (dead connectMLS session) -> zero posts, one alert, generator never called');
  await check('dead session produces zero posts + exactly one alert + generator not invoked', async () => {
    const harness = stateHarness();
    const notify = notifyHarness();
    let generatorCalled = false;
    const result = await main({
      state: harness.state,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: async () => { throw new Error('connectmls-actions.ensureSignedIn: connectMLS app session is fully expired'); },
      generatorRun: async () => { generatorCalled = true; return { ownedDrafted: 99, groupDrafted: 99 }; },
      force: true,
    });
    assert.strictEqual(result.ownedDrafted, 0, 'must draft zero owned posts on a dead session');
    assert.strictEqual(result.groupDrafted, 0, 'must draft zero group posts on a dead session');
    assert.strictEqual(result.liveReadFailed, true);
    assert.strictEqual(generatorCalled, false, 'generator must never be invoked when the live read itself throws');
    assert.strictEqual(notify.calls.length, 1, 'exactly one alert must fire');
    assert.ok(/live connectMLS read FAILED/.test(notify.calls[0]), 'alert must name the live-read failure');
    assert.strictEqual(harness.readSaved().last_result, 'live_read_failed');
  });

  console.log('\nTest 2: live read resolves but verifies zero listings -> zero posts, one alert, generator never called');
  await check('zero-verified read produces zero posts + one alert + generator not invoked', async () => {
    const harness = stateHarness();
    const notify = notifyHarness();
    let generatorCalled = false;
    const result = await main({
      state: harness.state,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: async () => ({
        results: [{ mls: '1916402', ok: false, reason: 'parse_failed' }],
        failures: [{ mls: '1916402', ok: false, reason: 'parse_failed' }],
        statusByMls: {},
      }),
      generatorRun: async () => { generatorCalled = true; return { ownedDrafted: 1, groupDrafted: 1 }; },
      force: true,
    });
    assert.strictEqual(result.ownedDrafted, 0);
    assert.strictEqual(result.groupDrafted, 0);
    assert.strictEqual(result.liveReadFailed, true);
    assert.strictEqual(generatorCalled, false, 'generator must never be invoked when zero listings verified');
    assert.strictEqual(notify.calls.length, 1);
    assert.ok(/verified ZERO listings/.test(notify.calls[0]));
    assert.strictEqual(harness.readSaved().last_result, 'zero_verified');
  });

  console.log('\nTest 3: good live read -> generator receives the live values, draft comes back, no alert');
  await check('good read passes live address/price through untouched, no alert fires', async () => {
    const harness = stateHarness();
    const notify = notifyHarness();
    const liveRow = {
      mls_number: '1916402',
      address: '23 Nopalito',
      city: 'San Antonio',
      zip: '78253',
      list_price: 999000, // the REAL live price from the incident, not the stale 1,195,000
      mls_status: 'ACT',
      is_active: true,
    };
    let receivedOpts = null;
    const result = await main({
      state: harness.state,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: async () => ({
        results: [{ mls: '1916402', ok: true, status: 'ACT', isActive: true, price: 999000 }],
        failures: [],
        statusByMls: { 1916402: liveRow },
      }),
      generatorRun: async (opts) => {
        receivedOpts = opts;
        return { ownedDrafted: 1, groupDrafted: 1 };
      },
      force: true,
    });
    assert.ok(receivedOpts, 'generator must be invoked on a good read');
    assert.strictEqual(receivedOpts.freshStatuses.length, 1);
    assert.strictEqual(receivedOpts.freshStatuses[0].list_price, 999000, 'generator must receive the LIVE price, not a stale one');
    assert.strictEqual(receivedOpts.freshStatuses[0].address, '23 Nopalito');
    assert.strictEqual(result.ownedDrafted, 1);
    assert.strictEqual(result.groupDrafted, 1);
    assert.strictEqual(result.liveReadFailed, false);
    assert.strictEqual(notify.calls.length, 0, 'a clean run must not alert Heath');
    assert.strictEqual(harness.readSaved().last_result, 'ok');
  });

  console.log('\nTest 4: partial failure -> generator sees ONLY the verified listing, failed one excluded, alert still fires');
  await check('partial failure excludes the failed listing from generation but still alerts', async () => {
    const harness = stateHarness();
    const notify = notifyHarness();
    let receivedOpts = null;
    const result = await main({
      state: harness.state,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: async () => ({
        results: [
          { mls: '1916402', ok: true, status: 'ACT', isActive: true, price: 999000 },
          { mls: '2015607', ok: false, reason: 'address_mismatch' },
        ],
        failures: [{ mls: '2015607', ok: false, reason: 'address_mismatch' }],
        statusByMls: { 1916402: { mls_number: '1916402', address: '23 Nopalito', list_price: 999000, is_active: true } },
      }),
      generatorRun: async (opts) => { receivedOpts = opts; return { ownedDrafted: 1, groupDrafted: 0 }; },
      force: true,
    });
    assert.strictEqual(receivedOpts.freshStatuses.length, 1, 'only the verified listing should reach the generator');
    assert.strictEqual(receivedOpts.freshStatuses[0].mls_number, '1916402');
    assert.strictEqual(result.liveReadFailed, false);
    assert.strictEqual(notify.calls.length, 1, 'Heath should still be told a listing was excluded');
    assert.ok(/failed the live MLS read/.test(notify.calls[0]));
  });

  console.log('\nTest 5: once/day gate skips a same-day rerun, --force bypasses it');
  await check('same-day rerun is skipped without touching the live read; force bypasses', async () => {
    const harness = stateHarness();
    const notify = notifyHarness();
    let syncCalls = 0;
    const syncAllStub = async () => { syncCalls++; return { results: [], failures: [], statusByMls: {} }; };

    const first = await main({
      state: { last_run_date: 'not-today-fake-sentinel' },
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: syncAllStub,
      generatorRun: async () => ({ ownedDrafted: 0, groupDrafted: 0 }),
      force: true, // force the first run so we control state deterministically
    });
    assert.notStrictEqual(first.skipped, 'already_ran_today');
    const savedAfterFirst = harness.readSaved();
    assert.ok(savedAfterFirst.last_run_date, 'first run must persist a last_run_date');

    const second = await main({
      state: savedAfterFirst,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: syncAllStub,
      generatorRun: async () => { throw new Error('must not be called on a same-day rerun'); },
      // force intentionally omitted -- exercising the real gate
    });
    assert.strictEqual(second.skipped, 'already_ran_today');
    assert.strictEqual(syncCalls, 1, 'the live MLS read must not run again on the same day');

    const third = await main({
      state: savedAfterFirst,
      saveState: harness.saveState,
      notifyHeath: notify.notifyHeath,
      syncAll: syncAllStub,
      generatorRun: async () => ({ ownedDrafted: 0, groupDrafted: 0 }),
      force: true,
    });
    assert.notStrictEqual(third.skipped, 'already_ran_today');
    assert.strictEqual(syncCalls, 2, '--force must bypass the once/day gate');
  });

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

run().catch((e) => {
  console.error('[regression-listing-marketing-generate-live] FATAL', e.message);
  process.exitCode = 1;
});
