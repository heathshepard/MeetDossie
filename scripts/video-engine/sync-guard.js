#!/usr/bin/env node
/**
 * sync-guard.js — the assertion that would have caught the double-speed bug.
 *
 * ===================================================================
 * THE BUG THIS EXISTS FOR (2026-09-22, shipped broken)
 * ===================================================================
 * A 1.08x speed-up was applied TWICE on the picture side:
 *   1. in the frame-extraction filter, as `setpts=PTS/1.08`, and then
 *   2. AGAIN by encoding the resulting frames at the original framerate.
 * Net picture speed 1.08 * 1.08 = 1.166x, against audio at 1.08x. His body
 * finished roughly 18 seconds before his voice did, and nothing in the
 * pipeline noticed — the render succeeded, the file played, the duration
 * looked plausible.
 *
 * THE CORRECT RELATIONSHIP
 * Frames extracted with `setpts=PTS/S` have already had the speed-up baked
 * into their COUNT. They must then be played at the SOURCE framerate, not at
 * source*S. Concretely, verified on the working cut:
 *
 *     source take     117.374 s
 *     atempo          1.08
 *     audio out       117.374 / 1.08 = 108.68 s
 *     frames kept     2717
 *     output fps      25
 *     picture out     2717 / 25      = 108.68 s
 *     drift           0 ms
 *
 * So: pictureSeconds = frameCount / outputFps must equal audioSeconds.
 *
 * WHAT THIS MODULE DOES
 *   assertFrameSync()   — pre-encode: given a frame count, an output fps and
 *                         the audio duration, fail if they disagree.
 *   expectedFrameCount()— the inverse: how many frames a speed-up SHOULD
 *                         yield, so a caller can check its own extraction.
 *   assertRenderedSync()— post-encode: ffprobe the finished file's own video
 *                         and audio stream durations and fail on drift.
 *
 * Default tolerance is 50 ms — about 1.25 frames at 25 fps. Lip-sync error
 * becomes perceptible around 45 ms of audio-lead / 125 ms of audio-lag, so
 * 50 ms is the right side of the line and anything larger is a real defect,
 * not rounding.
 *
 * Usage:
 *   node scripts/video-engine/sync-guard.js --video out.mp4 [--tolMs 50]
 *   node scripts/video-engine/sync-guard.js --frames 2717 --fps 25 --audioSec 108.68
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const DEFAULT_TOL_MS = 50;

class SyncError extends Error {
  constructor(msg, detail) { super(msg); this.name = 'SyncError'; this.detail = detail; }
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

function ffprobe(args) {
  return execFileSync('ffprobe', ['-v', 'error', ...args], { maxBuffer: 1 << 24 }).toString().trim();
}

/**
 * expectedFrameCount — frames you should have after `setpts=PTS/speed` on a
 * `srcSec` source shot at `srcFps`.
 *
 * NOTE the asymmetry that caused the bug: the frame COUNT shrinks by `speed`,
 * and that is the ONLY place the speed-up may be applied to the picture. If
 * you also raise the output framerate you have applied it twice.
 */
function expectedFrameCount(srcSec, srcFps, speed) {
  return Math.round((srcSec * srcFps) / speed);
}

/**
 * correctOutputFps — given that frames were extracted with setpts=PTS/speed
 * from footage at srcFps, the framerate they must be PLAYED at.
 *
 * It is srcFps. Not srcFps * speed, not srcFps / speed. The speed-up is
 * already in the frame count. This function exists so the answer is written
 * down once, in a file with a test, instead of re-derived at 1 a.m.
 */
function correctOutputFps(srcFps /* , speed */) {
  return srcFps;
}

/**
 * assertFrameSync — pre-encode gate.
 * @returns {{pictureSec:number, audioSec:number, driftMs:number}}
 * @throws  {SyncError} when |picture - audio| > tolMs
 */
