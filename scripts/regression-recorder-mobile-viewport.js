#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-07 feature-demo-recorder viewport fix.
 *
 * THE BUG
 * -------
 * feature-demo-recorder.js set recordVideo.size = viewport, so the only way
 * to get a 1080x1920 vertical video was viewport: {1080, 1920}. A 1080px-wide
 * CSS viewport is ABOVE the app's 768px mobile breakpoint, so every "mobile"
 * vertical demo actually recorded the DESKTOP layout stretched into a phone
 * frame (Sage's qa-vertical-2026-09-07 audit, 99-comparison shot).
 *
 * THE FIX
 * -------
 * Scene JSON now supports:
 *   device_scale_factor — decouples CSS viewport from recorded pixels
 *   output_size         — explicit recorded size override
 *   is_mobile/has_touch — real phone emulation flags
 * { viewport: 540x960, device_scale_factor: 2 } renders the true mobile UI
 * and records 1080x1920 physical pixels.
 *
 * TESTS (mocked Playwright — no browser, no network, no recording):
 *   1. VERTICAL: 540x960 @2x scene -> context viewport stays 540 (< 768
 *      mobile breakpoint), deviceScaleFactor 2, recordVideo.size 1080x1920,
 *      isMobile + hasTouch true. Fails pre-fix (recordVideo.size was 540x960).
 *   2. BACK-COMPAT: legacy desktop scene (viewport only, plus the
 *      allow_non_vertical opt-out the 2026-09-16 framing guard requires) ->
 *      recordVideo.size === viewport, scale factor 1, no mobile emulation.
 *   3. FRAMING GUARD (2026-09-16): a scene targeting a vertical surface is
 *      refused if it would record non-9:16, or below 1080x1920.
 *
 * Run manually:
 *   node scripts/regression-recorder-mobile-viewport.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const RAW_DIR = path.join(REPO, 'Media', 'feature-demos', 'raw');

// ─── Mock playwright before the recorder requires it ─────────────────────────

const captured = { contexts: [] };
const mockWebms = [];

const mockPlaywright = {
  chromium: {
    async launch() {
      return {
        async newContext(opts) {
          captured.contexts.push(opts);
          // record() looks for a fresh .webm after the run — fake one.
          const f = path.join(RAW_DIR, `regr-mock-${Date.now()}-${captured.contexts.length}.webm`);
          fs.mkdirSync(RAW_DIR, { recursive: true });
          fs.writeFileSync(f, 'mock');
          mockWebms.push(f);
          return {
            async newPage() { return { async close() {} }; },
            async close() {},
          };
        },
        async close() {},
      };
    },
  },
};

const playwrightPath = require.resolve('playwright', { paths: [REPO] });
require.cache[playwrightPath] = {
  id: playwrightPath,
  filename: playwrightPath,
  loaded: true,
  exports: mockPlaywright,
};

const { record } = require(path.join(REPO, 'scripts', 'feature-demo-recorder.js'));

// ─── Fixtures ────────────────────────────────────────────────────────────────

function writeScene(name, cfg) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, JSON.stringify(cfg));
  return p;
}

const verticalScene = writeScene('regr-recorder-vertical.json', {
  name: 'regr vertical mobile',
  form_factor: 'mobile-vertical',
  filename: 'regr-recorder-vertical.mp4',
  viewport: { width: 540, height: 960 },
  device_scale_factor: 2,
  is_mobile: true,
  slowmo_ms: 0,
  scenes: [],
});

