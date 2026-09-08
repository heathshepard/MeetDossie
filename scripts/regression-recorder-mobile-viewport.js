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
 *   2. BACK-COMPAT: legacy desktop scene (viewport only) -> recordVideo.size
 *      === viewport, scale factor 1, no mobile emulation.
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

const desktopScene = writeScene('regr-recorder-desktop.json', {
  name: 'regr legacy desktop',
  form_factor: 'desktop',
  filename: 'regr-recorder-desktop.mp4',
  viewport: { width: 1920, height: 1080 },
  slowmo_ms: 0,
  scenes: [],
});

// ─── Run ─────────────────────────────────────────────────────────────────────

const produced = [];

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
})()
  .then(cleanup)
  .catch((err) => { cleanup(); console.error(`FAIL: ${err.message}`); process.exit(1); });

function cleanup() {
  for (const f of [...mockWebms, ...produced, verticalScene, desktopScene]) {
    try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
  }
}