function assertFrameSync({ frameCount, outputFps, audioSec, tolMs = DEFAULT_TOL_MS, label = 'render' }) {
  if (!(frameCount > 0)) throw new SyncError(`sync-guard: frameCount must be > 0, got ${frameCount}`);
  if (!(outputFps > 0)) throw new SyncError(`sync-guard: outputFps must be > 0, got ${outputFps}`);
  if (!(audioSec > 0)) throw new SyncError(`sync-guard: audioSec must be > 0, got ${audioSec}`);

  const pictureSec = frameCount / outputFps;
  const driftMs = (pictureSec - audioSec) * 1000;
  const res = { pictureSec, audioSec, driftMs: +driftMs.toFixed(1), frameCount, outputFps };

  if (Math.abs(driftMs) > tolMs) {
    const ratio = pictureSec / audioSec;
    // The signature of the double-speed bug: picture SHORTER than audio by
    // very close to the speed factor again.
    const hint = ratio < 0.97
      ? `\n  Picture is ${(1 / ratio).toFixed(3)}x SHORT of the audio. If you applied a speed-up in BOTH setpts and the output framerate, that is this bug: frames extracted with setpts=PTS/S are played at the SOURCE fps, not source*S.`
      : ratio > 1.03
        ? `\n  Picture RUNS LONG of the audio by ${ratio.toFixed(3)}x — the atempo and the frame extraction disagree on the speed factor.`
        : '';
    throw new SyncError(
      `A/V SYNC FAIL (${label}): picture ${pictureSec.toFixed(3)}s vs audio ${audioSec.toFixed(3)}s — ` +
      `${driftMs > 0 ? '+' : ''}${driftMs.toFixed(0)}ms drift, tolerance ${tolMs}ms.` + hint +
      `\n  ${frameCount} frames / ${outputFps} fps = ${pictureSec.toFixed(3)}s.`,
      res);
  }
  return res;
}

/**
 * assertRenderedSync — post-encode gate. Reads the finished file's own
 * stream durations. This catches anything the pre-encode check could not
 * see, e.g. a `-r` that quietly resampled or a trailing padded frame.
 */
function assertRenderedSync(videoPath, { tolMs = DEFAULT_TOL_MS, label = null } = {}) {
  if (!fs.existsSync(videoPath)) throw new SyncError(`sync-guard: no such file ${videoPath}`);
  const name = label || videoPath;

  const nbFramesRaw = ffprobe(['-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', videoPath]);
  const frameCount = parseInt(nbFramesRaw, 10);
  const fpsRaw = ffprobe(['-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', videoPath]);
  const [fn, fd] = fpsRaw.split('/').map(Number);
  const outputFps = fd ? fn / fd : fn;
  const audioSecRaw = ffprobe(['-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', videoPath]);
  const audioSec = parseFloat(audioSecRaw);

  if (!Number.isFinite(audioSec)) {
    // No audio stream at all is a different failure, and a silent one — a
    // "finished video" with no voice has shipped before.
    throw new SyncError(`sync-guard: ${name} has no readable audio stream duration. A finished cut with no audio is not a pass.`);
  }
  return assertFrameSync({ frameCount, outputFps, audioSec, tolMs, label: name });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const tolMs = args.tolMs != null ? +args.tolMs : DEFAULT_TOL_MS;
  try {
    let res;
    if (args.video) {
      res = assertRenderedSync(args.video, { tolMs });
    } else if (args.frames && args.fps && args.audioSec) {
      res = assertFrameSync({ frameCount: +args.frames, outputFps: +args.fps, audioSec: +args.audioSec, tolMs });
    } else {
      console.error('Usage: sync-guard.js --video <mp4> [--tolMs 50]   |   --frames N --fps F --audioSec S');
      process.exit(1);
    }
    console.log(`A/V SYNC OK — picture ${res.pictureSec.toFixed(3)}s vs audio ${res.audioSec.toFixed(3)}s (${res.driftMs >= 0 ? '+' : ''}${res.driftMs}ms, tol ${tolMs}ms)`);
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
}

module.exports = { assertFrameSync, assertRenderedSync, expectedFrameCount, correctOutputFps, SyncError, DEFAULT_TOL_MS };
if (require.main === module) main();
