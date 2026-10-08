'use strict';
/**
 * review-lib/video.js — measured picture signals for review.js: frame
 * sampling, scene cuts, face geometry per sample (RFB-320 ONNX, same model
 * face-track-crop.js frames with), and a lip-sync estimate that needs no
 * source clip (mouth-region motion cross-correlated with the voice envelope).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const audio = require('./audio.js');

let ort = null, sharp = null;
function lazyDeps() {
  if (!ort) ort = require('onnxruntime-node');
  if (!sharp) sharp = require('sharp');
}

function ffprobe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,r_frame_rate,codec_type,codec_name:stream_side_data=rotation:stream_tags=rotate', '-of', 'json', file]).toString();
  const j = JSON.parse(out);
  const v = j.streams.find(s => s.codec_type === 'video');
  const a = j.streams.find(s => s.codec_type === 'audio');
  const fps = v ? v.r_frame_rate.split('/').reduce((x, y) => x / y) : null;
  // Phone footage carries a rotation tag; ffmpeg auto-rotates on decode, so
  // report the DISPLAY size (what every frame we pull will actually be).
  let rot = 0;
  if (v) {
    const sd = (v.side_data_list || []).find(d => d.rotation != null);
    rot = sd ? +sd.rotation : (v.tags && v.tags.rotate ? +v.tags.rotate : 0);
  }
  const swap = Math.abs(rot % 180) === 90;
  return { durationSec: +j.format.duration, width: v && (swap ? v.height : v.width), height: v && (swap ? v.width : v.height), fps, hasAudio: !!a, rotation: rot };
}

/** Times (s) where ffmpeg's scene detector fires above `threshold`. 0.08 catches same-face zoom/shot changes; 0.25 only hard cutaways. */
function sceneCuts(file, threshold = 0.08) {
  const r = spawnSync('ffmpeg', ['-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const txt = (r.stderr || '') + (r.stdout || '');
  const times = [];
  for (const m of txt.matchAll(/pts_time:([\d.]+)/g)) times.push(+(+m[1]).toFixed(3));
  return times.filter(t => t > 0.1);
}

/** One JPEG per requested time, `width` px wide, returns [{t, file}]. */
function sampleFrames(file, times, outDir, width = 540, prefix = 's') {
  fs.mkdirSync(outDir, { recursive: true });
  const out = [];
  for (const t of times) {
    const f = path.join(outDir, `${prefix}-${t.toFixed(2).replace('.', '_')}.jpg`);
    if (!fs.existsSync(f)) {
      execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(Math.max(0, t)), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', f]);
      // a request past the last decodable frame yields no file; back off a little and retry once
      if (!fs.existsSync(f) && t > 0.3) execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(t - 0.25), '-i', file, '-frames:v', '1', '-vf', `scale=${width}:-2`, '-q:v', '3', f]);
    }
    if (fs.existsSync(f)) out.push({ t, file: f });
  }
  return out;
}

/** A contact sheet (grid) of the given frame files, tiles `tileW` wide, `cols` per row. */
async function contactSheet(frameFiles, outFile, { cols = 3, tileW = 300, aspect = 16 / 9 } = {}) {
  lazyDeps();
  const tileH = Math.round(tileW * aspect);
  const rows = Math.ceil(frameFiles.length / cols);
  const tiles = [];
  for (let i = 0; i < frameFiles.length; i++) {
    const buf = await sharp(frameFiles[i]).resize(tileW, tileH, { fit: 'cover' }).toBuffer();
    tiles.push({ input: buf, left: (i % cols) * tileW, top: Math.floor(i / cols) * tileH });
  }
  await sharp({ create: { width: cols * tileW, height: rows * tileH, channels: 3, background: '#000' } }).composite(tiles).jpeg({ quality: 82 }).toFile(outFile);
  return outFile;
}

