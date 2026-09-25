#!/usr/bin/env node
/**
 * recomposite-matte.js — swap a matte's backdrop WITHOUT re-running the ONNX
 * matting pass. matte.js already writes per-frame alpha + clean-foreground
 * (fgr) PNGs to disk; this just re-composites those over a new backdrop
 * image. Use this whenever only the backdrop choice changes — it's the
 * expensive step (model inference) that recomposite avoids, not the cheap
 * one.
 *
 * Usage:
 *   node scripts/video-engine/recomposite-matte.js --alpha <dir> --fgr <dir> \
 *     --backdrop <img> --out <dir>
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

async function main() {
  const args = parseArgs();
  const alphaDir = args.alpha, fgrDir = args.fgr, backdropPath = args.backdrop, outDir = args.out;
  if (!alphaDir || !fgrDir || !backdropPath || !outDir) {
    console.error('Usage: recomposite-matte.js --alpha <dir> --fgr <dir> --backdrop <img> --out <dir>');
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  const files = fs.readdirSync(alphaDir).filter(f => /\.png$/i.test(f)).sort();
  let backdropRgb = null;
  const t0 = Date.now();
  for (const f of files) {
    // .greyscale() forces true single-channel output — without it, sharp's
    // PNG encoder had stored our "1-channel" alpha as 3-channel RGB, and
    // reading it back with plain .raw() silently returns channels:3 (each
    // "byte" is really 1 of 3 interleaved bytes), corrupting every
    // downstream stride calculation. Cost one fully-corrupted test render
    // to catch.
    const alphaBuf = await sharp(path.join(alphaDir, f)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = alphaBuf.info;
    const fgrRaw = await sharp(path.join(fgrDir, f)).removeAlpha().raw().toBuffer();
    const rgba = Buffer.alloc(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = fgrRaw[p * 3];
      rgba[p * 4 + 1] = fgrRaw[p * 3 + 1];
      rgba[p * 4 + 2] = fgrRaw[p * 3 + 2];
      rgba[p * 4 + 3] = alphaBuf.data[p];
    }
    const fgWithAlpha = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    if (!backdropRgb) backdropRgb = await sharp(backdropPath).resize(w, h, { fit: 'cover' }).png().toBuffer();
    await sharp(backdropRgb).composite([{ input: fgWithAlpha }]).png().toFile(path.join(outDir, f));
  }
  console.log(`Recomposited ${files.length} frames in ${Date.now() - t0}ms -> ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
