#!/usr/bin/env node
//
// scripts/register-local-video.js
//
// THE CLI registration path for a video that did NOT come off the weekly
// watch-folder scan (scripts/queue-finished-videos.py) and did NOT come off
// the multi-take-splice producer (scripts/video-engine/produce-variants.js).
// Both of those already register-and-queue automatically. This is for
// everything else: a one-off build script (scripts/video-engine/recipes/*),
// a hand-assembled cut, anything that lands anywhere on disk with nobody
// remembering to run a scanner over it.
//
// THE DEFECT THIS CLOSES (Atlas 2026-09-25): three finished mp4s existed on
// disk 2026-09-25 with zero video_library rows — dossie_trec_p8_disclosure.mp4
// and dossie_trec_p22_district_notice.mp4 in Media/finished-videos/ (built by
// the trec-7i recipe's own one-off scripts, which never call a queuer), and
// dossie_12b_v2.mp4 sitting in Downloads (not even in a watch folder). This
// script is the thing that should have been run on each of them the moment
// they finished rendering.
//
// It deliberately does NOT reimplement upload/insert/scheduling — those
// already exist and are proven (scripts/video-engine/queue-variant.js,
// verified live 2026-09-25). This is a thin CLI wrapper: run the quality
// gate, then call queueVariant(). One code path, two callers
// (produce-variants.js and this file).
//
// USAGE
//   node scripts/register-local-video.js \
//     --video Media/finished-videos/dossie_trec_p8_disclosure.mp4 \
//     --id dossie_trec_p8_disclosure \
//     --topic "TREC 20-19 paragraph 8 disclosure duty" \
//     --caption-file p8.caption.txt \
//     --platforms tiktok,instagram,facebook \
//     [--cover path/to/cover.png]   # default: extract frame 0 via ffmpeg
//     [--owner dossie]              # default: dossie
//     [--orientation vertical]      # default: inferred from the file's own
//                                   # pixel dimensions via ffprobe (height >
//                                   # width -> vertical). See ORIENTATION below.
//     [--scheduled-for <iso>]       # default: auto-pick the next open
//                                   # posting_schedule slot (queueVariant.js)
//     [--approve]                   # write heath_approved instead of approved
//     [--dry-run]                   # gate + print, upload/insert nothing
//
// ORIENTATION (Atlas 2026-09-26, Cole relay): classifyOrientation() in
// api/_lib/verify-video-quality.js checks an EXPLICIT orientation argument
// before it ever looks at the platforms array — it only infers from
// platforms, and only rejects a mixed vertical+horizontal array, when
// nothing was declared. Facebook is in HORIZONTAL_PLATFORMS because FB feed
// video is 16:9, but FB Reels is 9:16 — one platform, two surfaces, so a
// genuinely vertical (1080x1920) file targeting
// [facebook, instagram, tiktok, youtube] as ONE row is legitimate and must
// declare orientation='vertical' rather than be inferred from the platform
// names. This does NOT touch VERTICAL_PLATFORMS / HORIZONTAL_PLATFORMS —
// those still gate the platforms-only inference path for every caller that
// doesn't pass an explicit orientation.
//
// Caption: --caption / --caption-file, or omitted entirely to fall back to
// the same Claude Haiku generator api/register-video.js uses
// (api/_lib/video-caption.js) — one caption generator, not a second copy.
//
// Exit codes: 0 = registered (or dry-run printed). 1 = gate failed / bad args
// / upload-insert failed. Never silently "sort of" succeeds.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

require('./video-engine/env-local.js').load(null, { quiet: true });

