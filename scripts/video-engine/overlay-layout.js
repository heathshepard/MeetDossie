#!/usr/bin/env node
/**
 * overlay-layout.js — the "commentary" layout: the SUBJECT MATTER fills the
 * frame and Heath is composited over it as a foreground element.
 *
 * WHY THIS IS NOT THE THING WE REFUSED BEFORE
 * We declined to matte him onto a synthetic navy backdrop, and that was the
 * right call: §1 and §16 say a fake room reads AI-generated, and replacing a
 * real kitchen with a gradient is exactly that. This is the opposite. The
 * background here is the ACTUAL THING HE IS TALKING ABOUT — TREC 20-19 at
 * paragraph 7.I, or a real screen recording. Nothing is invented; the viewer
 * is shown the document while the sentence about the document is spoken.
 *
 * WHAT IT FIXES
 * trial_07 scored PAYOFF 2/5 because he says "put it in one place" and the
 * viewer never sees the one place. §10 wants Problem -> Solution -> Why I
 * care, and a solution you cannot see is not a solution. Showing ¶7.I on the
 * word "paragraph seven-I" is the payoff.
 *
 * DRIVEN BY THE SHOT PLAN, NOT THE WHOLE VIDEO
 * Overlay shots alternate with plain talking-head shots. A whole video in
 * this layout is a slideshow with a man glued to the corner; §4 wants visual
 * variation, and cutting TO the document and back IS that variation. Which
 * shots get it comes from the shot plan (shot.overlay), so the cut to the
 * document lands on a sentence boundary like every other cut.
 *
 * PLACEMENTS
 *   cutout-left / cutout-right
 *     The large standing cutout. Keyed subject, scaled to `heightFrac` of
 *     frame height, anchored to the bottom edge on one side. Head lands
 *     around 40% down, well clear of the caption band.
 *   inset-topleft / inset-topright / inset-bottomleft / inset-bottomright
 *     The small rectangular PiP. NOT keyed — a plain rectangular crop of the
 *     talking-head frame, which is what the reference layout actually uses
 *     and which cannot fringe because there is no matte involved. Cheaper
 *     and more robust; use it whenever the key would be marginal.
 *
 * SAFE ZONES (both enforced, not advisory)
 *   - Bottom 12% of frame is the platform UI zone (TikTok/Reels/Shorts
 *     controls). Nothing that carries meaning goes there. A standing cutout
 *     may run off the bottom edge — his waist is not information — but an
 *     inset never may.
 *   - The caption band is computed from brief.captionMarginV and kept clear
 *     of inset placements, so captions never land on top of the PiP.
 *
 * KEY QUALITY IS A REPORTED FACT, NOT AN ASSUMPTION
 * `assessKey()` measures the matte on real frames and returns numbers:
 * edge softness, how much of the alpha is in the uncertain 0.05-0.95 band,
 * and temporal stability. Heath is in a light blue polo against cream
 * cabinets — the worst realistic case for a keyer — so this is reported
 * every run rather than assumed to be fine.
 *
 * Usage:
 *   node scripts/video-engine/overlay-layout.js \
 *     --frames <cropped talking-head PNGs> --alpha <dir> --fgr <dir> \
 *     --background <image or video> --out <dir> \
 *     [--placement cutout-right] [--heightFrac 0.62] [--bgPunch x,y,w,h] \
 *     [--from 0] [--count 9999] [--assessOnly]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { execFileSync } = require('child_process');

const OUT_W = 1080, OUT_H = 1920;
// Platform UI exclusion: bottom 12% of a 9:16 frame is covered by
// TikTok/Reels/Shorts chrome on a real phone.
const BOTTOM_UI_FRAC = 0.12;

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { const k = a[i].slice(2); out[k] = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true; }
  }
  return out;
}

/**
 * assessKey — measure the matte instead of trusting it.
 *
 * Three numbers, all on the raw alpha:
 *   uncertainFrac  fraction of pixels in the 0.05-0.95 band. This is the
 *                  edge-softness measure: a crisp key has a thin band, a
 *                  mushy one has a wide halo. Reported relative to the
 *                  SUBJECT area, not the whole frame, or a small subject
 *                  always looks clean.
 *   edgeWidthPx    mean thickness of that band measured across the
 *                  silhouette — the number that actually predicts a visible
 *                  fringe.
 *   bandAreaJitter frame-to-frame change in the SIZE of the edge band, as a
 *                  fraction of its own mean.
 *
 * WHY NOT PER-PIXEL TEMPORAL DIFFERENCE. The obvious temporal metric —
 * compare alpha[i] to the previous frame's alpha[i] inside the band — was
 * the first thing here and it is wrong. The subject moves and the crop
 * window pans, so the band moves too, and the metric reads mostly SUBJECT
 * MOTION. It scored this footage 0.249 (a "poor" grade) on frames whose
 * edges are visibly stable; a hand gesture alone would fail any clip. Band
 * AREA is insensitive to where the subject is and only rises when the keyer
 * is actually changing its mind about the edge, which is the thing that
 * looks like boiling.
 */
