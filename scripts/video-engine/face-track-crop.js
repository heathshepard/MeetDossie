#!/usr/bin/env node
/**
 * face-track-crop.js — face-tracked auto-framing / punch-in.
 *
 * Detects the face per frame with the Ultra-Light-Fast-Generic-Face-Detector
 * (RFB-320, ONNX, ~1.27MB, from github.com/Linzaer/Ultra-Light-Fast-Generic-
 * Face-Detector-1MB — a standard SSD-style face detector with hardcoded
 * anchor priors, decoded + NMS'd here), then smooths the face-center path
 * with an EMA filter and crops a 9:16 (1080x1920 by default) window that
 * follows the face without jitter — a fixed zoom factor punch-in, panned
 * frame to frame.
 *
 * Usage:
 *   node scripts/video-engine/face-track-crop.js --frames <dir of PNGs> \
 *     --out <dir> [--zoom 1.35] [--smooth 0.15] [--w 1080] [--h 1920]
 *
 * Outputs:
 *   <out>/crop-path.json   - per-frame detected + smoothed crop rect
 *   <out>/cropped/f###.png - the cropped+scaled 1080x1920 frames
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

// --- RFB-320 prior box generation (matches the reference PyTorch repo) ---
const IMG_W = 320, IMG_H = 240;
const STRIDES = [8, 16, 32, 64];
const MIN_BOXES = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]];

function generatePriors() {
  const featureMapWs = STRIDES.map(s => Math.ceil(IMG_W / s));
  const featureMapHs = STRIDES.map(s => Math.ceil(IMG_H / s));
  const priors = [];
  for (let idx = 0; idx < STRIDES.length; idx++) {
    const fw = featureMapWs[idx], fh = featureMapHs[idx];
    const boxSizes = MIN_BOXES[idx];
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const cx = (x + 0.5) / fw;
        const cy = (y + 0.5) / fh;
        for (const size of boxSizes) {
          const w = size / IMG_W;
          const h = size / IMG_H;
          priors.push([cx, cy, w, h]);
        }
      }
    }
  }
  return priors;
}
const PRIORS = generatePriors();
const CENTER_VARIANCE = 0.1, SIZE_VARIANCE = 0.2;

function decodeBoxes(boxesRaw, scoresRaw, numPriors) {
  const results = [];
  for (let i = 0; i < numPriors; i++) {
    const score = scoresRaw[i * 2 + 1]; // class 1 = face
    if (score < 0.6) continue;
    const [pcx, pcy, pw, ph] = PRIORS[i];
    const dx = boxesRaw[i * 4], dy = boxesRaw[i * 4 + 1];
    const dw = boxesRaw[i * 4 + 2], dh = boxesRaw[i * 4 + 3];
    const cx = dx * CENTER_VARIANCE * pw + pcx;
    const cy = dy * CENTER_VARIANCE * ph + pcy;
    const w = Math.exp(dw * SIZE_VARIANCE) * pw;
    const h = Math.exp(dh * SIZE_VARIANCE) * ph;
    const x1 = cx - w / 2, y1 = cy - h / 2, x2 = cx + w / 2, y2 = cy + h / 2;
    results.push({ x1, y1, x2, y2, score });
  }
  // NMS
  results.sort((a, b) => b.score - a.score);
  const kept = [];
  const iou = (a, b) => {
    const ix1 = Math.max(a.x1, b.x1), iy1 = Math.max(a.y1, b.y1);
    const ix2 = Math.min(a.x2, b.x2), iy2 = Math.min(a.y2, b.y2);
    const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
    const inter = iw * ih;
    const areaA = (a.x2 - a.x1) * (a.y2 - a.y1);
    const areaB = (b.x2 - b.x1) * (b.y2 - b.y1);
    return inter / (areaA + areaB - inter);
  };
  for (const box of results) {
    if (kept.every(k => iou(k, box) < 0.4)) kept.push(box);
    if (kept.length >= 5) break;
  }
  return kept;
}

async function detectFace(session, filePath) {
  const meta = await sharp(filePath).metadata();
  const resized = await sharp(filePath).resize(IMG_W, IMG_H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
  const floatData = new Float32Array(3 * IMG_W * IMG_H);
  const plane = IMG_W * IMG_H;
  // model expects (x - 127) / 128 normalization, RGB, CHW
  for (let p = 0; p < plane; p++) {
    floatData[p] = (resized[p * 3] - 127) / 128;
    floatData[plane + p] = (resized[p * 3 + 1] - 127) / 128;
    floatData[2 * plane + p] = (resized[p * 3 + 2] - 127) / 128;
  }
  const input = new ort.Tensor('float32', floatData, [1, 3, IMG_H, IMG_W]);
  const results = await session.run({ input });
  const scores = results.scores.data;
  const boxes = results.boxes.data;
  const numPriors = PRIORS.length;
  const faces = decodeBoxes(boxes, scores, numPriors);
  if (faces.length === 0) return { found: false, srcW: meta.width, srcH: meta.height };
  const best = faces[0];
  return {
    found: true,
    srcW: meta.width, srcH: meta.height,
    // face center + size in SOURCE pixel coords
    cx: ((best.x1 + best.x2) / 2) * meta.width,
    cy: ((best.y1 + best.y2) / 2) * meta.height,
    fw: (best.x2 - best.x1) * meta.width,
    fh: (best.y2 - best.y1) * meta.height,
    score: best.score,
  };
}

async function main() {
  const args = parseArgs();
  const framesDir = args.frames;
  const outDir = args.out;
  const zoom = parseFloat(args.zoom || '1.35');
  const smooth = parseFloat(args.smooth || '0.15'); // EMA alpha; lower = smoother/less jitter
  const outW = parseInt(args.w || '1080', 10);
  const outH = parseInt(args.h || '1920', 10);
  const modelPath = args.model || 'models/version-RFB-320.onnx';
  const sampleEvery = parseInt(args.sampleEvery || '1', 10); // run detection every Nth frame, interpolate the rest — big speedup on long clips
  if (!framesDir || !outDir) {
    console.error('Usage: face-track-crop.js --frames <dir> --out <dir> [--zoom 1.35] [--smooth 0.15]');
    process.exit(1);
  }
  fs.mkdirSync(path.join(outDir, 'cropped'), { recursive: true });

  const session = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], logSeverityLevel: 3 });
  const files = fs.readdirSync(framesDir).filter(f => /\.png$/i.test(f)).sort();

  const detections = [];
  let lastReal = null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (sampleEvery > 1 && i % sampleEvery !== 0) {
      detections.push({ file: f, sampled: false });
      continue;
    }
    const d = await detectFace(session, path.join(framesDir, f));
    detections.push({ file: f, sampled: true, ...d });
  }
  // Interpolate skipped frames linearly between the nearest sampled detections.
  if (sampleEvery > 1) {
    for (let i = 0; i < detections.length; i++) {
      if (detections[i].sampled) continue;
      let prev = null, next = null;
      for (let j = i - 1; j >= 0; j--) if (detections[j].sampled) { prev = detections[j]; break; }
      for (let j = i + 1; j < detections.length; j++) if (detections[j].sampled) { next = detections[j]; break; }
      const base = prev || next;
      if (!base) continue;
      if (prev && next && prev.found && next.found) {
        const t = (i - detections.indexOf(prev)) / (detections.indexOf(next) - detections.indexOf(prev));
        detections[i] = {
          file: detections[i].file, sampled: false, found: true,
          srcW: base.srcW, srcH: base.srcH,
          cx: prev.cx + (next.cx - prev.cx) * t, cy: prev.cy + (next.cy - prev.cy) * t,
          fw: base.fw, fh: base.fh, score: Math.min(prev.score, next.score),
        };
      } else {
        detections[i] = { file: detections[i].file, sampled: false, ...base, file: detections[i].file };
      }
    }
  }

  const targetAspect = outW / outH;
  let emaCx = null, emaCy = null;
  const cropPath = [];
  for (const d of detections) {
    const srcW = d.srcW, srcH = d.srcH;
    // crop window sized by zoom (smaller window = more punch-in), matching target aspect
    let cropH = srcH / zoom;
    let cropW = cropH * targetAspect;
    if (cropW > srcW) { cropW = srcW; cropH = cropW / targetAspect; }

    let faceCx = d.found ? d.cx : srcW / 2;
    let faceCy = d.found ? d.cy : srcH * 0.42; // bias toward upper-third if no face found (typical talking-head framing)

    if (emaCx === null) { emaCx = faceCx; emaCy = faceCy; }
    else {
      emaCx = emaCx + smooth * (faceCx - emaCx);
      emaCy = emaCy + smooth * (faceCy - emaCy);
    }

    let cropX = emaCx - cropW / 2;
    let cropY = emaCy - cropH / 2.6; // keep face in upper-middle third, not dead-center
    cropX = Math.max(0, Math.min(srcW - cropW, cropX));
    cropY = Math.max(0, Math.min(srcH - cropH, cropY));

    cropPath.push({
      file: d.file, faceFound: d.found, faceScore: d.score || 0,
      rawFaceCx: d.found ? Math.round(d.cx) : null, rawFaceCy: d.found ? Math.round(d.cy) : null,
      smoothedCx: Math.round(emaCx), smoothedCy: Math.round(emaCy),
      crop: { x: Math.round(cropX), y: Math.round(cropY), w: Math.round(cropW), h: Math.round(cropH) },
    });
  }

  fs.writeFileSync(path.join(outDir, 'crop-path.json'), JSON.stringify({ zoom, smooth, outW, outH, frames: cropPath }, null, 2));

  // Render the cropped/scaled frames.
  for (const c of cropPath) {
    const inPath = path.join(framesDir, c.file);
    await sharp(inPath)
      .extract({ left: c.crop.x, top: c.crop.y, width: c.crop.w, height: c.crop.h })
      .resize(outW, outH)
      .png()
      .toFile(path.join(outDir, 'cropped', c.file));
  }

  const foundCount = cropPath.filter(c => c.faceFound).length;
  // Jitter metric: mean absolute frame-to-frame movement of the smoothed center
  let jitter = 0;
  for (let i = 1; i < cropPath.length; i++) {
    jitter += Math.abs(cropPath[i].smoothedCx - cropPath[i - 1].smoothedCx) + Math.abs(cropPath[i].smoothedCy - cropPath[i - 1].smoothedCy);
  }
  jitter = cropPath.length > 1 ? jitter / (cropPath.length - 1) : 0;

  console.log(JSON.stringify({ frames: cropPath.length, facesFound: foundCount, avgPxMovementPerFrame: Math.round(jitter) }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
