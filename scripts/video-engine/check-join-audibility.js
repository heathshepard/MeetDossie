#!/usr/bin/env node
/**
 * check-join-audibility.js — is a splice join distinguishable from an
 * ordinary moment in the same audio?
 *
 * Direct Node port of the proven exploratory script used to build
 * v7c_SPLICED.mp4 (`/home/heath/mw/v7/joins2.py`, 2026-09-30/10-01, itself a
 * rewrite of an.py's cruder step-detector after it mis-measured which join
 * points mattered). Ported here, rather than left as a one-off, per Heath's
 * standard: founder-video-production-standard.md §2 — "Joins must be
 * MEASURED inaudible, not asserted... Compare each join's short-time
 * discontinuity against the distribution at ~300 non-join points in the
 * same render. No join above the 99th percentile."
 *
 * METHOD (unchanged from joins2.py — do not "improve" the math without
 * re-validating against the real fixtures below, the whole point is this is
 * calibrated):
 *   A splice is audible when it introduces a discontinuity the surrounding
 *   material doesn't already contain. So rather than asking "is there a
 *   level change at the join" (there always is — a new phrase starts), ask
 *   whether the short-time level JUMP at each join sits inside the
 *   distribution of jumps at non-join points in the same render.
 *
 *   metric   = max |dLevel(dB)| between adjacent 5ms frames within ±60ms of
 *              a point (24 frames total, 23 deltas).
 *   baseline = that same metric at points spread every 0.08s across the
 *              render, excluding ±0.25s of any join (~300+ points on a
 *              30s clip).
 *   fail     = any join's metric falls above the 99th percentile of the
 *              baseline distribution.
 *
 * Decoded as mono 8kHz PCM s16le (SR=8000) — matches the exploratory
 * script's an.py exactly, which is what the thresholds below were measured
 * against; changing the sample rate changes the frame-energy math and would
 * invalidate the calibration.
 *
 * INPUT — this check needs the splice JOIN TIMESTAMPS, which only exist for
 * a multi-take-spliced build (not every video_library row). It does not
 * plug into api/_lib/verify-video-quality.js (which only ever receives a
 * finished mp4, no join metadata) or scripts/video-engine/quality-gate.js's
 * gateAvSync (which re-derives boundary points from cutlist.json's
 * different {cuts, keepSegments} shape, built by scripts/video-engine's own
 * render-cutlist.js — not what produced this recipe's master.json). This
 * script takes a generic {joins:[seconds...], cross_take:[1-based join
 * indices...]} shape instead, so it works against whatever pipeline wrote
 * the join list, including the one-off python build under /home/heath/mw/v7.
 *
 * USAGE
 *   node check-join-audibility.js --audio <wav-or-video> --joins <master.json>
 *   node check-join-audibility.js --audio v7c_voice.wav --joins v7c_master.json
 *
 * --joins accepts either {joins:[...], cross_take:[...]} (this recipe's
 * master.json shape) or a bare JSON array of join timestamps.
 *
 * Exits 1 and prints "FAIL" if any join is flagged; exits 0 and prints
 * "PASS" otherwise. Also exported as checkJoinAudibility() for programmatic
 * use from a gate.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');

const SR = 8000; // matches an.py — do not change without re-validating thresholds
const FRAME_S = 0.005; // 5ms
const WINDOW_FRAMES = 12; // +/-12 frames = +/-60ms around each point
const BASELINE_STEP_S = 0.08;
const BASELINE_EXCLUDE_S = 0.25; // exclude +/-0.25s of any join from the baseline
const BASELINE_EDGE_MARGIN_S = 0.5; // don't sample within 0.5s of clip start/end
const FLAG_PERCENTILE = 99.0;

/** Decodes any ffmpeg-readable audio/video source to a mono 8kHz Int16Array. */
function decodeMono8k(mediaPath) {
  const raw = execFileSync('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', mediaPath,
    '-ac', '1', '-ar', String(SR), '-f', 's16le', '-',
  ], { maxBuffer: 1 << 28 });
  const n = Math.floor(raw.length / 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = raw.readInt16LE(i * 2);
  return samples;
}

function rms(a, i, j) {
  const jj = Math.min(j, a.length);
  const ii = Math.max(0, i);
  if (jj <= ii) return 0;
  let s = 0;
  for (let k = ii; k < jj; k++) s += a[k] * a[k];
  return Math.sqrt(s / (jj - ii));
}

function db(x) {
  return x > 0 ? 20 * Math.log10(x / 32768.0) : -120.0;
}

/** Max |dB jump| between adjacent 5ms frames within +/-60ms of sample index c. */
function maxJumpAt(a, c) {
  const F = Math.round(FRAME_S * SR);
  const frames = [];
  for (let k = -WINDOW_FRAMES; k < WINDOW_FRAMES; k++) {
    frames.push(rms(a, c + k * F, c + (k + 1) * F));
  }
  let worst = 0;
  for (let k = 0; k < frames.length - 1; k++) {
    if (frames[k] > 0 && frames[k + 1] > 0) {
      const d = Math.abs(db(frames[k + 1]) - db(frames[k]));
      if (d > worst) worst = d;
    }
  }
  return worst;
}

