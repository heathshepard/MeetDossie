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
 *     --out <dir> [--zoom 1.35] [--smooth 0.15] [--w 1080] [--h 1920] \
 *     [--fps 30] [--headroomFraction 0.33] [--chinMarginFraction 0.08] \
 *     [--shotPlan <shot-plan.json>] [--punchZoomMax 1.6] [--maxScaleRatio 1.3] \
 *     [--openOnFace] [--hookZoomBoost 1.1] [--hookDurationSec 2.2]
 *
 * Outputs:
 *   <out>/crop-path.json   - per-frame detected + smoothed crop rect + face
 *                            box size + headroom fraction (feeds the note-4
 *                            framing gate directly, no re-detection needed)
 *   <out>/cropped/f###.png - the cropped+scaled 1080x1920 frames
 *
 * FRAMING DEFAULTS (Heath's note 4, every trial cut so far):
 *   - Headroom ~= 1/3 of frame height above the shoulder line (top-of-head
 *     positioned at `headroomFraction` down from frame top, not dead-center
 *     and not clipped).
 *   - Full chin kept with a small margin below it (`chinMarginFraction`).
 *   - Face box top/bottom are derived from the detector's box using
 *     HEAD_TOP_ABOVE_BOX / CHIN_BELOW_BOX approximation factors (RFB-320's
 *     box is roughly hairline-to-chin, not scalp-to-jaw) — these are
 *     estimates, not measured from Heath's own footage; flagged in the
 *     report as needing a real calibration pass against labeled frames.
 *
 * SHOT PLAN (--shotPlan, 2026-09-22)
 *   Without it this file produces ONE framing for the whole clip plus a
 *   single hook punch-in — which is how dossie_trial_06.mp4 ended up 35.7 s
 *   long with its first picture change at 27.0 s, in flat violation of §4.
 *   With it, each shot in the plan gets its own zoom and the crop HARD-CUTS
 *   between them: the EMA face-follow state is reset at every boundary so
 *   the new framing snaps rather than ramping (a ramp reads as a zoom
 *   effect; §4 wants an intentional cut). Shot boundaries come from
 *   shot-plan.js, which derives them from sentence/clause boundaries in the
 *   transcript, so cuts land on meaning. NO time is removed and NO audio is
 *   touched here, so a shot cut cannot clip a word or move lip sync.
 *
 *   --punchZoomMax caps the tightest shot (review.js's "floating head"
 *   finding) and --maxScaleRatio caps how far two consecutive shots may
 *   differ (its "jarring scale jump" finding). Both clamp the plan's own
 *   numbers here too, so a stale plan can't push past the cap.
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
  const modelPath = require('./model-path.js').resolveModel('version-RFB-320.onnx', args.model);
  const sampleEvery = parseInt(args.sampleEvery || '1', 10); // run detection every Nth frame, interpolate the rest — big speedup on long clips
  const fps = parseFloat(args.fps || '30');
  const headroomFraction = parseFloat(args.headroomFraction || '0.33');
  const chinMarginFraction = parseFloat(args.chinMarginFraction || '0.08');
  const hookZoomBoost = parseFloat(args.hookZoomBoost || '1.1');
  const hookDurationSec = parseFloat(args.hookDurationSec || '2.2');
  const hookEaseSec = parseFloat(args.hookEaseSec || '1.0');
  // --- shot plan (see file header) ---
  const shotPlan = args.shotPlan && fs.existsSync(args.shotPlan) ? JSON.parse(fs.readFileSync(args.shotPlan, 'utf8')) : null;
  const punchZoomMax = parseFloat(args.punchZoomMax || '1.6');
  const maxScaleRatio = parseFloat(args.maxScaleRatio || '1.3');
  const openOnFace = !!args.openOnFace && String(args.openOnFace) !== '0' && String(args.openOnFace) !== 'false';
  // RFB-320's detected box is roughly hairline-to-chin, not scalp-to-jaw —
  // approximation factors to recover actual head-top/chin from the box
  // (unmeasured against Heath's own footage — see file header).
  const HEAD_TOP_ABOVE_BOX = 0.35;
  const CHIN_BELOW_BOX = 0.12;
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

  // Adaptive zoom cap: the requested --zoom is a MAXIMUM (tightest), not a
  // fixed value — if the detected face is large enough that hitting the
  // requested zoom would leave no room for headroomFraction + chinMargin
  // (a close/tight selfie recording, which trial footage keeps being), the
  // base zoom is loosened just enough to fit the full framing target,
  // never tightened beyond what was asked. Still ONE uniform zoom for the
  // whole base clip — the hook punch-in is applied on top of this.
  const facesForMedian = detections.filter(d => d.found).map(d => d.fh).sort((a, b) => a - b);
  const medianFh = facesForMedian.length ? facesForMedian[Math.floor(facesForMedian.length / 2)] : null;
  let effectiveBaseZoom = zoom;
  if (medianFh && detections.length) {
    const srcHForCalc = detections.find(d => d.srcH)?.srcH;
    if (srcHForCalc) {
      const requiredSpanFactor = (1 + HEAD_TOP_ABOVE_BOX + CHIN_BELOW_BOX); // head-top-to-chin-bottom, in face-heights
      const availableFraction = (1 - headroomFraction - chinMarginFraction);
      const cropHRequired = medianFh * requiredSpanFactor / Math.max(0.05, availableFraction);
      const maxZoomForFraming = srcHForCalc / cropHRequired;
      if (maxZoomForFraming < zoom) {
        console.warn(`face-track-crop: requested zoom ${zoom} is too tight for the detected face size (median fh=${Math.round(medianFh)}px) to keep ${Math.round(headroomFraction * 100)}% headroom + chin margin — loosening base zoom to ${maxZoomForFraming.toFixed(3)}.`);
        effectiveBaseZoom = Math.max(1.0, maxZoomForFraming);
      }
    }
  }

  // --- resolve the shot plan into per-frame zoom targets --------------------
  // The plan's zooms are relative to the brief's requested base zoom; the
  // adaptive cap above may have loosened the real base, so rescale the plan
  // by the same factor instead of letting a plan number override a framing
  // constraint. Then clamp against punchZoomMax and maxScaleRatio.
  let resolvedShots = null;
  if (shotPlan && Array.isArray(shotPlan.shots) && shotPlan.shots.length) {
    const planBase = shotPlan.baseZoom || zoom;
    const rescale = effectiveBaseZoom / planBase;
    resolvedShots = shotPlan.shots.map(s => {
      let z = s.zoom * rescale;
      z = Math.min(z, punchZoomMax, effectiveBaseZoom * maxScaleRatio);
      z = Math.max(z, 1.0);
      return { ...s, resolvedZoom: z };
    });
    console.log(`face-track-crop: shot plan active — ${resolvedShots.length} shots, ${resolvedShots.length - 1} picture cuts, zooms ${resolvedShots.map(s => s.resolvedZoom.toFixed(3)).join('/')}`);
  }
  const shotAt = (tSec) => {
    if (!resolvedShots) return null;
    for (let i = 0; i < resolvedShots.length; i++) if (tSec >= resolvedShots[i].startSec && tSec < resolvedShots[i].endSec) return { shot: resolvedShots[i], idx: i };
    return { shot: resolvedShots[resolvedShots.length - 1], idx: resolvedShots.length - 1 };
  };

  // --openOnFace: back-fill the framing of the first frame that actually has
  // a face over any leading frames that don't, so the opening frame is
  // already composed on the subject instead of drifting in from a centred
  // fallback. If NO frame in the whole clip has a face this cannot help and
  // is reported as such — that is a source problem, not a framing one.
  let firstFaceIdx = detections.findIndex(d => d.found);
  if (openOnFace && firstFaceIdx > 0) {
    const anchor = detections[firstFaceIdx];
    for (let i = 0; i < firstFaceIdx; i++) detections[i] = { ...detections[i], found: true, backfilled: true, cx: anchor.cx, cy: anchor.cy, fw: anchor.fw, fh: anchor.fh, score: anchor.score };
    console.log(`face-track-crop: openOnFace back-filled ${firstFaceIdx} leading frame(s) from the first detected face at frame ${firstFaceIdx}`);
  }

  const targetAspect = outW / outH;
  let emaCx = null, emaCy = null, emaFh = null;
  let prevShotIdx = null;
  const cropPath = [];
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i];
    const srcW = d.srcW, srcH = d.srcH;
    const tSec = i / fps;

    let effectiveZoom = effectiveBaseZoom;
    let hookPhase = 'base';
    let shotIdx = null, shotFraming = null, isShotBoundary = false;
    const cur = shotAt(tSec);
    if (cur) {
      // SHOT PLAN MODE: one zoom per shot, hard cut between shots.
      effectiveZoom = cur.shot.resolvedZoom;
      hookPhase = cur.shot.framing;          // 'wide' | 'punch'
      shotIdx = cur.idx;
      shotFraming = cur.shot.framing;
      isShotBoundary = prevShotIdx !== null && prevShotIdx !== cur.idx;
      prevShotIdx = cur.idx;
    } else {
      // LEGACY MODE (no plan): ONE deliberate punch-in during the hook
      // window, eased back to base — never re-triggered. Kept so the engine
      // still works on footage with no usable transcript.
      if (tSec < hookDurationSec) {
        effectiveZoom = effectiveBaseZoom * hookZoomBoost;
        hookPhase = 'hook';
      } else if (tSec < hookDurationSec + hookEaseSec) {
        const t = (tSec - hookDurationSec) / hookEaseSec;
        effectiveZoom = effectiveBaseZoom * hookZoomBoost + (effectiveBaseZoom - effectiveBaseZoom * hookZoomBoost) * t;
        hookPhase = 'ease';
      }
    }

    // crop window sized by zoom (smaller window = more punch-in), matching target aspect
    let cropH = srcH / effectiveZoom;
    let cropW = cropH * targetAspect;
    if (cropW > srcW) { cropW = srcW; cropH = cropW / targetAspect; }

    let faceCx = d.found ? d.cx : srcW / 2;
    let faceCy = d.found ? d.cy : srcH * 0.42; // bias toward upper-third if no face found (typical talking-head framing)
    let faceFh = d.found ? d.fh : srcH * 0.22; // fallback assumed face height if never detected

    // A shot boundary is a CUT, not a move: snap the follow state to the new
    // framing instead of easing into it. Easing here is what makes an edit
    // read as a slow zoom effect rather than a deliberate second angle.
    if (emaCx === null || isShotBoundary) { emaCx = faceCx; emaCy = faceCy; emaFh = faceFh; }
    else {
      emaCx = emaCx + smooth * (faceCx - emaCx);
      emaCy = emaCy + smooth * (faceCy - emaCy);
      emaFh = emaFh + smooth * (faceFh - emaFh);
    }

    // Headroom/chin-margin driven vertical placement: recover approximate
    // head-top / chin-bottom from the detected box, then place the crop so
    // head-top sits headroomFraction down from the crop's top edge and
    // chin-bottom sits chinMarginFraction up from a natural shoulder line —
    // NOT a magic constant divisor on face center.
    const headTop = emaCy - emaFh / 2 - emaFh * HEAD_TOP_ABOVE_BOX;
    const chinBottom = emaCy + emaFh / 2 + emaFh * CHIN_BELOW_BOX;
    const desiredCropTopForHeadroom = headTop - cropH * headroomFraction;
    const desiredCropTopForChin = chinBottom - cropH * (1 - chinMarginFraction) - cropH * 0; // chin must stay above (1-chinMargin)*cropH from top
    // Prefer the headroom target; but never let it push the chin off the
    // bottom (or the top of the head above frame) — clamp between the two.
    let cropY = desiredCropTopForHeadroom;
    const minCropYForChin = chinBottom - cropH * (1 - chinMarginFraction);
    if (cropY < minCropYForChin) cropY = minCropYForChin; // chin was about to clip off bottom, prioritize chin
    if (cropY > headTop) cropY = headTop; // never clip the top of the head

    let cropX = emaCx - cropW / 2;
    cropX = Math.max(0, Math.min(srcW - cropW, cropX));
    cropY = Math.max(0, Math.min(srcH - cropH, cropY));

    const headroomPx = headTop - cropY;
    const actualHeadroomFraction = cropH > 0 ? headroomPx / cropH : null;
    const topClipped = headTop < cropY;

    cropPath.push({
      file: d.file, faceFound: d.found, faceScore: d.score || 0,
      tSec: +tSec.toFixed(3), hookPhase, effectiveZoom: +effectiveZoom.toFixed(4),
      shotIdx, shotFraming, isShotBoundary,
      rawFaceCx: d.found ? Math.round(d.cx) : null, rawFaceCy: d.found ? Math.round(d.cy) : null,
      smoothedCx: Math.round(emaCx), smoothedCy: Math.round(emaCy),
      faceBoxH: Math.round(emaFh), faceBoxHRatioOfCropH: cropH > 0 ? +(emaFh / cropH).toFixed(4) : null,
      headroomFraction: actualHeadroomFraction != null ? +actualHeadroomFraction.toFixed(4) : null,
      topClipped,
      crop: { x: Math.round(cropX), y: Math.round(cropY), w: Math.round(cropW), h: Math.round(cropH) },
    });
  }

  const shotBoundarySecs = cropPath.filter(c => c.isShotBoundary).map(c => c.tSec);
  fs.writeFileSync(path.join(outDir, 'crop-path.json'), JSON.stringify({
    zoom, smooth, outW, outH, fps, headroomFraction, chinMarginFraction, hookZoomBoost, hookDurationSec,
    shotPlanApplied: !!resolvedShots,
    shotCount: resolvedShots ? resolvedShots.length : 1,
    pictureCuts: shotBoundarySecs.length,
    shotBoundarySecs,
    punchZoomMax, maxScaleRatio, openOnFace,
    openOnFaceBackfilledFrames: openOnFace && firstFaceIdx > 0 ? firstFaceIdx : 0,
    noFaceAnywhere: firstFaceIdx === -1,
    frames: cropPath,
  }, null, 2));

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

  // Scale-variance metric across BASE-zoom frames only (excludes the
  // deliberate hook punch-in, which is supposed to differ) — feeds the
  // note-4 gate's "consistent scale across shots" check.
  // With a shot plan the "base" phase is named 'wide' — measure scale
  // consistency across the wide shots, which are the ones that are supposed
  // to match. Punch shots are deliberately different and must not count.
  const baseFrames = cropPath.filter(c => (c.hookPhase === 'base' || c.hookPhase === 'wide') && c.faceBoxHRatioOfCropH != null);
  const ratios = baseFrames.map(c => c.faceBoxHRatioOfCropH);
  const meanRatio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const scaleVariance = ratios.length ? ratios.reduce((s, r) => s + (r - meanRatio) ** 2, 0) / ratios.length : null;
  const topClippedCount = cropPath.filter(c => c.topClipped).length;
  const headroomVals = cropPath.map(c => c.headroomFraction).filter(v => v != null);
  const meanHeadroom = headroomVals.length ? headroomVals.reduce((a, b) => a + b, 0) / headroomVals.length : null;

  console.log(JSON.stringify({
    frames: cropPath.length, facesFound: foundCount, avgPxMovementPerFrame: Math.round(jitter),
    meanFaceBoxHRatioOfCropH: meanRatio != null ? +meanRatio.toFixed(4) : null,
    scaleVarianceBaseFrames: scaleVariance != null ? +scaleVariance.toFixed(6) : null,
    meanHeadroomFraction: meanHeadroom != null ? +meanHeadroom.toFixed(4) : null,
    topClippedFrames: topClippedCount,
    shotPlanApplied: !!resolvedShots,
    pictureCuts: shotBoundarySecs.length,
    shotBoundarySecs: shotBoundarySecs.map(t => +t.toFixed(2)),
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
