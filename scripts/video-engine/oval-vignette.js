#!/usr/bin/env node
/**
 * oval-vignette.js — non-ML fallback for shots where the ONNX matte bands
 * (fast hand motion). Instead of a clean cutout, this pushes a tighter
 * punch-in then heavily blurs + darkens everything OUTSIDE a face-centered
 * oval, so the room behind the subject can't be read even though it's still
 * technically "in frame." Cheap (no model inference) and has no motion-edge
 * failure mode since it doesn't try to segment the subject at all.
 *
 * Usage:
 *   node scripts/video-engine/oval-vignette.js --frames <dir> --out <dir> \
 *     [--zoom 1.18] [--ovalCx 0.5] [--ovalCy 0.38] [--ovalRx 0.46] [--ovalRy 0.36] [--blur 45] [--darken 0.35]
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
  const framesDir = args.frames, outDir = args.out;
  if (!framesDir || !outDir) {
    console.error('Usage: oval-vignette.js --frames <dir> --out <dir> [--zoom 1.18] [--blur 45] [--darken 0.35]');
    process.exit(1);
  }
  const zoom = parseFloat(args.zoom || '1.18');
  const ovalCx = parseFloat(args.ovalCx || '0.5');
  const ovalCy = parseFloat(args.ovalCy || '0.38');
  const ovalRx = parseFloat(args.ovalRx || '0.46');
  const ovalRy = parseFloat(args.ovalRy || '0.36');
  const blurAmt = parseFloat(args.blur || '45');
  const darken = parseFloat(args.darken || '0.35');
  fs.mkdirSync(outDir, { recursive: true });

  const files = fs.readdirSync(framesDir).filter(f => /\.png$/i.test(f)).sort();
  if (!files.length) { console.error('No frames in', framesDir); process.exit(1); }

  const first = await sharp(path.join(framesDir, files[0])).metadata();
  const W = first.width, H = first.height;

  // Soft-edged oval mask, white (opaque=sharp) inside, black (transparent=blurred) outside.
  const maskSvg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="m" cx="${ovalCx * 100}%" cy="${ovalCy * 100}%" r="50%">
        <stop offset="72%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="#000"/>
    <ellipse cx="${ovalCx * W}" cy="${ovalCy * H}" rx="${ovalRx * W}" ry="${ovalRy * H}" fill="url(#m)"/>
  </svg>`;
  const maskBuf = await sharp(Buffer.from(maskSvg)).png().toBuffer();
  const maskRaw = await sharp(maskBuf).ensureAlpha().removeAlpha().greyscale().raw().toBuffer();

  const t0 = Date.now();
  for (const f of files) {
    // Punch in: crop a smaller centered window, scale back up to WxH.
    const cw = Math.round(W / zoom), ch = Math.round(H / zoom);
    const left = Math.round((W - cw) / 2), top = Math.round((H - ch) * 0.42); // bias up slightly, matches face bias
    const zoomed = sharp(path.join(framesDir, f)).extract({ left, top, width: cw, height: ch }).resize(W, H);
    const sharpBuf = await zoomed.clone().png().toBuffer();
    const blurredDark = await zoomed.clone().blur(blurAmt).modulate({ brightness: 1 - darken }).raw().ensureAlpha().toBuffer();
    const sharpRaw = await sharp(sharpBuf).raw().ensureAlpha().toBuffer();

    const outBuf = Buffer.alloc(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      const m = maskRaw[p] / 255; // 1 = sharp, 0 = blurred/dark
      for (let c = 0; c < 3; c++) {
        outBuf[p * 4 + c] = Math.round(sharpRaw[p * 4 + c] * m + blurredDark[p * 4 + c] * (1 - m));
      }
      outBuf[p * 4 + 3] = 255;
    }
    await sharp(outBuf, { raw: { width: W, height: H, channels: 4 } }).png().toFile(path.join(outDir, f));
  }
  console.log(`oval-vignette: ${files.length} frames in ${Date.now() - t0}ms -> ${outDir}`);
}

main().catch(e => { console.error(e); process.exit(1); });
