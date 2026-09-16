#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/_lib/fb-own-identity.js (2026-09-16 fix).
 *
 * THE BUG
 * -------
 * scripts/harvest-tc-discovery-responses.js (and scripts/watch-guest-thread-
 * replies.js, which imported the same array) matched HEATH_FB_NAMES=
 * ['Heath Shepard'] with EXACT string equality. Facebook's acting identity
 * for group posting/commenting is the PAGE "Heath Shepard, Realtor with
 * Keller Williams City View" (confirmed live 2026-09-16,
 * facebook.com/HeathShepardRealtor), not the bare personal-profile name --
 * so is_own_comment silently came back false for every one of Heath's own
 * comments under that identity, risking the auto-reply pipeline drafting a
 * reply to Heath as if he were a stranger.
 *
 * THIS TEST PINS DOWN
 * --------------------
 *   1. The real Page-suffixed name is recognized as Heath's own (the
 *      concrete case that was broken).
 *   2. The bare personal name still matches (regression floor).
 *   3. A name that merely SHARES A PREFIX but is a different person
 *      ("Heath Shepardson", "Heath Shepard-Jones") does NOT falsely match --
 *      proves this is a name-boundary prefix match, not a raw substring
 *      check that would over-match.
 *   4. The name list is configurable via HEATH_FB_OWN_NAMES (env var), not a
 *      literal baked into either consumer file.
 *   5. Both real consumers (the harvester's is_own_comment computation and
 *      watch-guest-thread-replies.js's isHeath) are wired to the shared
 *      matcher, not a private re-implementation.
 *
 * Run manually:
 *   node scripts/regression-fb-own-identity-match.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const { isOwnAuthor, getOwnNames, DEFAULT_OWN_NAMES } = require(
  path.join(__dirname, '_lib', 'fb-own-identity.js'),
);

function testPageSuffixedNameMatches() {
  const pageDisplayName = 'Heath Shepard, Realtor with Keller Williams City View';
  assert.strictEqual(
    isOwnAuthor(pageDisplayName),
    true,
    'the real acting Page display name must self-flag as Heath\'s own (this was the live bug)',
  );

  // Case/whitespace-insensitive.
  assert.strictEqual(isOwnAuthor('  HEATH SHEPARD,   Realtor with Keller Williams City View  '), true, 'case/whitespace-insensitive match');

  console.log('PASS: Page-suffixed acting identity ("Heath Shepard, Realtor with Keller Williams City View") is recognized as Heath\'s own comment');
}

function testBarePersonalNameStillMatches() {
  assert.strictEqual(isOwnAuthor('Heath Shepard'), true, 'bare personal name is still a match (regression floor)');
  console.log('PASS: bare "Heath Shepard" still matches');
}

function testDoesNotOverMatch() {
  const notHeath = [
    'Heath Shepardson',
    'Heath Shepard-Jones',
    'Co-Heath Shepard',
    'Maria Gonzalez',
    'Heathshepard', // no boundary at all
    '',
    null,
    undefined,
  ];
  for (const author of notHeath) {
    assert.strictEqual(isOwnAuthor(author), false, `must NOT match a different person / empty author: "${author}"`);
  }
  console.log('PASS: prefix match respects name boundaries -- no false positives on a similar-but-different name');
}

function testConfigNotLiteral() {
  // Names come from config (env var), with a documented default -- not a
  // literal array re-declared inside each consumer file.
  const prevEnv = process.env.HEATH_FB_OWN_NAMES;
  try {
    process.env.HEATH_FB_OWN_NAMES = 'Custom Test Identity';
    assert.strictEqual(isOwnAuthor('Custom Test Identity'), true, 'HEATH_FB_OWN_NAMES env override is honored');
    assert.strictEqual(isOwnAuthor('Heath Shepard'), false, 'when overridden, the old default no longer matches (proves it is not hardcoded)');
    assert.deepStrictEqual(getOwnNames(), ['Custom Test Identity'], 'getOwnNames() reflects the env override');
  } finally {
    if (prevEnv === undefined) delete process.env.HEATH_FB_OWN_NAMES;
    else process.env.HEATH_FB_OWN_NAMES = prevEnv;
  }

  // With no override, the shipped defaults cover both real identities.
  assert.ok(DEFAULT_OWN_NAMES.some((n) => n === 'Heath Shepard'), 'default list includes the personal name');
  assert.ok(
    DEFAULT_OWN_NAMES.some((n) => n === 'Heath Shepard, Realtor with Keller Williams City View'),
    'default list includes the confirmed Page display name',
  );

  console.log('PASS: own-identity name list is config (HEATH_FB_OWN_NAMES), not a literal, with the two real identities as shipped defaults');
}

function testConsumersWireSharedMatcher() {
  const harvesterSrc = fs.readFileSync(path.join(__dirname, 'harvest-tc-discovery-responses.js'), 'utf8');
  assert.ok(
    harvesterSrc.includes("require('./_lib/fb-own-identity')"),
    'harvest-tc-discovery-responses.js uses the shared fb-own-identity module',
  );
  assert.ok(
    harvesterSrc.includes('is_own_comment: isOwnAuthor(author)'),
    'harvester computes is_own_comment via the shared robust matcher, not an exact-equality literal',
  );
  assert.ok(
    !/is_own_comment:\s*HEATH_FB_NAMES\.some/.test(harvesterSrc),
    'harvester no longer has the old exact-match HEATH_FB_NAMES.some(...) inline for is_own_comment',
  );

  const watcherSrc = fs.readFileSync(path.join(__dirname, 'watch-guest-thread-replies.js'), 'utf8');
  assert.ok(
    watcherSrc.includes('isOwnAuthor') && watcherSrc.includes('const isHeath = (author) => isOwnAuthor(author)'),
    'watch-guest-thread-replies.js delegates isHeath() to the shared robust matcher, not its own exact-match reimplementation',
  );
  assert.ok(
    !/norm\(author\)\.toLowerCase\(\) === n\.toLowerCase\(\)/.test(watcherSrc),
    'watch-guest-thread-replies.js no longer has the old exact-match isHeath reimplementation',
  );

  console.log('PASS: both real consumers (harvester + guest-thread watcher) are wired to the shared robust matcher');
}

async function main() {
  testPageSuffixedNameMatches();
  testBarePersonalNameStillMatches();
  testDoesNotOverMatch();
  testConfigNotLiteral();
  testConsumersWireSharedMatcher();
  console.log('PASS: fb-own-identity match fix — Page-suffixed name, boundary safety, config override, both consumers wired');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