async function assessKey(alphaDir, opts = {}) {
  const files = fs.readdirSync(alphaDir).filter(f => /\.png$/i.test(f)).sort();
  const sample = files.slice(0, Math.min(files.length, opts.sample || 20));
  if (!sample.length) return { error: 'no alpha frames to assess' };
  const per = [];
  for (const f of sample) {
    const { data, info } = await sharp(path.join(alphaDir, f)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const n = info.width * info.height;
    let opaque = 0, uncertain = 0;
    for (let i = 0; i < n; i++) {
      const a = data[i] / 255;
      if (a > 0.95) opaque++;
      else if (a >= 0.05) uncertain++;
    }
    const subjectArea = opaque + uncertain;
    // Edge band thickness: the uncertain band wraps the silhouette, so
    // area/perimeter approximates its width. Perimeter of a blob of area A
    // that is roughly person-shaped is ~4*sqrt(A) — close enough to turn
    // area into a width in pixels for comparison purposes.
    const approxPerimeter = 4 * Math.sqrt(Math.max(1, opaque));
    per.push({
      file: f,
      subjectFracOfFrame: +(subjectArea / n).toFixed(4),
      uncertainFracOfSubject: subjectArea ? +(uncertain / subjectArea).toFixed(4) : null,
      edgeWidthPx: +(uncertain / approxPerimeter).toFixed(2),
      bandArea: uncertain,
    });
  }
  // Band-area stability: mean absolute frame-to-frame change in the size of
  // the transition band, normalised by its own mean. Motion-insensitive.
  const areas = per.map(p => p.bandArea);
  const meanArea = areas.reduce((a, b) => a + b, 0) / Math.max(1, areas.length);
  let d = 0;
  for (let i = 1; i < areas.length; i++) d += Math.abs(areas[i] - areas[i - 1]);
  const bandAreaJitter = (areas.length > 1 && meanArea > 0) ? +(d / (areas.length - 1) / meanArea).toFixed(4) : null;
  const avg = (k) => { const v = per.map(p => p[k]).filter(x => x != null); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4) : null; };
  const edgeWidthPx = avg('edgeWidthPx');
  const uncertainFracOfSubject = avg('uncertainFracOfSubject');
  // Thresholds from what a fringe actually looks like at 1080x1920 on a
  // phone. Deliberately reported as a grade with the numbers attached, so a
  // marginal key is never quietly called "fine".
  let grade, verdict;
  const stable = bandAreaJitter == null || bandAreaJitter <= 0.15;
  if (edgeWidthPx <= 3.0 && stable) { grade = 'good'; verdict = 'clean enough to composite over any background'; }
  else if (edgeWidthPx <= 9.0 && stable) { grade = 'acceptable-on-light'; verdict = 'soft edge — effectively invisible over a light/white document page, visible as a pale halo over a dark or saturated background'; }
  else { grade = 'poor'; verdict = 'fringe or edge instability will be visible; use the rectangular inset placement, or shoot against a green screen'; }
  return { framesAssessed: sample.length, edgeWidthPx, uncertainFracOfSubject, bandAreaJitter, grade, verdict, perFrame: per.slice(0, 5) };
}

