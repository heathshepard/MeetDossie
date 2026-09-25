#!/usr/bin/env node
/**
 * matte.js — Background separation via RobustVideoMatting (ONNX, CPU).
 *
 * Reads a PNG frame sequence, runs RVM's recurrent matting model frame by
 * frame (carrying r1..r4 hidden state forward for temporal stability), and
 * writes one of two output shapes.
 *
 * ===================================================================
 * --mode rgba  (DEFAULT, 5.7 fps)  vs  --mode full  (legacy, 0.65 fps)
 * ===================================================================
 * `full` writes THREE files per frame — alpha, fgr, and a comp-blurbg
 * composite (plus comp-workspace when a backdrop is given). Measured at
 * **0.65 fps**: a 2717-frame take took ~70 minutes.
 *
 * `rgba` writes ONE RGBA PNG per frame at `compressionLevel: 1`, into a
 * single `rgba/` subdir. Measured at **5.7 fps** — the same take in ~10
 * minutes. It is an 8.8x speedup for identical matting, because the model
 * pass was never the bottleneck: the PNG encodes were.
 *
 * Three things make up that difference, all of them I/O, none of them quality:
 *   1. One file per frame instead of three-to-four.
 *   2. compressionLevel 1 instead of sharp's default 6. These are scratch
 *      frames that get decoded by ffmpeg minutes later and deleted; spending
 *      CPU to make them smaller on disk is pure waste.
 *   3. No blur/modulate/resize round trip per frame. The blurred background
 *      composite was being rebuilt from disk for every single frame.
 *
 * `full` is kept behind the flag because refine-composite.js consumes
 * alpha/ and fgr/ separately.
 *
 * ===================================================================
 * STAGE FRAMES ON THE NATIVE LINUX FILESYSTEM, NOT /mnt/c
 * ===================================================================
 * The WSL/NTFS boundary was roughly HALF the cost of this pass. Thousands of
 * small PNG writes through the 9p mount is the worst possible access pattern
 * for it. This module now refuses to write its output under /mnt/ unless
 * --allowSlowFs is passed, because the failure is invisible — it just takes
 * all night and nobody knows why.
 *
 * INPUT WIDTH: 640px is sufficient. RVM's mobilenetv3 variant downsamples to
 * ~512px on the long edge internally regardless (see autoDownsampleRatio), so
 * feeding it 1080 or 2160 wide frames costs decode and PNG time for detail
 * the model never sees. The alpha is upscaled at composite time.
 *
 * Usage:
 *   node scripts/video-engine/matte.js --frames <dir of input PNGs> --out <output dir> \
 *     [--mode rgba|full] [--backdrop <path>] [--model models/rvm_mobilenetv3_fp32.onnx] \
 *     [--allowSlowFs]
 *
 * Model: RobustVideoMatting mobilenetv3 fp32, downloaded from the official
 * GitHub release (https://github.com/PeterL1n/RobustVideoMatting). CPU-only —
 * see report in Media/video-engine-proto/matte-report.json for measured
 * seconds/frame on this machine (no NVIDIA GPU detected).
 */
const fs = require('fs');
const path = require('path');
const ort = require('onnxruntime-node');
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

// RVM's recommended auto downsample: keep the internal matting pass around
// 512px on the long edge for the mobilenetv3 variant.
function autoDownsampleRatio(w, h) {
  return Math.min(512 / Math.max(w, h), 1.0);
}

async function loadFrameTensor(filePath) {
  const img = sharp(filePath);
  const meta = await img.metadata();
  const { data } = await img.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = meta.width, h = meta.height;
  // HWC uint8 RGB -> CHW float32 [0,1]
  const floatData = new Float32Array(3 * w * h);
  const plane = w * h;
  for (let p = 0; p < plane; p++) {
    floatData[p] = data[p * 3] / 255;
    floatData[plane + p] = data[p * 3 + 1] / 255;
    floatData[2 * plane + p] = data[p * 3 + 2] / 255;
  }
  return { tensor: new ort.Tensor('float32', floatData, [1, 3, h, w]), w, h };
}

