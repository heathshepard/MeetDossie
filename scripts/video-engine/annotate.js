#!/usr/bin/env node
/**
 * annotate.js — hand-drawn annotation draw-on (the red circle).
 *
 * PROVENANCE: ported from the hand-built pipeline behind
 * Downloads/dossie_water_60s_v4.mp4 (scratchpad scroll/circle.html +
 * scroll/shotcirc.js). Constants below are the measured working values.
 *
 * WHY AN SVG DASH ANIMATION AND NOT A DRAWBOX
 * §4 wants edits that read as intentional, and §3 wants the visual to carry
 * meaning on its own. A rectangle appearing instantly reads as software. An
 * ellipse that DRAWS ITSELF, slightly off-axis, in marker red, reads as a
 * person pointing at the clause. That is the whole effect, and it is why the
 * rotation is -1.5 deg and the cap is round: a perfectly level, flat-capped
 * ellipse looks machine-made.
 *
 * MECHANISM
 * `stroke-dasharray` is set to the ellipse's perimeter and `stroke-dashoffset`
 * is animated perimeter -> 0, so the stroke is revealed rather than faded in.
 * Frames are screenshotted through Playwright with `omitBackground: true`, so
 * each PNG is transparent outside the stroke and can be overlaid directly.
 *
 * PROVEN VALUES
 *   stroke #E8433C, width 13, linecap round, rotate(-1.5 cx cy)
 *   frames 21, ease-out  1 - (1-p)^2
 *   for TREC 20-19 para 7.I(2) at the settled scroll position:
 *     cx=530 cy=1330 rx=495 ry=265, dasharray 2450
 * The paragraph geometry is a PARAMETER, not a constant — 7.I(2) is just the
 * first clause we ever circled.
 *
 * Usage (frames):
 *   node scripts/video-engine/annotate.js --outDir circ/ \
 *     [--cx 530] [--cy 1330] [--rx 495] [--ry 265] [--frames 21] \
 *     [--stroke '#E8433C'] [--strokeWidth 13] [--rotate -1.5] [--dasharray auto]
 *
 * Usage (overlay filter for an existing clip):
 *   node scripts/video-engine/annotate.js --in bg.mp4 --out bg_circled.mp4 \
 *     --at 12.4 --holdSec 6.0 --cx 530 --cy 1330 --rx 495 --ry 265 --fps 25
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROVEN = {
  stroke: '#E8433C',
  strokeWidth: 13,
  rotate: -1.5,
  frames: 21,
  // TREC 20-19 para 7.I(2) at the doc-scroll settle position (targetY 4600).
  cx: 530, cy: 1330, rx: 495, ry: 265, dasharray: 2450,
  drawSec: 0.84,   // 21 frames at 25fps
  fps: 25,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

/**
 * Ramanujan's approximation of an ellipse perimeter. The hand-built version
 * used a hardcoded 2450 for rx=495 ry=265; this reproduces it to <1% and
 * generalises. A dasharray SHORTER than the true perimeter leaves the circle
 * visibly unclosed, so we round UP.
 */
function ellipsePerimeter(rx, ry) {
  const h = Math.pow(rx - ry, 2) / Math.pow(rx + ry, 2);
  return Math.PI * (rx + ry) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

function buildHtml({ cx, cy, rx, ry, stroke, strokeWidth, rotate, dasharray, W, H }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0}html,body{width:${W}px;height:${H}px;background:transparent}
svg{position:absolute;inset:0}
</style></head><body>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
 <ellipse id="e" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"
   fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round"
   transform="rotate(${rotate} ${cx} ${cy})"
   stroke-dasharray="${dasharray}" stroke-dashoffset="${dasharray}"/>
</svg>
<script>
 const P = new URLSearchParams(location.search);
 const t = parseFloat(P.get('p') || '0');
 document.getElementById('e').setAttribute('stroke-dashoffset', String(${dasharray} * (1 - t)));
</script>
</body></html>`;
}

/**
 * renderFrames — writes N transparent PNGs c000..cNNN into outDir.
 * Returns { outDir, frames, htmlPath, dasharray }.
 */
async function renderFrames(opts) {
  const {
    outDir,
    cx = PROVEN.cx, cy = PROVEN.cy, rx = PROVEN.rx, ry = PROVEN.ry,
    stroke = PROVEN.stroke, strokeWidth = PROVEN.strokeWidth, rotate = PROVEN.rotate,
    frames = PROVEN.frames, W = 1080, H = 1920,
    dasharray = null,
  } = opts;

  const dash = dasharray != null ? dasharray : Math.ceil(ellipsePerimeter(rx, ry));
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, '_annot.html');
  fs.writeFileSync(htmlPath, buildHtml({ cx, cy, rx, ry, stroke, strokeWidth, rotate, dasharray: dash, W, H }));

  const { chromium } = require('playwright');
  const b = await chromium.launch();
  try {
    const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    // The hand-built version did a full `goto` per frame (21 page loads, ~90 s).
    // One load plus a direct attribute write produces byte-identical frames in
    // a fraction of the time — the query-string plumbing in the HTML is kept
    // so the page is still openable by hand for tuning the geometry.
    await p.goto(`file://${htmlPath}`, { waitUntil: 'load' });
    for (let i = 0; i < frames; i++) {
      const prog = frames === 1 ? 1 : Math.min(1, i / (frames - 1));
      const eased = 1 - Math.pow(1 - prog, 2);   // ease-out (proven)
      await p.evaluate(([d, t]) => {
        document.getElementById('e').setAttribute('stroke-dashoffset', String(d * (1 - t)));
      }, [dash, eased]);
      await p.screenshot({ path: path.join(outDir, `c${String(i).padStart(3, '0')}.png`), omitBackground: true });
    }
  } finally { await b.close(); }
  return { outDir, frames, htmlPath, dasharray: dash };
}

