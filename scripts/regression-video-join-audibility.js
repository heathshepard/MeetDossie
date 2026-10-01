#!/usr/bin/env node
'use strict';

/**
 * Regression test for scripts/video-engine/check-join-audibility.js — the
 * join-audibility gate added 2026-10-01 per
 * founder-video-production-standard.md §2: "Joins must be MEASURED
 * inaudible, not asserted... No join above the 99th percentile."
 *
 * TESTS
 * -----
 *   1. SYNTHETIC (no external dependency, always runs): a clean sine-wave
 *      WAV with one deliberately injected loud click gets its injected join
 *      flagged, and its two clean joins pass — proves the check can
 *      actually fail, not just always-pass on real footage.
 *   2. REAL fixtures (/home/heath/mw/v7/{v7b,v7c}_voice.wav +
 *      {v7b,v7c}_master.json — Heath's local workstation, not checked into
 *      git, same convention as scripts/regression-video-quality-gate.js's
 *      Media/rust-conversations fixtures): both the approved v7c build and
 *      its v7b predecessor score 0-of-13 joins flagged. Join quality was
 *      NOT the defect that made v7b hard to watch — see
 *      scripts/regression-video-caption-box.js for that one — so this test
 *      is a forward-looking regression guard, not a positive/negative pair.
 *      If the fixtures aren't present on this machine, this half prints a
 *      clear SKIP (not a silent pass) and the synthetic test still gates
 *      the script's exit code.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { checkJoinAudibility } = require('./video-engine/check-join-audibility.js');

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

function test1Synthetic() {
  console.log('\n=== Test 1: synthetic clean-sine + injected click ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'join-audibility-test-'));
  const clean = path.join(tmp, 'clean.wav');
  const clicked = path.join(tmp, 'clicked.wav');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=10', '-af', 'volume=0.3', clean, '-loglevel', 'error']);
  execFileSync('ffmpeg', ['-y', '-i', clean, '-af', "volume=enable='between(t,5.0,5.02)':volume=8", clicked, '-loglevel', 'error']);

  const result = checkJoinAudibility({ mediaPath: clicked, joins: [2.0, 5.0, 8.0], crossTake: [] });
  const byTime = Object.fromEntries(result.perJoin.map((j) => [j.t, j]));

  check('overall result is FAIL (injected click present)', result.pass === false);
  check('injected join (t=5.0) is flagged', byTime[5].flagged === true, `percentile=${byTime[5].percentileOfBaseline}`);
  check('clean join (t=2.0) is NOT flagged', byTime[2].flagged === false, `percentile=${byTime[2].percentileOfBaseline}`);
  check('clean join (t=8.0) is NOT flagged', byTime[8].flagged === false, `percentile=${byTime[8].percentileOfBaseline}`);
  check('flaggedCount === 1', result.flaggedCount === 1, `got ${result.flaggedCount}`);

  fs.rmSync(tmp, { recursive: true, force: true });
}

function test2RealFixtures() {
  console.log('\n=== Test 2: real fixtures (v7b/v7c) ===');
  const base = '/home/heath/mw/v7';
  const pairs = [
    ['v7c (approved, "video is great and ready for posting")', path.join(base, 'v7c_voice.wav'), path.join(base, 'v7c_master.json')],
    ['v7b (predecessor — unreadable captions, but joins were already clean)', path.join(base, 'v7b_voice.wav'), path.join(base, 'v7b_master.json')],
  ];
  for (const [label, audio, joinsPath] of pairs) {
    if (!fs.existsSync(audio) || !fs.existsSync(joinsPath)) {
      console.log(`  SKIP  ${label} — fixture not present on this machine (${audio})`);
      continue;
    }
    const meta = JSON.parse(fs.readFileSync(joinsPath, 'utf8'));
    const result = checkJoinAudibility({ mediaPath: audio, joins: meta.joins, crossTake: meta.cross_take || [] });
    check(`${label}: 0 joins flagged`, result.flaggedCount === 0, `got ${result.flaggedCount} of ${result.perJoin.length} — ${JSON.stringify(result.flagged)}`);
  }
}

test1Synthetic();
test2RealFixtures();

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