/** Background frame(s): a still image, or a video decoded to a frame sequence. */
async function prepareBackground(bgPath, count, workDir, punch, fit, anchorMode) {
  fs.mkdirSync(workDir, { recursive: true });
  const isVideo = /\.(mp4|mov|m4v|webm|mkv)$/i.test(bgPath);
  // "Legible at phone size" usually means punching into the relevant
  // paragraph rather than showing a whole page. --bgPunch x,y,w,h crops the
  // background BEFORE it is scaled to cover, so a 2550x3300 contract page
  // becomes a readable block instead of a grey texture.
  const punchFilter = punch ? `crop=${punch.w}:${punch.h}:${punch.x}:${punch.y},` : '';
  // FIT MODE. 'cover' is right for a screen recording — it already fills a
  // rectangle and cropping its edges costs nothing.
  //
  // It is WRONG for a document. A contract paragraph is wide and short;
  // cover-scaling 2180x620 into 1080x1920 needs a 3.1x blow-up and then
  // keeps a 1080px-wide vertical slice of it, which is three words per line
  // and unreadable — the exact opposite of the requirement that the document
  // be legible at phone size. 'page' fits the punched region to the frame
  // WIDTH, centres it vertically, and backs it with a soft neutral so the
  // whole paragraph survives.
  const fitMode = fit || 'cover';
  // WHERE the page sits vertically. A contract paragraph fitted to 1080 wide
  // is only 300-500 px tall, so 'page' mode ALWAYS leaves neutral space —
  // that is a property of the content, not a bug, and the reference layout
  // fills exactly that space with the presenter. Centring the page leaves
  // the dead space at the TOP and puts the text where the cutout's head
  // lands, which covers the sentence the whole shot exists to show. Anchor
  // it high by default and the cutout gets the lower half to itself.
  const anchor = anchorMode || 'top';
  const padY = anchor === 'center' ? '(oh-ih)/2' : String(Math.round(OUT_H * 0.10));
  const vf = fitMode === 'page'
    ? `${punchFilter}scale=${OUT_W}:-2,pad=${OUT_W}:${OUT_H}:0:${padY}:color=0xF2F1EE`
    : `${punchFilter}scale=${OUT_W}:${OUT_H}:force_original_aspect_ratio=increase,crop=${OUT_W}:${OUT_H}`;
  if (isVideo) {
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', bgPath, '-vf', `${vf},fps=30`, '-frames:v', String(count), path.join(workDir, 'b%05d.png')]);
    let files = fs.readdirSync(workDir).filter(f => /\.png$/i.test(f)).sort();
    // A background shorter than the shot holds its last frame rather than
    // running out — a black gap here would be a silent defect.
    while (files.length && files.length < count) {
      const src = path.join(workDir, files[files.length - 1]);
      const dst = path.join(workDir, `b${String(files.length + 1).padStart(5, '0')}.png`);
      fs.copyFileSync(src, dst);
      files = fs.readdirSync(workDir).filter(f => /\.png$/i.test(f)).sort();
    }
    return files.map(f => path.join(workDir, f));
  }
  const still = path.join(workDir, 'bg-still.png');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', bgPath, '-vf', vf, '-frames:v', '1', '-update', '1', still]);
  return new Array(count).fill(still);
}

/**
 * placementRect — where the subject goes, in output pixels.
 * Returns { left, top, width, height, keyed }.
 */