// ── RFB-320 face detector ──
// The exported version-RFB-320.onnx already runs the SSD decode inside the
// graph: `boxes` is [1, 4420, 4] of normalized CORNER boxes (x1, y1, x2, y2)
// and `scores` is [1, 4420, 2] with class 1 = face. Do NOT re-decode against
// prior boxes — that snaps every box to a prior's centre/size and was why
// the first cut of this file measured face heights of 0.45 / 0.61 / 0.84
// exactly, in every trial. (face-track-crop.js still carries that re-decode.)
function nmsBoxes(boxesRaw, scoresRaw) {
  const results = [];
  for (let i = 0; i < scoresRaw.length / 2; i++) {
    const score = scoresRaw[i * 2 + 1];
    if (score < 0.6) continue;
    results.push({ x1: boxesRaw[i * 4], y1: boxesRaw[i * 4 + 1], x2: boxesRaw[i * 4 + 2], y2: boxesRaw[i * 4 + 3], score });
  }
  results.sort((a, b) => b.score - a.score);
  const kept = [];
  const iou = (a, b) => { const iw = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)), ih = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1)); const inter = iw * ih; return inter / ((a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter); };
  for (const b of results) { if (kept.every(k => iou(k, b) < 0.4)) kept.push(b); if (kept.length >= 3) break; }
  return kept;
}
const IMG_W = 320, IMG_H = 240;
async function faceSession(modelPath) {
  lazyDeps();
  return ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'], logSeverityLevel: 3 });
}
/**
 * Largest face in an image, as fractions of the image (x1,y1,x2,y2 in 0..1),
 * or null. The frame is letterboxed into the detector's 320x240 (aspect
 * preserved, black bars) — squashing a 9:16 frame to 4:3 with fit:'fill'
 * makes the detector return a box covering ~90% of the frame height, which
 * is useless for any geometry judgment.
 */
async function detectFace(session, input) {
  lazyDeps();
  const meta = await sharp(input).metadata();
  const w = meta.width, h = meta.height;
  const sc = Math.min(IMG_W / w, IMG_H / h);
  const rw = Math.max(1, Math.round(w * sc)), rh = Math.max(1, Math.round(h * sc));
  const ox = Math.floor((IMG_W - rw) / 2), oy = Math.floor((IMG_H - rh) / 2);
  const resized = await sharp(input).resize(rw, rh, { fit: 'fill' }).removeAlpha().toColourspace('srgb')
    .extend({ top: oy, bottom: IMG_H - rh - oy, left: ox, right: IMG_W - rw - ox, background: '#000' })
    .raw().toBuffer();
  const plane = IMG_W * IMG_H;
  const f = new Float32Array(3 * plane);
  for (let p = 0; p < plane; p++) { f[p] = (resized[p * 3] - 127) / 128; f[plane + p] = (resized[p * 3 + 1] - 127) / 128; f[2 * plane + p] = (resized[p * 3 + 2] - 127) / 128; }
  const res = await session.run({ input: new ort.Tensor('float32', f, [1, 3, IMG_H, IMG_W]) });
  const faces = nmsBoxes(res.boxes.data, res.scores.data);
  if (!faces.length) return null;
  faces.sort((a, b) => (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1));
  const b = faces[0];
  // map back from the padded 320x240 canvas to fractions of the original image
  const mx = (v) => Math.max(0, Math.min(1, (v * IMG_W - ox) / rw));
  const my = (v) => Math.max(0, Math.min(1, (v * IMG_H - oy) / rh));
  return { x1: mx(b.x1), y1: my(b.y1), x2: mx(b.x2), y2: my(b.y2), score: b.score, rawTop: (b.y1 * IMG_H - oy) / rh };
}

/**
 * Face geometry per sampled frame, in frame fractions. faceH = box height /
 * frame height. headroom = box top / frame height (negative-ish => clipped).
 */
async function faceMetrics(session, samples) {
  const out = [];
  for (const s of samples) {
    const box = await detectFace(session, s.file);
    out.push(box ? { t: s.t, found: true, faceH: +(box.y2 - box.y1).toFixed(3), faceW: +(box.x2 - box.x1).toFixed(3), cx: +((box.x1 + box.x2) / 2).toFixed(3), cy: +((box.y1 + box.y2) / 2).toFixed(3), top: +box.rawTop.toFixed(3), bottom: +box.y2.toFixed(3), score: +box.score.toFixed(2) }
      : { t: s.t, found: false });
  }
  return out;
}

