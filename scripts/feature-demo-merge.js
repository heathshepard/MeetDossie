'use strict';

// scripts/feature-demo-merge.js
//
// Take a raw .webm screen recording and an ElevenLabs voiceover, align them,
// and emit a final .mp4 sized to the voiceover length. If the recording is
// SHORTER than the voiceover, the final frame is held to make up the gap. If
// the recording is LONGER, it's trimmed to the voiceover end + 1s tail.
//
// Usage:
//   node scripts/feature-demo-merge.js <scene-script.json> [--regen-voiceover]

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateSpeech } = require('../api/_utils/tts');

// ─── Env loader ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const RAW_DIR = path.join(__dirname, '..', 'Media', 'feature-demos', 'raw');
const VO_DIR = path.join(__dirname, '..', 'Media', 'feature-demos', 'voiceovers');
const OUT_DIR = path.join(__dirname, '..', 'Media', 'feature-demos');
fs.mkdirSync(RAW_DIR, { recursive: true });
fs.mkdirSync(VO_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── ffmpeg / ffprobe locators ────────────────────────────────────────────────

function findFfmpeg() {
  const check = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (check.status === 0) return 'ffmpeg';
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1-full_build', 'bin', 'ffmpeg.exe'
  );
  if (fs.existsSync(winget)) return winget;
  throw new Error('ffmpeg not found. Install via: winget install Gyan.FFmpeg');
}

function findFfprobe() {
  const check = spawnSync('ffprobe', ['-version'], { encoding: 'utf8' });
  if (check.status === 0) return 'ffprobe';
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1-full_build', 'bin', 'ffprobe.exe'
  );
  if (fs.existsSync(winget)) return winget;
  throw new Error('ffprobe not found. Install via: winget install Gyan.FFmpeg');
}

function runFfmpeg(ffmpeg, args) {
  console.log(`[merge] ffmpeg ${args.join(' ')}`);
  const res = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg exited ${res.status}: ${res.stderr || res.stdout}`);
  return res;
}

function durationSeconds(ffprobe, file) {
  const res = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`ffprobe failed on ${file}: ${res.stderr}`);
  return parseFloat(res.stdout.trim());
}

// ─── Voiceover gen ────────────────────────────────────────────────────────────

async function generateVoiceover(text, voiceId, outPath) {
  console.log(`[merge] Generating voiceover (voice=${voiceId})`);
  const { buffer, provider } = await generateSpeech(text, {
    elevenLabsVoiceId: voiceId,
    persona: 'luna',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  fs.writeFileSync(outPath, buffer);
  console.log(`[merge] Voiceover saved (${provider}): ${outPath}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function merge(scriptPath, opts = {}) {
  const cfg = JSON.parse(fs.readFileSync(scriptPath, 'utf8'));
  const baseName = cfg.filename.replace(/\.mp4$/i, '');
  const rawWebm = path.join(RAW_DIR, `${baseName}.webm`);
  const voPath = path.join(VO_DIR, `${baseName}.mp3`);
  const finalMp4 = path.join(OUT_DIR, cfg.filename);

  if (!fs.existsSync(rawWebm)) throw new Error(`Raw recording missing: ${rawWebm}. Run feature-demo-recorder.js first.`);

  // 1. Voiceover — generate if missing or --regen flag passed
  if (!fs.existsSync(voPath) || opts.regen) {
    if (!cfg.voiceover) throw new Error('Scene script is missing a "voiceover" field.');
    await generateVoiceover(cfg.voiceover, cfg.elevenlabs_voice_id, voPath);
  } else {
    console.log(`[merge] Voiceover already exists: ${voPath} (pass --regen-voiceover to rebuild)`);
  }

  // 2. Probe durations
  const ffmpeg = findFfmpeg();
  const ffprobe = findFfprobe();
  const voDur = durationSeconds(ffprobe, voPath);
  const vidDur = durationSeconds(ffprobe, rawWebm);
  console.log(`[merge] voiceover=${voDur.toFixed(2)}s  video=${vidDur.toFixed(2)}s`);

  // 3. Target length = voiceover + 1.0s tail (so last frame breathes)
  const targetLen = voDur + 1.0;

  // 4. Build filter chain:
  //    - If video shorter than target: pad with last-frame freeze via tpad.
  //    - If video longer than target: hard-trim with -t.
  //    - Audio: pad with silence to targetLen via apad+atrim.

  const args = ['-y',
    '-i', rawWebm,
    '-i', voPath,
  ];

  if (vidDur < targetLen) {
    // tpad clones the last frame for (targetLen - vidDur)s
    const padSec = (targetLen - vidDur).toFixed(2);
    args.push(
      '-filter_complex',
      `[0:v]tpad=stop_mode=clone:stop_duration=${padSec},fps=30[v];[1:a]apad,atrim=duration=${targetLen.toFixed(2)},asetpts=N/SR/TB[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', targetLen.toFixed(2),
      '-movflags', '+faststart',
      finalMp4,
    );
  } else {
    // Trim video to targetLen, voiceover is shorter so pad with silence
    args.push(
      '-filter_complex',
      `[0:v]trim=duration=${targetLen.toFixed(2)},setpts=PTS-STARTPTS,fps=30[v];[1:a]apad,atrim=duration=${targetLen.toFixed(2)},asetpts=N/SR/TB[a]`,
      '-map', '[v]', '-map', '[a]',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k',
      '-t', targetLen.toFixed(2),
      '-movflags', '+faststart',
      finalMp4,
    );
  }

  runFfmpeg(ffmpeg, args);

  const finalDur = durationSeconds(ffprobe, finalMp4);
  const finalSize = (fs.statSync(finalMp4).size / 1024 / 1024).toFixed(2);
  console.log(`\n[merge] DONE`);
  console.log(`  ${finalMp4}`);
  console.log(`  duration=${finalDur.toFixed(2)}s  size=${finalSize} MB`);
  return finalMp4;
}

if (require.main === module) {
  const scriptPath = process.argv[2];
  const regen = process.argv.includes('--regen-voiceover');
  if (!scriptPath) {
    console.error('Usage: node scripts/feature-demo-merge.js <scene-script.json> [--regen-voiceover]');
    process.exit(1);
  }
  merge(path.resolve(scriptPath), { regen })
    .then((p) => console.log(`\nFINAL: ${p}`))
    .catch((err) => {
      console.error(`[merge] FATAL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { merge };
