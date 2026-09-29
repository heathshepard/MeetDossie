#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-16 "YouTube has never posted" fix.
 *
 * THE BUG
 * -------
 * api/cron-post-videos.js's ZERNIO_ACCOUNTS map hardcoded a real Zernio
 * account id for every platform EXCEPT youtube, which read:
 *
 *     youtube: process.env.ZERNIO_YOUTUBE_ACCOUNT_ID || null,
 *
 * ZERNIO_YOUTUBE_ACCOUNT_ID was never set in Vercel (confirmed via
 * `vercel env ls`), so it resolved to null. resolveZernioAccountId() falls
 * back to this map for owner='dossie', so every YouTube target resolved to
 * null and failed — silently, because YouTube was also missing from
 * silence-alarm's TRACKED_PAIRS. Net effect: the @meetdossie channel was
 * connected to Zernio with the youtube.upload scope from 2026-05-29 and
 * published exactly ZERO videos in ~4 months, with zero alerts.
 *
 * THE INVARIANT THIS LOCKS
 * ------------------------
 * Every platform listed in DEFAULT_PLATFORMS must have a usable, literal
 * account id in ZERNIO_ACCOUNTS. An unset environment variable must never be
 * able to silently disable an entire publishing platform. If a platform is
 * genuinely not connected, it belongs OUT of DEFAULT_PLATFORMS — not present
 * with a null id that fails at publish time.
 *
 * These are source-level assertions on purpose: the defect was in a
 * module-load-time constant, so it is invisible to any test that mocks the
 * account map. Reintroducing the `process.env.X || null` pattern for a
 * DEFAULT_PLATFORMS platform fails this test immediately.
 *
 * Run manually:
 *   node scripts/regression-zernio-account-ids-resolvable.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(REPO, 'api', 'cron-post-videos.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`  FAIL  ${name}\n        ${err.message}`);
    failed++;
  }
}

// ── Parse ZERNIO_ACCOUNTS and DEFAULT_PLATFORMS out of the source ──────────
function extractBlock(startMarker) {
  const i = SRC.indexOf(startMarker);
  assert.ok(i !== -1, `could not find ${startMarker} in cron-post-videos.js`);
  // Find whichever bracket actually opens the literal after the `=`.
  const afterEq = i + startMarker.length;
  const braceAt = SRC.indexOf('{', afterEq);
  const brackAt = SRC.indexOf('[', afterEq);
  const useBracket = brackAt !== -1 && (braceAt === -1 || brackAt < braceAt);
  const open = useBracket ? brackAt : braceAt;
  const close = SRC.indexOf(useBracket ? ']' : '}', open);
  assert.ok(open !== -1 && close !== -1, `could not delimit the literal after ${startMarker}`);
  return SRC.slice(open, close + 1);
}

const accountsBlock = extractBlock('const ZERNIO_ACCOUNTS =');
const defaultBlock = extractBlock('const DEFAULT_PLATFORMS =');

const DEFAULT_PLATFORMS = [...defaultBlock.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);

// platform -> raw right-hand side, comments stripped.
const accountEntries = {};
for (const line of accountsBlock.split('\n')) {
  const stripped = line.replace(/\/\/.*$/, '').trim();
  const m = stripped.match(/^([a-z]+):\s*(.+?),?$/);
  if (m) accountEntries[m[1]] = m[2].replace(/,$/, '').trim();
}

console.log('Zernio account id resolvability\n');

check('DEFAULT_PLATFORMS parsed and non-empty', () => {
  assert.ok(DEFAULT_PLATFORMS.length >= 5, `parsed only ${DEFAULT_PLATFORMS.length}: ${DEFAULT_PLATFORMS}`);
});

// Guard against a vacuous green: if the parser ever returns an empty list,
// every for-loop assertion below would "pass" while checking nothing.
function assertParsed() {
  assert.ok(DEFAULT_PLATFORMS.length >= 5, `parser returned ${DEFAULT_PLATFORMS.length} platforms — refusing to assert vacuously`);
  assert.ok(Object.keys(accountEntries).length >= 5, `parser returned ${Object.keys(accountEntries).length} account entries — refusing to assert vacuously`);
}

check('every DEFAULT_PLATFORMS platform has a ZERNIO_ACCOUNTS entry', () => {
  assertParsed();
  for (const p of DEFAULT_PLATFORMS) {
    assert.ok(accountEntries[p] !== undefined, `DEFAULT_PLATFORMS includes '${p}' but ZERNIO_ACCOUNTS has no entry for it`);
  }
});

check('no DEFAULT_PLATFORMS account id is a bare env-var lookup that can fall back to null', () => {
  assertParsed();
  for (const p of DEFAULT_PLATFORMS) {
    const rhs = accountEntries[p];
    assert.ok(
      !/process\.env\./.test(rhs),
      `ZERNIO_ACCOUNTS.${p} = ${rhs} — an unset env var silently disables this whole platform. ` +
      `This is the exact defect that kept YouTube at zero posts for ~4 months.`,
    );
    assert.ok(!/\bnull\b/.test(rhs), `ZERNIO_ACCOUNTS.${p} can resolve to null: ${rhs}`);
  }
});

check('every DEFAULT_PLATFORMS account id is a literal 24-char Zernio ObjectId', () => {
  assertParsed();
  for (const p of DEFAULT_PLATFORMS) {
    const rhs = accountEntries[p];
    const m = rhs.match(/^'([0-9a-f]{24})'$/);
    assert.ok(m, `ZERNIO_ACCOUNTS.${p} = ${rhs} is not a literal 24-hex-char Zernio account id`);
  }
});

check("youtube specifically resolves to Dossie's real @meetdossie channel account", () => {
  assert.strictEqual(
    accountEntries.youtube,
    "'6a19ef442b2567671a6aa273'",
    'youtube must map to the live Zernio account for @meetdossie (UCLtSlBEakQh-ClTVd_KGhWA), ' +
    'verified against Zernio /api/v1/accounts on 2026-09-16 with scope youtube.upload granted',
  );
});

check('youtube is tracked by the silence alarm', () => {
  const alarm = fs.readFileSync(path.join(REPO, 'api', '_lib', 'silence-alarm.js'), 'utf8');
  const tracked = alarm.slice(alarm.indexOf('const TRACKED_PAIRS'), alarm.indexOf('];', alarm.indexOf('const TRACKED_PAIRS')));
  assert.ok(
    /platform:\s*'youtube'/.test(tracked),
    'silence-alarm TRACKED_PAIRS has no youtube entry — an untracked platform can never register as silent, ' +
    'which is why nobody noticed YouTube had never posted at all',
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