// allow_non_vertical is REQUIRED here as of 2026-09-16. The recorder now
// refuses a non-9:16 take whenever the scene targets a vertical surface, and
// treats a scene with no `platforms` key as vertical — because
// feature-demo-publish.js defaults platforms to ['facebook','twitter',
// 'linkedin'], and Facebook renders those as Reels. Without that conservative
// default, an unlabelled scene would land in exactly the hole that shipped
// feature-demo-stage-checklist-desktop-2026-09-07 as ~80% black bars.
// A genuinely-landscape take (internal sales-demo walkthrough) opts out here.
const desktopScene = writeScene('regr-recorder-desktop.json', {
  name: 'regr legacy desktop',
  form_factor: 'desktop',
  filename: 'regr-recorder-desktop.mp4',
  viewport: { width: 1920, height: 1080 },
  allow_non_vertical: true,
  slowmo_ms: 0,
  scenes: [],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const produced = [];
const extraScenes = [];

(async () => {
  produced.push(await record(verticalScene));
  produced.push(await record(desktopScene));

  // Test 1 — vertical mobile scene
  const v = captured.contexts[0];
  assert.ok(v.viewport.width < 768,
    `VERTICAL: CSS viewport width must stay under the 768px mobile breakpoint, got ${v.viewport.width}`);
  assert.strictEqual(v.viewport.width, 540, 'VERTICAL: CSS viewport width');
  assert.strictEqual(v.viewport.height, 960, 'VERTICAL: CSS viewport height');
  assert.strictEqual(v.deviceScaleFactor, 2, 'VERTICAL: deviceScaleFactor must pass through');
  assert.strictEqual(v.recordVideo.size.width, 1080,
    `VERTICAL: recorded width must be 1080 physical px, got ${v.recordVideo.size.width}`);
  assert.strictEqual(v.recordVideo.size.height, 1920,
    `VERTICAL: recorded height must be 1920 physical px, got ${v.recordVideo.size.height}`);
  assert.strictEqual(v.isMobile, true, 'VERTICAL: isMobile emulation');
  assert.strictEqual(v.hasTouch, true, 'VERTICAL: hasTouch implied by is_mobile');

  // Test 2 — legacy desktop scene unchanged
  const d = captured.contexts[1];
  assert.strictEqual(d.viewport.width, 1920, 'DESKTOP: viewport width');
  assert.strictEqual(d.recordVideo.size.width, 1920, 'DESKTOP: recorded size === viewport');
  assert.strictEqual(d.recordVideo.size.height, 1080, 'DESKTOP: recorded size === viewport');
  assert.strictEqual(d.deviceScaleFactor || 1, 1, 'DESKTOP: no scale factor');
  assert.ok(!d.isMobile, 'DESKTOP: no mobile emulation');

  console.log('PASS: vertical 540x960 @2x records 1080x1920 of the real mobile layout');
  console.log('PASS: legacy desktop scenes are untouched');

  // Test 3 — the 2026-09-16 framing guard. These are the two shapes that
  // actually shipped broken (landscape) or would silently halve resolution.
  const contextsBefore = captured.contexts.length;

  const landscapeToFacebook = writeScene('regr-recorder-landscape-fb.json', {
    name: 'regr landscape to facebook',
    form_factor: 'desktop',
    filename: 'regr-recorder-landscape-fb.mp4',
    viewport: { width: 1920, height: 1080 },
    platforms: ['facebook', 'twitter', 'linkedin'],
    slowmo_ms: 0,
    scenes: [],
  });
  await assert.rejects(
    () => record(landscapeToFacebook),
    /REFUSING to record[\s\S]*not 9:16/,
    'GUARD: a 1920x1080 scene bound for Facebook must be refused (the 2026-09-15 defect)',
  );

  const halfResVertical = writeScene('regr-recorder-halfres.json', {
    name: 'regr half-res vertical',
    form_factor: 'mobile-vertical',
    filename: 'regr-recorder-halfres.mp4',
    viewport: { width: 540, height: 960 },
    device_scale_factor: 2,
    output_size: { width: 540, height: 960 }, // the override that cancels the dsf fix
    is_mobile: true,
    platforms: ['tiktok', 'instagram'],
    slowmo_ms: 0,
    scenes: [],
  });
  await assert.rejects(
    () => record(halfResVertical),
    /REFUSING to record[\s\S]*below the 1080x1920 delivery resolution/,
    'GUARD: an output_size override that halves resolution must be refused',
  );

  const optedOut = writeScene('regr-recorder-optout.json', {
    name: 'regr opted-out landscape',
    form_factor: 'desktop',
    filename: 'regr-recorder-optout.mp4',
    viewport: { width: 1920, height: 1080 },
    platforms: ['facebook'],
    allow_non_vertical: true,
    slowmo_ms: 0,
    scenes: [],
  });
  produced.push(await record(optedOut));
  assert.strictEqual(captured.contexts.length, contextsBefore + 1,
    'GUARD: allow_non_vertical must still let a deliberate landscape take record');

  extraScenes.push(landscapeToFacebook, halfResVertical, optedOut);
  console.log('PASS: framing guard refuses landscape-to-vertical and half-resolution takes');
  console.log('PASS: allow_non_vertical opt-out still records');
})()
  .then(cleanup)
  .catch((err) => { cleanup(); console.error(`FAIL: ${err.message}`); process.exit(1); });

function cleanup() {
  for (const f of [...mockWebms, ...produced, ...extraScenes, verticalScene, desktopScene]) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
  }
}
