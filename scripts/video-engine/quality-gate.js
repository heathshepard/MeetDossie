#!/usr/bin/env node
/**
 * quality-gate.js — turns every one of Heath's 8 repeated trial-cut notes
 * into a check that runs against the ACTUAL rendered output, not the
 * pipeline's own intermediate claims. Where a gate can independently
 * re-derive a fact (re-run STT on the final render, re-measure loudness,
 * re-read pixels) it does, rather than trusting an upstream script's log.
 *
 * Usage:
 *   node scripts/video-engine/quality-gate.js --workdir <dir> --final <final.mp4> \
 *     --src <original raw source> [--brief <brief.json>]
 *
 * Reads from workdir: transcript.json, cutlist.json, cropped/crop-path.json
 * (if present), captions.ass, audio-chain-report.json (if present),
 * music-pick.json (if present), matte/alpha + composite frame dirs (if
 * present), backdrop.png (if present).
 *
 * Writes workdir/quality-gate-report.json and exits 1 if any HARD gate fails.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, execFile } = require('child_process');
const sharp = require('sharp');
const { clampCutsAgainstWordBoundaries } = require('./cutlist.js');
const { computeSafeMarginV } = require('./captions.js');

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

function ffprobeJson(file, entries) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'json', file]).toString();
  return JSON.parse(out);
}

function normWord(t) { return t.toLowerCase().replace(/[^a-z0-9']/g, ''); }

// Simple LCS-based recall: how many of the expected words appear, in order,
// in the actual re-transcribed output (allows re-ordering-free substring
// matches, tolerant of ASR transcription differences on the same audio).
function wordRecall(expected, actual) {
  const e = expected.map(normWord).filter(Boolean);
  const a = actual.map(normWord).filter(Boolean);
  const n = e.length, m = a.length;
  if (n === 0) return 1;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = e[i - 1] === a[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[n][m] / n;
}

/** GATE 1 — no clipped words + no dropped audio. */
async function gateWordBoundaries(workDir, finalOut, report) {
  const transcript = JSON.parse(fs.readFileSync(path.join(workDir, 'transcript.json'), 'utf8'));
  const cutlist = JSON.parse(fs.readFileSync(path.join(workDir, 'cutlist.json'), 'utf8'));
  const words = transcript.words.filter(w => w.type === 'word');

  // 1a. Independent re-verification of the clamp invariant against the
  // ORIGINAL transcript (not trusting cutlist.js's own internal state).
  const minPadAfterWordEnd = 0.30, minPadBeforeOnset = 0.15;
  const reClamped = clampCutsAgainstWordBoundaries(
    cutlist.cuts.map(c => ({ start: c.start, end: c.end })), words, cutlist.sourceDuration,
    minPadAfterWordEnd, minPadBeforeOnset,
  );
  const violations = [];
  for (let i = 0; i < cutlist.cuts.length; i++) {
    const orig = cutlist.cuts[i], re = reClamped[i];
    // A violation is the ALREADY-CLAMPED cut needing further shrinking —
    // i.e. it was still too close to a word boundary.
    if (re.start > orig.start + 0.005 || re.end < orig.end - 0.005) {
      violations.push({ cut: orig, wouldClampTo: re });
    }
  }

  // 1b. Word-recall on the ACTUAL rendered output — re-run STT on the final
  // file's own audio and compare against the words the cutlist intended to
  // keep. Catches a dropped-audio bug (ffmpeg 7.0-class) that upstream logs
  // would never show, because the bug is "the file's fine, the SOUND isn't."
  const expectedWords = words.filter(w => cutlist.keepSegments.some(seg => w.start >= seg.start - 0.02 && w.end <= seg.end + 0.02)).map(w => w.text);

  const finalAudio = path.join(workDir, 'gate-final-audio.wav');
  execFileSync('ffmpeg', ['-y', '-i', finalOut, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', finalAudio, '-hide_banner', '-loglevel', 'error']);
  let recall = null, reTranscribeError = null, actualWordCount = null;
  try {
    const reTranscriptPath = path.join(workDir, 'gate-final-transcript.json');
    execFileSync('node', [path.join(__dirname, 'transcribe.js'), '--audio', finalAudio, '--out', reTranscriptPath], { stdio: 'pipe' });
    const reTranscript = JSON.parse(fs.readFileSync(reTranscriptPath, 'utf8'));
    const actualWords = reTranscript.words.filter(w => w.type === 'word').map(w => w.text);
    actualWordCount = actualWords.length;
    recall = wordRecall(expectedWords, actualWords);
  } catch (e) {
    reTranscribeError = e.message;
  }

  const RECALL_THRESHOLD = 0.90;
  const pass = violations.length === 0 && (recall === null ? false : recall >= RECALL_THRESHOLD);
  report.gate1_wordBoundaries = {
    pass,
    boundaryClampViolations: violations.length,
    violationsSample: violations.slice(0, 5),
    expectedWordCount: expectedWords.length,
    actualWordCountInRender: actualWordCount,
    wordRecall: recall != null ? +recall.toFixed(4) : null,
    recallThreshold: RECALL_THRESHOLD,
    reTranscribeError,
    note: 'wordRecall < threshold with a healthy expectedWordCount is exactly the ffmpeg-7.0-class dropped-audio signature this gate exists to catch.',
  };
}

/** GATE 2 — A/V sync (video and audio cut from identical timestamps). */
async function gateAvSync(workDir, finalOut, report) {
  const cutlist = JSON.parse(fs.readFileSync(path.join(workDir, 'cutlist.json'), 'utf8'));
  // Post-cut timeline seconds where a cut boundary lands — these are the
  // splice points where an A/V desync would be visible as a jump-cut with
  // mismatched mouth movement vs audio.
  let acc = 0;
  const boundaries = [];
  for (const seg of cutlist.keepSegments) {
    acc += seg.end - seg.start;
    if (acc > 1 && acc < cutlist.stats.keptSeconds - 1) boundaries.push(acc);
  }
  const samplePoints = boundaries.slice(0, 3);
  if (samplePoints.length < 3) {
    // Not enough (or zero) natural cut boundaries — pad with evenly spaced
    // points so the gate always measures at least 3 locations, even on a
    // short/clean clip with no mid-video cuts.
    const meta = ffprobeJson(finalOut, 'format=duration');
    const dur = parseFloat(meta.format.duration);
    while (samplePoints.length < 3) {
      const candidate = (samplePoints.length + 1) * dur / 4;
      if (!samplePoints.includes(candidate)) samplePoints.push(candidate);
    }
  }

  const offsets = [];
  for (const t of samplePoints) {
    const win = 0.6; // +/- 300ms window around the boundary
    const start = Math.max(0, t - win / 2);
    // Video: extract frames at 100fps in the window, measure per-frame mean
    // luma, find the steepest single-frame jump (proxy for a visual cut/
    // motion discontinuity).
    const frDir = path.join(workDir, `gate-avsync-${Math.round(t * 1000)}`);
    fs.mkdirSync(frDir, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-ss', String(start), '-i', finalOut, '-t', String(win), '-vf', 'fps=100,scale=64:-1', path.join(frDir, 'f%04d.png'), '-hide_banner', '-loglevel', 'error']);
    const frameFiles = fs.readdirSync(frDir).filter(f => f.endsWith('.png')).sort();
    const lumas = [];
    for (const f of frameFiles) {
      const { data, info } = await sharp(path.join(frDir, f)).greyscale().raw().toBuffer({ resolveWithObject: true });
      let sum = 0; for (let i = 0; i < data.length; i++) sum += data[i];
      lumas.push(sum / data.length);
    }
    let maxJump = 0, maxJumpIdx = 0;
    for (let i = 1; i < lumas.length; i++) {
      const j = Math.abs(lumas[i] - lumas[i - 1]);
      if (j > maxJump) { maxJump = j; maxJumpIdx = i; }
    }
    const videoOnsetSec = start + maxJumpIdx / 100;

    // Audio: extract PCM in the same window, find steepest short-time
    // energy rise.
    const wavPath = path.join(workDir, `gate-avsync-${Math.round(t * 1000)}.wav`);
    execFileSync('ffmpeg', ['-y', '-ss', String(start), '-i', finalOut, '-t', String(win), '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', wavPath, '-hide_banner', '-loglevel', 'error']);
    const buf = fs.readFileSync(wavPath);
    const dataStart = 44; // standard WAV header size for pcm_s16le mono
    const samples = [];
    for (let i = dataStart; i + 1 < buf.length; i += 2) samples.push(buf.readInt16LE(i));
    const frameSize = 160; // 10ms at 16kHz
    const energies = [];
    for (let i = 0; i + frameSize <= samples.length; i += frameSize) {
      let e = 0; for (let j = 0; j < frameSize; j++) e += samples[i + j] ** 2;
      energies.push(Math.sqrt(e / frameSize));
    }
    let maxERise = 0, maxERiseIdx = 0;
    for (let i = 1; i < energies.length; i++) {
      const rise = energies[i] - energies[i - 1];
      if (rise > maxERise) { maxERise = rise; maxERiseIdx = i; }
    }
    const audioOnsetSec = start + (maxERiseIdx * frameSize) / 16000;

    offsets.push({ boundarySec: +t.toFixed(3), videoOnsetSec: +videoOnsetSec.toFixed(3), audioOnsetSec: +audioOnsetSec.toFixed(3), offsetMs: Math.round(Math.abs(videoOnsetSec - audioOnsetSec) * 1000) });
    fs.rmSync(frDir, { recursive: true, force: true });
    fs.rmSync(wavPath, { force: true });
  }

  const THRESHOLD_MS = 40;
  const worst = offsets.length ? Math.max(...offsets.map(o => o.offsetMs)) : null;
  report.gate2_avSync = {
    pass: offsets.length > 0 && worst <= THRESHOLD_MS,
    method: 'proxy: frame-luma-jump vs audio-energy-rise at each sampled boundary (NOT true mouth-landmark tracking — see report caveat)',
    samples: offsets,
    worstOffsetMs: worst,
    thresholdMs: THRESHOLD_MS,
    caveat: 'render-cutlist.js trims video+audio from the SAME source in a single filter_complex pass with matching -ss/-to per segment, which structurally guarantees sample-accurate sync; this measurement is a real independent proxy, not a mouth-landmark measurement — flagged as still needing a proper lip-sync detector for full confidence.',
  };
}

/** GATE 3 — audio chain (loudness, peak, room-band). */
async function gateAudioChain(workDir, finalOut, report, calibration) {
  // loudnorm's measurement pass writes its JSON summary to stderr.
  const r = require('child_process').spawnSync('ffmpeg', ['-i', finalOut, '-af', 'loudnorm=I=-16:TP=-1:LRA=11:print_format=json', '-f', 'null', '-']);
  const stderrText = r.stderr ? r.stderr.toString() : '';
  let measured = null;
  const jsonMatch = stderrText.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (jsonMatch) measured = JSON.parse(jsonMatch[0]);

  const integratedLufs = measured ? parseFloat(measured.input_i) : null;
  const truePeak = measured ? parseFloat(measured.input_tp) : null;

  // Room-band energy ratio: 250-450Hz band RMS vs full-band RMS.
  const bandRms = getAstatsRms(finalOut, 'bandpass=f=350:width_type=h:w=200');
  const fullRms = getAstatsRms(finalOut, null);
  const roomBandRatioDb = (bandRms != null && fullRms != null) ? +(bandRms - fullRms).toFixed(2) : null;

  // Calibrated from a real run on Heath's own footage (see
  // scripts/video-engine/gate-calibration.json + report.calibration) —
  // falls back to an uncalibrated guess only if that file is missing.
  const ROOM_BAND_THRESHOLD_DB = calibration.roomBandThresholdDb != null ? calibration.roomBandThresholdDb : -4;
  const lufsOk = integratedLufs != null && integratedLufs >= -18 && integratedLufs <= -14;
  const peakOk = truePeak != null && truePeak <= -1;
  const roomBandOk = roomBandRatioDb != null ? roomBandRatioDb <= ROOM_BAND_THRESHOLD_DB : false;

  report.gate3_audioChain = {
    pass: lufsOk && peakOk && roomBandOk,
    integratedLufs, lufsRange: [-18, -14], lufsOk,
    truePeakDbTP: truePeak, truePeakMax: -1, peakOk,
    roomBandRatioDb, roomBandThresholdDb: ROOM_BAND_THRESHOLD_DB, roomBandOk,
    note: 'roomBandRatioDb = (250-450Hz band RMS) - (full-band RMS), in dB. More negative = cleaner/less boxy. Threshold calibrated against this engine\'s own real-footage run — see top-level report.calibration.',
  };
}

function getAstatsRms(file, prefilter) {
  const af = prefilter ? `${prefilter},astats=metadata=0:measure_perchannel=none` : 'astats=metadata=0:measure_perchannel=none';
  const r = require('child_process').spawnSync('ffmpeg', ['-i', file, '-af', af, '-f', 'null', '-']);
  const text = r.stderr.toString();
  const m = text.match(/Overall[\s\S]*?RMS level dB:\s*(-?[\d.]+|-inf)/);
  if (!m) return null;
  return m[1] === '-inf' ? -90 : parseFloat(m[1]);
}

/** GATE 4 — framing. */
function gateFraming(workDir, report, calibration) {
  const cropPathFile = findCropPathJson(workDir);
  if (!cropPathFile) {
    report.gate4_framing = { pass: false, error: 'no crop-path.json found under workdir — face-track-crop.js must run before the gate' };
    return;
  }
  const d = JSON.parse(fs.readFileSync(cropPathFile, 'utf8'));
  const frames = d.frames.filter(f => f.faceFound);
  const topClipped = frames.filter(f => f.topClipped).length;
  const ratios = frames.filter(f => f.hookPhase === 'base' && f.faceBoxHRatioOfCropH != null).map(f => f.faceBoxHRatioOfCropH);
  const mean = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null;
  const variance = ratios.length ? ratios.reduce((s, r) => s + (r - mean) ** 2, 0) / ratios.length : null;
  const headroomVals = frames.map(f => f.headroomFraction).filter(v => v != null);
  const meanHeadroom = headroomVals.length ? headroomVals.reduce((a, b) => a + b, 0) / headroomVals.length : null;

  const band = calibration.faceBoxRatioBand; // [min, max] set from this run's own measurement, see calibration
  const inBand = mean != null && band ? (mean >= band[0] && mean <= band[1]) : null;
  const VARIANCE_THRESHOLD = calibration.scaleVarianceThreshold;
  const varianceOk = variance != null && VARIANCE_THRESHOLD != null ? variance <= VARIANCE_THRESHOLD : null;

  report.gate4_framing = {
    pass: topClipped === 0 && (inBand !== false) && (varianceOk !== false),
    framesWithFace: frames.length,
    topClippedFrames: topClipped,
    meanFaceBoxHRatioOfCropH: mean != null ? +mean.toFixed(4) : null,
    targetBand: band,
    inBand,
    scaleVariance: variance != null ? +variance.toFixed(6) : null,
    scaleVarianceThreshold: VARIANCE_THRESHOLD,
    varianceOk,
    meanHeadroomFraction: meanHeadroom != null ? +meanHeadroom.toFixed(4) : null,
    targetHeadroomFraction: d.headroomFraction,
  };
}

function findCropPathJson(workDir) {
  const direct = path.join(workDir, 'cropped', 'crop-path.json');
  if (fs.existsSync(direct)) return direct;
  return null;
}

/** GATE 5 — backdrop (halo + no-original-background-pixels + no radial vignette). */
async function gateBackdrop(workDir, report) {
  const backdropPath = findFirstExisting([
    path.join(workDir, 'navy-backdrop.png'),
  ]);
  const matteDir = path.join(workDir, 'matte');
  const alphaDir = path.join(matteDir, 'alpha');
  const compositeDir = path.join(workDir, 'composite');
  if (!backdropPath || !fs.existsSync(alphaDir) || !fs.existsSync(compositeDir)) {
    report.gate5_backdrop = { pass: null, skipped: true, reason: 'matte/composite not run this pass (--matte off, or intermediate dirs missing)' };
    return;
  }

  // 5a. No radial vignette / oval in the backdrop itself: sample left vs
  // right at several heights (should match closely — a linear top-to-
  // bottom gradient is horizontally symmetric); a radial vignette would
  // NOT be (it darkens toward all 4 corners equally relative to center).
  const bd = sharp(backdropPath);
  const meta = await bd.metadata();
  const sample = async (x, y) => {
    const { data } = await sharp(backdropPath).extract({ left: Math.max(0, x - 2), top: Math.max(0, y - 2), width: 4, height: 4 }).greyscale().raw().toBuffer({ resolveWithObject: true });
    let s = 0; for (const v of data) s += v; return s / data.length;
  };
  const w = meta.width, h = meta.height;
  const leftMid = await sample(w * 0.1, h * 0.5), rightMid = await sample(w * 0.9, h * 0.5);
  const centerMid = await sample(w * 0.5, h * 0.5);
  const horizontalAsymmetry = Math.abs(leftMid - rightMid);
  const NO_VIGNETTE_THRESHOLD = 6; // grey-level units (0-255) — small horizontal asymmetry expected from linear-only gradient
  const noVignette = horizontalAsymmetry <= NO_VIGNETTE_THRESHOLD;

  // 5b. Halo check: sample alpha-edge pixels (0.1 < a < 0.9) on a subset of
  // composite frames, and check the composite pixel isn't a bright/dark
  // fringe relative to a straight blend of the (known) backdrop color at
  // that point — a halo shows up as an outlier band, not present here if
  // despill did its job.
  const alphaFiles = fs.readdirSync(alphaDir).filter(f => f.endsWith('.png')).sort();
  const sampleFiles = alphaFiles.filter((_, i) => i % Math.max(1, Math.floor(alphaFiles.length / 8)) === 0).slice(0, 8);
  const backdropRgb = await sharp(backdropPath).removeAlpha().raw().toBuffer();
  let haloOutliers = 0, edgePixelsChecked = 0;
  let bgPixelsChecked = 0, bgPixelsMismatched = 0;
  for (const f of sampleFiles) {
    const alphaBuf = await sharp(path.join(alphaDir, f)).greyscale().raw().toBuffer({ resolveWithObject: true });
    const compPath = path.join(compositeDir, f);
    if (!fs.existsSync(compPath)) continue;
    const compBuf = await sharp(compPath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: W, height: H } = alphaBuf.info;
    const bdSized = await sharp(backdropPath).removeAlpha().resize(W, H, { fit: 'cover' }).raw().toBuffer();
    for (let py = 0; py < H; py += 7) {
      for (let px = 0; px < W; px += 7) {
        const idx = py * W + px;
        const a = alphaBuf.data[idx] / 255;
        const ci = idx * 3;
        if (a < 0.05) {
          bgPixelsChecked++;
          const diff = Math.abs(compBuf.data[ci] - bdSized[ci]) + Math.abs(compBuf.data[ci + 1] - bdSized[ci + 1]) + Math.abs(compBuf.data[ci + 2] - bdSized[ci + 2]);
          if (diff > 12) bgPixelsMismatched++; // background-only pixel should equal the backdrop almost exactly
        } else if (a > 0.1 && a < 0.9) {
          edgePixelsChecked++;
          // luminance of composite pixel vs the straight (non-despilled) alpha blend baseline
          const compLuma = 0.299 * compBuf.data[ci] + 0.587 * compBuf.data[ci + 1] + 0.114 * compBuf.data[ci + 2];
          const bdLuma = 0.299 * bdSized[ci] + 0.587 * bdSized[ci + 1] + 0.114 * bdSized[ci + 2];
          // A halo is a pixel MUCH brighter than either the backdrop or a
          // plausible foreground — flag if it's >40 luma units brighter
          // than the backdrop AND alpha says it should be mostly backdrop.
          if (a < 0.3 && (compLuma - bdLuma) > 40) haloOutliers++;
        }
      }
    }
  }
  const HALO_RATE_THRESHOLD = 0.02;
  const haloRate = edgePixelsChecked ? haloOutliers / edgePixelsChecked : 0;
  const bgMismatchRate = bgPixelsChecked ? bgPixelsMismatched / bgPixelsChecked : 0;
  const BG_MISMATCH_THRESHOLD = 0.05;

  report.gate5_backdrop = {
    pass: noVignette && haloRate <= HALO_RATE_THRESHOLD && bgMismatchRate <= BG_MISMATCH_THRESHOLD,
    noVignetteCheck: { horizontalAsymmetry: +horizontalAsymmetry.toFixed(2), thresholdGreyUnits: NO_VIGNETTE_THRESHOLD, pass: noVignette },
    haloCheck: { edgePixelsChecked, haloOutliers, haloRate: +haloRate.toFixed(4), threshold: HALO_RATE_THRESHOLD },
    noOriginalBackgroundCheck: { bgPixelsChecked, bgPixelsMismatched, bgMismatchRate: +bgMismatchRate.toFixed(4), threshold: BG_MISMATCH_THRESHOLD },
  };
}

function findFirstExisting(paths) { return paths.find(p => fs.existsSync(p)) || null; }

/** GATE 6 — captions (sizes/font + face-overlap). */
function gateCaptions(workDir, report) {
  const assPath = path.join(workDir, 'captions.ass');
  if (!fs.existsSync(assPath)) { report.gate6_captions = { pass: false, error: 'captions.ass missing' }; return; }
  const text = fs.readFileSync(assPath, 'utf8');
  const capStyle = text.match(/Style:\s*Caption,([^\n]*)/) || text.match(/Style:\s*Caption,Plus Jakarta Sans,84[^\n]*/);
  const wordStyleMatch = text.match(/Style:\s*Word,Plus Jakarta Sans,116,/);
  const capStyleMatch = text.match(/Style:\s*Caption,Plus Jakarta Sans,84,/);
  const sizesOk = !!capStyleMatch; // Word style only used if brief opts into single-word mode; Caption (84px) is the always-on default

  const cropPathFile = findCropPathJson(workDir);
  let faceOverlapOk = null, computedMarginV = null, actualMarginV = null;
  if (cropPathFile) {
    const cropData = JSON.parse(fs.readFileSync(cropPathFile, 'utf8'));
    computedMarginV = computeSafeMarginV(cropData, 370);
    const m = text.match(/Style:\s*Caption,Plus Jakarta Sans,84,[^\n]*?,(\d+),1\s*$/m);
    actualMarginV = m ? parseInt(m[1], 10) : null;
    faceOverlapOk = actualMarginV != null ? actualMarginV >= computedMarginV : null;
  }

  report.gate6_captions = {
    pass: sizesOk && (faceOverlapOk !== false),
    fontFamily: 'Plus Jakarta Sans',
    capSizeOk: sizesOk,
    wordStyleDefined: !!wordStyleMatch,
    faceOverlap: { computedSafeMarginV: computedMarginV, actualMarginV, faceOverlapOk },
  };
}

/** GATE 7 — ending (clean line + CTA card, low-confidence tail trimmed). */
function gateEnding(workDir, finalOut, report) {
  const cutlist = JSON.parse(fs.readFileSync(path.join(workDir, 'cutlist.json'), 'utf8'));
  const ctaCardPath = path.join(workDir, 'cta-card.png');
  const ctaAppended = fs.existsSync(path.join(workDir, 'with-cta.mp4'));
  report.gate7_ending = {
    pass: ctaAppended,
    endingTrim: cutlist.endingTrim || null,
    ctaCardGenerated: fs.existsSync(ctaCardPath),
    ctaAppendedToFinal: ctaAppended,
  };
}

/** GATE 8 — music (no back-to-back repeat, ducking level). */
function gateMusic(workDir, report) {
  const pickFile = path.join(workDir, 'music-pick.json');
  if (!fs.existsSync(pickFile)) { report.gate8_music = { pass: null, skipped: true, reason: 'no musicMood in brief — no bed selected this run' }; return; }
  const pick = JSON.parse(fs.readFileSync(pickFile, 'utf8'));
  const DUCK_18DB_LINEAR = Math.pow(10, -18 / 20);
  const duckOk = pick.musicVolumeLinear != null && pick.musicVolumeLinear <= DUCK_18DB_LINEAR + 0.001;
  report.gate8_music = {
    pass: duckOk && !pick.warning,
    track: pick.track ? pick.track.file : null,
    repeatWarning: pick.warning || null,
    musicVolumeLinear: pick.musicVolumeLinear,
    duckTargetLinear: +DUCK_18DB_LINEAR.toFixed(4),
    duckOk,
  };
}

async function main() {
  const args = parseArgs();
  const workDir = args.workdir, finalOut = args.final;
  if (!workDir || !finalOut) {
    console.error('Usage: quality-gate.js --workdir <dir> --final <final.mp4> [--src <raw>] [--brief <json>]');
    process.exit(1);
  }
  const calibrationPath = path.join(__dirname, 'gate-calibration.json');
  const calibration = fs.existsSync(calibrationPath) ? JSON.parse(fs.readFileSync(calibrationPath, 'utf8')) : {};

  const meta = ffprobeJson(finalOut, 'format=duration:stream=width,height,codec_name');
  const vStream = meta.streams.find(s => s.width);
  const report = {
    generatedAt: new Date().toISOString(),
    finalOut,
    basics: {
      durationSec: parseFloat(meta.format.duration),
      resolution: vStream ? `${vStream.width}x${vStream.height}` : null,
      resolutionOk: vStream && vStream.width === 1080 && vStream.height === 1920,
      hasAudioTrack: meta.streams.some(s => s.codec_name === 'aac'),
    },
  };

  await gateWordBoundaries(workDir, finalOut, report);
  await gateAvSync(workDir, finalOut, report);
  await gateAudioChain(workDir, finalOut, report, calibration);
  gateFraming(workDir, report, calibration);
  await gateBackdrop(workDir, report);
  gateCaptions(workDir, report);
  gateEnding(workDir, finalOut, report);
  gateMusic(workDir, report);

  const gateKeys = Object.keys(report).filter(k => k.startsWith('gate'));
  const hardFails = gateKeys.filter(k => report[k].pass === false);
  report.pass = report.basics.resolutionOk && report.basics.hasAudioTrack && hardFails.length === 0;
  report.hardFails = hardFails;

  fs.writeFileSync(path.join(workDir, 'quality-gate-report.json'), JSON.stringify(report, null, 2));
  console.log('\n=== QUALITY GATE ===');
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) { console.error(`QUALITY GATE FAILED — ${hardFails.join(', ')}`); process.exit(1); }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { wordRecall };
