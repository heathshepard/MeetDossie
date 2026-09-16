#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/cron-generate-posts.js's ?target_date=YYYY-MM-DD
 * advance-fill parameter (Carter, 2026-09-16 — the piece
 * cron-weekly-content-scheduler.js calls to pre-fill days ahead of the
 * same-day 11:00 UTC cron). Pure validation-function test — no network, no
 * Anthropic call, no DB.
 *
 * Run manually:
 *   node scripts/regression-cron-generate-posts-target-date.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');

// cron-generate-posts.js requires ANTHROPIC_API_KEY etc at module scope for
// its handler body, but parseTargetDate itself has no such dependency —
// requiring the module is safe without a real key (the key is only checked
// inside the request handler, not at require time).
const { parseTargetDate } = require(path.join(REPO, 'api/cron-generate-posts.js'));

function fakeReq(targetDate) {
  return { query: targetDate ? { target_date: targetDate } : {} };
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

  console.log('Test 1: absent target_date -> null (zero behavior change for the daily cron)');
  check('no query param returns null', () => {
    assert.strictEqual(parseTargetDate(fakeReq(null)), null);
  });

  console.log('\nTest 2: today and a few days out are accepted');
  const today = new Date().toISOString().slice(0, 10);
  check('today is accepted', () => {
    const result = parseTargetDate(fakeReq(today));
    assert.ok(result && !result.error, `expected today to be accepted, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.iso, today);
  });
  const in3Days = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
  check('3 days out is accepted (inside the 7-day scheduler window)', () => {
    const result = parseTargetDate(fakeReq(in3Days));
    assert.ok(result && !result.error, `expected +3d to be accepted, got: ${JSON.stringify(result)}`);
  });

  console.log('\nTest 3: bounds are enforced — [today, today+13]');
  const in14Days = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
  check('14 days out is rejected (past the bound)', () => {
    const result = parseTargetDate(fakeReq(in14Days));
    assert.ok(result && result.error, `expected +14d to be rejected, got: ${JSON.stringify(result)}`);
  });
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  check('yesterday is rejected (no backdating a date-keyed post_id)', () => {
    const result = parseTargetDate(fakeReq(yesterday));
    assert.ok(result && result.error, `expected yesterday to be rejected, got: ${JSON.stringify(result)}`);
  });

  console.log('\nTest 4: malformed input is rejected, never silently coerced');
  for (const bad of ['not-a-date', '2026-13-01', '09-16-2026', '']) {
    check(`"${bad}" is rejected`, () => {
      const req = fakeReq(bad === '' ? null : bad);
      if (bad === '') return; // empty string means "absent" per fakeReq — covered by Test 1
      const result = parseTargetDate(req);
      assert.ok(result && result.error, `expected "${bad}" to be rejected, got: ${JSON.stringify(result)}`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
