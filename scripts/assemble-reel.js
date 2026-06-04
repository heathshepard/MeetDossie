#!/usr/bin/env node
/**
 * assemble-reel.js
 * Assembles a 2-clip vertical social reel with text overlays and ElevenLabs voiceover.
 *
 * Usage:
 *   node scripts/assemble-reel.js \
 *     --clip1 <path>        Pain-point shot (plays first, ~5s)
 *     --clip2 <path>        Relief shot (plays second, ~5s)
 *     --headline1 <text>    Text overlay for clip 1 (default: "$8,000/year")
 *     --headline2 <text>    Text overlay for clip 2 (default: "or $29/month")
 *     --cta <text>          CTA at bottom third of clip 2 (default: "meetdossie.com/founding")
 *     --voiceover <text>    Script for ElevenLabs TTS (required, or use --skip-voiceover)
 *     --voice-id <id>       ElevenLabs voice ID (default: IKne3meq5aSn9XLyUdCD)
 *     --output <path>       Output MP4 (required)
 *     --skip-voiceover      Assemble without audio (for testing)
 *
 * Requirements:
 *   - ffmpeg in PATH
 *   - ELEVENLABS_API_KEY in environment or .env.production in MeetDossie repo root
 *
 * Pipeline:
 *   1. Generate voiceover via ElevenLabs TTS API
 *   2. Concatenate clips to a temp intermediate file (codec copy, instant)
 *   3. Apply drawtext overlays + audio via filter_complex
 *   4. Output H.264/AAC MP4, yuv420p, 1080x1920
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const https = require('https');

// ---------------------------------------------------------------------------
// Resolve ElevenLabs API key
// ---------------------------------------------------------------------------
function resolveElevenLabsKey() {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY;

  // Walk up to find .env.production
  const candidates = [
    path.join(__dirname, '..', '.env.production'),
    path.join(__dirname, '..', '.env.production.local'),
    path.join(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
    if (fs.existsSync(f)) {
      const match = fs.readFileSync(f, 'utf8').match(/ELEVENLABS_API_KEY="?([^"\n]+)"?/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generate voiceover via ElevenLabs streaming TTS
// ---------------------------------------------------------------------------
async function generateVoiceover(text, voiceId, apiKey, outputPath) {
  const body = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: { stability: 0.65, similarity_boost: 0.75, style: 0.0, speed: 1.15 },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${voiceId}/stream`,
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', (c) => (err += c));
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${err}`)));
        return;
      }
      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Locate ffmpeg binary (checks PATH then common WinGet install)
// ---------------------------------------------------------------------------
function findFfmpeg() {
  // Try PATH first
  const check = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  if (check.status === 0) return 'ffmpeg';

  // WinGet default location on Windows
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1-full_build', 'bin', 'ffmpeg.exe'
  );
  if (fs.existsSync(winget)) return winget;

  throw new Error('ffmpeg not found in PATH or WinGet install location');
}

// ---------------------------------------------------------------------------
// Write a temp file (ASCII, no BOM — required for ffmpeg filter scripts)
// ---------------------------------------------------------------------------
function writeTempAscii(content, suffix) {
  const p = path.join(os.tmpdir(), `assemble_reel_${Date.now()}${suffix}`);
  fs.writeFileSync(p, content, { encoding: 'ascii' });
  return p;
}

// ---------------------------------------------------------------------------
// Run ffmpeg, inherit stderr so progress is visible
// ---------------------------------------------------------------------------
function ffmpeg(ffmpegBin, args) {
  const result = spawnSync(ffmpegBin, args, { stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited with code ${result.status}`);
  }
}

// ---------------------------------------------------------------------------
// Build drawtext filter chain for a single text overlay
// Parameters:
//   text        - displayed string ($ and , are escaped for ffmpeg)
//   fontFile    - Windows path with backslash-escaped colon (C\:/Windows/...)
//   fontSize    - integer
//   yExpr       - ffmpeg expression for y position
//   tStart      - fade-in starts at this timestamp (seconds)
//   tEnd        - fade ends and text disappears at this timestamp
//   fadeDur     - fade-in duration in seconds (default 0.3)
// ---------------------------------------------------------------------------
function drawtextFilter(text, fontFile, fontSize, yExpr, tStart, tEnd, fadeDur = 0.3) {
  // Escape characters that ffmpeg's drawtext treats as special
  const escaped = text
    .replace(/\$/g, '\\$')
    .replace(/,/g, '\\,')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");

  return (
    `drawtext=fontfile='${fontFile}'` +
    `:text='${escaped}'` +
    `:fontsize=${fontSize}` +
    `:fontcolor=white@1.0` +
    `:x=(w-text_w)/2` +
    `:y=${yExpr}` +
    `:enable='between(t,${tStart},${tEnd})'` +
    `:alpha='min(1\\,(t-${tStart})/${fadeDur})'`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  function flag(name, defaultVal) {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return defaultVal;
    return args[i + 1];
  }

  function hasFlag(name) {
    return args.includes(`--${name}`);
  }

  const clip1 = flag('clip1', null);
  const clip2 = flag('clip2', null);
  const headline1 = flag('headline1', '$8,000/year');
  const headline2 = flag('headline2', 'or $29/month');
  const cta = flag('cta', 'meetdossie.com/founding');
  const voiceoverText = flag('voiceover', null);
  const voiceId = flag('voice-id', 'IKne3meq5aSn9XLyUdCD');
  const outputPath = flag('output', null);
  const skipVoiceover = hasFlag('skip-voiceover');

  if (!clip1 || !clip2) {
    console.error('ERROR: --clip1 and --clip2 are required.');
    process.exit(1);
  }
  if (!outputPath) {
    console.error('ERROR: --output is required.');
    process.exit(1);
  }
  if (!voiceoverText && !skipVoiceover) {
    console.error('ERROR: --voiceover <text> is required (or use --skip-voiceover).');
    process.exit(1);
  }

  if (!fs.existsSync(clip1)) {
    console.error(`ERROR: clip1 not found: ${clip1}`);
    process.exit(1);
  }
  if (!fs.existsSync(clip2)) {
    console.error(`ERROR: clip2 not found: ${clip2}`);
    process.exit(1);
  }

  const ffmpegBin = findFfmpeg();
  console.log(`ffmpeg: ${ffmpegBin}`);

  const tempFiles = [];

  try {
    // Step 1 — Generate voiceover
    let voiceoverPath = null;
    if (!skipVoiceover) {
      const apiKey = resolveElevenLabsKey();
      if (!apiKey) {
        console.error(
          'ERROR: ELEVENLABS_API_KEY not found in environment or .env.production. ' +
          'Use --skip-voiceover to assemble without audio.'
        );
        process.exit(1);
      }
      voiceoverPath = path.join(os.tmpdir(), `reel_voiceover_${Date.now()}.mp3`);
      tempFiles.push(voiceoverPath);
      console.log(`Generating voiceover (voice ${voiceId})...`);
      await generateVoiceover(voiceoverText, voiceId, apiKey, voiceoverPath);
      console.log(`Voiceover saved: ${voiceoverPath}`);
    }

    // Step 2 — Concatenate clips (codec copy, near-instant)
    const concatListPath = writeTempAscii(
      `file '${clip1.replace(/\\/g, '/')}'\nfile '${clip2.replace(/\\/g, '/')}'\n`,
      '_concat.txt'
    );
    tempFiles.push(concatListPath);

    const intermediatePath = path.join(os.tmpdir(), `reel_concat_${Date.now()}.mp4`);
    tempFiles.push(intermediatePath);

    console.log('Concatenating clips...');
    ffmpeg(ffmpegBin, [
      '-y',
      '-f', 'concat', '-safe', '0', '-i', concatListPath,
      '-c', 'copy',
      intermediatePath,
    ]);
    console.log(`Intermediate: ${intermediatePath}`);

    // Step 3 — Build filter_complex for text overlays
    // Font paths in ffmpeg drawtext require C\:/Windows/... notation on Windows
    const fontBold = 'C\\:/Windows/Fonts/arialbd.ttf';
    const fontRegular = 'C\\:/Windows/Fonts/arial.ttf';

    // Timing: clip1 = 0–5s, clip2 = 5–10s
    const dt1 = drawtextFilter(headline1, fontBold, 80, '(h/2-80)', 0.5, 4.5);
    const dt2 = drawtextFilter(headline2, fontBold, 80, '(h/2-80)', 5.5, 9.5);
    const dt3 = drawtextFilter(cta, fontRegular, 44, 'h*0.82', 8.0, 10.5);

    // Get video duration so we can trim padded audio to exactly match.
    // apad alone runs forever without a duration bound — atrim stops it cleanly.
    let videoDuration = 10.08; // safe default for 2x ~5s clips
    try {
      const probe = spawnSync(ffmpegBin, ['-i', intermediatePath], { encoding: 'utf8' });
      const m = (probe.stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
      if (m) videoDuration = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
    } catch (_) { /* use default */ }

    let filterContent;
    if (voiceoverPath) {
      filterContent =
        `[0:v]${dt1},${dt2},${dt3}[v];` +
        `[1:a]volume=0.9,apad,atrim=duration=${videoDuration.toFixed(3)},asetpts=PTS-STARTPTS[a]`;
    } else {
      filterContent = `[0:v]${dt1},${dt2},${dt3}[v]`;
    }

    const filterFile = writeTempAscii(filterContent, '_filter.txt');
    tempFiles.push(filterFile);

    // Step 4 — Final encode
    console.log('Encoding final reel...');
    const encodeArgs = [
      '-y',
      '-i', intermediatePath,
    ];
    if (voiceoverPath) encodeArgs.push('-i', voiceoverPath);

    encodeArgs.push(
      '-/filter_complex', filterFile,
      '-map', '[v]',
    );
    if (voiceoverPath) encodeArgs.push('-map', '[a]');

    encodeArgs.push(
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
      '-pix_fmt', 'yuv420p'
    );
    if (voiceoverPath) {
      encodeArgs.push('-c:a', 'aac', '-b:a', '192k');
    }

    encodeArgs.push(outputPath);

    ffmpeg(ffmpegBin, encodeArgs);

    console.log(`\nDone. Output: ${outputPath}`);
    const stat = fs.statSync(outputPath);
    console.log(`Size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);

  } finally {
    // Clean up temp files
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_) { /* ignore */ }
    }
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
