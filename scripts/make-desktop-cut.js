#!/usr/bin/env node
'use strict';

// scripts/make-desktop-cut.js
//
// Turns one finished 9:16 vertical master into the 16:9 DESKTOP CUT, so the
// same day's material feeds Facebook, LinkedIn and X as well as Instagram,
// TikTok and YouTube Shorts.
//
// ---------------------------------------------------------------------------
// WHY A SECOND FILE AND NOT A SECOND ROW ON THE SAME ONE
// ---------------------------------------------------------------------------
// api/_lib/verify-video-quality.js ships one SHAPE per video_library row and
// refuses a platforms array that mixes the two families. That refusal is right:
// on 2026-09-15 two real 1920x1080 files went to Facebook, which renders that
// surface as vertical Reels and letterboxed them into a thin strip with ~80%
// black around it. The opposite mistake — a 9:16 file dropped into a desktop
// feed — is the same defect mirrored.
//
// So "post daily to every platform" cannot mean one asset tagged with every
// platform. It means render both shapes. This file is the second shape.
//
// ---------------------------------------------------------------------------
// HOW THE 16:9 FRAME IS FILLED, AND WHY NOT BLACK BARS
// ---------------------------------------------------------------------------
// The gate's content_fills_frame rule requires real content across >=85% of the
// frame and detects persistent uniform bars of ANY colour (it works on a
// normalised 128x128 grayscale grid, so a white or blush bar counts exactly
// like a black one). A naive pillarbox measures ~0.31 there and fails — and it
// SHOULD fail, because two thirds of a desktop feed slot would be dead space.
//
// The composition here is the standard feed treatment: the source scaled to
// cover the full 1920x1080 and heavily blurred as a background plate, with the
// sharp 607x1080 vertical column centred on top of it. Every row and column of
// the output therefore carries moving, varying picture — the frame is genuinely
// full, not padded. This is not a way around the rule; a blurred plate derived
// from the footage is what the rule asks for instead of bars.
//
// CAPTIONS are already burned into the master and ride along inside the sharp
// column. The gate treats captions_present as advisory on the horizontal lane
// for exactly this reason.
//
// COVER: the vertical cover PNG gets the same treatment at 1920x1080, because
// cover_asset_present is a hard rule on both lanes and a 9:16 cover on a
// desktop post is the thumbnail version of the same mistake.
//
// RUNTIME is unchanged, and the horizontal lane's window is 10-90s (hard max
// 120s) against the vertical lane's tighter Reels windows — so a cut that
// passed vertically always fits horizontally.
//
// ---------------------------------------------------------------------------
// USAGE
// ---------------------------------------------------------------------------
//   node scripts/make-desktop-cut.js --in <master.mp4> [--cover <cover.png>]
//        [--out <desktop.mp4>] [--platforms facebook,linkedin]
//
// Writes, next to --out:
//   <stem>.mp4          1920x1080 H.264 + the master's audio, stream-copied
//   <stem>.cover.png    1920x1080 cover
//   <stem>.meta.json    manifest with orientation=horizontal and the real
//                       horizontal platform lane, which
//                       scripts/queue-finished-videos.py reads and lets
//                       override its filename guesses
//   <stem>.caption.txt  copied from the master when one exists
//
// The output stem carries `-desktop-` so that even if the sidecar is lost, the
// scanner's own naming lane still classifies it as the landscape cut.

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
try { require('./_lib/load-env-local.js').loadEnvLocal(REPO); } catch { /* optional */ }

const { splitLanes, loadOwnerLanes } = require('./_lib/video-lanes.js');

const W = 1920;
const H = 1080;
// 1080 * 9/16 = 607.5 -> 608 keeps the column even-width for yuv420p.
const COL_W = 608;

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

function die(msg) {
  console.error('[desktop-cut] ' + msg);
  process.exit(1);
}
function log(m) { console.log('[desktop-cut] ' + m); }