function placementRect(placement, opts = {}) {
  const heightFrac = opts.heightFrac != null ? opts.heightFrac : 0.62;
  const uiTop = Math.round(OUT_H * (1 - BOTTOM_UI_FRAC)); // 1690
  const margin = Math.round(OUT_W * 0.04);

  if (/^cutout/.test(placement)) {
    // Standing cutout: keyed, anchored to the BOTTOM EDGE. Running off the
    // bottom is correct for this layout — his waist carries no information,
    // so the UI zone covering it costs nothing, and a cutout floating above
    // the bottom edge reads as a sticker.
    const height = Math.round(OUT_H * heightFrac);
    const width = Math.round(height * (OUT_W / OUT_H)); // subject frames are 9:16
    const top = OUT_H - height;
    const left = /left/.test(placement) ? -Math.round(width * 0.10) : OUT_W - width + Math.round(width * 0.10);
    return { left, top, width, height, keyed: true, note: 'standing cutout, bottom-anchored, may run off frame edges' };
  }
  // Rectangular inset (PiP): NOT keyed. No matte means no fringe — this is
  // the placement to use when assessKey() grades the key below "good".
  const insetW = Math.round(OUT_W * (opts.insetWidthFrac || 0.34));
  const insetH = Math.round(insetW * 4 / 3);
  const captionTop = OUT_H - (opts.captionMarginV || 370) - Math.round((opts.captionSize || 84) * 1.6);
  const left = /left/.test(placement) ? margin : OUT_W - insetW - margin;
  let top = /^inset-top/.test(placement) ? margin : Math.min(uiTop - insetH - margin, captionTop - insetH - margin);
  if (top < margin) top = margin;
  return { left, top, width: insetW, height: insetH, keyed: false, note: 'rectangular inset, clear of the caption band and the bottom UI zone' };
}

/** Composite one frame. */
async function compositeFrame({ bgPath, fgrPath, alphaPath, framePath, rect, outPath, insetBorder = true }) {
  const layers = [];
  if (rect.keyed) {
    const fgr = await sharp(fgrPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alpha = await sharp(alphaPath).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = fgr;
    for (let i = 0; i < info.width * info.height; i++) data[i * 4 + 3] = alpha.data[i];
    const subject = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
      .resize(rect.width, rect.height, { fit: 'fill' }).png().toBuffer();
    layers.push({ input: subject, left: rect.left, top: rect.top });
  } else {
    let inset = sharp(framePath).resize(rect.width, rect.height, { fit: 'cover', position: 'top' });
    let buf = await inset.png().toBuffer();
    if (insetBorder) {
      // A thin light border separates the PiP from a busy document page.
      const b = 4;
      buf = await sharp({ create: { width: rect.width + b * 2, height: rect.height + b * 2, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0.92 } } })
        .composite([{ input: buf, left: b, top: b }]).png().toBuffer();
      layers.push({ input: buf, left: rect.left - b, top: rect.top - b });
    } else {
      layers.push({ input: buf, left: rect.left, top: rect.top });
    }
  }
  // sharp refuses composites that fall outside the canvas, so a cutout that
  // deliberately runs off the edge has to be pre-cropped to the visible part
  // rather than clamped into frame (clamping would slide him inward and
  // break the placement).
  const safe = [];
  for (const l of layers) {
    let { input, left, top } = l;
    const meta = await sharp(input).metadata();
    let cropL = 0, cropT = 0, cropW = meta.width, cropH = meta.height;
    if (left < 0) { cropL = -left; cropW -= cropL; left = 0; }
    if (top < 0) { cropT = -top; cropH -= cropT; top = 0; }
    if (left + cropW > OUT_W) cropW = OUT_W - left;
    if (top + cropH > OUT_H) cropH = OUT_H - top;
    if (cropW <= 0 || cropH <= 0) continue;
    if (cropL || cropT || cropW !== meta.width || cropH !== meta.height) {
      input = await sharp(input).extract({ left: cropL, top: cropT, width: cropW, height: cropH }).png().toBuffer();
    }
    safe.push({ input, left, top });
  }
  await sharp(bgPath).resize(OUT_W, OUT_H, { fit: 'cover' }).composite(safe).png().toFile(outPath);
}