/**
 * A/V sync against the SOURCE take (no reference-free method survived
 * validation — mouth-motion/envelope correlation could not see a synthetic
 * +200 ms shift; single-frame face-crop matching had no usable peak either).
 * For each probe time in the output:
 *   1. audio: cross-correlate 0.8 s of output voice against the whole source
 *      voice (coarse 4-sample stride, then exact) -> source time of the audio.
 *   2. picture: build a face-box MOTION series (mean |frame - previous| over
 *      the face box, at the output fps) for `winSec` of output, and the same
 *      series from the source around the audio match; cross-correlate the two
 *      series -> source time of the picture. Same footage => sharp peak, and
 *      crop / zoom / matte / grade / captions do not change the motion timing.
 *   offsetMs = audio - picture. Positive = audio LATE vs picture.
 * Probe windows that contain an output cut are skipped (a cut is a motion
 * spike the source does not have).
 */
async function syncAgainstSource(outFile, srcFile, session, probeTimes, { cuts = [], winSec = 2.0 } = {}) {
  lazyDeps();
  const sr = audio.SR;
  const outPcm = audio.decodePcm(outFile);
  const srcPcm = audio.decodePcm(srcFile);
  const outMeta = ffprobe(outFile);
  const fps = Math.round(outMeta.fps || 30);
  const results = [];
  for (const tOut of probeTimes) {
    if (cuts.some(c => c > tOut - 0.1 && c < tOut + winSec + 0.1)) { results.push({ tOut, ok: false, reason: 'window crosses a cut' }); continue; }
    const WIN = 0.8;
    const a = outPcm.subarray(Math.round((tOut + winSec / 2 - WIN / 2) * sr), Math.round((tOut + winSec / 2 + WIN / 2) * sr));
    if (a.length < WIN * sr * 0.9) { results.push({ tOut, ok: false, reason: 'past end of audio' }); continue; }
    const xc = xcorr(a, srcPcm, 4);
    if (!xc || xc.corr < 0.5) { results.push({ tOut, ok: false, reason: `audio not found in source (corr ${xc ? xc.corr.toFixed(2) : 'n/a'})` }); continue; }
    const tSrcAudioStart = xc.lag / sr - winSec / 2 + WIN / 2; // source time that lines up with output tOut, per the audio
    // output motion series
    const oFrames = await framesGray(outFile, tOut, winSec, fps, 360);
    const ob = await detectFace(session, await sharp(oFrames.raw.subarray(0, oFrames.fsz), { raw: { width: oFrames.w, height: oFrames.h, channels: 1 } }).png().toBuffer());
    if (!ob) { results.push({ tOut, ok: false, reason: 'no face in output window' }); continue; }
    const oMotion = motionSeries(oFrames, ob);
    // source motion series over a wider window so we can slide ±pad
    const pad = 0.6;
    const s0 = Math.max(0, tSrcAudioStart - pad);
    const sFrames = await framesGray(srcFile, s0, winSec + 2 * pad, fps * 2, 360);
    const sbMid = Math.floor(sFrames.n / 2);
    const sb = await detectFace(session, await sharp(sFrames.raw.subarray(sbMid * sFrames.fsz, (sbMid + 1) * sFrames.fsz), { raw: { width: sFrames.w, height: sFrames.h, channels: 1 } }).png().toBuffer());
    if (!sb) { results.push({ tOut, ok: false, reason: 'no face in source window' }); continue; }
    const sMotion = motionSeries(sFrames, sb, 2);
    const m = seriesMatch(oMotion, sMotion, 2);
    if (!m) { results.push({ tOut, ok: false, reason: 'motion series too short' }); continue; }
    const tSrcVideoStart = s0 + m.lag / (fps * 2);
    const offsetMs = Math.round((tSrcAudioStart - tSrcVideoStart) * 1000);
    results.push({ tOut, ok: true, offsetMs, audioCorr: +xc.corr.toFixed(3), motionCorr: +m.r.toFixed(3), motionMargin: +m.margin.toFixed(2), tSrcAudio: +tSrcAudioStart.toFixed(3), tSrcVideo: +tSrcVideoStart.toFixed(3) });
  }
  const good = results.filter(r => r.ok && r.motionCorr >= 0.6 && r.motionMargin >= 1.15);
  const offsets = good.map(r => r.offsetMs).sort((x, y) => x - y);
  return { probes: results, medianOffsetMs: offsets.length ? offsets[offsets.length >> 1] : null, maxAbsOffsetMs: offsets.length ? Math.max(...offsets.map(Math.abs)) : null, measured: good.length, resolutionMs: Math.round(500 / fps) };
}