/**
 * overlayOnClip — draw the annotation onto an existing clip at `at` seconds
 * and hold the finished ellipse for `holdSec`.
 *
 * The draw is a PNG sequence overlaid from `at`; the final frame is then held
 * as a still, so the circle stays on the clause while the caption explains it
 * rather than blinking away the moment it finishes drawing.
 */
async function overlayOnClip(opts) {
  const {
    input, out, at, holdSec = 4.0, fps = PROVEN.fps,
    frames = PROVEN.frames, keepFramesDir = null,
    ...geom
  } = opts;
  if (!input || !fs.existsSync(input)) throw new Error(`annotate: input clip not found: ${input}`);
  const { nativeTmp } = require('./doc-scroll.js');
  const dir = keepFramesDir || nativeTmp('annot');
  const info = await renderFrames({ outDir: dir, frames, ...geom });

  const drawSec = frames / fps;
  const endT = at + drawSec + holdSec;

  // ONE overlay input, built with tpad — do NOT do this with a PTS shift.
  // The first port of this used
  //     [1:v]setpts=PTS-STARTPTS+<at>/TB
  // plus a second `-loop 1` still for the hold. `overlay` then has no
  // secondary frame available for main-input times before <at>, and with an
  // infinite -loop input on the other pad the graph stalls instead of
  // erroring — it hung twice for 5+ minutes with all 21 PNGs already on disk.
  //
  // tpad avoids the whole problem: pad the FRONT with transparent frames up
  // to `at`, then clone the final drawn frame for `holdSec`, giving one
  // continuous RGBA stream that starts at t=0 like the main input does.
  //
  // MUST be ONE tpad with both start_* and stop_* options. Written as two
  // CHAINED tpad filters the stop pad silently does nothing — measured: the
  // ellipse drew 3.40->4.24 s and then vanished (red-pixel count 30095 -> 0
  // at t=4.3) while ffmpeg reported success. With both options on a single
  // tpad the hold is there (30172 px at 4.3, still 30196 at 5.0).
  const fc =
    `[1:v]format=rgba,` +
    `tpad=start_duration=${at}:start_mode=add:color=#00000000` +
    `:stop_duration=${holdSec}:stop_mode=clone[ov];` +
    `[0:v][ov]overlay=0:0:eof_action=pass[v]`;

  execFileSync('ffmpeg', [
    '-y',
    '-i', input,
    '-framerate', String(fps), '-start_number', '0', '-i', path.join(dir, 'c%03d.png'),
    '-filter_complex', fc,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-c:a', 'copy',
    out, '-hide_banner', '-loglevel', 'error',
  ], { maxBuffer: 1 << 28, timeout: 10 * 60 * 1000 });
  void endT;

  if (!keepFramesDir) fs.rmSync(dir, { recursive: true, force: true });
  return { out, at, drawSec, holdSec, dasharray: info.dasharray };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const geom = {
    cx: args.cx != null ? +args.cx : PROVEN.cx,
    cy: args.cy != null ? +args.cy : PROVEN.cy,
    rx: args.rx != null ? +args.rx : PROVEN.rx,
    ry: args.ry != null ? +args.ry : PROVEN.ry,
    stroke: args.stroke && args.stroke !== true ? args.stroke : PROVEN.stroke,
    strokeWidth: args.strokeWidth != null ? +args.strokeWidth : PROVEN.strokeWidth,
    rotate: args.rotate != null ? +args.rotate : PROVEN.rotate,
    dasharray: (args.dasharray && args.dasharray !== 'auto') ? +args.dasharray : null,
  };
  const frames = args.frames != null ? +args.frames : PROVEN.frames;

  if (args.in) {
    const res = await overlayOnClip({
      input: args.in, out: args.out, at: +args.at, holdSec: args.holdSec != null ? +args.holdSec : 4.0,
      fps: args.fps != null ? +args.fps : PROVEN.fps, frames, ...geom,
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (args.outDir) {
    const res = await renderFrames({ outDir: args.outDir, frames, ...geom });
    console.log(JSON.stringify(res, null, 2));
  } else {
    console.error('Usage: annotate.js --outDir <dir> | --in <clip> --out <clip> --at <sec> [--cx --cy --rx --ry ...]');
    process.exit(1);
  }
}

module.exports = { renderFrames, overlayOnClip, ellipsePerimeter, PROVEN };
if (require.main === module) main().catch(e => { console.error('ERR', e.message); process.exit(1); });
