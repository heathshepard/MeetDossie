#!/usr/bin/env node
/**
 * refine-composite.js — turns raw matte.js alpha/fgr output into a
 * halo-free, temporally-stable composite over a backdrop:
 *
 *   1. Temporal median over a sliding window (default 5 frames) on the
 *      alpha channel — a fast hand producing one bad frame of banding gets
 *      smoothed into "slightly soft for a moment" instead of a visible
 *      artifact spike.
 *   2. Morphological erosion (N passes, 3x3 min-filter) — pulls the alpha
 *      edge in 1-2px, which is exactly where RVM's light-fringe halo lives
 *      (anti-aliased edge pixels that are secretly part-backdrop).
 *   3. Feather (small gaussian blur on the eroded alpha) so the pulled-in
 *      edge doesn't look like a hard cutout.
 *   4. Despill / light-wrap — in the alpha transition band (not fully
 *      opaque, not fully transparent), blend the foreground's OWN color
 *      toward the backdrop color before compositing, proportional to how
 *      "edge-y" that pixel is (peaks at alpha=0.5, zero at alpha=0 or 1).
 *      This is what actually removes a colored fringe — plain alpha
 *      blending alone does not, because the fringe pixel's un-blended
 *      color is already wrong (part-backdrop-colored) before the blend.
 *
 * Usage:
 *   node scripts/video-engine/refine-composite.js --alpha <dir> --fgr <dir> \
 *     --backdrop <img> --out <dir> [--erode 2] [--feather 2] \
 *     [--temporalWindow 5] [--despill 0.5]
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const val = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

async function loadGrey(p) {
  const { data, info } = await sharp(p).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

function erode(buf, w, h, passes) {
  let src = buf;
  for (let pass = 0; pass < passes; pass++) {
    const dst = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        let m = src[i];
        if (x > 0) m = Math.min(m, src[i - 1]);
        if (x < w - 1) m = Math.min(m, src[i + 1]);
        if (y > 0) m = Math.min(m, src[i - w]);
        if (y < h - 1) m = Math.min(m, src[i + w]);
        dst[i] = m;
      }
    }
    src = dst;
  }
  return src;
}

function medianOf(arr) {
  // small fixed-size insertion sort — arr length is the temporal window (<=5), cheap.
  const a = arr.slice().sort((x, y) => x - y);
  return a[a.length >> 1];
}

async function main() {
  const args = parseArgs();
  const alphaDir = args.alpha, fgrDir = args.fgr, backdropPath = args.backdrop, outDir = args.out;
  if (!alphaDir || !fgrDir || !backdropPath || !outDir) {
    console.error('Usage: refine-composite.js --alpha <dir> --fgr <dir> --backdrop <img> --out <dir>');
    process.exit(1);
  }
  const erodePasses = parseInt(args.erode || '2', 10);
  const featherPx = parseFloat(args.feather || '2');
  const window = parseInt(args.temporalWindow || '5', 10);
  const half = Math.floor(window / 2);
  const despillStrength = parseFloat(args.despill || '0.5');

  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(alphaDir).filter(f => /\.png$/i.test(f)).sort();
  if (!files.length) { console.error('No frames in', alphaDir); process.exit(1); }

  const first = await sharp(path.join(alphaDir, files[0])).metadata();
  const W = first.width, H = first.height;
  // .removeAlpha() is required — sharp's SVG-rendered PNGs default to RGBA,
  // and a plain .raw() on a 4-channel image silently returns 4 bytes/pixel
  // while this script indexes assuming 3, which scrambles every pixel after
  // the first (the exact striped/rotated-looking corruption this comment
  // is here to stop someone re-discovering).
  const backdropRgb = await sharp(backdropPath).removeAlpha().resize(W, H, { fit: 'cover' }).raw().toBuffer();

  // Preload all alpha frames into memory (single-channel Uint8, W*H bytes
  // each — for 973 frames at 1080x1920 that's ~2GB, fits the box's 31GB).
  console.log(`Loading ${files.length} alpha frames...`);
  const alphaCache = new Array(files.length);
  for (let i = 0; i < files.length; i++) {
    alphaCache[i] = (await loadGrey(path.join(alphaDir, files[i]))).data;
  }

  const t0 = Date.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // 1. Temporal median.
    const lo = Math.max(0, i - half), hi = Math.min(files.length - 1, i + half);
    const windowFrames = [];
    for (let j = lo; j <= hi; j++) windowFrames.push(alphaCache[j]);
    const medianAlpha = Buffer.alloc(W * H);
    const vals = new Array(windowFrames.length);
    for (let p = 0; p < W * H; p++) {
      for (let k = 0; k < windowFrames.length; k++) vals[k] = windowFrames[k][p];
      medianAlpha[p] = medianOf(vals);
    }

    // 2. Erode.
    const eroded = erode(medianAlpha, W, H, erodePasses);

    // 3. Feather. Same sharp gotcha as matte.js's alpha PNG write: any
    // operator (here .blur()) on a 1-channel raw pipeline silently promotes
    // to 3-channel output — force it back with .toColourspace('b-w') or the
    // per-pixel indexing below reads 1-of-3 interleaved bytes and scrambles
    // the whole frame (cost two fully-corrupted test renders to catch).
    const feathered = await sharp(eroded, { raw: { width: W, height: H, channels: 1 } })
      .blur(featherPx).toColourspace('b-w').raw().toBuffer();

    // 4. Despill + composite.
    const fgrRaw = await sharp(path.join(fgrDir, f)).removeAlpha().raw().toBuffer();
    const outBuf = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const a = feathered[p] / 255;
      const w = 4 * a * (1 - a) * despillStrength; // edge-band weight, 0 at a=0/1, peaks at a=0.5
      const fp = p * 3;
      for (let c = 0; c < 3; c++) {
        const fgrC = fgrRaw[fp + c];
        const bgC = backdropRgb[fp + c];
        const despilled = fgrC + (bgC - fgrC) * w;
        outBuf[fp + c] = Math.round(despilled * a + bgC * (1 - a));
      }
    }
    await sharp(outBuf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(path.join(outDir, f));
    if (i % 50 === 0) process.stdout.write(`  ${i}/${files.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)\n`);
  }
  console.log(`refine-composite: ${files.length} frames in ${((Date.now() - t0) / 1000).toFixed(0)}s -> ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
