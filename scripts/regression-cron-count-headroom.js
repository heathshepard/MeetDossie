#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 cron consolidation (Atlas).
 *
 * WHY
 *   Staging deploy 167cb30a was rejected outright by Vercel's vercel.json
 *   schema validator: "crons should NOT have more than 100 items" (we were
 *   at 101). This guards against silently drifting back up to the ceiling,
 *   AND against a consolidation regression where a job that got merged
 *   into a dispatcher (api/cron-dispatch-*.js) quietly stops being callable
 *   — either because its require() was dropped from the dispatcher, or
 *   because it got re-added as its own standalone vercel.json entry AND
 *   left in a dispatcher (double-fire risk), or its handler file vanished.
 *
 * WHAT IT CHECKS
 *   1. vercel.json crons.length stays under the 100-item schema cap, with
 *      real headroom (<=85) — not a "squeak under" number.
 *   2. Every api/cron-dispatch-*.js file that exists is still registered
 *      as its own entry in vercel.json's crons array (the dispatcher itself
 *      didn't get orphaned).
 *   3. Every job a dispatcher require()s (its "members", parsed straight
 *      out of the dispatcher's own source — no hand-maintained list to
 *      drift) still has a handler file on disk.
 *   4. No member job is ALSO independently registered as a standalone
 *      vercel.json cron entry — that would double-fire it (once via the
 *      dispatcher's schedule, once via its own).
 *   5. Every dispatcher module still `module.exports`s a callable function
 *      (require() doesn't throw) — catches a syntax/require error in the
 *      merged jobs before Vercel's build does.
 *
 * Pure filesystem/require test — no network, no DB, no Vercel.
 *
 * Run manually:
 *   node scripts/regression-cron-count-headroom.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const VERCEL_JSON_PATH = path.join(REPO, 'vercel.json');
const API_DIR = path.join(REPO, 'api');

// Real headroom, not a squeak-under number. Vercel's hard schema cap is 100.
const HARD_CAP = 100;
const HEADROOM_CEILING = 85;

// Vercel's vercel.json schema ALSO caps `functions` at 50 properties — hit
// this ourselves mid-fix on 2026-09-16 (54 properties after adding 16
// dispatcher maxDuration entries) and had to glob-merge same-config entries
// back down to 18. Guard it the same way as the crons cap so the next
// person who adds a per-file maxDuration override doesn't rediscover this
// the same way (a second failed staging deploy).
const FUNCTIONS_HARD_CAP = 50;
const FUNCTIONS_HEADROOM_CEILING = 40;

function loadVercelJson() {
  return JSON.parse(fs.readFileSync(VERCEL_JSON_PATH, 'utf8'));
}

// Pull every `{ name: '...', mod: require('./NAME.js') }` entry straight out
// of a dispatcher's own source — this is the actual member list Vercel will
// run, not a hand-maintained mirror of it that can drift.
function parseDispatcherMembers(dispatcherFile) {
  const src = fs.readFileSync(dispatcherFile, 'utf8');
  const members = [];
  const re = /require\(['"]\.\/([\w-]+)\.js['"]\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (m[1] === '_lib/cron-multiplex' || m[1].startsWith('_lib')) continue;
    members.push(m[1]);
  }
  return members;
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

  const v = loadVercelJson();
  const crons = Array.isArray(v.crons) ? v.crons : [];
  const cronPaths = new Set(crons.map((c) => c.path));

  console.log('Test 1: hard cap + real headroom');
  check(`crons.length (${crons.length}) is under Vercel's hard cap of ${HARD_CAP}`, () => {
    assert.ok(crons.length < HARD_CAP, `${crons.length} >= ${HARD_CAP}`);
  });
  check(`crons.length (${crons.length}) leaves real headroom (<= ${HEADROOM_CEILING}, not a squeak-under fix)`, () => {
    assert.ok(crons.length <= HEADROOM_CEILING, `${crons.length} > ${HEADROOM_CEILING} — consolidation eroded, re-check`);
  });

  const funcCount = v.functions ? Object.keys(v.functions).length : 0;
  check(`functions property count (${funcCount}) is under Vercel's hard cap of ${FUNCTIONS_HARD_CAP}`, () => {
    assert.ok(funcCount < FUNCTIONS_HARD_CAP, `${funcCount} >= ${FUNCTIONS_HARD_CAP}`);
  });
  check(`functions property count (${funcCount}) leaves real headroom (<= ${FUNCTIONS_HEADROOM_CEILING})`, () => {
    assert.ok(funcCount <= FUNCTIONS_HEADROOM_CEILING, `${funcCount} > ${FUNCTIONS_HEADROOM_CEILING} — re-run the glob-merge pass`);
  });

  console.log('\nTest 2: every dispatcher file is itself a registered cron');
  const dispatcherFiles = fs.readdirSync(API_DIR).filter((f) => /^cron-dispatch-.*\.js$/.test(f));
  check(`found at least one cron-dispatch-*.js file (got ${dispatcherFiles.length})`, () => {
    assert.ok(dispatcherFiles.length > 0);
  });
  for (const file of dispatcherFiles) {
    const routePath = '/api/' + file.replace(/\.js$/, '');
    check(`${routePath} is registered in vercel.json crons`, () => {
      assert.ok(cronPaths.has(routePath), `dispatcher file exists but has no vercel.json cron entry`);
    });
  }

  console.log('\nTest 3-4: every job a dispatcher absorbed still has a live path, none double-registered');
  let totalMembers = 0;
  for (const file of dispatcherFiles) {
    const members = parseDispatcherMembers(path.join(API_DIR, file));
    for (const member of members) {
      totalMembers++;
      const handlerFile = path.join(API_DIR, `${member}.js`);
      check(`${file} -> ${member}.js exists on disk`, () => {
        assert.ok(fs.existsSync(handlerFile), `missing handler file for absorbed job ${member}`);
      });
      const memberRoute = '/api/' + member;
      check(`${member} is NOT also a standalone vercel.json cron entry (would double-fire)`, () => {
        assert.ok(!cronPaths.has(memberRoute), `${memberRoute} appears both inside ${file} AND as its own cron entry`);
      });
    }
  }
  check(`traced at least as many absorbed jobs as dispatcher files would suggest (got ${totalMembers})`, () => {
    assert.ok(totalMembers >= dispatcherFiles.length, 'expected multiple members per dispatcher on average');
  });

  console.log('\nTest 5: every dispatcher module require()s cleanly and exports a callable handler');
  for (const file of dispatcherFiles) {
    check(`require('./api/${file}') does not throw and exports a function`, () => {
      delete require.cache[require.resolve(path.join(API_DIR, file))];
      const mod = require(path.join(API_DIR, file));
      assert.strictEqual(typeof mod, 'function', `expected a function export, got ${typeof mod}`);
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