/** mean |f[i]-f[i-step]| inside the face box, per frame (first `step` entries = 0). */
function motionSeries(frames, box, step = 1) {
  const W = frames.w, H = frames.h, fsz = frames.fsz;
  const x1 = Math.max(0, Math.round(box.x1 * W)), x2 = Math.min(W, Math.round(box.x2 * W));
  const y1 = Math.max(0, Math.round(box.y1 * H)), y2 = Math.min(H, Math.round(box.y2 * H));
  const out = new Float32Array(frames.n);
  for (let i = step; i < frames.n; i++) {
    let d = 0, c = 0;
    const A = frames.raw.subarray(i * fsz, (i + 1) * fsz), B = frames.raw.subarray((i - step) * fsz, (i - step + 1) * fsz);
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x += 1) { const p = y * W + x; d += Math.abs(A[p] - B[p]); c++; }
    out[i] = c ? d / c : 0;
  }
  return out;
}
/**
 * Slide the output series a (1 sample per output frame, a[i] = diff of
 * frames i-1,i) over the source series b sampled every `stride` entries
 * (b built at stride x fps with diffs `stride` apart). Returns the best lag
 * in b's sample units (i.e. half-frames when stride=2), the normalized
 * correlation r, and peak / second-peak margin.
 */
function seriesMatch(a, b, stride = 1) {
  const n = a.length - 1; // skip index 0 (no previous frame)
  if (n < 10 || b.length < n * stride + stride) return null;
  const za = zscore(Array.from(a.subarray(1)));
  const out = [];
  for (let lag = stride; lag + (n - 1) * stride < b.length; lag++) {
    const seg = []; for (let i = 0; i < n; i++) seg.push(b[lag + i * stride]);
    const zb = zscore(seg);
    let s = 0; for (let i = 0; i < n; i++) s += za[i] * zb[i];
    out.push({ lag: lag - stride, r: s / n }); // b[lag] is the diff ending at source sample `lag`; output a[1] ends at frame 1 => window start = lag - stride
  }
  out.sort((x, y) => y.r - x.r);
  const best = out[0];
  const second = out.find(o => Math.abs(o.lag - best.lag) > 2 * stride) || { r: 0 };
  return { lag: best.lag, r: best.r, margin: best.r / Math.max(1e-6, second.r) };
}
function zscore(arr) { const m = arr.reduce((p, q) => p + q, 0) / arr.length; const sd = Math.sqrt(arr.reduce((p, q) => p + (q - m) ** 2, 0) / arr.length) || 1; return arr.map(v => (v - m) / sd); }

function xcorr(a, b, stride) {
  // normalized cross-correlation of a (short) slid over b (long); coarse pass then refine ±stride*2
  let sa = 0; for (const v of a) sa += v * v;
  if (sa === 0) return null;
  const n = a.length, maxS = b.length - n;
  let best = -2, bl = 0;
  for (let s = 0; s <= maxS; s += stride) {
    let d = 0, sb = 0;
    for (let i = 0; i < n; i += 2) { const x = b[s + i]; d += a[i] * x; sb += x * x; }
    const c = d / Math.sqrt(sa * sb + 1e-9);
    if (c > best) { best = c; bl = s; }
  }
  for (let s = Math.max(0, bl - stride * 2); s <= Math.min(maxS, bl + stride * 2); s++) {
    let d = 0, sb = 0;
    for (let i = 0; i < n; i++) { const x = b[s + i]; d += a[i] * x; sb += x * x; }
    const c = d / Math.sqrt(sa * sb + 1e-9);
    if (c > best) { best = c; bl = s; }
  }
  return { lag: bl, corr: best };
}

