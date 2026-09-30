'use strict';

// scripts/capture-screen-recording-trec-clause.js
//
// Captures a clean, postable screen recording of a REAL TREC form (blank
// specimen, never an executed contract) scrolling/zooming to and
// highlighting one specific paragraph. Output lands in
// Media/screen-recordings/ under the naming convention documented in
// Media/screen-recordings/LIBRARY.md:
//
//   <topic-slug>-mobile-<YYYY-MM-DD>.mp4    portrait  -> instagram, tiktok
//   <topic-slug>-desktop-<YYYY-MM-DD>.mp4   landscape -> facebook, twitter, linkedin
//
// Technique: render the target PDF page to a high-DPI PNG (pdftoppm), load
// it in a static HTML page inside a Playwright-recorded browser context, and
// run a slow CSS transform (translate+scale) from a full-page "establishing"
// framing to a zoomed, centered framing on the target paragraph's bounding
// box — then fade in a highlight box around it. No PDF viewer chrome is ever
// rendered (no toolbar, no scrollbars): the PDF is a flat image inside a
// plain <div>.
//
// The target paragraph's bounding box (in PDF points, 72/inch, top-left
// origin matching pdftotext -bbox) must be measured once per clause via:
//   pdftoppm -png -r 150 -f <page> -l <page> <pdf> out
//   pdftotext -bbox -f <page> -l <page> <pdf> out.bbox.html
// then reading the <word> tags around the target paragraph. This keeps the
// script deterministic and re-runnable — re-running produces the same crop
// every time; only the DATE in the output filename changes.
//
// Usage:
//   node scripts/capture-screen-recording-trec-clause.js --clause para-7i-groundwater

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright');

const REPO_ROOT = path.join(__dirname, '..');
const SCREEN_RECORDINGS_DIR = path.join(REPO_ROOT, 'Media', 'screen-recordings');
const TMP_DIR = path.join(REPO_ROOT, '.tmp', 'screen-recording-trec');

// ─── Known clause registry ─────────────────────────────────────────────────
//
// bbox is [x0, y0, x1, y1] in PDF points (72/inch), already padded ~4pt
// beyond the tightest word bounding boxes so the highlight box doesn't
// crop letters. Measured against scripts/trec-forms/20-19.pdf (the blank
// 05-04-2026 promulgated revision — never a filled/executed copy).
// Every bboxPt boundary below was found by rendering the page at 400 DPI to
// grayscale PGM and scanning for a horizontal pixel row that is genuinely
// 100% white (value 255) across the full text-column width — not just a
// pdftotext -bbox word gap, which is unreliable: word/checkbox glyph boxes
// routinely claim 1-2pt more padding than the glyph actually ink, and this
// form's line leading is tight enough that adjacent lines' *bboxes* overlap
// even when their *ink* does not. Trusting bbox numbers alone previously
// shipped a highlight box whose lower edge sliced through "(1) Buyer has
// received the Seller's Water Disclosure." — caught only by a coordinator
// watching the actual frame. The fix: find the real blank pixel row first
// (scripts/capture-screen-recording-trec-clause.js was iterated against
// scratch PNG/PGM renders, not committed — see the method in this file's
// git history if a boundary ever needs re-deriving), THEN pick bboxPt from
// the middle of that confirmed-blank band.
const CLAUSES = {
  'para-7i-groundwater': {
    pdf: path.join(REPO_ROOT, 'scripts', 'trec-forms', '20-19.pdf'),
    page: 5,
    label: 'Paragraph 7.I — Seller’s Disclosure About Groundwater and Surface Water Rights',
    // Top: blank band 426.5-428pt between ¶7.H's last line and the ¶7.I
    // heading. Bottom: blank band 504.0-507.5pt between "(1) Buyer has
    // received..." and "(2) Buyer has not received...". (The original 500pt
    // bottom bound sliced through "(1)"'s line and its checkbox glyph —
    // fixed 2026-09-30.)
    bboxPt: [51, 427, 564, 505.5],
  },
  'para-12b-brokerage-compensation': {
    pdf: path.join(REPO_ROOT, 'scripts', 'trec-forms', '20-19.pdf'),
    page: 7,
    label: 'Paragraph 12.B — Brokerage Compensation',
    // Top: blank band 75.3-75.9pt between ¶12.A's last line and "B.
    // BROKERAGE COMPENSATION:". Bottom: blank band 181.8-182.2pt between
    // "...owed by Seller to Seller's broker." and "C. EXPENSE LIMITATION:".
    bboxPt: [51, 75.8, 566, 182.0],
  },
  'para-5b-option-period': {
    pdf: path.join(REPO_ROOT, 'scripts', 'trec-forms', '20-19.pdf'),
    page: 2,
    label: 'Paragraph 5.B — Termination Option (Option Period + 5:00 p.m. deadline)',
    // Whole lettered clause B, heading to end — contains both the blank
    // "_____ days" field and the printed "5:00 p.m. ... by the date
    // specified." line the script needs. Top: blank band 253.8-255.2pt
    // (after ¶5.A). Bottom: blank band 338.5-339.4pt (before ¶5.C).
    bboxPt: [51, 254.5, 566, 339.0],
  },
  'para-5e-time-of-essence': {
    pdf: path.join(REPO_ROOT, 'scripts', 'trec-forms', '20-19.pdf'),
    page: 2,
    label: 'Paragraph 5.E — Time Is Of the Essence',
    // Top: blank band 401.6-402.2pt (after ¶5.D). Bottom: blank band
    // 422.9-424.9pt (before ¶6).
    bboxPt: [51, 401.9, 566, 423.5],
  },
};