async function main() {
  const args = parseArgs();
  // --assessOnly is a read-only measurement pass and must not require an
  // output directory — it exists to answer "is the key good enough" BEFORE
  // committing to a render.
  if (args.assessOnly) {
    if (!args.alpha) { console.error('--assessOnly needs --alpha <dir>'); process.exit(1); }
    console.log(JSON.stringify(await assessKey(args.alpha), null, 2));
    return;
  }

  const outDir = args.out;
  if (!outDir) { console.error('Usage: overlay-layout.js --frames <dir> --alpha <dir> --fgr <dir> --background <img|mp4> --out <dir> [--placement cutout-right]'); process.exit(1); }

  const framesDir = args.frames, alphaDir = args.alpha, fgrDir = args.fgr;
  const placement = args.placement || 'cutout-right';
  const rect = placementRect(placement, {
    heightFrac: args.heightFrac ? parseFloat(args.heightFrac) : undefined,
    insetWidthFrac: args.insetWidthFrac ? parseFloat(args.insetWidthFrac) : undefined,
    captionMarginV: args.captionMarginV ? parseInt(args.captionMarginV, 10) : undefined,
    captionSize: args.captionSize ? parseInt(args.captionSize, 10) : undefined,
  });
  console.log(`overlay-layout: placement=${placement} rect=${rect.width}x${rect.height}+${rect.left}+${rect.top} keyed=${rect.keyed} — ${rect.note}`);

  const frameFiles = fs.readdirSync(framesDir).filter(f => /\.png$/i.test(f)).sort();
  const from = parseInt(args.from || '0', 10);
  const count = Math.min(parseInt(args.count || String(frameFiles.length), 10), frameFiles.length - from);
  const slice = frameFiles.slice(from, from + count);

  // Key quality is REPORTED on every run, not assumed.
  let keyReport = null;
  if (rect.keyed && alphaDir) {
    keyReport = await assessKey(alphaDir);
    console.log(`overlay-layout: KEY QUALITY ${keyReport.grade} — edge width ${keyReport.edgeWidthPx}px, band-area jitter ${keyReport.bandAreaJitter}. ${keyReport.verdict}`);
    if (keyReport.grade === 'poor') console.warn('overlay-layout: WARNING — the key is graded POOR. The rectangular inset placement avoids the matte entirely and is the honest choice until a green screen exists.');
  }

  const bgWork = path.join(outDir, '_bg');
  fs.mkdirSync(outDir, { recursive: true });
  const punch = args.bgPunch ? (() => { const [x, y, w, h] = String(args.bgPunch).split(',').map(Number); return { x, y, w, h }; })() : null;
  const bgFrames = await prepareBackground(args.background, slice.length, bgWork, punch, args.bgFit, args.bgAnchor);

  for (let i = 0; i < slice.length; i++) {
    const f = slice[i];
    await compositeFrame({
      bgPath: bgFrames[Math.min(i, bgFrames.length - 1)],
      fgrPath: fgrDir ? path.join(fgrDir, f) : null,
      alphaPath: alphaDir ? path.join(alphaDir, f) : null,
      framePath: path.join(framesDir, f),
      rect,
      outPath: path.join(outDir, f),
      insetBorder: args.insetBorder !== 'false',
    });
  }
  const report = { placement, rect, frames: slice.length, keyReport, background: args.background, bgPunch: punch, bgFit: args.bgFit || 'cover' };
  fs.writeFileSync(path.join(outDir, 'overlay-report.json'), JSON.stringify(report, null, 2));
  console.log(`overlay-layout: wrote ${slice.length} frames to ${outDir}`);
}

module.exports = { assessKey, placementRect, prepareBackground, compositeFrame, OUT_W, OUT_H, BOTTOM_UI_FRAC };
if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