const { queueVariant } = require('./video-engine/queue-variant.js');
const { generateCaption } = require('../api/_lib/video-caption.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_CLI = path.join(REPO_ROOT, 'scripts', 'check-video-quality-cli.js');

function arg(name, dflt = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
}

function extractCoverFrame(videoPath) {
  const tmp = path.join(require('os').tmpdir(), `cover-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  execFileSync('ffmpeg', ['-y', '-ss', '0', '-i', videoPath, '-frames:v', '1', tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size === 0) {
    throw new Error('ffmpeg produced no cover frame — pass --cover explicitly');
  }
  return tmp;
}

function runQualityGate(videoPath, coverPath, platforms, orientation) {
  const cmd = ['--video', videoPath, '--cover', coverPath];
  if (platforms && platforms.length) cmd.push('--platforms', platforms.join(','));
  // Explicit orientation wins over platforms inference inside
  // classifyOrientation() — safe to pass both. See file header ORIENTATION note.
  if (orientation) cmd.push('--orientation', orientation);
  const result = require('child_process').spawnSync('node', [GATE_CLI, ...cmd], { encoding: 'utf8' });
  const lines = (result.stdout || '').trim().split('\n').filter(Boolean);
  if (!lines.length) {
    throw new Error(`quality gate produced no output (exit ${result.status}). stderr: ${(result.stderr || '').slice(0, 500)}`);
  }
  return JSON.parse(lines[lines.length - 1]);
}

/**
 * Detect vertical vs horizontal from the file's OWN pixel dimensions via
 * ffprobe — never guessed from filename or platform list. Used only when the
 * caller doesn't pass --orientation explicitly, so this never has to be
 * remembered by hand (Cole relay, 2026-09-26).
 */
function detectOrientationFromPixels(videoPath) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=s=x:p=0', videoPath,
  ], { encoding: 'utf8' }).trim();
  const [w, h] = out.split('x').map(Number);
  if (!w || !h) throw new Error(`ffprobe returned no readable dimensions for ${videoPath}: "${out}"`);
  const orientation = h > w ? 'vertical' : 'horizontal';
  console.log(`[register-local-video] ffprobe dimensions ${w}x${h} -> orientation=${orientation}`);
  return orientation;
}

async function main() {
  const videoPath = arg('--video');
  if (!videoPath || !fs.existsSync(videoPath)) {
    console.error(`FAILED: --video not found: ${videoPath || '(missing)'}`);
    process.exit(1);
  }
  const id = arg('--id', path.basename(videoPath, path.extname(videoPath)));
  const topic = arg('--topic', id);
  const platforms = String(arg('--platforms', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const owner = arg('--owner', 'dossie');
  const dryRun = process.argv.includes('--dry-run');
  const approve = process.argv.includes('--approve');
  const scheduledFor = arg('--scheduled-for');

  if (!platforms.length) {
    console.error('FAILED: --platforms is required (comma-separated, e.g. tiktok,instagram,facebook)');
    process.exit(1);
  }

  let orientation = arg('--orientation');
  if (orientation && orientation !== 'vertical' && orientation !== 'horizontal' && orientation !== 'vertical_long') {
    console.error(`FAILED: --orientation must be vertical | horizontal | vertical_long, got: ${orientation}`);
    process.exit(1);
  }
  if (!orientation) {
    orientation = detectOrientationFromPixels(videoPath);
  }

  let coverPath = arg('--cover');
  let coverIsTemp = false;
  if (!coverPath) {
    console.log('[register-local-video] no --cover given, extracting frame 0 via ffmpeg...');
    coverPath = extractCoverFrame(videoPath);
    coverIsTemp = true;
  }

  console.log(`[register-local-video] running quality gate for ${platforms.join(',')} (orientation=${orientation})...`);
  const gateResult = runQualityGate(videoPath, coverPath, platforms, orientation);
  console.log(`[register-local-video] gate result: pass=${gateResult.pass} failedRules=${(gateResult.failedRules || []).join(',') || 'none'}`);

  const captionFile = arg('--caption-file');
  let caption = captionFile ? fs.readFileSync(captionFile, 'utf8').trim() : arg('--caption');
  if (!caption) {
    console.log('[register-local-video] no caption given, generating via Claude Haiku...');
    caption = await generateCaption(topic, { log: console.log, warn: console.warn });
  }

  try {
    const out = await queueVariant({
      videoPath, coverPath, id, topic, caption, platforms, owner,
      gateResult, approve, dryRun, scheduledFor,
      extraDetail: { registered_by: 'scripts/register-local-video.js', orientation },
    });
    console.log(JSON.stringify(out, null, 2));
    if (!gateResult.pass) process.exit(1); // queueVariant would have already thrown, but be explicit
  } finally {
    if (coverIsTemp) { try { fs.unlinkSync(coverPath); } catch { /* best effort */ } }
  }
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
