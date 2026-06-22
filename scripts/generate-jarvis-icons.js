// Atlas: generate Jarvis PWA PNG icons at 192x192 and 512x512.
// Uses Playwright headless to rasterize an Iron Man HUD glyph onto a canvas
// at exact pixel sizes. Run: node scripts/generate-jarvis-icons.js
//
// Output:
//   jarvis-pwa-icon-192.png
//   jarvis-pwa-icon-512.png
//
// Re-runnable + deterministic.
'use strict';

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

function buildHtml(size) {
  // Cyan-on-dark HUD glyph: dark blue radial bg, layered hex-grid ring, glowing
  // cyan core, gold "J" sigil for Jarvis. Designed maskable-safe: critical
  // content stays inside the safe area (80% radius).
  return `<!doctype html><html><head><meta charset="utf-8"/>
  <style>
    html, body { margin: 0; padding: 0; background: transparent; }
    .stage {
      width: ${size}px; height: ${size}px;
      position: relative;
      background:
        radial-gradient(circle at 50% 42%, #0f1f3a 0%, #050810 70%, #020308 100%);
    }
    /* Hex-style background ring */
    .stage::before {
      content: '';
      position: absolute; inset: 0;
      background-image:
        radial-gradient(circle at 50% 50%, transparent 38%, rgba(77, 208, 225, 0.20) 39%, transparent 41%),
        radial-gradient(circle at 50% 50%, transparent 56%, rgba(77, 208, 225, 0.18) 57%, transparent 59%),
        radial-gradient(circle at 50% 50%, transparent 74%, rgba(77, 208, 225, 0.16) 75%, transparent 77%);
    }
    .arc {
      position: absolute; inset: 8%;
      border-radius: 50%;
      border: ${Math.max(2, Math.round(size * 0.012))}px solid rgba(77, 208, 225, 0.55);
      box-shadow:
        inset 0 0 ${Math.round(size * 0.10)}px rgba(0, 229, 255, 0.18),
        0 0 ${Math.round(size * 0.06)}px rgba(77, 208, 225, 0.28);
    }
    .arc.inner {
      inset: 22%;
      border-color: rgba(77, 208, 225, 0.32);
    }
    .core {
      position: absolute;
      left: 50%; top: 50%;
      width: 46%; height: 46%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background:
        radial-gradient(circle at 50% 45%, rgba(0, 229, 255, 0.95) 0%, rgba(77, 208, 225, 0.55) 40%, rgba(77, 208, 225, 0.05) 75%, transparent 90%);
      filter: blur(${Math.round(size * 0.004)}px);
    }
    .center-dot {
      position: absolute;
      left: 50%; top: 50%;
      width: 16%; height: 16%;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      background:
        radial-gradient(circle at 50% 50%, #ffffff 0%, #c5f6ff 30%, #00e5ff 70%);
      box-shadow:
        0 0 ${Math.round(size * 0.04)}px rgba(0, 229, 255, 0.95),
        0 0 ${Math.round(size * 0.10)}px rgba(0, 229, 255, 0.45);
    }
    .sigil {
      position: absolute;
      left: 50%; top: 50%;
      transform: translate(-50%, -55%);
      font-family: 'Georgia', 'Times New Roman', serif;
      font-weight: 700;
      font-size: ${Math.round(size * 0.36)}px;
      color: #c9a96e;
      text-shadow:
        0 0 ${Math.round(size * 0.04)}px rgba(201, 169, 110, 0.6),
        0 0 ${Math.round(size * 0.01)}px rgba(0, 0, 0, 0.7);
      letter-spacing: -0.04em;
      line-height: 1;
    }
    .ticks {
      position: absolute; inset: 5%;
      border-radius: 50%;
      pointer-events: none;
    }
    .tick {
      position: absolute; left: 50%; top: 0;
      width: ${Math.max(1, Math.round(size * 0.008))}px;
      height: ${Math.round(size * 0.05)}px;
      background: rgba(77, 208, 225, 0.55);
      transform-origin: 50% ${Math.round(size * 0.45)}px;
    }
  </style></head>
  <body>
    <div class="stage">
      <div class="arc"></div>
      <div class="arc inner"></div>
      <div class="ticks" id="ticks"></div>
      <div class="core"></div>
      <div class="sigil">J</div>
      <div class="center-dot"></div>
    </div>
    <script>
      // 12 hash marks around the ring
      const ticks = document.getElementById('ticks');
      for (let i = 0; i < 12; i++) {
        const t = document.createElement('div');
        t.className = 'tick';
        t.style.transform = 'translateX(-50%) rotate(' + (i * 30) + 'deg)';
        ticks.appendChild(t);
      }
    </script>
  </body></html>`;
}

async function render(size, outPath) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(buildHtml(size), { waitUntil: 'load' });
    await page.waitForTimeout(50);
    const buf = await page.locator('.stage').screenshot({
      omitBackground: false,
      type: 'png',
    });
    fs.writeFileSync(outPath, buf);
    console.log('wrote', outPath, buf.length, 'bytes');
  } finally {
    await browser.close();
  }
}

(async function main() {
  const root = path.resolve(__dirname, '..');
  await render(192, path.join(root, 'jarvis-pwa-icon-192.png'));
  await render(512, path.join(root, 'jarvis-pwa-icon-512.png'));
})().catch((e) => { console.error(e); process.exit(1); });
