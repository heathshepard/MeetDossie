#!/usr/bin/env node
/**
 * face-detect-lib.js — the RFB-320 face detector, extracted from
 * face-track-crop.js so recording-preset.js's auto-detection and the
 * tracker share ONE implementation.
 *
 * This was inline in face-track-crop.js until 2026-09-22. It moved because
 * preset auto-detection needs the same detector, and a second copy would be
 * a second thing to keep in sync with the model's actual output layout —
 * which is exactly the bug the comment on decodeBoxes() describes.
 *
 * Model: Ultra-Light-Fast-Generic-Face-Detector RFB-320 (ONNX, ~1.27 MB),
 * github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB.
 */
'use strict';
const ort = require('onnxruntime-node');
const sharp = require('sharp');

const IMG_W = 320, IMG_H = 240;
const STRIDES = [8, 16, 32, 64];
const MIN_BOXES = [[10, 16, 24], [32, 48], [64, 96], [128, 192, 256]];

function generatePriors() {
  const featureMapWs = STRIDES.map(s => Math.ceil(IMG_W / s));
  const featureMapHs = STRIDES.map(s => Math.ceil(IMG_H / s));
  const priors = [];
  for (let idx = 0; idx < STRIDES.length; idx++) {
    const fw = featureMapWs[idx], fh = featureMapHs[idx];
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const cx = (x + 0.5) / fw, cy = (y + 0.5) / fh;
        for (const size of MIN_BOXES[idx]) priors.push([cx, cy, size / IMG_W, size / IMG_H]);
      }
    }
  }
  return priors;
}
const PRIORS = generatePriors();

// 2026-09-21 (video-engine-reviewer-0921, verified again on consolidation
// 2026-09-22): the exported version-RFB-320.onnx already applies the SSD
// decode INSIDE the graph — `boxes` is [1, 4420, 4] of normalized CORNER
// boxes (x1, y1, x2, y2), not prior offsets. Re-decoding them against PRIORS
// snapped every box to a prior's centre/size, so the crop path tracked prior
// grid points near the face instead of the face, and box sizes came out
// quantized (0.45 / 0.61 / 0.84 of the frame). review-lib/video.js measured
// it. PRIORS is kept only as the record of how the model is laid out.
function decodeBoxes(boxesRaw, scoresRaw, numPriors) {
  const results = [];
  for (let i = 0; i < numPriors; i++) {
    const score = scoresRaw[i * 2 + 1]; // class 1 = face
    if (score < 0.6) continue;
    results.push({ x1: boxesRaw[i * 4], y1: boxesRaw[i * 4 + 1], x2: boxesRaw[i * 4 + 2], y2: boxesRaw[i * 4 + 3], score });
  }
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

async function createSession(modelPathOverride) {
  const modelPath = require('./model-path.js').resolveModel('version-RFB-320.onnx', modelPathOverride);
  return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], logSeverityLevel: 3 });
}

/** Detect the highest-scoring face in one image file. Coords are SOURCE pixels. */
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
  const faces = decodeBoxes(results.boxes.data, results.scores.data, PRIORS.length);
  if (faces.length === 0) return { found: false, srcW: meta.width, srcH: meta.height };
  const best = faces[0];
  return {
    found: true,
    srcW: meta.width, srcH: meta.height,
    cx: ((best.x1 + best.x2) / 2) * meta.width,
    cy: ((best.y1 + best.y2) / 2) * meta.height,
    fw: (best.x2 - best.x1) * meta.width,
    fh: (best.y2 - best.y1) * meta.height,
    score: best.score,
  };
}

/** Convenience for one-off calls (preset detection) — creates and drops a session. */
let _sharedSession = null;
async function detectFaceInFile(filePath, modelPathOverride) {
  if (!_sharedSession) _sharedSession = await createSession(modelPathOverride);
  return detectFace(_sharedSession, filePath);
}

module.exports = { createSession, detectFace, detectFaceInFile, decodeBoxes, generatePriors, PRIORS, IMG_W, IMG_H };
