'use strict';

// scripts/capture-screen-recording-app.js
//
// Captures a clean, postable screen recording of a REAL Dossie app flow
// (demo account only, WORKS-list capabilities only — see
// docs/DOSSIE-VERIFIED-CAPABILITIES.md) and places it in
// Media/screen-recordings/ under the naming convention documented in
// Media/screen-recordings/LIBRARY.md:
//
//   <topic-slug>-mobile-<YYYY-MM-DD>.mp4    portrait  -> instagram, tiktok
//   <topic-slug>-desktop-<YYYY-MM-DD>.mp4   landscape -> facebook, twitter, linkedin
//
// Reuses scripts/feature-demo-recorder.js's proven Playwright recordVideo
// pipeline (RULE 1 — scan before build) rather than reimplementing scene
// actions, login handling, or the vertical-aspect framing preflight. That
// recorder writes raw .webm to Media/feature-demos/raw/; this wrapper
// converts to .mp4 via ffmpeg and moves the result into
// Media/screen-recordings/ with the collision-safe naming convention above.
//
// Usage:
//   node scripts/capture-screen-recording-app.js scripts/screen-recording-scenes/dossier-deadlines-mobile.json

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { record } = require('./feature-demo-recorder.js');

const SCREEN_RECORDINGS_DIR = path.join(__dirname, '..', 'Media', 'screen-recordings');

function findFfmpeg() {
  const probe = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (probe.status === 0) return 'ffmpeg';
  throw new Error('ffmpeg not found on PATH');
}

// Never overwrite an existing recording — append a date/counter on collision,
// per LIBRARY.md's naming rule.
function collisionSafePath(destDir, filename) {
  let candidate = path.join(destDir, filename);
  if (!fs.existsSync(candidate)) return candidate;
  const ext = path.extname(filename);
  const base = filename.slice(0, -ext.length);
  let n = 2;
  while (fs.existsSync(path.join(destDir, `${base}-${n}${ext}`))) n += 1;
  return path.join(destDir, `${base}-${n}${ext}`);
}

async function main(scriptPath) {
  const scriptCfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  console.log(`[capture-app] scene: ${scriptCfg.name} (${scriptCfg.form_factor})`);

  const rawWebmPath = await record(scriptPath); // reuses feature-demo-recorder.js verbatim

  fs.mkdirSync(SCREEN_RECORDINGS_DIR, { recursive: true });
  const destPath = collisionSafePath(SCREEN_RECORDINGS_DIR, scriptCfg.filename);

  const ffmpeg = findFfmpeg();
  const args = [
    '-y', '-i', rawWebmPath,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium',
    '-an', // silent — voiceover/music added downstream by the video pipeline
    destPath,
  ];
  console.log(`[capture-app] ffmpeg ${args.join(' ')}`);
  const res = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 });
  if (res.status !== 0) {
    throw new Error(`ffmpeg convert failed: ${res.stderr || res.stdout}`);
  }

  console.log(`\n[capture-app] DONE: ${destPath}`);
  return destPath;
}

if (require.main === module) {
  const scriptPath = process.argv[2];
  if (!scriptPath) {
    console.error('Usage: node scripts/capture-screen-recording-app.js <scene-script.json>');
    process.exit(1);
  }
  main(path.resolve(scriptPath)).catch((err) => {
    console.error(`[capture-app] FATAL: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
