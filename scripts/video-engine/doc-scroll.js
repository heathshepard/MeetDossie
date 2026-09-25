#!/usr/bin/env node
/**
 * doc-scroll.js — scrolling-document background.
 *
 * PROVENANCE: this is a port of the hand-typed ffmpeg pipeline that produced
 * Downloads/dossie_water_60s_v4.mp4 on 2026-09-22/23. Every constant below
 * was measured off that working output, not invented. Before this module
 * existed the engine could not reproduce its own best video.
 *
 * WHAT IT DOES
 * Renders a PDF's pages to a tall vertical strip, then flies a 1080x1920
 * viewport down that strip and settles on a target paragraph — the visual
 * that makes "this clause is real, in the actual contract" land without
 * anybody reading a word of it (§3: information is not content; the scroll
 * is the *evidence gesture*, the captions carry the meaning).
 *
 * THE PIPELINE (proven values)
 *   1. pdftoppm -f <first> -l <last> -r 200 -png <pdf>   (200 DPI)
 *   2. vstack the pages -> a single strip. For TREC 20-19 pages 3-5 that is
 *      1700 x 6600.
 *   3. Viewport:  crop=1080:1920:110:<Y>  then  scale=1080:1920
 *      x=110 is the proven left inset: it trims the page margin so the body
 *      text fills the 1080 width instead of floating in white.
 *
 * THE EASING (proven)
 *   Fast-scroll-and-settle, cubic ease-out over `settleSec` (3.2 s default):
 *       Y = targetY * (1 - pow(1 - min(t/settleSec, 1), 3))
 *   For 20-19 ¶7.I on page 5 the target is y=4600.
 *
 *   Idle drift once settled — the page must not freeze dead, or the shot
 *   reads like a screenshot:
 *       Y = targetY + driftPx * sin(t / driftPeriod)      (35 px, /5)
 *
 *   Move-away/return between paragraphs uses smoothstep, NOT a linear ramp:
 *       p' = pow(p, 2) * (3 - 2*p)
 *   A linear move between two paragraphs reads like a scrollbar drag; the
 *   smoothstep reads like a hand.
 *
 * DURATION CONTRACT
 * `--dur` is exact. The clip is generated at the requested length and then
 * asserted with ffprobe, because a background that is 40 ms short of the
 * shot it backs shows as a one-frame black flash at the splice.
 *
 * Usage:
 *   node scripts/video-engine/doc-scroll.js --pdf scripts/trec-forms/20-19.pdf \
 *     --out bg.mp4 --dur 60.4 [--first 3] [--last 5] [--targetY 4600] \
 *     [--fps 25] [--settleSec 3.2] [--driftPx 35] [--driftPeriod 5] \
 *     [--dpi 200] [--vx 110] [--stops '[{"at":22.9,"y":2100,"moveSec":1.1}]'] \
 *     [--keepStrip strip.png]
 *
 * --stops lets the shot leave the settled paragraph and come back (each stop
 * is {at, y, moveSec, holdSec}); omit it for the single-target behaviour that
 * the 60 s cut used.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROVEN = {
  dpi: 200,
  vx: 110,          // left inset of the 1080-wide viewport into the strip
  targetY: 4600,    // ¶7.I of TREC 20-19 page 5, at 200 DPI, pages 3-5 stacked
  settleSec: 3.2,
  driftPx: 35,
  driftPeriod: 5,
  fps: 25,          // matches the 1.08x audio sync rule — see sync-guard.js
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

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts });
}

function probeDuration(file) {
  return parseFloat(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

function probeSize(file) {
  const s = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
  const [w, h] = s.split('x').map(Number);
  return { w, h };
}

/**
 * Stage scratch on the NATIVE Linux filesystem, never /mnt/c. The WSL/NTFS
 * boundary was measured as roughly half the cost of the frame-heavy passes
 * (see matte.js's header for the same finding). A PDF at 200 DPI is ~40 MB
 * of PNG; writing that across the 9p boundary twice is pure waste.
 */
