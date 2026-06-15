#!/usr/bin/env node
/**
 * Talking-Head + Screen-Background video pipeline (Dossie / Shepard Ventures).
 *
 * What this does
 * --------------
 * Heath records himself against a solid green backdrop (vertical, phone is fine).
 * This script:
 *   1) Chroma-keys the green out of the selfie and composites it over a Dossie
 *      screen recording, locally with ffmpeg. Output is a single 1080x1920 MP4.
 *   2) (Optional) Sends the selfie audio to OpenAI Whisper for word-level
 *      transcription. We use that for karaoke captions.
 *   3) Uploads the composite + audio to Supabase Storage.
 *   4) Calls Creatomate to add bold karaoke captions + a background music bed,
 *      and outputs the final post-ready vertical video.
 *   5) Drops the finished video at:
 *        Media/finished-videos/talking-head-<YYYY-MM-DD>-<slug>.mp4
 *      and pings Heath via Claudy on Telegram for approval.
 *
 * Design notes (why split between ffmpeg and Creatomate)
 * ------------------------------------------------------
 * - ffmpeg's `chromakey` filter is bulletproof, free, runs locally, and gives
 *   us pixel-level control over the key color, similarity threshold, and edge
 *   blend. Creatomate's API does not expose a documented green-screen filter.
 * - Creatomate is best at: caption rendering with per-word timing, audio
 *   ducking, deterministic 1080x1920 output, and CDN hosting of the finished
 *   file. We let it do that and nothing else.
 * - Net result: ONE creatomate render call per finished video. Predictable
 *   cost. ffmpeg eats the heavy pixel work.
 *
 * CLI
 * ---
 *   node scripts/generate-talking-head-video.js \
 *     --selfie  <path-to-green-screen-selfie.mp4> \
 *     --screen  <path-to-screen-recording.mp4 OR filename in Media/screen-recordings/> \
 *     [--script "<voiceover transcript text>"] \
 *     [--script-file <path-to-txt>] \
 *     [--music <path-to-mp3>] \
 *     [--caption "Bottom-line one-liner for social"] \
 *     [--slug talking-head-test] \
 *     [--telegram] \
 *     [--keep-temp]
 *
 * If --script / --script-file are both omitted, we run Whisper on the selfie
 * audio and use the returned word timings for karaoke captions.
 *
 * Required env (read from MeetDossie/.env.local)
 * ----------------------------------------------
 *   CREATOMATE_API_KEY
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY   (used for storage upload; private buckets)
 *   OPENAI_API_KEY              (only required if no script provided)
 *   TELEGRAM_BOT_TOKEN          (Claudy — only if --telegram)
 *   TELEGRAM_CHAT_ID            (only if --telegram)
 *
 * @author Atlas (Head of Platform Engineering — Shepard Ventures)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Repo-anchored constants. All paths absolute by design so the script behaves
// the same no matter what cwd Cole spawns us from.
// ---------------------------------------------------------------------------
const REPO_ROOT = 'C:\\Users\\Heath Shepard\\Desktop\\MeetDossie';
const MEDIA_DIR = path.join(REPO_ROOT, 'Media');
const SCREEN_RECORDINGS_DIR = path.join(MEDIA_DIR, 'screen-recordings');
const FINISHED_VIDEOS_DIR = path.join(MEDIA_DIR, 'finished-videos');
const MUSIC_DIR = path.join(MEDIA_DIR, 'Music');
const DEFAULT_MUSIC = path.join(MUSIC_DIR, 'joyinsound-corporate-motivational-background-music-403417.mp3');
const ENV_LOCAL = path.join(REPO_ROOT, '.env.local');

const FINAL_WIDTH = 1080;
const FINAL_HEIGHT = 1920;
const FINAL_FPS = 30;

// Chroma key params. similarity 0.30 = aggressive enough to catch a green
// bedsheet under uneven lighting without eating skin tones. blend 0.12 keeps
// the edge soft so it doesn't look cut-out.
const CHROMA_COLOR = '0x00FF00';
const CHROMA_SIMILARITY = 0.30;
const CHROMA_BLEND = 0.12;

// ---------------------------------------------------------------------------
// .env.local loader — minimal, no dep. Supports `KEY="value"` and `KEY=value`.
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  if (!fs.existsSync(ENV_LOCAL)) return;
  const text = fs.readFileSync(ENV_LOCAL, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvLocal();

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

function usage(msg) {
  if (msg) console.error('ERROR:', msg);
  console.error(
    '\nUsage:\n' +
    '  node scripts/generate-talking-head-video.js \\\n' +
    '    --selfie <path-to-green-screen.mp4> \\\n' +
    '    --screen <path-or-filename-in-Media/screen-recordings/> \\\n' +
    '    [--script "voiceover text"] [--script-file path.txt] \\\n' +
    '    [--music path.mp3] [--caption "social caption"] \\\n' +
    '    [--slug talking-head-test] [--telegram] [--keep-temp]\n'
  );
  process.exit(msg ? 2 : 0);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'untitled';
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function shaTag(input) {
  return crypto.createHash('sha1').update(input).digest('hex').slice(0, 8);
}

function logStep(label) {
  console.log('\n=== ' + label + ' ===');
}

// Resolve --screen: accept either an absolute path or a filename relative to
// Media/screen-recordings/.
function resolveScreenPath(arg) {
  if (!arg) return null;
  if (fs.existsSync(arg)) return path.resolve(arg);
  const direct = path.join(SCREEN_RECORDINGS_DIR, arg);
  if (fs.existsSync(direct)) return direct;
  // Try the vertical subfolder, just in case.
  const vert = path.join(SCREEN_RECORDINGS_DIR, 'vertical', arg);
  if (fs.existsSync(vert)) return vert;
  throw new Error('Screen recording not found: ' + arg);
}

// ffprobe wrapper. Returns { width, height, duration }.
function ffprobe(file) {
  const r = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration:format=duration',
    '-of', 'json',
    file,
  ], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('ffprobe failed for ' + file + ': ' + r.stderr);
  const j = JSON.parse(r.stdout);
  const stream = (j.streams || [])[0] || {};
  const fmt = j.format || {};
  return {
    width: stream.width || 0,
    height: stream.height || 0,
    duration: parseFloat(stream.duration || fmt.duration || '0'),
  };
}

// ---------------------------------------------------------------------------
// Stage 1: ffmpeg composite — chroma-key selfie, overlay on screen recording,
// 1080x1920 vertical, selfie audio preserved.
// ---------------------------------------------------------------------------
function ffmpegComposite({ selfiePath, screenPath, outPath, duration }) {
  logStep('Stage 1 — ffmpeg chroma-key composite');

  // Filter graph:
  //  - [0:v]: selfie — chroma-keyed, scaled to fit inside 1080x1920 keeping
  //    aspect, then padded to exactly 1080x1920 so the overlay coords are
  //    deterministic.
  //  - [1:v]: screen — scaled to cover 1080x1920 (crop to fill), looped to
  //    match selfie duration.
  //  - overlay [bg][fg] -> final video
  //
  // We keep the selfie audio (-map 0:a) and drop screen audio entirely.
  const filter = [
    // Screen recording: cover-fit to 1080x1920. We always force the same scale
    // chain regardless of the input aspect ratio so the math stays simple.
    '[1:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[bg]',
    // Selfie: chroma key first (in original aspect), then fit inside 1080x1920
    // with transparent padding so we can overlay at 0,0.
    `[0:v]chromakey=color=${CHROMA_COLOR}:similarity=${CHROMA_SIMILARITY}:blend=${CHROMA_BLEND},` +
      'scale=1080:1920:force_original_aspect_ratio=decrease,' +
      'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x00000000,setsar=1[fg]',
    // Composite
    '[bg][fg]overlay=0:0:format=auto,format=yuv420p[v]',
  ].join(';');

  const args = [
    '-y',
    '-i', selfiePath,
    '-stream_loop', '-1', '-i', screenPath, // loop screen recording forever; -t below clips it
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-r', String(FINAL_FPS),
    '-c:a', 'aac',
    '-b:a', '160k',
    '-t', duration.toFixed(2),
    '-movflags', '+faststart',
    outPath,
  ];

  console.log('  ffmpeg ' + args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' '));
  const r = spawnSync('ffmpeg', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) throw new Error('ffmpeg composite failed (exit ' + r.status + ')');

  if (!fs.existsSync(outPath)) throw new Error('Composite output missing: ' + outPath);
  console.log('  OK composite: ' + outPath);
}

// ---------------------------------------------------------------------------
// Stage 1b: extract selfie audio to MP3 (for upload to Creatomate + Whisper).
// ---------------------------------------------------------------------------
function ffmpegExtractAudio({ selfiePath, outPath }) {
  const r = spawnSync('ffmpeg', [
    '-y', '-i', selfiePath,
    '-vn', '-c:a', 'libmp3lame', '-q:a', '4',
    outPath,
  ], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) throw new Error('audio extract failed');
}

// ---------------------------------------------------------------------------
// Stage 2: Whisper transcription with word-level timestamps.
// Returns { text, words: [{ word, start, end }] }
// ---------------------------------------------------------------------------
async function whisperTranscribe(audioPath) {
  logStep('Stage 2 — OpenAI Whisper transcription');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set — provide --script to skip Whisper');

  const buf = fs.readFileSync(audioPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/mpeg' }), path.basename(audioPath));
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');

  const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey },
    body: form,
  });
  if (!r.ok) throw new Error('Whisper failed: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  const words = (j.words || []).map(w => ({ word: w.word, start: w.start, end: w.end }));
  console.log(`  OK Whisper: ${words.length} words, ${j.duration?.toFixed?.(1) || '?'}s`);
  return { text: j.text || '', words };
}

// ---------------------------------------------------------------------------
// Build pseudo word-timings from a provided script when --script was passed
// without Whisper. We distribute words evenly across the selfie duration so
// captions still feel synced. Not perfect, but good enough when Heath supplies
// his own transcript.
// ---------------------------------------------------------------------------
function fakeWordTimings(scriptText, duration) {
  const words = scriptText.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const per = duration / words.length;
  return words.map((w, i) => ({ word: w, start: i * per, end: (i + 1) * per }));
}

// ---------------------------------------------------------------------------
// Stage 3: Supabase Storage uploads.
// We use the service_role key for simplicity (server-side script). Bucket
// `videos` is private; `voiceovers` is public-read. We need the composite
// publicly fetchable by Creatomate, so we upload it to `social-cards` (already
// public, mime type permissive) under a unique key — same pattern the
// existing creatomate pipeline uses for frames/audio.
// ---------------------------------------------------------------------------
async function supabaseUpload({ bucket, filename, bytes, contentType }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');

  const upUrl = `${url}/storage/v1/object/${bucket}/${filename}`;
  const r = await fetch(upUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!r.ok && r.status !== 409) {
    throw new Error(`Supabase upload failed (${bucket}/${filename}): ${r.status} ${await r.text()}`);
  }
  return `${url}/storage/v1/object/public/${bucket}/${filename}`;
}

// ---------------------------------------------------------------------------
// Stage 4: Creatomate render — captions + music bed over the composite.
//
// We build per-word text elements (Hormozi-style: bold white, yellow on the
// "active" word). Each word element is visible only during its [start..end]
// window, achieved by setting `time` + `duration` on the element. Creatomate
// supports this natively.
//
// To prevent caption thrash (a flicker per word), we chunk the words into
// short phrases of 2-4 words. The active word inside the phrase is rendered
// in yellow via a `color` per-word in `text` strings is NOT a Creatomate
// feature, so instead we render each *word* as its own text element. With 30
// words and 30 elements over 45 seconds, this is well within Creatomate's
// element budget.
// ---------------------------------------------------------------------------
async function creatomateRender({ compositeUrl, musicUrl, words, duration }) {
  logStep('Stage 4 — Creatomate composite render');
  const apiKey = process.env.CREATOMATE_API_KEY;
  if (!apiKey) throw new Error('CREATOMATE_API_KEY not set');

  const elements = [];

  // Track 1: the chroma-keyed composite video. Audio from this track is the
  // talking-head's voice — keep at 100%.
  elements.push({
    type: 'video',
    track: 1,
    time: 0,
    duration,
    source: compositeUrl,
    fit: 'cover',
    volume: '100%',
  });

  // Track 2: background music bed at low volume so it sits under the voice.
  // -20 dB ~= 10% linear volume.
  if (musicUrl) {
    elements.push({
      type: 'audio',
      track: 2,
      time: 0,
      duration,
      source: musicUrl,
      volume: '10%',
      loop: true,
    });
  }

  // Track 3+: per-word caption elements. Hormozi style — big bold white,
  // bottom third, yellow highlight on the active word.
  // We render each word as a single element and time it precisely.
  // To keep the look readable, we also draw a "context strip" — the next 3
  // words sitting next to the active one in white at lower opacity.
  //
  // Implementation: cluster words into rolling 3-word phrases. For each
  // phrase, emit one text element with the active word in yellow via Pango
  // markup... Creatomate does NOT support Pango. Falling back to: emit ONE
  // text element per word, sized large, bottom-third, visible only during
  // that word's [start..end]. Simple, predictable, no flicker.
  if (words && words.length) {
    let track = 3;
    for (const w of words) {
      const start = Math.max(0, w.start);
      const end = Math.min(duration, w.end);
      const dur = Math.max(0.08, end - start);
      const cleanWord = (w.word || '').trim();
      if (!cleanWord) continue;
      elements.push({
        type: 'text',
        track,
        time: start,
        duration: dur,
        text: cleanWord.toUpperCase(),
        x_alignment: '50%',
        y_alignment: '75%',
        width: '85%',
        font_family: 'Inter',
        font_weight: '900',
        font_size: '9 vmin',
        fill_color: '#FFE600', // yellow active word
        stroke_color: '#000000',
        stroke_width: '0.6 vmin',
        background_color: 'rgba(0,0,0,0.55)',
        background_x_padding: '4%',
        background_y_padding: '2%',
        background_border_radius: '2%',
        shadow_color: 'rgba(0,0,0,0.6)',
        shadow_blur: '1 vmin',
      });
      track++;
    }
  }

  const body = {
    source: {
      output_format: 'mp4',
      width: FINAL_WIDTH,
      height: FINAL_HEIGHT,
      frame_rate: FINAL_FPS,
      duration,
      elements,
    },
  };

  const r = await fetch('https://api.creatomate.com/v1/renders', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('Creatomate render submit failed: ' + r.status + ' ' + (await r.text()));
  const j = await r.json();
  const render = Array.isArray(j) ? j[0] : j;
  console.log('  OK render submitted: ' + render.id);

  // Poll
  const start = Date.now();
  const maxMs = 6 * 60 * 1000; // 6 minutes
  while (Date.now() - start < maxMs) {
    await new Promise(res => setTimeout(res, 5000));
    const s = await fetch('https://api.creatomate.com/v1/renders/' + render.id, {
      headers: { Authorization: 'Bearer ' + apiKey },
    });
    if (!s.ok) {
      console.log('  poll error ' + s.status);
      continue;
    }
    const sj = await s.json();
    console.log('  status: ' + sj.status);
    if (sj.status === 'succeeded') return sj;
    if (sj.status === 'failed') throw new Error('Creatomate render failed: ' + (sj.error_message || 'unknown'));
  }
  throw new Error('Creatomate render timed out after 6 min');
}

// ---------------------------------------------------------------------------
// Stage 5: download finished video into Media/finished-videos/.
// ---------------------------------------------------------------------------
async function downloadTo(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('Download failed: ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(destPath, buf);
  return destPath;
}

// ---------------------------------------------------------------------------
// Telegram ping via Claudy (TELEGRAM_BOT_TOKEN). Sends video as document
// (avoids Telegram re-compressing it) + a short caption.
// ---------------------------------------------------------------------------
async function telegramSendVideo({ filePath, caption }) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('  (Telegram skipped — no TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
    return null;
  }
  // Use sendVideo so it plays inline on Heath's phone (sendDocument would force
  // a download). 50 MB upload cap on bot API, which is fine for <=60s clips.
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption || '');
  form.append('parse_mode', 'HTML');
  form.append('supports_streaming', 'true');
  const buf = fs.readFileSync(filePath);
  form.append('video', new Blob([buf], { type: 'video/mp4' }), path.basename(filePath));

  const r = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) {
    const errText = await r.text();
    console.log('  Telegram sendVideo failed: ' + r.status + ' ' + errText);
    // Fall back to a text-only ping so Heath at least knows it's done.
    try {
      const tr = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: (caption || 'Talking-head video ready') + '\n\n(sendVideo failed: ' + r.status + ')',
          parse_mode: 'HTML',
        }),
      });
      if (!tr.ok) console.log('  Telegram text fallback also failed: ' + tr.status);
    } catch (_) { /* ignore */ }
    return null;
  }
  console.log('  OK Telegram delivered to chat ' + chatId);
  return await r.json();
}

