#!/usr/bin/env node
'use strict';

/**
 * Regression test for api/_lib/cron-sanity.js — the static vercel.json scan
 * (Carter, 2026-09-16) that catches the exact trick that hid the 2026-07
 * content-engine shutdown: a schedule with fixed day-of-month AND fixed
 * month (fires at most once/year) plus a cron whose handler file no longer
 * exists on disk.
 *
 * Pure filesystem test — no network, no DB, no Vercel.
 *
 * Run manually:
 *   node scripts/regression-cron-sanity-check.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { scanCronSanity, isNearNeverSchedule } = require(path.join(REPO, 'api/_lib/cron-sanity.js'));

function writeTmpVercelJson(crons) {
  const p = path.join(os.tmpdir(), `vercel-sanity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ crons }));
  return p;
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

  console.log('Test 1: isNearNeverSchedule — the exact 2026-07 pattern + generalized form');
  check('0 0 1 1 * (the real shutdown pattern) is near-never', () => {
    assert.strictEqual(isNearNeverSchedule('0 0 1 1 *').nearNever, true);
  });
  check('0 0 15 6 * (a different fixed day+month) is near-never — not hardcoded to Jan 1', () => {
    assert.strictEqual(isNearNeverSchedule('0 0 15 6 *').nearNever, true);
  });
  check('0 11 * * * (real daily cron) is NOT near-never', () => {
    assert.strictEqual(isNearNeverSchedule('0 11 * * *').nearNever, false);
  });
  check('0 9 * * 1 (real weekly cron, fixed dow only) is NOT near-never', () => {
    assert.strictEqual(isNearNeverSchedule('0 9 * * 1').nearNever, false);
  });
  check('0 0 1 * * (monthly, fixed dom but NOT fixed month) is NOT near-never', () => {
    assert.strictEqual(isNearNeverSchedule('0 0 1 * *').nearNever, false);
  });

  console.log('\nTest 2: scanCronSanity — flags near-never + missing handler, leaves healthy crons alone');
  const apiDir = path.join(REPO, 'api');
  const vercelJsonPath = writeTmpVercelJson([
    { path: '/api/cron-generate-posts', schedule: '0 11 * * *' }, // real file, real schedule -> clean
    { path: '/api/cron-totally-fake-handler-xyz', schedule: '*/30 * * * *' }, // real schedule, fake file -> missing_handler
    { path: '/api/cron-unexplained-yearly-thing', schedule: '0 0 4 3 *' }, // fake file + near-never -> both issues
  ]);
  const scan = scanCronSanity({ vercelJsonPath, apiDir });
  check('scan succeeds and counts all 3 crons', () => {
    assert.strictEqual(scan.ok, true);
    assert.strictEqual(scan.totalCrons, 3);
  });
  check('real cron with real schedule + real file produces NO issues', () => {
    assert.ok(!scan.issues.some((i) => i.path === '/api/cron-generate-posts'), `expected no issues for cron-generate-posts, got: ${JSON.stringify(scan.issues)}`);
  });
  check('fake-handler cron with a healthy schedule gets exactly one missing_handler issue', () => {
    const issues = scan.issues.filter((i) => i.path === '/api/cron-totally-fake-handler-xyz');
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].type, 'missing_handler');
  });
  check('unexplained-yearly cron with a fake file gets BOTH issues', () => {
    const issues = scan.issues.filter((i) => i.path === '/api/cron-unexplained-yearly-thing');
    assert.strictEqual(issues.length, 2);
    assert.ok(issues.some((i) => i.type === 'near_never_schedule'));
    assert.ok(issues.some((i) => i.type === 'missing_handler'));
  });
  fs.unlinkSync(vercelJsonPath);

  console.log('\nTest 3: known cost-freeze marker (api/_lib/paused-crons.js) is labeled distinctly, not raised as a fresh incident');
  const vercelJsonPath2 = writeTmpVercelJson([
    { path: '/api/cron-generate-posts', schedule: '0 0 1 1 *' }, // real handler file, but frozen schedule
  ]);
  const scan2 = scanCronSanity({ vercelJsonPath: vercelJsonPath2, apiDir });
  check('known freeze marker gets near_never_schedule_known_freeze, not the bare near_never_schedule type', () => {
    const issue = scan2.issues.find((i) => i.path === '/api/cron-generate-posts');
    assert.ok(issue, 'expected an issue for the frozen cron');
    assert.strictEqual(issue.type, 'near_never_schedule_known_freeze');
    assert.ok(/cost-freeze marker/.test(issue.detail));
  });
  fs.unlinkSync(vercelJsonPath2);

  console.log('\nTest 4: missing vercel.json fails LOUD, never silently reports zero issues');
  const scan3 = scanCronSanity({ vercelJsonPath: '/tmp/definitely-does-not-exist-vercel.json', apiDir });
  check('missing file returns ok:false with an error, not ok:true issues:[]', () => {
    assert.strictEqual(scan3.ok, false);
    assert.ok(scan3.error);
  });

  console.log('\nTest 5: real repo vercel.json parses clean today (no live false positives)');
  const liveScan = scanCronSanity();
  check('live scan runs without throwing and returns a well-formed result', () => {
    assert.strictEqual(liveScan.ok, true);
    assert.ok(liveScan.totalCrons > 50, `expected the real repo to have many crons, got ${liveScan.totalCrons}`);
    assert.ok(Array.isArray(liveScan.issues));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
