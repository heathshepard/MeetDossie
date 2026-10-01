#!/usr/bin/env node
'use strict';

/**
 * Regression test for the captions_box_readable rule added to
 * api/_lib/verify-video-quality.js 2026-10-01 — see
 * founder-video-production-standard.md §4 and §7: "The quality gate scored
 * captions 3/3 on a video Heath could not read." This is the fix: a direct
 * pixel measurement (contrast, opacity, on-screen position) instead of a
 * vision-model judgement.
 *
 * FIXTURES — Heath's local workstation (`/home/heath/mw/v7/`), not checked
 * into git, same convention as scripts/regression-video-quality-gate.js's
 * Media/rust-conversations fixtures. Per the task's own instruction ("A
 * check that passes both is worthless"), this is a REQUIRED positive/
 * negative pair, not an optional nice-to-have — if either fixture is
 * missing, this test FAILS LOUDLY rather than silently skipping.
 *
 *   BAD  = v7b_SPLICED.mp4 — top-aligned captions (Alignment 8, MarginV
 *          175), the cut Heath flagged "I can't read it."
 *   GOOD = v7c_SPLICED.mp4 — bottom-centre captions (Alignment 2, MarginV
 *          1005), approved: "The video is great and ready for posting."
 */
const fs = require('fs');
const { checkVideoQuality } = require('../api/_lib/verify-video-quality.js');

const BAD = '/home/heath/mw/v7/v7b_SPLICED.mp4';
const GOOD = '/home/heath/mw/v7/v7c_SPLICED.mp4';

let failures = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`);
  }
}

async function main() {
  if (!fs.existsSync(BAD) || !fs.existsSync(GOOD)) {
    console.error(`REQUIRED fixtures missing — this test cannot validate anything without both:\n  BAD:  ${BAD}\n  GOOD: ${GOOD}`);
    process.exit(1);
  }

  const badResult = await checkVideoQuality({ videoPath: BAD, coverPath: BAD, platforms: ['tiktok'] });
  const goodResult = await checkVideoQuality({ videoPath: GOOD, coverPath: GOOD, platforms: ['tiktok'] });

  console.log('\n=== BAD fixture (v7b_SPLICED.mp4 — top-aligned, "I can\'t read it") ===');
  console.log(JSON.stringify(badResult.rules.captions_box_readable, null, 2));
  console.log('samples:', JSON.stringify(badResult.detail.caption_box_samples, null, 2));

  console.log('\n=== GOOD fixture (v7c_SPLICED.mp4 — bottom-centre, approved) ===');
  console.log(JSON.stringify(goodResult.rules.captions_box_readable, null, 2));
  console.log('samples:', JSON.stringify(goodResult.detail.caption_box_samples, null, 2));

  console.log('\n=== Assertions ===');
  check('BAD fixture: captions_box_readable FAILS', badResult.rules.captions_box_readable.pass === false);
  check('GOOD fixture: captions_box_readable PASSES', goodResult.rules.captions_box_readable.pass === true);

  const badSamples = (badResult.detail.caption_box_samples || []).filter((s) => s.box);
  const goodSamples = (goodResult.detail.caption_box_samples || []).filter((s) => s.box);
  check('BAD fixture: every located caption box sits in the top 30% of frame height',
    badSamples.length > 0 && badSamples.every((s) => s.centerFrac < 0.30),
    JSON.stringify(badSamples.map((s) => s.centerFrac)));
  check('GOOD fixture: every located caption box sits at/below 30% of frame height',
    goodSamples.length > 0 && goodSamples.every((s) => s.centerFrac >= 0.30),
    JSON.stringify(goodSamples.map((s) => s.centerFrac)));

  // Both files render an opaque box (libass BorderStyle=3 fills from
  // OutlineColour in this build, not BackColour's alpha — see the block
  // comment above locateCaptionBox() in verify-video-quality.js). Contrast/
  // opacity are NOT the discriminator between these two specific files —
  // position is — but both should still measure healthy contrast/opacity,
  // proving those sub-metrics aren't accidentally failing good content.
  check('BAD fixture: contrast/opacity sub-metrics are themselves healthy (position is the sole failure)',
    badSamples.every((s) => s.contrast >= 100 && s.fillStd <= 35));
  check('GOOD fixture: contrast/opacity sub-metrics are healthy',
    goodSamples.every((s) => s.contrast >= 100 && s.fillStd <= 35));

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