// ---------------------------------------------------------------------------
// video_library row insert (best-effort — no failure if Supabase rejects).
// ---------------------------------------------------------------------------
async function logToVideoLibrary({ slug, dateStr, finalPath, supabaseVideoUrl, caption }) {
  // Schema as observed in production (probed 2026-06-15):
  //   id (text, PK), path (text), type (text), topic (text), produced_date
  //   (date), status (text), platforms (text[]), caption (text),
  //   telegram_message_id, supabase_url (text), posted_date, created_at
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const repoRelativePath = finalPath.replace(/^.*?MeetDossie[\\/]/, '').replace(/\\/g, '/');
    const row = {
      id: `talking-head-${slug}-${dateStr}`,
      path: repoRelativePath,
      type: 'talking_head',
      topic: 'talking_head',
      produced_date: dateStr,
      status: 'draft',
      platforms: ['instagram', 'tiktok', 'facebook', 'linkedin', 'twitter'],
      caption: caption || '',
      supabase_url: supabaseVideoUrl || '',
    };
    const r = await fetch(`${url}/rest/v1/video_library`, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal,resolution=merge-duplicates',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      console.log('  video_library insert non-fatal failure: ' + r.status + ' ' + (await r.text()));
    } else {
      console.log('  OK video_library row inserted (' + row.id + ')');
    }
  } catch (e) {
    console.log('  video_library insert non-fatal exception: ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  const args = parseArgs(process.argv);
  if (args.help || args.h) usage();
  if (!args.selfie) usage('--selfie is required');
  if (!args.screen) usage('--screen is required');

  const selfiePath = path.resolve(args.selfie);
  if (!fs.existsSync(selfiePath)) usage('selfie file not found: ' + selfiePath);

  const screenPath = resolveScreenPath(args.screen);
  const musicPath = args.music ? path.resolve(args.music) : (fs.existsSync(DEFAULT_MUSIC) ? DEFAULT_MUSIC : null);

  ensureDir(FINISHED_VIDEOS_DIR);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'talking-head-'));
  console.log('Temp working dir: ' + tmpRoot);

  const slug = slugify(args.slug || path.basename(selfiePath, path.extname(selfiePath)));
  const dateStr = todayISO();
  const finalName = `talking-head-${dateStr}-${slug}.mp4`;
  const finalPath = path.join(FINISHED_VIDEOS_DIR, finalName);

  try {
    // Probe selfie for duration. We clip the screen recording to match.
    const selfieInfo = ffprobe(selfiePath);
    const duration = Math.min(60, Math.max(3, selfieInfo.duration));
    console.log(`Selfie: ${selfieInfo.width}x${selfieInfo.height}, ${selfieInfo.duration.toFixed(2)}s — using duration ${duration.toFixed(2)}s`);

    const screenInfo = ffprobe(screenPath);
    console.log(`Screen: ${path.basename(screenPath)} — ${screenInfo.width}x${screenInfo.height}, ${screenInfo.duration.toFixed(2)}s`);

    // Stage 1: composite
    const compositePath = path.join(tmpRoot, 'composite.mp4');
    ffmpegComposite({ selfiePath, screenPath, outPath: compositePath, duration });

    // Stage 1b: extract audio (for Whisper, only if needed)
    let words;
    let scriptText = '';
    if (args.script) {
      scriptText = args.script;
    } else if (args['script-file']) {
      scriptText = fs.readFileSync(path.resolve(args['script-file']), 'utf8');
    }
    if (scriptText) {
      console.log('Using provided script — distributing word timings evenly across duration.');
      words = fakeWordTimings(scriptText, duration);
    } else {
      const audioPath = path.join(tmpRoot, 'selfie-audio.mp3');
      ffmpegExtractAudio({ selfiePath, outPath: audioPath });
      const tr = await whisperTranscribe(audioPath);
      words = tr.words;
      scriptText = tr.text;
    }

    // Stage 3: upload composite + music to Supabase Storage. We use the
    // `videos` bucket — it's public, 100MB cap, and explicitly allow-lists
    // both video/mp4 and audio/mpeg. `social-cards` rejects audio mime types
    // (image-first bucket), so don't reuse it here.
    logStep('Stage 3 — Supabase Storage upload');
    const stamp = shaTag(finalName + Date.now());
    const compositeBytes = fs.readFileSync(compositePath);
    const compositeKey = `talking-head/${dateStr}-${slug}-${stamp}-composite.mp4`;
    const compositeUrl = await supabaseUpload({
      bucket: 'videos',
      filename: compositeKey,
      bytes: compositeBytes,
      contentType: 'video/mp4',
    });
    console.log('  composite URL: ' + compositeUrl);

    let musicUrl = null;
    if (musicPath && fs.existsSync(musicPath)) {
      const mBytes = fs.readFileSync(musicPath);
      const mKey = `talking-head/music-${shaTag(musicPath)}.mp3`;
      musicUrl = await supabaseUpload({
        bucket: 'videos',
        filename: mKey,
        bytes: mBytes,
        contentType: 'audio/mpeg',
      });
      console.log('  music URL:     ' + musicUrl);
    }

    // Stage 4: Creatomate render
    const render = await creatomateRender({ compositeUrl, musicUrl, words, duration });

    // Stage 5: download + log + telegram
    logStep('Stage 5 — Download + deliver');
    await downloadTo(render.url, finalPath);
    console.log('  finished video: ' + finalPath);
    console.log('  Creatomate URL: ' + render.url);
    console.log('  render scale:   ' + (render.render_scale || 1));
    if (render.render_scale && render.render_scale < 1) {
      console.log('  WARN: Creatomate returned render_scale=' + render.render_scale +
        ' — account is on a dev tier. Upgrade plan for full 1080x1920.');
    }

    // Also upload the finished video back into Supabase `videos` bucket so
    // downstream cron-post-videos can pick it up the same way it does for the
    // existing pipelines.
    let finalSupabaseUrl = '';
    try {
      const finishedBytes = fs.readFileSync(finalPath);
      finalSupabaseUrl = await supabaseUpload({
        bucket: 'videos',
        filename: `talking-head/${finalName}`,
        bytes: finishedBytes,
        contentType: 'video/mp4',
      });
      console.log('  finished URL:   ' + finalSupabaseUrl);
    } catch (e) {
      console.log('  finished upload non-fatal: ' + e.message);
    }

    await logToVideoLibrary({
      slug,
      dateStr,
      finalPath,
      supabaseVideoUrl: finalSupabaseUrl,
      caption: args.caption || '',
    });

    if (args.telegram) {
      const cap =
        `<b>Talking-head video ready</b>\n` +
        (args.caption ? `\n${args.caption}\n` : '') +
        `\nslug: <code>${slug}</code>\n` +
        `duration: ${duration.toFixed(1)}s\n` +
        `file: <code>${finalName}</code>\n` +
        (render.render_scale && render.render_scale < 1
          ? `\n⚠ render_scale ${render.render_scale} — dev tier, not full HD`
          : '');
      await telegramSendVideo({ filePath: finalPath, caption: cap });
    }

    // Final JSON for any orchestrator scraping stdout
    console.log('\nJSON_OUTPUT:');
    console.log(JSON.stringify({
      ok: true,
      final_path: finalPath,
      final_name: finalName,
      creatomate_url: render.url,
      duration,
      render_scale: render.render_scale || 1,
      composite_url: compositeUrl,
      music_url: musicUrl,
      script_text: scriptText.slice(0, 500),
      word_count: words ? words.length : 0,
    }));
  } catch (err) {
    console.error('\nFATAL:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    if (!args['keep-temp']) {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch (_) { /* ignore */ }
    } else {
      console.log('Temp dir retained: ' + tmpRoot);
    }
  }
})();