const PAGE_W_PT = 612; // TREC 20-19 is standard Letter, portrait
const PAGE_H_PT = 792;
const RENDER_DPI = 400;

function run(cmd, args) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}: ${res.stderr || res.stdout}`);
  }
  return res;
}

function findFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'ffmpeg';
  throw new Error('ffmpeg not found on PATH');
}

function collisionSafePath(destDir, filename) {
  let candidate = path.join(destDir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let n = 2;
  while (fs.existsSync(path.join(destDir, `${base}-${n}${ext}`))) n += 1;
  return path.join(destDir, `${base}-${n}${ext}`);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Computes the geometry (fit scale, zoom scale, translate offsets, highlight
// box screen rect) for one form factor. All units are output pixels.
function computeGeometry({ outputW, outputH, nativeW, nativeH, bboxNativePx, zoomMultiplier, maxZoomToAvoidTextClip }) {
  const fitScale = Math.min(outputW / nativeW, outputH / nativeH);
  const [bx0, by0, bx1, by1] = bboxNativePx;
  const paraCenter = [(bx0 + bx1) / 2, (by0 + by1) / 2];
  const paraW = bx1 - bx0;

  let zoomScale = fitScale * zoomMultiplier;
  // Never clip the paragraph's own text out of frame horizontally.
  const maxZoomScale = (outputW * 0.94) / paraW;
  if (zoomScale > Math.min(maxZoomScale, fitScale * maxZoomToAvoidTextClip)) {
    zoomScale = Math.min(maxZoomScale, fitScale * maxZoomToAvoidTextClip);
  }

  const startTx = (outputW - nativeW * fitScale) / 2;
  const startTy = (outputH - nativeH * fitScale) / 2;

  const endTx = outputW / 2 - zoomScale * paraCenter[0];
  const endTy = outputH / 2 - zoomScale * paraCenter[1];

  const boxScreen = {
    left: endTx + zoomScale * bx0,
    top: endTy + zoomScale * by0,
    width: zoomScale * (bx1 - bx0),
    height: zoomScale * (by1 - by0),
  };

  return { fitScale, zoomScale, startTx, startTy, endTx, endTy, boxScreen };
}

function buildHtml({ imagePath, nativeW, nativeH, outputW, outputH, geo, label }) {
  const fileUrl = 'file://' + imagePath.replace(/\\/g, '/');
  // Caption bar is a solid, fixed-position band pinned to the bottom of the
  // frame — independent of the page transform — so it NEVER partially
  // overlaps document text (which would look like an accidental crop). Its
  // height scales with the smaller frame dimension so it reads at a sane
  // size on both a 1080x1920 portrait frame and a 1920x1080 landscape one.
  const captionH = Math.round(Math.min(outputW, outputH) * 0.11);
  const captionFontPx = Math.round(captionH * 0.34);
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;padding:0;background:#F5E6E0;overflow:hidden;}
  #frame{position:relative;width:${outputW}px;height:${outputH}px;overflow:hidden;background:#F5E6E0;}
  #page{position:absolute;top:0;left:0;width:${nativeW}px;height:${nativeH}px;
    transform-origin:0 0;
    transform:translate(${geo.startTx}px, ${geo.startTy}px) scale(${geo.fitScale});
    transition:transform 4.5s cubic-bezier(0.45,0,0.2,1);
    box-shadow:0 0 0 1px rgba(0,0,0,0.06);}
  #highlight{position:absolute;left:${geo.boxScreen.left}px;top:${geo.boxScreen.top}px;
    width:${geo.boxScreen.width}px;height:${geo.boxScreen.height}px;
    border:4px solid #C9A96E;border-radius:6px;
    box-shadow:0 0 0 4000px rgba(26,26,46,0.18);
    opacity:0;transition:opacity 1.1s ease-out;pointer-events:none;}
  #caption{position:absolute;left:0;right:0;bottom:0;height:${captionH}px;
    background:#1A1A2E;color:#F5E6E0;font-family:Georgia,serif;font-size:${captionFontPx}px;
    display:flex;align-items:center;justify-content:center;text-align:center;padding:0 24px;
    box-sizing:border-box;opacity:0;transition:opacity 1.1s ease-out;}
  .zoomed #page{transform:translate(${geo.endTx}px, ${geo.endTy}px) scale(${geo.zoomScale});}
  .zoomed #highlight{opacity:1;}
  .zoomed #caption{opacity:1;}
</style></head>
<body>
  <div id="frame">
    <img id="page" src="${fileUrl}">
    <div id="highlight"></div>
    <div id="caption">${label}</div>
  </div>
</body></html>`;
}

