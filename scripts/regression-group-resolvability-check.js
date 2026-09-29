#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/_lib/group-resolvability-check.js (Carter,
 * 2026-09-16) — the startup gate added after a live browser audit of
 * Heath's real Facebook account disproved two group names sitting in
 * config ("Boerne Real Estate" and "Real Estate in Austin TX" — neither
 * exists under those names). Neither happened to be in
 * scripts/comment-hunt-groups.json or scripts/fb-commenter-groups.json,
 * but nothing would have caught it if they had been — this pins down that
 * an entry lacking a real, verified URL is refused and reported, not
 * silently scanned/posted to.
 *
 * WHAT THIS PINS DOWN
 * --------------------
 *   1. checkGroupResolvable() — missing url, PLACEHOLDER url, a
 *      non-facebook.com-group url, and existence_verified !== true all
 *      refuse. Only a real url + existence_verified===true resolves.
 *   2. filterResolvableGroups() — splits resolvable/unresolved correctly
 *      and calls the report callback once per refusal with a reason that
 *      names the group.
 *   3. Live config lock-in — comment-hunt-groups.json's 4 active posting
 *      target groups all resolve today; fb-commenter-groups.json's 19
 *      legacy entries (none ever verified live) all refuse today. If
 *      either count ever changes, this test fails loudly rather than
 *      silently letting an unverified group start getting scanned/posted
 *      to, or a real group getting wrongly excluded.
 *   4. Wiring — the three consumers (fb-comment-hunt-daily.js,
 *      api/_lib/daily-group5-post-generator.js, fb-group-commenter.js)
 *      each actually import and use filterResolvableGroups(), not just a
 *      copy-pasted filter.
 *
 * Run manually:
 *   node scripts/regression-group-resolvability-check.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');

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

  const {
    checkGroupResolvable,
    filterResolvableGroups,
  } = require(path.join(REPO, 'scripts/_lib/group-resolvability-check.js'));

  console.log('\n1. checkGroupResolvable() — single-entry rules');

  check('a real, verified group resolves', () => {
    const r = checkGroupResolvable({
      name: 'DFW Realtors - Network & Collaborate',
      url: 'https://www.facebook.com/groups/531847711158328/',
      existence_verified: true,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.reason, null);
  });

  check('missing url refuses', () => {
    const r = checkGroupResolvable({ name: 'No URL Group', existence_verified: true });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('No URL Group'));
    assert.ok(r.reason.includes('no url set'));
  });

  check('PLACEHOLDER url refuses', () => {
    const r = checkGroupResolvable({
      name: 'Unfilled Group',
      url: 'https://www.facebook.com/groups/PLACEHOLDER/',
      existence_verified: true,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes('PLACEHOLDER'));
  });

  check('a plausible-looking but non-facebook.com url refuses', () => {
    const r = checkGroupResolvable({
      name: 'Fake Group',
      url: 'https://example.com/groups/totally-real/',
      existence_verified: true,
    });
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.includes("doesn't look like a real facebook.com group URL"));
  });

  check('THE BUG THIS CLOSES: a real-shaped facebook.com url with existence_verified missing/false refuses', () => {
    // Reproduces the exact failure mode: a name and URL that LOOK plausible
    // ("Boerne Real Estate", "Real Estate in Austin TX") but were never
    // actually confirmed to exist live.
    const neverVerified = checkGroupResolvable({
      name: 'Boerne Real Estate',
      url: 'https://www.facebook.com/groups/boernerealestate/',
      // existence_verified intentionally omitted
    });
    assert.strictEqual(neverVerified.ok, false);
    assert.ok(neverVerified.reason.includes('existence_verified is not true'));

    const explicitlyFalse = checkGroupResolvable({
      name: 'Real Estate in Austin TX',
      url: 'https://www.facebook.com/groups/realestateinaustintx/',
      existence_verified: false,
    });
    assert.strictEqual(explicitlyFalse.ok, false);
  });

  check('supports the group_url/group_name field names (fb-commenter-groups.json shape)', () => {
    const r = checkGroupResolvable(
      { group_name: 'Texas Real Estate Agents', group_url: 'https://www.facebook.com/groups/texasrealestateagents/', existence_verified: false },
      { urlField: 'group_url', nameField: 'group_name' },
    );
    assert.strictEqual(r.ok, false);
    assert.ok(r.reason.startsWith('Texas Real Estate Agents:'));
  });

  console.log('\n2. filterResolvableGroups() — split + reporting');

  check('splits resolvable/unresolved and reports each refusal exactly once', () => {
    const groups = [
      { key: 'good', url: 'https://www.facebook.com/groups/123/', existence_verified: true },
      { key: 'bad_no_verify', url: 'https://www.facebook.com/groups/456/' },
      { key: 'bad_placeholder', url: 'https://www.facebook.com/groups/PLACEHOLDER/', existence_verified: true },
    ];
    const reported = [];
    const { resolvable, unresolved } = filterResolvableGroups(groups, { report: (msg) => reported.push(msg) });
    assert.strictEqual(resolvable.length, 1);
    assert.strictEqual(resolvable[0].key, 'good');
    assert.strictEqual(unresolved.length, 2);
    assert.strictEqual(reported.length, 2, 'report callback fires exactly once per unresolved group');
  });

  check('empty/non-array input never throws, returns empty resolvable', () => {
    assert.deepStrictEqual(filterResolvableGroups(null).resolvable, []);
    assert.deepStrictEqual(filterResolvableGroups(undefined).resolvable, []);
    assert.deepStrictEqual(filterResolvableGroups([]).resolvable, []);
  });

  console.log('\n3. Live config lock-in — real repo files, real counts');

  check('comment-hunt-groups.json: all 4 active posting-target groups resolve today', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/comment-hunt-groups.json'), 'utf8'));
    const { resolvable, unresolved } = filterResolvableGroups(cfg.groups, { report: () => {} });
    assert.strictEqual(resolvable.length, 4, `expected all 4 active groups verified+resolvable, got ${resolvable.length} (unresolved: ${unresolved.map(u => u.reason).join(' | ')})`);
    assert.strictEqual(unresolved.length, 0);
  });

  check('comment-hunt-groups.json: skip_groups never feeds loadTargetGroups (posting) regardless of their own resolvability', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/comment-hunt-groups.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.skip_groups) && cfg.skip_groups.length === 4);
    // Every entry (including skip_groups) now carries the schema fields —
    // this only asserts the fields exist, not that skip_groups gets loaded
    // anywhere (it deliberately never does).
    for (const g of cfg.skip_groups) {
      assert.ok('existence_verified' in g, `${g.name}: missing existence_verified field`);
      assert.ok('acting_identity' in g, `${g.name}: missing acting_identity field`);
      assert.ok('requires_admin_approval' in g, `${g.name}: missing requires_admin_approval field`);
    }
  });

  check('fb-commenter-groups.json: all 20 legacy entries are honestly unverified today (none resolve)', () => {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/fb-commenter-groups.json'), 'utf8'));
    assert.ok(Array.isArray(cfg.groups), 'fb-commenter-groups.json must use the {_readme, groups} shape');
    assert.strictEqual(cfg.groups.length, 20, `expected 20 legacy entries preserved (marked unverified, not deleted), got ${cfg.groups.length}`);
    const { resolvable, unresolved } = filterResolvableGroups(cfg.groups, { urlField: 'group_url', nameField: 'group_name', report: () => {} });
    assert.strictEqual(resolvable.length, 0, 'none of these have ever been confirmed live — must not silently resolve');
    assert.strictEqual(unresolved.length, 20);
    for (const g of cfg.groups) {
      assert.strictEqual(g.existence_verified, false, `${g.group_name}: must be explicitly marked existence_verified=false, not omitted`);
    }
  });

  console.log('\n4. Wiring — every consumer actually imports and uses the gate');

  check('fb-comment-hunt-daily.js imports and calls filterResolvableGroups', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/fb-comment-hunt-daily.js'), 'utf8');
    assert.ok(src.includes("require('./_lib/group-resolvability-check')"));
    assert.ok(src.includes('filterResolvableGroups(configuredGroups)'));
  });

  check('api/_lib/daily-group5-post-generator.js (the real posting target list) imports and calls filterResolvableGroups', () => {
    const src = fs.readFileSync(path.join(REPO, 'api/_lib/daily-group5-post-generator.js'), 'utf8');
    assert.ok(src.includes("require('../../scripts/_lib/group-resolvability-check')"));
    assert.ok(src.includes('filterResolvableGroups(configured)'));
  });

  check('fb-group-commenter.js imports and calls filterResolvableGroups', () => {
    const src = fs.readFileSync(path.join(REPO, 'scripts/fb-group-commenter.js'), 'utf8');
    assert.ok(src.includes("require('./_lib/group-resolvability-check')"));
    assert.ok(src.includes('filterResolvableGroups(withUrl'));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