function ffprobeJson(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=width,height,codec_type',
    '-show_entries', 'format=duration', '-of', 'json', file,
  ], { encoding: 'utf8' });
  return JSON.parse(out);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status})`);
}

async function main() {
  const inPath = opt('in');
  if (!inPath) die('--in <master.mp4> is required');
  if (!fs.existsSync(inPath)) die(`input not found: ${inPath}`);

  const probe = ffprobeJson(inPath);
  const v = (probe.streams || []).find((s) => s.codec_type === 'video');
  const hasAudio = (probe.streams || []).some((s) => s.codec_type === 'audio');
  if (!v) die('input has no video stream');
  const ratio = v.width / v.height;
  if (ratio >= 1) {
    die(`input is ${v.width}x${v.height} (ratio ${ratio.toFixed(3)}) — this tool derives the `
      + 'horizontal cut FROM a vertical master. A file that is already landscape needs no cut, '
      + 'and running this on one would blur-plate a 16:9 source against itself.');
  }
  // Refusing a silent master here rather than producing a silent derivative:
  // the vertical row would fail the gate's audio_present_and_audible rule and
  // this one would fail it identically, so making the file at all just doubles
  // the wasted render.
  if (!hasAudio) {
    die('input has no audio stream — the master is silent, which is itself a build defect '
      + '(scripts/build-shortform-video.py refuses to emit one). Fix the master, not the cut.');
  }

  const inDir = path.dirname(path.resolve(inPath));
  const inStem = path.basename(inPath, path.extname(inPath));
  // `-desktop-<date>` is the scanner's own landscape naming lane
  // (scripts/queue-finished-videos.py classify_video), so the file classifies
  // correctly even with no sidecar.
  const dateSuffix = (/\d{4}-\d{2}-\d{1,2}$/.exec(inStem) || [])[0]
    || new Date().toISOString().slice(0, 10);
  const baseStem = inStem.replace(/-\d{4}-\d{2}-\d{1,2}$/, '').replace(/-(mobile|selfie|vertical)$/, '');
  const outStem = `${baseStem}-desktop-${dateSuffix}`;
  const outPath = opt('out') || path.join(inDir, `${outStem}.mp4`);
  const outDir = path.dirname(path.resolve(outPath));
  fs.mkdirSync(outDir, { recursive: true });
  const finalStem = path.basename(outPath, path.extname(outPath));
  const coverOut = path.join(outDir, `${finalStem}.cover.png`);
  const metaOut = path.join(outDir, `${finalStem}.meta.json`);

  log(`master : ${inPath}  (${v.width}x${v.height}, ${Number(probe.format.duration).toFixed(2)}s)`);

  // ── video ────────────────────────────────────────────────────────────────
  // [bg] cover the full frame from the source, then blur hard. scale=-2 keeps
  //      dimensions even. The crop re-centres after the over-scale.
  // [fg] the sharp vertical column at full output height.
  // Audio is stream-copied: the master's mix is already loudnorm'd to spec and
  // re-encoding it would only lose quality.
  const filter =
    `[0:v]scale=${W}:-2:flags=lanczos,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.06:saturation=1.1[bg];`
    + `[0:v]scale=${COL_W}:${H}:flags=lanczos[fg];`
    + `[bg][fg]overlay=(W-w)/2:0,setsar=1,format=yuv420p[v]`;

  run('ffmpeg', ['-y', '-v', 'error', '-i', inPath,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '19', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart',
    outPath]);
  log(`video  : ${outPath}`);

  // ── cover ────────────────────────────────────────────────────────────────
  // Three places to look, in order of authority. The third matters: renders
  // that predate build-shortform-video.py always writing <out>.cover.png leave
  // their cover in the private render-work directory and only record the path
  // in the meta sidecar's `cover_png`. Without that fallback this tool skips
  // the cover on exactly the videos already on disk, and the cut then fails
  // the gate's cover_asset_present rule for a file that has a perfectly good
  // cover ten directories away.
  let masterMetaEarly = {};
  try {
    const mp = path.join(inDir, `${inStem}.meta.json`);
    if (fs.existsSync(mp)) masterMetaEarly = JSON.parse(fs.readFileSync(mp, 'utf8')) || {};
  } catch { masterMetaEarly = {}; }
  const coverIn = opt('cover')
    || [
      path.join(inDir, `${inStem}.cover.png`),
      path.join(inDir, `${inStem}.png`),
      masterMetaEarly.cover_png,
    ].filter(Boolean).find((p) => fs.existsSync(p));
  if (coverIn && fs.existsSync(coverIn)) {
    run('ffmpeg', ['-y', '-v', 'error', '-i', coverIn,
      '-filter_complex',
      `[0:v]split[a][b];`
        + `[a]scale=${W}:-2:flags=lanczos,crop=${W}:${H},boxblur=28:2,eq=brightness=-0.06[bg];`
        + `[b]scale=${COL_W}:${H}:flags=lanczos[fg];`
        + `[bg][fg]overlay=(W-w)/2:0,format=rgb24[out]`,
      '-map', '[out]', '-frames:v', '1',
      coverOut]);
    log(`cover  : ${coverOut}`);
  } else {
    // Not fatal here, but it WILL fail the gate's cover_asset_present rule, so
    // say exactly that rather than letting it look fine and fail later.
    console.warn('[desktop-cut] WARNING: no cover PNG found next to the master and none passed '
      + `via --cover. ${path.basename(coverOut)} was NOT written, and this cut will FAIL the `
      + 'gate\'s cover_asset_present rule.');
  }

  // ── caption sidecar ──────────────────────────────────────────────────────
  const capIn = path.join(inDir, `${inStem}.caption.txt`);
  if (fs.existsSync(capIn)) {
    fs.copyFileSync(capIn, path.join(outDir, `${finalStem}.caption.txt`));
    log(`caption: copied from the master`);
  } else {
    console.warn('[desktop-cut] WARNING: no caption sidecar next to the master — the row will '
      + 'ingest with an EMPTY caption (never a template string; that is the scanner\'s rule).');
  }

  // ── manifest ─────────────────────────────────────────────────────────────
  let masterMeta = {};
  const masterMetaPath = path.join(inDir, `${inStem}.meta.json`);
  try {
    if (fs.existsSync(masterMetaPath)) masterMeta = JSON.parse(fs.readFileSync(masterMetaPath, 'utf8')) || {};
  } catch { masterMeta = {}; }

  const owner = masterMeta.target_owner || opt('owner') || 'dossie';
  let horizontal;
  const explicit = opt('platforms');
  if (explicit) {
    horizontal = splitLanes(explicit.split(',').map((s) => s.trim()).filter(Boolean)).horizontal;
  } else {
    const lanes = await loadOwnerLanes();
    horizontal = (lanes.owners[owner] || {}).horizontal || [];
    log(`lane   : ${owner} horizontal = [${horizontal.join(', ') || 'none'}] (${lanes.source})`);
  }
  if (horizontal.length === 0) {
    die(`owner ${owner} has no active horizontal (facebook/twitter/linkedin) Zernio account, `
      + 'so this cut has nowhere to go. Not writing a row that can never post.');
  }

  const outProbe = ffprobeJson(outPath);
  const ov = (outProbe.streams || []).find((s) => s.codec_type === 'video');
  const manifest = {
    ...masterMeta,
    derived_from: path.basename(inPath),
    orientation: 'horizontal',
    resolution: `${ov.width}x${ov.height}`,
    duration_seconds: Number(Number(outProbe.format.duration).toFixed(2)),
    type: 'screen_recording',
    platforms: horizontal,
    target_owner: owner,
    cover_png: fs.existsSync(coverOut) ? path.resolve(coverOut) : null,
    cut: {
      method: 'blurred-cover plate + centred sharp 9:16 column',
      column_width: COL_W,
      note: 'Captions are burned into the master and ride inside the column; the gate treats '
        + 'captions_present as advisory on the horizontal lane.',
    },
  };
  fs.writeFileSync(metaOut, JSON.stringify(manifest, null, 2), 'utf8');
  log(`meta   : ${metaOut}`);
  log(`DONE   ${ov.width}x${ov.height} -> ${horizontal.join(', ')}`);
}

main().catch((e) => die((e && e.stack) || String(e)));