async function framesGray(file, t0, dur, fps, W) {
  const meta = ffprobe(file);
  const H = Math.round(W * meta.height / meta.width / 2) * 2;
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t0), '-t', String(dur), '-i', file, '-vf', `fps=${fps},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 30 });
  const fsz = W * H;
  return { raw, w: W, h: H, fsz, n: Math.floor(raw.length / fsz) };
}

/**
 * Grid of face crops (one per sample that has a face), `cols` x rows, each
 * tile `tileW` square around the face box — dense enough to judge eye
 * contact / script reading across the whole runtime (§5), which full-frame
 * contact sheets are too small for.
 */
async function faceGrid(video, faceSamples, outFile, { cols = 4, tileW = 220, max = 16 } = {}) {
  lazyDeps();
  const picks = faceSamples.filter(f => f.found && f.faceH >= 0.12);
  const step = Math.max(1, picks.length / max);
  const chosen = [];
  for (let i = 0; i < picks.length && chosen.length < max; i += step) chosen.push(picks[Math.floor(i)]);
  if (!chosen.length) return null;
  const meta = ffprobe(video);
  const tiles = [];
  for (let i = 0; i < chosen.length; i++) {
    const f = chosen[i];
    const size = Math.round(Math.min(1, f.faceW * 1.35) * meta.width);
    const cx = Math.round(f.cx * meta.width), cy = Math.round(f.cy * meta.height);
    const x = Math.max(0, Math.min(meta.width - size, cx - size / 2)), y = Math.max(0, Math.min(meta.height - size, cy - size / 2));
    const buf = execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', String(f.t), '-i', video, '-frames:v', '1', '-vf', `crop=${size}:${size}:${x}:${y},scale=${tileW}:${tileW}`, '-f', 'image2', '-vcodec', 'mjpeg', '-q:v', '3', '-'], { maxBuffer: 1 << 24 });
    tiles.push({ input: buf, left: (i % cols) * tileW, top: Math.floor(i / cols) * tileW });
  }
  const rows = Math.ceil(chosen.length / cols);
  await sharp({ create: { width: cols * tileW, height: rows * tileW, channels: 3, background: '#000' } }).composite(tiles).jpeg({ quality: 82 }).toFile(outFile);
  return { file: outFile, times: chosen.map(c => c.t), cols, rows };
}

/** Mean luma (0-255) of a frame at t — a near-zero value is an accidental black frame (§17 TECHNICAL). */
function frameLuma(video, t) {
  try {
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, t)), '-i', video, '-frames:v', '1', '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 20 });
    if (!raw.length) return null;
    let s = 0; for (const v of raw) s += v; return +(s / raw.length).toFixed(1);
  } catch { return null; }
}

/** Probe start times for syncAgainstSource: one per uncut stretch >= winSec+0.3, spread over the runtime, max `max`. */
function syncProbeTimes(durationSec, cuts, winSec = 2.0, max = 6) {
  const bounds = [0, ...cuts.filter(c => c > 0.2 && c < durationSec - 0.2).sort((a, b) => a - b), durationSec];
  const probes = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1];
    if (b - a >= winSec + 0.3) probes.push(+(a + 0.15).toFixed(2));
  }
  if (probes.length <= max) return probes;
  const step = probes.length / max;
  return Array.from({ length: max }, (_, k) => probes[Math.floor(k * step)]);
}

module.exports = { syncProbeTimes, faceGrid, frameLuma, ffprobe, sceneCuts, sampleFrames, contactSheet, faceSession, detectFace, faceMetrics, syncAgainstSource };
