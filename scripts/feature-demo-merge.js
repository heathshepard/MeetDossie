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

// Resolves an ffmpeg-suite binary. Prefers one already on PATH; otherwise
// locates the winget install. Version-agnostic (globs `ffmpeg-*-full_build`
// rather than pinning a version) and works under WSL, where LOCALAPPDATA is
// unset and the Windows profile is reachable only via /mnt/c.
function findFfBinary(name) {
  const check = spawnSync(name, ['-version'], { encoding: 'utf8' });
  if (check.status === 0) return name;

  const WINGET_PKG = 'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe';
  const roots = [];
  if (process.env.LOCALAPPDATA) roots.push(process.env.LOCALAPPDATA);
  // WSL: enumerate Windows profiles under /mnt/c/Users.
  try {
    for (const user of fs.readdirSync('/mnt/c/Users')) {
      roots.push(path.join('/mnt/c/Users', user, 'AppData', 'Local'));
    }
  } catch { /* not WSL, or no /mnt/c — fall through */ }

  for (const root of roots) {
    const pkgDir = path.join(root, 'Microsoft', 'WinGet', 'Packages', WINGET_PKG);
    let builds;
    try {
      builds = fs.readdirSync(pkgDir).filter((d) => /^ffmpeg-.*build$/.test(d));
    } catch { continue; }
    // Newest build directory first, so an upgrade is picked up automatically.
    builds.sort().reverse();
    for (const build of builds) {
      const exe = path.join(pkgDir, build, 'bin', `${name}.exe`);
      if (fs.existsSync(exe)) return exe;
    }
  }

  throw new Error(`${name} not found. Install via: winget install Gyan.FFmpeg`);
}

function findFfmpeg() { return findFfBinary('ffmpeg'); }
function findFfprobe() { return findFfBinary('ffprobe'); }

// The winget ffmpeg/ffprobe are real Windows binaries. Under WSL, a WSL path
// like /mnt/c/Users/... means nothing to a Windows .exe — it needs the
// Windows-style equivalent (C:\Users\...). Only translate when we're
// actually about to shell out to a .exe; a native Linux ffmpeg on PATH
// understands WSL paths natively and must NOT be translated.
function toBinPath(binary, p) {
  if (!binary.toLowerCase().endsWith('.exe')) return p;
  if (!p.startsWith('/')) return p; // already a plain filename/flag
  const res = spawnSync('wslpath', ['-w', p], { encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`wslpath -w failed on ${p}: ${res.stderr}`);
  return res.stdout.trim();
}

function runFfmpeg(ffmpeg, args) {
  const translated = args.map((a) => (a.startsWith('/') ? toBinPath(ffmpeg, a) : a));
  console.log(`[merge] ffmpeg ${translated.join(' ')}`);
  const res = spawnSync(ffmpeg, translated, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`ffmpeg exited ${res.status}: ${res.stderr || res.stdout}`);
  return res;
}

function durationSeconds(ffprobe, file) {
  const res = spawnSync(ffprobe, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    toBinPath(ffprobe, file),
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
