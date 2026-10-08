#!/usr/bin/env node
/**
 * generate-video-cover.js — render a scroll-stopping 1080x1920 cover for a
 * finished video, designed for the size it is ACTUALLY seen at.
 *
 * WHY THIS EXISTS (2026-10-02)
 * ---------------------------------------------------------------------------
 * Heath's Instagram grid was a page of identical grey tiles. Two separate
 * faults produced that:
 *
 *   1. scripts/queue-finished-videos.py extracted frame 0 of the mp4 as the
 *      "cover". On a document explainer, frame 0 is a full page of TREC body
 *      text. Fixed in that file (resolve_cover()).
 *   2. api/cron-post-videos.js never sent any cover to Zernio at all, so every
 *      platform derived its own thumbnail from the video. Fixed there.
 *
 * This file is the third part: actually making a cover worth sending.
 *
 * THE ONE MEASUREMENT THAT DRIVES THE WHOLE LAYOUT
 * ---------------------------------------------------------------------------
 * The Instagram profile grid crop is a TRUE 1:1 SQUARE keeping y=418..1498 of
 * the 1080x1920 cover. Heath measured that off a live reel on 2026-10-02.
 * docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §1.2 says 1080x1350 — that figure is
 * WRONG and this constant supersedes it.
 *
 * Everything that matters must live inside that square, because that square is
 * all a grid browser ever sees. And it is rendered at roughly 150 CSS px on a
 * phone, so the real design test is: does it read at 150px? That is a ~7.2x
 * downscale. A 150px-tall element on the canvas becomes 21px on screen. Body
 * text is hopeless; only a face and a few huge words survive.
 *
 * Hence the rules this renderer enforces:
 *   - His head fills ~60% of the square's height (~93px on a phone).
 *   - 3-5 words maximum, set enormous, on a solid high-contrast band.
 *   - NO document/contract imagery anywhere. That is what made every tile
 *     identical grey noise.
 *   - Accent colour rotates per video so adjacent tiles never twin.
 *
 * USAGE
 *   node scripts/generate-video-cover.js --spec covers/my-video.json
 *   node scripts/generate-video-cover.js \
 *      --id dossie-trec-5b-termination-weekend-2026-10-01 \
 *      --video Media/finished-videos/foo.mp4 --face-ts 11.2 \
 *      --face-rect 600:480:1180:640 \
 *      --hook "IT WAS DUE SATURDAY" --kicker "TEXAS AGENTS" \
 *      --accent gold --out Media/finished-videos/foo.cover.png
 *
 * --face-rect is x:w:y:h in the SOURCE video's 1080x1920 frame, naming the
 * head-and-shoulders box. It is explicit rather than auto-detected because the
 * RFB-320 ONNX model that scripts/video-engine/face-detect-lib.js wants is not
 * installed on this machine (no scripts/video-engine/models/, no node_modules
 * there). Explicit beats a silent bad crop; wire the detector in later and
 * have it fill this field.
 *
 * Writes {out} and, next to it, {out stem}_square.png — the exact grid crop,
 * so a human (or a reviewer agent) can check the only framing that matters
 * without having to re-derive it.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANVAS_W = 1080;
const CANVAS_H = 1920;

// Heath's live-reel measurement, 2026-10-02. See header.
const GRID_SAFE_TOP = 418;
const GRID_SAFE_H = 1080;
const GRID_SAFE_BOTTOM = GRID_SAFE_TOP + GRID_SAFE_H; // 1498

// Brand tokens — CLAUDE.md §4.
const NAVY = '#1A1A2E';
const ACCENTS = {
  gold: { bg: '#C9A96E', ink: '#1A1A2E' },
  coral: { bg: '#E8836B', ink: '#1A1A2E' },
  blush: { bg: '#F5E6E0', ink: '#1A1A2E' },
  sage: { bg: '#8BA888', ink: '#1A1A2E' },
};
const ACCENT_ORDER = ['gold', 'coral', 'sage', 'blush'];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

/**
 * Deterministic accent choice from the video id, so a grid of videos
 * alternates colour without anyone maintaining a counter. Same id always
 * yields the same colour (re-running the generator never reshuffles a grid).
 */
function accentForId(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ACCENT_ORDER[h % ACCENT_ORDER.length];
}

