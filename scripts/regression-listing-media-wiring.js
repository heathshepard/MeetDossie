#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-11 URGENT fix to listing marketing posts
 * queuing with media_url=null despite real cards/video existing on disk.
 *
 * THE BUG
 * -------
 * Real marketing videos (Desktop/listing-videos/*.mp4) and Canva cards
 * existed for Fawndale/Wild Cherry/Nopalito, but nothing in
 * scripts/listing-marketing-generator.js ever pointed at them -- every
 * queued row had media_url=null and Telegram showed "no media yet".
 * Instagram cannot post text-only via the API at all, so a null-media IG
 * row is a guaranteed-fail dead row.
 *
 * THE FIX
 * -------
 * 1. The 6 video files were uploaded to the public 'videos' storage bucket
 *    (listing-media's mime allowlist is images-only) and referenced from
 *    listing-marketing-facts.js's new `videos` field per listing.
 * 2. pickMedia() prefers that video over the static MLS photo wherever a
 *    video asset is on file, falling back to the photo only when none
 *    exists yet (e.g. Senisa, no video shot yet).
 * 3. refuseIfInstagramWithoutMedia() blocks any Instagram insert that has
 *    no media_url, rather than letting a doomed row reach Telegram.
 *
 * TESTS (no network access -- pure function tests against the real fact
 * pack + generator code, ZERO production DB access):
 *   1. Fawndale (has a video on file) resolves to the video URL, isVideo=true.
 *   2. Nopalito (has a video on file) resolves to the video URL, isVideo=true.
 *   3. Senisa (no video on file) falls back to a photo URL, isVideo=false.
 *   4. refuseIfInstagramWithoutMedia blocks instagram+no-media, allows
 *      instagram+media, and never blocks facebook regardless of media.
 *
 * Run manually:
 *   node scripts/regression-listing-media-wiring.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');

process.env.SUPABASE_URL = 'https://example-project.supabase.co'; // STORAGE_BASE just needs to be non-empty; no network call made by pickMedia itself

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

  const { pickMedia, refuseIfInstagramWithoutMedia } = require(path.join(REPO, 'scripts/listing-marketing-generator.js'));
  const { LISTINGS } = require(path.join(REPO, 'scripts/_lib/listing-marketing-facts.js'));

  console.log('\nTest 1: Fawndale resolves to its uploaded video, not the static photo');
  const fawndale = LISTINGS['2015607'];
  check('Fawndale has a videos field on file', () => assert.ok(fawndale.videos && fawndale.videos.vertical, 'fact pack is missing the uploaded video reference'));
  const fawndaleMedia = pickMedia(fawndale, 'kitchen');
  check('Fawndale pickMedia() returns isVideo=true', () => assert.strictEqual(fawndaleMedia.isVideo, true));
  check('Fawndale pickMedia() URL points at the vertical video, not a .jpg', () => {
    assert.ok(/702-fawndale-vertical\.mp4$/.test(fawndaleMedia.url), `got ${fawndaleMedia.url}`);
  });

  console.log('\nTest 2: Nopalito resolves to its uploaded video');
  const nopalito = LISTINGS['1916402'];
  const nopalitoMedia = pickMedia(nopalito, null);
  check('Nopalito pickMedia() returns isVideo=true', () => assert.strictEqual(nopalitoMedia.isVideo, true));
  check('Nopalito pickMedia() URL points at the vertical video', () => {
    assert.ok(/23-nopalito-vertical\.mp4$/.test(nopalitoMedia.url), `got ${nopalitoMedia.url}`);
  });

  console.log('\nTest 3: Senisa (no video shot yet) falls back to a photo, never null while a photo exists');
  const senisa = LISTINGS['1997664'];
  check('Senisa fact pack has no videos field (no clip shot yet)', () => assert.ok(!senisa.videos, 'expected Senisa to have no videos field for this test to be meaningful'));
  const senisaMedia = pickMedia(senisa, null);
  check('Senisa pickMedia() returns isVideo=false', () => assert.strictEqual(senisaMedia.isVideo, false));
  check('Senisa pickMedia() URL points at a real uploaded photo, not null', () => {
    assert.ok(senisaMedia.url && /\.jpg$/.test(senisaMedia.url), `got ${senisaMedia.url}`);
  });

  console.log('\nTest 4: Instagram-without-media refusal guard');
  check('refuses instagram with no media_url', () => assert.strictEqual(refuseIfInstagramWithoutMedia('instagram', null, 'test'), true));
  check('allows instagram WITH a media_url', () => assert.strictEqual(refuseIfInstagramWithoutMedia('instagram', 'https://example.com/x.mp4', 'test'), false));
  check('never blocks facebook even with no media_url (FB can post text-only)', () => assert.strictEqual(refuseIfInstagramWithoutMedia('facebook', null, 'test'), false));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Regression test crashed:', err);
  process.exit(1);
});
