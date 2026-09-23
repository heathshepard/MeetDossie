#!/usr/bin/env node
/**
 * doc-snip.js — the "document snip" evidence card.
 *
 * PROVENANCE: ported from the hand-built pipeline behind
 * Downloads/dossie_water_60s_v4.mp4 (2026-09-22/23). Values below are
 * measured from that output.
 *
 * ===================================================================
 * KNOWN LIMITATION — READ THIS BEFORE "FIXING" THE TYPE SIZE
 * ===================================================================
 * At full TREC contract line width, a paragraph cropped from the page and
 * scaled to fit 1030 px lands at roughly **13 px of cap height** on a
 * 1080-wide frame. On a phone that is not readable, and no amount of
 * scaling fixes it without cropping away the line ends that make it look
 * like a real contract.
 *
 * That is not a bug. **This card is PROOF that the clause exists — it is not
 * something the viewer reads.** It is the shot of the document, the way a
 * news package shows the filing. The WORDS are carried by the captions,
 * which are 82 px. §3 of the Creative Director Standard: information is not
 * content; the card supplies credibility, the captions supply meaning.
 *
 * If you want the words legible on their own, that is a different element —
 * a typeset quote card (see scratchpad plate/quote.html) with the clause
 * re-set at 45 px. Do not try to turn this module into that one; a
 * re-typeset quote is no longer evidence that the contract says it.
 * ===================================================================
 *
 * THE PIPELINE (proven values)
 *   1. pdftoppm -r 300  (300 DPI — the snip is a still, it can afford the
 *      resolution the 200-DPI scroll strip cannot)
 *   2. crop the paragraph. Working value for TREC 20-19 p5 para 7.I(2):
 *        crop=2280:262:158:2082
 *   3. scale=1030:-2
 *   4. highlight band over the operative phrase:
 *        drawbox=x=8:y=62:w=1014:h=30:color=#FFE9A8@0.55:t=fill
 *   5. pad=1070:ih+44:20:22:white          (the white paper margin)
 *   6. border: drawbox=0:0:1070:ih:color=#E8A33D:t=6
 *
 * COMPOSITING
 * The card lands at y=326 and the background is dimmed
 * `eq=brightness=-0.30:contrast=0.95` for exactly the display window. The dim
 * is what makes the card read as "the camera pushed in on the page" instead
 * of "a PNG appeared"; without it the white card and the white contract
 * behind it merge into one bright slab.
 *
 * Usage (card only):
 *   node scripts/video-engine/doc-snip.js --pdf scripts/trec-forms/20-19.pdf \
 *     --page 5 --out snip.png --crop 2280:262:158:2082 \
 *     [--hl 8:62:1014:30] [--noHl] [--width 1030]
 *
 * Usage (composite onto a clip):
 *   node scripts/video-engine/doc-snip.js --pdf ... --page 5 --crop ... \
 *     --in bg.mp4 --out bg_snip.mp4 --at 30.2 --holdSec 5.0 [--y 326] [--fps 25]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROVEN = {
  dpi: 300,
  width: 1030,
  crop: '2280:262:158:2082',          // TREC 20-19 p5, para 7.I(2)
  hl: '8:62:1014:30',                 // "at any time prior to the closing"
  hlColor: '#FFE9A8@0.55',
  padW: 1070, padX: 20, padY: 22,
  borderColor: '#E8A33D', borderT: 6,
  y: 326,
  dim: 'eq=brightness=-0.30:contrast=0.95',
  fps: 25,
  /** measured cap height of contract body type at these settings, in px */
  measuredTypeHeightPx: 13,
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

function run(cmd, args) {
  return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
}

function probeSize(file) {
  const s = run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]).toString().trim();
  const [w, h] = s.split('x').map(Number);
  return { w, h };
}

/**
 * buildCard — render the page, crop the paragraph, highlight, pad, border.
 * Returns { out, w, h, typeHeightPx } — typeHeightPx is an ESTIMATE of the
 * resulting body-type cap height, surfaced so callers can see the limitation
 * in numbers rather than rediscovering it on a phone.
 */