/** Pull the face plate out of the video with ffmpeg. Returns a PNG path. */
function extractFacePlate(videoPath, ts, rect, tmpDir) {
  const [x, w, y, h] = String(rect).split(':').map(Number);
  if ([x, w, y, h].some((n) => !Number.isFinite(n))) {
    throw new Error(`--face-rect must be x:w:y:h, got "${rect}"`);
  }
  const outPath = path.join(tmpDir, 'face.png');
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-ss', String(ts),
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `crop=${w}:${h}:${x}:${y}`,
    outPath,
  ]);
  return { outPath, w, h };
}

function imgDims(p) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', p,
  ]).toString().trim();
  const [w, h] = out.split(',').map(Number);
  return { w, h };
}

/**
 * The page. Layout maths, all in canvas px:
 *
 *   y 0 .........418 ................................ 1498 ........ 1920
 *            |<------------ GRID-SAFE SQUARE ---------->|
 *            |   kicker (small, optional)               |
 *            |   FACE — head ~60% of square height      |
 *            |   HOOK BAND — 3-5 words, enormous        |
 *
 * Above 418 and below 1498 is bleed: the face and background continue there so
 * the full 9:16 cover still looks composed in the Reels tab, but nothing
 * load-bearing lives there.
 */
function buildHtml({ faceDataUri, faceW, faceH, headBox, hook, kicker, accent, opts = {} }) {
  const acc = ACCENTS[accent] || ACCENTS.gold;

  // Hook band sits at the bottom of the safe square.
  const BAND_H = 330;
  const BAND_BOTTOM_MARGIN = 26;
  const bandTop = GRID_SAFE_BOTTOM - BAND_BOTTOM_MARGIN - BAND_H;

  // Scale the face plate so his HEAD is a target height, then position it so
  // the head sits in the upper part of the safe square. headBox is the head's
  // box within the face plate, in face-plate px.
  const TARGET_HEAD_H = 640;           // ~59% of the 1080 square -> ~89px @150
  const scale = TARGET_HEAD_H / headBox.h;
  const scaledW = faceW * scale;
  const scaledH = faceH * scale;

  // Put the top of his head a little below the top of the safe square.
  const HEAD_TOP_ON_CANVAS = GRID_SAFE_TOP + 52;
  const imgTop = HEAD_TOP_ON_CANVAS - headBox.y * scale;
  // Centre his head horizontally on the canvas.
  const headCentreInPlate = (headBox.x + headBox.w / 2) * scale;
  const imgLeft = CANVAS_W / 2 - headCentreInPlate;

  // Long hooks step down a size so they never overflow the band.
  const words = hook.trim().split(/\s+/);
  const charCount = hook.replace(/\s/g, '').length;
  let fontSize = 150;
  if (charCount > 14) fontSize = 132;
  if (charCount > 18) fontSize = 118;
  if (charCount > 23) fontSize = 104;

  // The tight ellipse.
  // Radii are a FRACTION of the head box, not a multiple. The source plate is
  // a talking head composited over a contract page, so the page sits directly
  // left and right of his head inside the plate. Any ellipse wide enough to
  // "comfortably" contain the head also contains columns of body text — which
  // is the bug this cover exists to fix. 0.62 keeps his face and hair fully
  // opaque while the page edges land out in the feather and vanish.
  // Override with --mask rx:ry:cyFrac when a plate is framed differently.
  const maskOverride = opts.mask ? String(opts.mask).split(':').map(Number) : null;
  const rx = maskOverride ? maskOverride[0] : headBox.w * scale * 0.62;
  const ry = maskOverride ? maskOverride[1] : headBox.h * scale * 0.95;
  const cx = headCentreInPlate;
  const cyFrac = maskOverride ? maskOverride[2] : 0.62;
  const cy = (headBox.y + headBox.h * cyFrac) * scale;
  // A LONG, LATE feather. The earlier version faded out gradually from 60%,
  // which left a bright ring of blurred contract page glowing around his head
  // — at 150px that halo read as a smudge and undid the point of the cover.
  // Holding full opacity to 72% and then falling off fast keeps his hair and
  // jaw intact while the page edge never gets a chance to show.
  const ellipseMask = `radial-gradient(ellipse ${rx.toFixed(0)}px ${ry.toFixed(0)}px at ${cx.toFixed(0)}px ${cy.toFixed(0)}px, #000 0%, #000 72%, rgba(0,0,0,.45) 86%, rgba(0,0,0,0) 97%)`;

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
  @font-face { font-family: 'Anton'; src: local('Anton'); }
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${CANVAS_W}px; height:${CANVAS_H}px; }
  body {
    position:relative; overflow:hidden; background:${NAVY};
    -webkit-font-smoothing:antialiased;
  }

  /* Face plate.
     The MASK is the important part, not decoration. The source frame is a
     talking head composited over a TREC contract page, so a plain rectangular
     crop drags columns of body text in behind him — which is the exact thing
     that made every tile identical grey noise. Feathering the plate to nothing
     on an ellipse around his head removes the document entirely and leaves him
     on flat navy, so the tile reads as A FACE at 150px instead of as a page. */
  /* Layer 1 — the same frame, blown up and blurred to oblivion. This is what
     occupies the space around him. Blurring is what DESTROYS the contract
     text: at 56px blur the page stops being glyphs and becomes a soft dark
     field, so nothing in the tile competes with his face or the hook. */
  .face-bg {
    position:absolute; left:-12%; top:-12%; width:124%; height:124%;
    object-fit:cover;
    filter: blur(64px) brightness(.20) saturate(.45);
    transform: scale(1.15);
  }

  /* Layer 2 — him, sharp, masked to a TIGHT ellipse round his head and
     shoulders. Tight is the whole point: a generous ellipse just lets the
     document back in, which is the bug this cover exists to fix. */
  .face {
    position:absolute;
    left:${imgLeft.toFixed(1)}px; top:${imgTop.toFixed(1)}px;
    width:${scaledW.toFixed(1)}px; height:${scaledH.toFixed(1)}px;
    object-fit:cover;
    filter: saturate(1.08) contrast(1.06);
    -webkit-mask-image: ${ellipseMask};
            mask-image: ${ellipseMask};
  }

  /* Layer 3 — the halo killer, sitting ON TOP of the sharp plate and sharing
     its exact geometry and ellipse.

     Masking alone was not enough. However tight the ellipse, the feather zone
     still shows whatever the plate has there, and on a document explainer that
     is a brightly lit contract page right beside his head. It came through as
     a pale smudge that, at 150px, was the most eye-catching thing in the tile.
     Painting navy over the same feather zone removes it for ANY frame, instead
     of needing the ellipse hand-tuned per video until the leak happens to
     disappear. Transparent across his face, solid navy by the time it reaches
     the plate edge.

     It spans the WHOLE CANVAS, not just the plate's rectangle. Scoped to the
     plate it left a visible vertical seam down each side of the cut-out, where
     shaded plate met unshaded blurred backdrop. Covering everything and
     placing the ellipse in canvas coordinates makes the transition continuous.
  */
  .plate-shade {
    position:absolute; inset:0;
    background: radial-gradient(
      ellipse ${(rx * 1.02).toFixed(0)}px ${(ry * 1.02).toFixed(0)}px at ${(imgLeft + cx).toFixed(0)}px ${(imgTop + cy).toFixed(0)}px,
      rgba(26,26,46,0) 0%, rgba(26,26,46,0) 58%, rgba(26,26,46,.88) 82%, ${NAVY} 96%);
  }

  /* A soft navy-to-slightly-lifted pool behind him so he is not floating on
     dead flat colour — depth without introducing any readable detail. */
  .pool {
    position:absolute; inset:0;
    background: radial-gradient(60% 34% at 50% ${(GRID_SAFE_TOP + 390)}px,
      rgba(96,104,150,.30) 0%, rgba(42,44,74,.16) 52%, rgba(26,26,46,0) 78%);
  }

  /* Floor under the hook band so his torso fades out rather than being
     chopped by a hard edge. */
  .floor {
    position:absolute; left:0; right:0;
    top:${(bandTop - 190).toFixed(0)}px; height:200px;
    background:linear-gradient(to bottom, rgba(26,26,46,0), ${NAVY} 88%);
  }
  .below {
    position:absolute; left:0; right:0; top:${bandTop}px; bottom:0;
    background:${NAVY};
  }

  .kicker {
    position:absolute; left:0; right:0;
    top:${(GRID_SAFE_TOP - 94).toFixed(0)}px;
    text-align:center;
    font-family:'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif;
    font-weight:900; font-size:52px; letter-spacing:.14em;
    color:${acc.bg}; text-transform:uppercase;
  }

  .band {
    position:absolute; left:46px; right:46px;
    top:${bandTop}px; height:${BAND_H}px;
    background:${acc.bg};
    display:flex; align-items:center; justify-content:center;
    padding:0 40px;
  }
  .hook {
    font-family:'Arial Black','Helvetica Neue',Helvetica,Arial,sans-serif;
    font-weight:900;
    font-size:${fontSize}px; line-height:.96;
    letter-spacing:-.02em;
    color:${acc.ink}; text-transform:uppercase; text-align:center;
    text-wrap:balance;
  }
