#!/usr/bin/env node
'use strict';

/**
 * Regression test for two structural rules added to
 * api/_lib/verify-video-quality.js 2026-10-01 —
 * founder-video-production-standard.md §3 and §6:
 *
 *   speed_applied_once — "Speed is applied in exactly ONE place... Twice
 *     caused an 18-second A/V drift." Proxy: the finished file's video and
 *     audio STREAM durations must agree (a double-application desyncs them
 *     measurably; this gate never sees the build's internal speed stage).
 *   end_decay_tail — "End of video needs a real decay tail (~0.33s); a cut
 *     from -34dB to digital silence in one frame reads as truncation."
 *
 * Both are real/synthetic pairs: REAL known-good fixtures (v7_FINAL.mp4,
 * v7b_SPLICED.mp4, v7c_SPLICED.mp4 — all pass; neither defect was present
 * in these specific files, see the report) plus SYNTHETIC fixtures built
 * on the fly with ffmpeg to PROVE each rule can actually fail, not just
 * always pass on real footage.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { checkVideoQuality } = require('../api/_lib/verify-video-quality.js');

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function ruleFor(videoPath, ruleName) {
  const result = await checkVideoQuality({ videoPath, coverPath: videoPath, platforms: ['tiktok'] });
  return result.rules[ruleName];
}

async function testRealFixtures() {
  console.log('\n=== REAL fixtures (v7_FINAL / v7b_SPLICED / v7c_SPLICED) ===');
  const files = [
    ['v7_FINAL', '/home/heath/mw/v7/v7_FINAL.mp4'],
    ['v7b_SPLICED', '/home/heath/mw/v7/v7b_SPLICED.mp4'],
    ['v7c_SPLICED', '/home/heath/mw/v7/v7c_SPLICED.mp4'],
  ];
  for (const [label, p] of files) {
    if (!fs.existsSync(p)) { console.log(`  SKIP  ${label} not present on this machine (${p})`); continue; }
    const speed = await ruleFor(p, 'speed_applied_once');
    const decay = await ruleFor(p, 'end_decay_tail');
    check(`${label}: speed_applied_once passes`, speed.pass === true, speed.note);
    check(`${label}: end_decay_tail passes`, decay.pass === true, decay.note);
  }
}

async function testSyntheticSpeedMismatch(tmp) {
  console.log('\n=== SYNTHETIC: video/audio stream duration mismatch (expect speed_applied_once FAIL) ===');
  const vid = path.join(tmp, 'vid10.mp4');
  const aud = path.join(tmp, 'aud16.m4a');
  const out = path.join(tmp, 'mismatched_speed.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=10', '-c:v', 'libx264', '-an', vid, '-loglevel', 'error']);
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=16', '-c:a', 'aac', aud, '-loglevel', 'error']);
  execFileSync('ffmpeg', ['-y', '-i', vid, '-i', aud, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'copy', out, '-loglevel', 'error']);

  const speed = await ruleFor(out, 'speed_applied_once');
  check('mismatched streams: speed_applied_once FAILS', speed.pass === false, speed.note);
}

async function testSyntheticAbruptCutoff(tmp) {
  console.log('\n=== SYNTHETIC: audio cuts off abruptly while loud (expect end_decay_tail FAIL) ===');
  const out = path.join(tmp, 'abrupt_cut.mp4');
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
    '-c:v', 'libx264', '-c:a', 'aac', '-ac', '1', out, '-loglevel', 'error']);

  const decay = await ruleFor(out, 'end_decay_tail');
  check('abrupt cutoff: end_decay_tail FAILS', decay.pass === false, decay.note);
}

async function testSyntheticRealDecay(tmp) {
  console.log('\n=== SYNTHETIC: audio fades out over 1.0s (expect end_decay_tail PASS) ===');
  const out = path.join(tmp, 'real_decay.mp4');
  // afade ramps LINEAR AMPLITUDE, not linear dB — most of the audible dB
  // drop happens in the final fraction of the ramp, so a short fade can
  // still cross -34dB very close to the end. A full 1.0s fade gives the
  // -34dB crossing comfortable room ahead of the 0.15s minimum.
  execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1080x1920:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
    '-af', 'afade=t=out:st=5.0:d=1.0',
    '-c:v', 'libx264', '-c:a', 'aac', '-ac', '1', out, '-loglevel', 'error']);

  const decay = await ruleFor(out, 'end_decay_tail');
  check('real 1.0s fade-out: end_decay_tail passes', decay.pass === true, decay.note);
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'structural-assertions-test-'));
  try {
    await testRealFixtures();
    await testSyntheticSpeedMismatch(tmp);
    await testSyntheticAbruptCutoff(tmp);
    await testSyntheticRealDecay(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