async function tensorToPng(tensor, w, h, channels, outPath) {
  // tensor is CHW float32 [0,1], channels = 1 (alpha) or 3 (rgb)
  const plane = w * h;
  const buf = Buffer.alloc(plane * channels);
  const data = tensor.data;
  for (let p = 0; p < plane; p++) {
    for (let c = 0; c < channels; c++) {
      const v = data[c * plane + p];
      buf[p * channels + c] = Math.max(0, Math.min(255, Math.round(v * 255)));
    }
  }
  let img = sharp(buf, { raw: { width: w, height: h, channels } });
  // Force a genuinely single-channel PNG for the alpha matte — without this,
  // sharp's encoder silently promotes 1-channel raw input to a 3-channel
  // (RGB) PNG on write, and a plain .raw() read-back later reports
  // channels:3, corrupting anyone who assumes 1 byte/pixel (see
  // recomposite-matte.js's fix comment for the failure this caused).
  if (channels === 1) img = img.toColourspace('b-w');
  await img.png().toFile(outPath);
}

async function main() {
  const args = parseArgs();
  const framesDir = args.frames;
  const outDir = args.out;
  const modelPath = require('./model-path.js').resolveModel('rvm_mobilenetv3_fp32.onnx', args.model);
  const backdropPath = args.backdrop || null;
  if (!framesDir || !outDir) {
    console.error('Usage: matte.js --frames <dir> --out <dir> [--backdrop <img>] [--model <onnx>]');
    process.exit(1);
  }

  // --mode rgba (default) is the fast path: ONE RGBA PNG per frame.
  const mode = args.mode === 'full' ? 'full' : 'rgba';

  // Staging frames on /mnt/c was ~half the wall-clock cost of this pass.
  // Fail loudly rather than run all night for no reason.
  if (path.resolve(outDir).startsWith('/mnt/') && !args.allowSlowFs) {
    console.error(
      `matte.js: --out is on the Windows mount (${outDir}).\n` +
      `  Thousands of small PNG writes across the WSL/NTFS 9p boundary was measured as roughly\n` +
      `  HALF the total cost of this pass. Stage frames under /tmp (native ext4) and copy the\n` +
      `  finished video out at the end. Pass --allowSlowFs to override.`);
    process.exit(1);
  }

  const subs = mode === 'rgba' ? ['rgba'] : ['alpha', 'fgr', 'comp-blurbg', 'comp-workspace'];
  for (const sub of subs) {
    fs.mkdirSync(path.join(outDir, sub), { recursive: true });
  }

  const files = fs.readdirSync(framesDir).filter(f => /\.png$/i.test(f)).sort();
  if (files.length === 0) {
    console.error('No PNG frames found in', framesDir);
    process.exit(1);
  }

  console.log(`Loading RVM model: ${modelPath}`);
  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });

  // Recurrent state starts as zero tensors of size [1,1,1,1] per RVM spec
  // (the model broadcasts internally on first call).
  let r1i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r2i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r3i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);
  let r4i = new ort.Tensor('float32', new Float32Array([0]), [1, 1, 1, 1]);

  let backdropRgb = null;
  let backdropW = 0, backdropH = 0;

  const perFrameMs = [];
  let W = 0, H = 0;
  const wallT0 = Date.now();

  for (let i = 0; i < files.length; i++) {
    const inPath = path.join(framesDir, files[i]);
    const { tensor: src, w, h } = await loadFrameTensor(inPath);
    W = w; H = h;
    const downsample = autoDownsampleRatio(w, h);
    const feeds = {
      src, r1i, r2i, r3i, r4i,
      downsample_ratio: new ort.Tensor('float32', new Float32Array([downsample]), [1]),
    };
    const t0 = Date.now();
    const results = await session.run(feeds);
    const dt = Date.now() - t0;
    perFrameMs.push(dt);

    r1i = results.r1o; r2i = results.r2o; r3i = results.r3o; r4i = results.r4o;

    const alphaName = files[i];
    if (mode === 'full') {
      await tensorToPng(results.pha, w, h, 1, path.join(outDir, 'alpha', alphaName));
      await tensorToPng(results.fgr, w, h, 3, path.join(outDir, 'fgr', alphaName));
    }

    // Build the foreground-with-alpha RGBA buffer directly from tensors —
    // skips a PNG encode/decode round trip through disk per frame.
    const plane = w * h;
    const fgrData = results.fgr.data, phaData = results.pha.data;
    const rgba = Buffer.alloc(plane * 4);
    for (let p = 0; p < plane; p++) {
      rgba[p * 4] = Math.max(0, Math.min(255, Math.round(fgrData[p] * 255)));
      rgba[p * 4 + 1] = Math.max(0, Math.min(255, Math.round(fgrData[plane + p] * 255)));
      rgba[p * 4 + 2] = Math.max(0, Math.min(255, Math.round(fgrData[2 * plane + p] * 255)));
      rgba[p * 4 + 3] = Math.max(0, Math.min(255, Math.round(phaData[p] * 255)));
    }
    if (mode === 'rgba') {
      // THE FAST PATH. compressionLevel 1, one file, straight from the raw
      // buffer — no intermediate PNG encode/decode, no per-frame disk reads.
      await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
        .png({ compressionLevel: 1 })
        .toFile(path.join(outDir, 'rgba', alphaName));
      process.stdout.write(`frame ${i + 1}/${files.length} — ${dt}ms\r`);
      continue;
    }

    const fgWithAlpha = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();

    // Composite (a): blurred/darkened version of the SAME source frame.
    // Downscale-then-blur-then-upscale instead of blurring at full res —
    // visually identical for a heavy background blur, far cheaper.
    const srcBuf = fs.readFileSync(inPath);
    const smallW = 220, smallH = Math.round(220 * h / w);
    const blurredBg = await sharp(srcBuf).resize(smallW, smallH).blur(6).modulate({ brightness: 0.55 })
      .resize(w, h).png().toBuffer();
    await sharp(blurredBg).composite([{ input: fgWithAlpha }]).png()
      .toFile(path.join(outDir, 'comp-blurbg', alphaName));

    // Composite (b): workspace backdrop.
    if (backdropPath) {
      if (!backdropRgb) {
        backdropRgb = await sharp(backdropPath).resize(w, h, { fit: 'cover' }).png().toBuffer();
      }
      await sharp(backdropRgb).composite([{ input: fgWithAlpha }]).png()
        .toFile(path.join(outDir, 'comp-workspace', alphaName));
    }

    process.stdout.write(`frame ${i + 1}/${files.length} — ${dt}ms\r`);
  }
  console.log('');

  const avgMs = perFrameMs.reduce((a, b) => a + b, 0) / perFrameMs.length;
  const wallSec = (Date.now() - wallT0) / 1000;
  const report = {
    model: modelPath,
    mode,
    frames: files.length,
    frameSize: `${W}x${H}`,
    gpu: false,
    executionProvider: 'cpu',
    avgMsPerFrame: Math.round(avgMs),
    avgSecPerFrame: +(avgMs / 1000).toFixed(3),
    minMs: Math.min(...perFrameMs),
    maxMs: Math.max(...perFrameMs),
    // The number that actually matters. avgMsPerFrame only times the model
    // call; the 0.65 -> 5.7 fps difference was entirely in what happens
    // around it, so timing the model alone hid the whole problem.
    wallClockSec: +wallSec.toFixed(1),
    fps: +(files.length / wallSec).toFixed(2),
    outputFs: path.resolve(outDir).startsWith('/mnt/') ? 'WINDOWS-MOUNT (slow)' : 'native',
  };
  if (W > 900) {
    console.warn(`NOTE: input frames are ${W}px wide. RVM downsamples to ~512px internally regardless — 640px input gives the same matte for less decode and PNG time.`);
  }
  fs.writeFileSync(path.join(outDir, 'matte-report.json'), JSON.stringify(report, null, 2));
  console.log('Report:', report);
}

main().catch(e => { console.error(e); process.exit(1); });