async function captureOne({ clauseKey, formFactor, outputW, outputH, zoomMultiplier, maxZoomToAvoidTextClip }) {
  const clause = CLAUSES[clauseKey];
  if (!clause) throw new Error(`Unknown clause "${clauseKey}". Known: ${Object.keys(CLAUSES).join(', ')}`);

  fs.mkdirSync(TMP_DIR, { recursive: true });
  const pngBase = path.join(TMP_DIR, `${clauseKey}-p${clause.page}`);
  console.log(`[trec-capture] rendering page ${clause.page} of ${path.basename(clause.pdf)} @ ${RENDER_DPI}dpi`);
  run('pdftoppm', ['-png', '-r', String(RENDER_DPI), '-f', String(clause.page), '-l', String(clause.page), clause.pdf, pngBase]);
  const rendered = fs.readdirSync(TMP_DIR).find((f) => f.startsWith(path.basename(pngBase)) && f.endsWith('.png'));
  if (!rendered) throw new Error('pdftoppm did not produce a PNG');
  const imagePath = path.join(TMP_DIR, rendered);

  const pxPerPt = RENDER_DPI / 72;
  const nativeW = Math.round(PAGE_W_PT * pxPerPt);
  const nativeH = Math.round(PAGE_H_PT * pxPerPt);
  const bboxNativePx = clause.bboxPt.map((v) => v * pxPerPt);

  const geo = computeGeometry({
    outputW, outputH, nativeW, nativeH, bboxNativePx, zoomMultiplier, maxZoomToAvoidTextClip,
  });
  console.log(`[trec-capture] ${formFactor}: fitScale=${geo.fitScale.toFixed(4)} zoomScale=${geo.zoomScale.toFixed(4)}`);

  const html = buildHtml({ imagePath, nativeW, nativeH, outputW, outputH, geo, label: clause.label });
  const htmlPath = path.join(TMP_DIR, `${clauseKey}-${formFactor}.html`);
  fs.writeFileSync(htmlPath, html);

  const rawDir = path.join(TMP_DIR, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const sessionStart = Date.now();

  const browser = await chromium.launch({ headless: process.env.HEADFUL !== '1' });
  const context = await browser.newContext({
    viewport: { width: outputW, height: outputH },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: { width: outputW, height: outputH } },
  });
  const page = await context.newPage();
  try {
    await page.goto('file://' + htmlPath, { waitUntil: 'load' });
    await page.waitForTimeout(2600); // establishing shot — whole form visible
    await page.evaluate(() => document.getElementById('frame').classList.add('zoomed'));
    await page.waitForTimeout(4700); // slow zoom/pan settles (matches 4.5s CSS transition)
    await page.waitForTimeout(3200); // hold on the highlighted, labeled clause
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  const webms = fs.readdirSync(rawDir)
    .filter((f) => f.endsWith('.webm'))
    .map((f) => ({ full: path.join(rawDir, f), mtime: fs.statSync(path.join(rawDir, f)).mtimeMs }))
    .filter((r) => r.mtime >= sessionStart - 1000)
    .sort((a, b) => b.mtime - a.mtime);
  if (!webms.length) throw new Error('No new .webm found after recording.');
  const rawWebm = webms[0].full;

  const topicSlug = clauseKey.replace(/^para-/, 'trec-');
  const filename = `${topicSlug}-${formFactor}-${todayISO()}.mp4`;
  fs.mkdirSync(SCREEN_RECORDINGS_DIR, { recursive: true });
  const destPath = collisionSafePath(SCREEN_RECORDINGS_DIR, filename);

  const ffmpeg = findFfmpeg();
  const args = ['-y', '-i', rawWebm, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-an', destPath];
  console.log(`[trec-capture] ffmpeg ${args.join(' ')}`);
  const res = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg convert failed: ${res.stderr || res.stdout}`);

  console.log(`[trec-capture] DONE (${formFactor}): ${destPath}`);
  return destPath;
}

async function main() {
  const args = process.argv.slice(2);
  const clauseIdx = args.indexOf('--clause');
  const clauseArg = clauseIdx >= 0 ? args[clauseIdx + 1] : 'para-7i-groundwater';
  const clauseKeys = clauseArg === 'all' ? Object.keys(CLAUSES) : [clauseArg];
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null; // 'mobile' | 'desktop'

  const targets = [
    { formFactor: 'mobile', outputW: 1080, outputH: 1920, zoomMultiplier: 1.15, maxZoomToAvoidTextClip: 1.3 },
    { formFactor: 'desktop', outputW: 1920, outputH: 1080, zoomMultiplier: 2.44, maxZoomToAvoidTextClip: 3.0 },
  ].filter((t) => !only || t.formFactor === only);

  const outputs = [];
  for (const clauseKey of clauseKeys) {
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop
      const out = await captureOne({ clauseKey, ...target });
      outputs.push(out);
    }
  }
  console.log('\n[trec-capture] All done:');
  outputs.forEach((o) => console.log(`  ${o}`));
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[trec-capture] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, computeGeometry, CLAUSES };
