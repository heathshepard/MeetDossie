#!/usr/bin/env node
/**
 * matte.js — Background separation via RobustVideoMatting (ONNX, CPU).
 *
 * Reads a PNG frame sequence, runs RVM's recurrent matting model frame by
 * frame (carrying r1..r4 hidden state forward for temporal stability), and
 * writes:
 *   - <out>/alpha/f###.png        - per-frame alpha matte (grayscale)
 *   - <out>/fgr/f###.png          - per-frame clean foreground (RGB)
 *   - <out>/comp-blurbg/f###.png  - composited over a blurred/darkened copy of the SAME frame
 *   - <out>/comp-workspace/f###.png - composited over a workspace backdrop image
 *
 * Usage:
 *   node scripts/video-engine/matte.js --frames <dir of input PNGs> --out <output dir> \
 *     [--backdrop <path to backdrop jpg/png>] [--model models/rvm_mobilenetv3_fp32.onnx]
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
  await sharp(buf, { raw: { width: w, height: h, channels } }).png().toFile(outPath);
}

async function main() {
  const args = parseArgs();
  const framesDir = args.frames;
  const outDir = args.out;
  const modelPath = args.model || 'models/rvm_mobilenetv3_fp32.onnx';
  const backdropPath = args.backdrop || null;
  if (!framesDir || !outDir) {
    console.error('Usage: matte.js --frames <dir> --out <dir> [--backdrop <img>] [--model <onnx>]');
    process.exit(1);
  }

  for (const sub of ['alpha', 'fgr', 'comp-blurbg', 'comp-workspace']) {
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
    await tensorToPng(results.pha, w, h, 1, path.join(outDir, 'alpha', alphaName));
    await tensorToPng(results.fgr, w, h, 3, path.join(outDir, 'fgr', alphaName));

    // Composite (a): blurred/darkened version of the SAME source frame.
    const srcBuf = fs.readFileSync(inPath);
    const blurredBg = await sharp(srcBuf).blur(18).modulate({ brightness: 0.55 }).png().toBuffer();
    const fgrPngPath = path.join(outDir, 'fgr', alphaName);
    const alphaPngPath = path.join(outDir, 'alpha', alphaName);
    const fgrBuf = await sharp(fgrPngPath).ensureAlpha().png().toBuffer();
    const alphaBuf = await sharp(alphaPngPath).raw().toBuffer();
    const fgrRaw = await sharp(fgrBuf).removeAlpha().raw().toBuffer();
    const rgba = Buffer.alloc(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[p * 4] = fgrRaw[p * 3];
      rgba[p * 4 + 1] = fgrRaw[p * 3 + 1];
      rgba[p * 4 + 2] = fgrRaw[p * 3 + 2];
      rgba[p * 4 + 3] = alphaBuf[p];
    }
    const fgWithAlpha = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    await sharp(blurredBg).resize(w, h).composite([{ input: fgWithAlpha }]).png()
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
  const report = {
    model: modelPath,
    frames: files.length,
    frameSize: `${W}x${H}`,
    gpu: false,
    executionProvider: 'cpu',
    avgMsPerFrame: Math.round(avgMs),
    avgSecPerFrame: +(avgMs / 1000).toFixed(3),
    minMs: Math.min(...perFrameMs),
    maxMs: Math.max(...perFrameMs),
  };
  fs.writeFileSync(path.join(outDir, 'matte-report.json'), JSON.stringify(report, null, 2));
  console.log('Report:', report);
}

main().catch(e => { console.error(e); process.exit(1); });
