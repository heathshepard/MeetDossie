#!/usr/bin/env node
'use strict';

// Render an HTML card to a fixed-size PNG with Playwright.
//
// WHY THIS EXISTS: the hook card and the CTA end card are binary requirements
// for every short-form video (docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §5 items
// 1/3/7/10, §5a checks 1/4/16). The obvious way to draw them is ffmpeg's
// drawtext/drawbox — but the static ffmpeg on this machine ships WITHOUT
// those filters:
//     $ ffmpeg -filters | grep drawtext   ->   (nothing)
//     [AVFilterGraph] No such filter: 'drawtext'
// libass (`subtitles`/`ass`) IS present, which is why burned captions still
// work, but libass is a subtitle renderer, not a layout engine — it can't do
// the colour blocks, mixed weights and web fonts a real hook card needs.
// There is also no PIL and no pip in this environment
// (local-toolchain-constraints memory), so Python image libs are out.
//
// Playwright is already a dependency (it's what captures the app footage in
// the first place), so HTML+CSS is both the least new machinery AND the most
// control: real brand fonts from public/fonts, gradients, precise type.
//
// Usage:
//   node scripts/render-card-png.js --html card.html --out card.png [--width 1080] [--height 1920]

const path = require('path');
const fs = require('fs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { out[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (!args.html || !args.out) {
    console.error('usage: render-card-png.js --html <file.html> --out <file.png> [--width N] [--height N]');
    process.exit(2);
  }
  const width = parseInt(args.width || '1080', 10);
  const height = parseInt(args.height || '1920', 10);
  const htmlPath = path.resolve(args.html);
  if (!fs.existsSync(htmlPath)) {
    console.error(`html not found: ${htmlPath}`);
    process.exit(2);
  }

  const { chromium } = require(path.join('/mnt/c/Users/Heath/Projects/MeetDossie', 'node_modules', 'playwright'));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto('file://' + htmlPath, { waitUntil: 'networkidle' });
    // Fonts are loaded from file:// via @font-face; wait for them so the
    // screenshot never captures a fallback-font flash.
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.resolve(args.out), type: 'png' });
    console.log(`[card] ${args.out} ${width}x${height}`);
  } finally {
    await browser.close();
  }
})().catch((err) => { console.error(err && err.message); process.exit(1); });