function nativeTmp(tag) {
  const base = path.join(os.tmpdir(), `doc-scroll-${tag}-${process.pid}`);
  if (base.startsWith('/mnt/')) {
    throw new Error(`os.tmpdir() resolved to ${base}, which is on the Windows mount. Frame staging must be on the native Linux filesystem.`);
  }
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/**
 * buildStrip — pdftoppm the page range at `dpi` and vstack into one PNG.
 * Returns { strip, w, h }.
 */
function buildStrip({ pdf, first, last, dpi, workDir }) {
  if (!fs.existsSync(pdf)) throw new Error(`PDF not found: ${pdf}`);
  const prefix = path.join(workDir, 'p');
  run('pdftoppm', ['-f', String(first), '-l', String(last), '-r', String(dpi), '-png', pdf, prefix]);
  const pages = fs.readdirSync(workDir).filter(f => /^p-?\d+\.png$/.test(f)).sort();
  if (!pages.length) throw new Error(`pdftoppm produced no pages for ${pdf} ${first}-${last}`);
  const strip = path.join(workDir, 'strip.png');
  if (pages.length === 1) {
    fs.copyFileSync(path.join(workDir, pages[0]), strip);
  } else {
    const inputs = [];
    for (const p of pages) inputs.push('-i', path.join(workDir, p));
    run('ffmpeg', ['-y', ...inputs, '-filter_complex', `vstack=inputs=${pages.length}`, '-frames:v', '1', strip, '-hide_banner', '-loglevel', 'error']);
  }
  const meta = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', strip]).toString().trim();
  const [w, h] = meta.split('x').map(Number);
  return { strip, w, h, pages: pages.length };
}

/**
 * buildYExpr — the ffmpeg `crop` y expression.
 *
 * Phase 1 (0 .. settleSec): cubic ease-out from 0 to targetY.
 * Phase 2 (settleSec .. end): targetY + drift, interrupted by any `stops`.
 *
 * ffmpeg expressions have no local variables, so this composes as a nest of
 * `if(lt(t, ...), ...)` — verbose, but it is what the working render used and
 * it keeps the whole move in ONE filter with no intermediate re-encode.
 */
function buildYExpr({ targetY, settleSec, driftPx, driftPeriod, stops, maxY }) {
  const clamp = e => `max(0,min(${maxY},${e}))`;
  const settle = `${targetY}*(1-pow(1-min(t/${settleSec},1),3))`;
  const idle = `${targetY}+${driftPx}*sin(t/${driftPeriod})`;

  // Each stop: leave `from` for `y` over moveSec (smoothstep), hold holdSec,
  // then smoothstep back. Composed innermost-last so earlier stops win.
  let settled = idle;
  for (const s of (stops || []).slice().reverse()) {
    const at = +s.at, y = +s.y;
    const moveSec = s.moveSec != null ? +s.moveSec : 1.1;
    const holdSec = s.holdSec != null ? +s.holdSec : 2.0;
    const outEnd = at + moveSec;
    const holdEnd = outEnd + holdSec;
    const backEnd = holdEnd + moveSec;
    // smoothstep(p) = p^2 * (3 - 2p)
    const ssOut = `pow((t-${at})/${moveSec},2)*(3-2*((t-${at})/${moveSec}))`;
    const ssBack = `pow((t-${holdEnd})/${moveSec},2)*(3-2*((t-${holdEnd})/${moveSec}))`;
    const goingOut = `${targetY}+(${y}-${targetY})*(${ssOut})`;
    const holding = `${y}`;
    const comingBack = `${y}+(${targetY}-${y})*(${ssBack})`;
    settled = `if(lt(t,${at}),${settled},if(lt(t,${outEnd}),${goingOut},if(lt(t,${holdEnd}),${holding},if(lt(t,${backEnd}),${comingBack},${settled}))))`;
  }
  return clamp(`if(lt(t,${settleSec}),${settle},${settled})`);
}

/**
 * renderScroll — the callable entry point. Produces an mp4 of EXACTLY `dur`
 * seconds at `fps`, 1080x1920.
 */
function renderScroll(opts) {
  const {
    pdf, out, dur,
    first = 3, last = 5,
    dpi = PROVEN.dpi, vx = PROVEN.vx,
    targetY = PROVEN.targetY,
    settleSec = PROVEN.settleSec,
    driftPx = PROVEN.driftPx,
    driftPeriod = PROVEN.driftPeriod,
    fps = PROVEN.fps,
    stops = null,
    keepStrip = null,
    strip: providedStrip = null,
  } = opts;

  if (!out) throw new Error('renderScroll needs --out');
  if (!(dur > 0)) throw new Error('renderScroll needs a positive --dur');

  const workDir = nativeTmp('strip');
  let stripInfo;
  try {
    if (providedStrip && fs.existsSync(providedStrip)) {
      const { w, h } = probeSize(providedStrip);
      stripInfo = { strip: providedStrip, w, h, pages: null };
    } else {
      stripInfo = buildStrip({ pdf, first, last, dpi, workDir });
    }
    const { strip, w, h } = stripInfo;
    // The viewport is 1080x1920 cut out of the strip at x=vx. If the strip is
    // narrower than 1080+vx the crop silently clamps and the page drifts
    // off-centre, so say so instead.
    if (w < 1080 + vx) {
      throw new Error(`strip is ${w}px wide; a 1080 viewport at x=${vx} needs ${1080 + vx}px. Raise --dpi or lower --vx.`);
    }
    const maxY = Math.max(0, h - 1920);
    if (targetY > maxY) {
      throw new Error(`--targetY ${targetY} exceeds the strip's scrollable height ${maxY} (strip ${w}x${h}). Check --first/--last/--dpi.`);
    }

    const yExpr = buildYExpr({ targetY, settleSec, driftPx, driftPeriod, stops, maxY });
    const vf = `crop=1080:1920:${vx}:'${yExpr}',scale=1080:1920,format=yuv420p`;

    run('ffmpeg', [
      '-y', '-loop', '1', '-framerate', String(fps), '-t', String(dur), '-i', strip,
      '-vf', vf,
      '-frames:v', String(Math.round(dur * fps)),
      '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-r', String(fps), '-vsync', 'cfr',
      out, '-hide_banner', '-loglevel', 'error',
    ]);

    if (keepStrip) fs.copyFileSync(strip, keepStrip);

    // Duration contract — a background short of its shot is a black flash.
    const actual = probeDuration(out);
    const driftMs = Math.abs(actual - dur) * 1000;
    if (driftMs > 60) {
      throw new Error(`doc-scroll produced ${actual.toFixed(3)}s for a requested ${dur}s (${driftMs.toFixed(0)}ms off). Refusing to hand back a background that won't cover its shot.`);
    }
    return { out, dur: actual, strip: keepStrip || null, stripSize: `${w}x${h}`, targetY, fps, frames: Math.round(dur * fps) };
  } finally {
    if (!providedStrip) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf && !args.strip) { console.error('Usage: doc-scroll.js --pdf <pdf> --out <mp4> --dur <sec> [--first 3] [--last 5] [--targetY 4600] [--fps 25] [--stops <json>]'); process.exit(1); }
  const res = renderScroll({
    pdf: args.pdf,
    strip: args.strip || null,
    out: args.out,
    dur: +args.dur,
    first: args.first != null ? +args.first : 3,
    last: args.last != null ? +args.last : 5,
    dpi: args.dpi != null ? +args.dpi : PROVEN.dpi,
    vx: args.vx != null ? +args.vx : PROVEN.vx,
    targetY: args.targetY != null ? +args.targetY : PROVEN.targetY,
    settleSec: args.settleSec != null ? +args.settleSec : PROVEN.settleSec,
    driftPx: args.driftPx != null ? +args.driftPx : PROVEN.driftPx,
    driftPeriod: args.driftPeriod != null ? +args.driftPeriod : PROVEN.driftPeriod,
    fps: args.fps != null ? +args.fps : PROVEN.fps,
    stops: args.stops && args.stops !== true ? JSON.parse(args.stops) : null,
    keepStrip: args.keepStrip && args.keepStrip !== true ? args.keepStrip : null,
  });
  console.log(JSON.stringify(res, null, 2));
}

module.exports = { renderScroll, buildStrip, buildYExpr, nativeTmp, PROVEN };
if (require.main === module) main();