function buildCard(opts) {
  const {
    pdf, page, out,
    crop = PROVEN.crop,
    hl = PROVEN.hl,
    noHl = false,
    width = PROVEN.width,
    dpi = PROVEN.dpi,
    hlColor = PROVEN.hlColor,
    padW = PROVEN.padW, padX = PROVEN.padX, padY = PROVEN.padY,
    borderColor = PROVEN.borderColor, borderT = PROVEN.borderT,
  } = opts;

  if (!fs.existsSync(pdf)) throw new Error(`doc-snip: PDF not found: ${pdf}`);
  const { nativeTmp } = require('./doc-scroll.js');
  const work = nativeTmp('snip');
  try {
    const prefix = path.join(work, 'pg');
    run('pdftoppm', ['-f', String(page), '-l', String(page), '-r', String(dpi), '-png', pdf, prefix]);
    const rendered = fs.readdirSync(work).filter(f => /\.png$/.test(f)).sort();
    if (!rendered.length) throw new Error(`pdftoppm produced nothing for page ${page}`);
    const pagePng = path.join(work, rendered[0]);

    const [cw, ch, cx, cy] = String(crop).split(':').map(Number);
    const { w: pw, h: ph } = probeSize(pagePng);
    if (cx + cw > pw || cy + ch > ph) {
      throw new Error(`crop ${crop} falls outside the ${pw}x${ph} page render at ${dpi} DPI. Re-derive the crop at this DPI.`);
    }

    const steps = [`crop=${cw}:${ch}:${cx}:${cy}`, `scale=${width}:-2`];
    if (!noHl && hl) {
      const [hx, hy, hw, hh] = String(hl).split(':').map(Number);
      steps.push(`drawbox=x=${hx}:y=${hy}:w=${hw}:h=${hh}:color=${hlColor}:t=fill`);
    }
    steps.push(`pad=${padW}:ih+${padY * 2}:${padX}:${padY}:white`);
    steps.push(`drawbox=x=0:y=0:w=iw:h=ih:color=${borderColor}:t=${borderT}`);

    run('ffmpeg', ['-y', '-i', pagePng, '-vf', steps.join(','), '-frames:v', '1', out, '-hide_banner', '-loglevel', 'error']);
    const { w, h } = probeSize(out);

    // Estimate of resulting cap height. TREC body type is 10pt; at `dpi` that
    // is 10/72*dpi px on the page render, then scaled by width/cw.
    const typeHeightPx = Math.round((10 / 72) * dpi * (width / cw));
    if (typeHeightPx < 20) {
      console.warn(`NOTE: body type lands at ~${typeHeightPx}px. That is EXPECTED — see this module's header. The card is proof the clause exists; the captions carry the words.`);
    }
    return { out, w, h, typeHeightPx };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * compositeOnClip — dim the background and lay the card on it for a window.
 */
function compositeOnClip(opts) {
  const {
    input, out, card, at, holdSec = 5.0,
    y = PROVEN.y, fps = PROVEN.fps, dim = PROVEN.dim,
    fadeSec = 0.25,
  } = opts;
  if (!fs.existsSync(input)) throw new Error(`doc-snip: input clip not found: ${input}`);
  if (!fs.existsSync(card)) throw new Error(`doc-snip: card not found: ${card}`);
  const end = at + holdSec;
  const win = `between(t,${at},${end.toFixed(3)})`;

  // Dim the whole background for the window, then overlay the card centred
  // horizontally at y. The card fades in/out over fadeSec so it doesn't pop.
  const fc =
    `[0:v]split[base][dimsrc];` +
    `[dimsrc]${dim}[dimmed];` +
    `[base][dimmed]overlay=0:0:enable='${win}'[bg];` +
    `[1:v]format=rgba,fade=t=in:st=${at}:d=${fadeSec}:alpha=1,fade=t=out:st=${(end - fadeSec).toFixed(3)}:d=${fadeSec}:alpha=1,setpts=PTS-STARTPTS[cardv];` +
    `[bg][cardv]overlay=(W-w)/2:${y}:enable='${win}'[v]`;

  execFileSync('ffmpeg', [
    '-y', '-i', input,
    '-loop', '1', '-framerate', String(fps), '-i', card,
    '-filter_complex', fc,
    '-map', '[v]', '-map', '0:a?',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-r', String(fps), '-c:a', 'copy', '-shortest',
    out, '-hide_banner', '-loglevel', 'error',
  ], { maxBuffer: 1 << 28 });
  return { out, at, holdSec, y };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pdf) { console.error('Usage: doc-snip.js --pdf <pdf> --page <n> --out <png> [--crop w:h:x:y] [--hl x:y:w:h|--noHl]  |  ... --in <clip> --out <clip> --at <sec>'); process.exit(1); }

  const cardOpts = {
    pdf: args.pdf,
    page: args.page != null ? +args.page : 5,
    crop: args.crop && args.crop !== true ? args.crop : PROVEN.crop,
    hl: args.hl && args.hl !== true ? args.hl : PROVEN.hl,
    noHl: !!args.noHl,
    width: args.width != null ? +args.width : PROVEN.width,
    dpi: args.dpi != null ? +args.dpi : PROVEN.dpi,
  };

  if (args.in) {
    const cardPath = args.card && args.card !== true ? args.card : (args.out + '.card.png');
    const card = buildCard({ ...cardOpts, out: cardPath });
    const res = compositeOnClip({
      input: args.in, out: args.out, card: card.out,
      at: +args.at, holdSec: args.holdSec != null ? +args.holdSec : 5.0,
      y: args.y != null ? +args.y : PROVEN.y,
      fps: args.fps != null ? +args.fps : PROVEN.fps,
    });
    console.log(JSON.stringify({ ...res, card }, null, 2));
  } else {
    const res = buildCard({ ...cardOpts, out: args.out });
    console.log(JSON.stringify(res, null, 2));
  }
}

module.exports = { buildCard, compositeOnClip, PROVEN };
if (require.main === module) main();