function percentileOf(sortedArr, v) {
  let lo = 0;
  for (const b of sortedArr) if (b < v) lo++;
  return (100 * lo) / sortedArr.length;
}

function percentileValue(sortedArr, p) {
  const idx = Math.min(sortedArr.length - 1, Math.floor((sortedArr.length * p) / 100));
  return sortedArr[idx];
}

function normalizeJoinsInput(parsed) {
  if (Array.isArray(parsed)) return { joins: parsed, crossTake: [] };
  if (parsed && Array.isArray(parsed.joins)) {
    return { joins: parsed.joins, crossTake: Array.isArray(parsed.cross_take) ? parsed.cross_take : [] };
  }
  throw new Error('joins input must be a JSON array of seconds, or {joins:[...], cross_take:[...]}');
}

/**
 * @param {object} opts
 * @param {string} opts.mediaPath - audio or video file, ffmpeg-readable
 * @param {number[]} opts.joins - join timestamps in seconds, in the SAME
 *   timeline as mediaPath's own audio (post-speed-change if speed was
 *   already applied before this file was rendered)
 * @param {number[]} [opts.crossTake] - 1-based indices into `joins` that are
 *   cross-take splices, for reporting only
 * @returns {{pass:boolean, baseline:object, perJoin:Array, flaggedCount:number, flagged:Array}}
 */
function checkJoinAudibility(opts) {
  const { mediaPath, joins, crossTake = [] } = opts;
  if (!joins || !joins.length) throw new Error('no join timestamps supplied');
  const a = decodeMono8k(mediaPath);
  const dur = a.length / SR;

  const base = [];
  for (let t = BASELINE_EDGE_MARGIN_S; t < dur - BASELINE_EDGE_MARGIN_S; t += BASELINE_STEP_S) {
    if (joins.every((j) => Math.abs(t - j) > BASELINE_EXCLUDE_S)) {
      // Math.trunc (not round) to match the reference script's Python
      // int(t*SR), which truncates — using round() here shifted sample
      // indices by up to half a sample and measurably moved the baseline
      // distribution during porting (caught by scripts/regression-video-join-audibility.js).
      base.push(maxJumpAt(a, Math.trunc(t * SR)));
    }
  }
  base.sort((x, y) => x - y);
  if (base.length < 30) {
    throw new Error(`only ${base.length} non-join baseline points available (need a real distribution, not a handful) — clip too short or joins cover too much of it`);
  }

  const perJoin = joins.map((t, idx) => {
    const v = maxJumpAt(a, Math.trunc(t * SR));
    const p = percentileOf(base, v);
    return {
      index: idx + 1,
      t: Math.round(t * 1000) / 1000,
      maxJumpDb: Math.round(v * 10) / 10,
      percentileOfBaseline: Math.round(p * 10) / 10,
      crossTake: crossTake.includes(idx + 1),
      flagged: p > FLAG_PERCENTILE,
    };
  });
  const flagged = perJoin.filter((j) => j.flagged);

  return {
    pass: flagged.length === 0,
    baseline: {
      n: base.length,
      medianDb: Math.round(percentileValue(base, 50) * 10) / 10,
      p90Db: Math.round(percentileValue(base, 90) * 10) / 10,
      p99Db: Math.round(percentileValue(base, 99) * 10) / 10,
      maxDb: Math.round(base[base.length - 1] * 10) / 10,
    },
    perJoin,
    flaggedCount: flagged.length,
    flagged,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.audio || !args.joins) {
    console.error('Usage: check-join-audibility.js --audio <wav-or-video> --joins <master.json | joins-array.json>');
    process.exit(2);
  }
  const parsed = JSON.parse(fs.readFileSync(args.joins, 'utf8'));
  const { joins, crossTake } = normalizeJoinsInput(parsed);
  const result = checkJoinAudibility({ mediaPath: args.audio, joins, crossTake });

  console.log(`baseline (non-join) max 5ms jump: median ${result.baseline.medianDb}dB  p90 ${result.baseline.p90Db}  p99 ${result.baseline.p99Db}  max ${result.baseline.maxDb}  (n=${result.baseline.n})`);
  console.log();
  console.log('join    t(s)    maxjump   percentile-of-baseline');
  for (const j of result.perJoin) {
    console.log(`${String(j.index).padStart(4)} ${j.t.toFixed(3).padStart(7)}  ${j.maxJumpDb.toFixed(1).padStart(8)}   ${j.percentileOfBaseline.toFixed(1).padStart(6)}%${j.crossTake ? '  CROSS-TAKE' : ''}${j.flagged ? '   <-- outlier, inspect' : ''}`);
  }
  console.log();
  console.log(`joins above the 99th percentile of ordinary moments: ${result.flaggedCount} of ${result.perJoin.length}`);
  console.log(result.pass ? 'PASS' : 'FAIL');
  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) main();
module.exports = { checkJoinAudibility, decodeMono8k, maxJumpAt, FLAG_PERCENTILE, SR };