</style></head>
<body>
  <img class="face-bg" src="${faceDataUri}" alt="">
  <div class="pool"></div>
  <img class="face" src="${faceDataUri}" alt="">
  <div class="plate-shade"></div>
  <div class="floor"></div>
  <div class="below"></div>
  ${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}
  <div class="band"><div class="hook">${esc(hook)}</div></div>
</body></html>`;
}

async function main() {
  const args = parseArgs(process.argv);

  let spec = {};
  if (args.spec) {
    spec = JSON.parse(fs.readFileSync(args.spec, 'utf8'));
  }
  const get = (k, d) => (args[k] !== undefined ? args[k] : (spec[k] !== undefined ? spec[k] : d));

  const id = get('id');
  const hook = get('hook');
  const out = get('out');
  if (!id || !hook || !out) {
    console.error('need --id, --hook and --out (or a --spec containing them)');
    process.exit(2);
  }

  const kicker = get('kicker', '');
  const accent = get('accent') || accentForId(id);
  if (!ACCENTS[accent]) {
    console.error(`unknown --accent "${accent}" (have: ${Object.keys(ACCENTS).join(', ')})`);
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-'));
  let facePath;
  let plate;

  if (get('face-image')) {
    facePath = get('face-image');
    plate = imgDims(facePath);
  } else {
    const video = get('video');
    const faceTs = get('face-ts');
    const faceRect = get('face-rect');
    if (!video || faceTs === undefined || !faceRect) {
      console.error('need --face-image, or all of --video --face-ts --face-rect');
      process.exit(2);
    }
    const r = extractFacePlate(video, faceTs, faceRect, tmpDir);
    facePath = r.outPath;
    plate = { w: r.w, h: r.h };
  }

  // headBox: the head's box WITHIN the face plate, as x:w:y:h. Defaults to a
  // centred box covering the upper half, which is right for a head-and-
  // shoulders crop and obviously wrong for anything else — so pass it.
  const headRaw = get('head-box');
  let headBox;
  if (headRaw) {
    const [hx, hw, hy, hh] = String(headRaw).split(':').map(Number);
    headBox = { x: hx, w: hw, y: hy, h: hh };
  } else {
    headBox = { x: plate.w * 0.22, w: plate.w * 0.56, y: plate.h * 0.04, h: plate.h * 0.52 };
  }

  const faceDataUri = `data:image/png;base64,${fs.readFileSync(facePath).toString('base64')}`;
  const html = buildHtml({
    faceDataUri, faceW: plate.w, faceH: plate.h, headBox, hook, kicker, accent,
    opts: { mask: get("mask") },
  });

  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: CANVAS_W, height: CANVAS_H },
    deviceScaleFactor: 1,
  });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  await page.screenshot({ path: out, type: 'png' });
  await browser.close();

  // The grid crop, written next to the cover. This is the ONLY framing a
  // profile-grid browser ever sees, so make it trivially inspectable rather
  // than something each reviewer has to re-derive.
  const squareOut = out.replace(/\.png$/i, '') + '_square.png';
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', out,
    '-vf', `crop=${CANVAS_W}:${GRID_SAFE_H}:0:${GRID_SAFE_TOP}`,
    squareOut,
  ]);

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`cover  : ${out}`);
  console.log(`square : ${squareOut}  (grid crop y=${GRID_SAFE_TOP}..${GRID_SAFE_BOTTOM})`);
  console.log(`accent : ${accent}${args.accent || spec.accent ? '' : ' (derived from id)'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
