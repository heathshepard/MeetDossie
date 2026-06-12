'use strict';

// scripts/sage-reel-builder.js
//
// Builds a 60-90s social reel by chaining 2-3 tutorial bites with brand title
// cards between them. Optimized for IG/TikTok/FB Reels (1080x1920 vertical).
//
// Usage:
//   node scripts/sage-reel-builder.js \
//     --slug morning-workflow-reel \
//     --title "Your Morning Workflow" \
//     --bites read-your-morning-brief,check-pipeline-at-a-glance,use-talk-to-dossie-voice \
//     --platforms instagram,facebook,tiktok \
//     --caption "Three taps. Your whole morning, handled. #realestate #txrealtor"
//
// What it does:
// 1. Resolves each bite slug to a local Media/tutorial-videos/<slug>-vN.mp4
//    (picks highest version). Falls back to Supabase URL if local missing.
// 2. Renders title card frames via ffmpeg for the reel intro + section breaks.
// 3. Concats: intro card -> bite1 -> divider card -> bite2 -> divider card -> bite3 -> outro card
// 4. Uploads final MP4 to Supabase Storage videos/reels/<slug>.mp4
// 5. Queues social_posts rows (draft) for each target platform with the reel.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const https = require('https');

// ─── Load .env.local ──────────────────────────────────────────────────────────
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch (_) {}
})();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ROOT = path.join(__dirname, '..');
const BITES_DIR = path.join(ROOT, 'Media', 'tutorial-videos');
const REELS_DIR = path.join(ROOT, 'Media', 'tutorial-videos', 'reels');
const CACHE_DIR = path.join(REELS_DIR, '_cache');

// Zernio account IDs (CLAUDE.md sec 22)
const ZERNIO_ACCOUNTS = {
  facebook: '69f253c3985e734bf3d8f9bc',
  instagram: '69f25431985e734bf3d8fcbe',
  tiktok: '69f15791985e734bf3d13b89',
};

function parseArgs() {
  const a = process.argv.slice(2);
  // Only track CLI-provided values; defaults applied AFTER brief merge so brief wins.
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--slug') o.slug = a[++i];
    else if (a[i] === '--title') o.title = a[++i];
    else if (a[i] === '--bites') o.bites = a[++i].split(',').map(s => s.trim()).filter(Boolean);
    else if (a[i] === '--platforms') o.platforms = a[++i];
    else if (a[i] === '--caption') o.caption = a[++i];
    else if (a[i] === '--hashtags') o.hashtags = a[++i];
    else if (a[i] === '--no-queue') o.noQueue = true;
    else if (a[i] === '--brief') o.briefPath = a[++i];
  }
  let merged = { ...o };
  if (o.briefPath) {
    const b = JSON.parse(fs.readFileSync(o.briefPath, 'utf8'));
    // Brief fills in anything CLI didn't set; CLI flags still win when both present.
    merged = { ...b, ...o };
  }
  if (!merged.slug || !merged.bites?.length) throw new Error('Need --slug and --bites');
  // Apply default platforms only if neither brief nor CLI set them.
  if (!merged.platforms) merged.platforms = 'instagram,facebook';
  // Brief may set platforms as an array; CLI sets as comma-separated string. Normalize.
  if (Array.isArray(merged.platforms)) {
    merged.platforms = merged.platforms.map(s => s.trim()).filter(Boolean);
  } else {
    merged.platforms = String(merged.platforms).split(',').map(s => s.trim()).filter(Boolean);
  }
  return merged;
}

function findFfmpeg() {
  if (spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' }).status === 0) return 'ffmpeg';
  const winget = path.join(
    process.env.LOCALAPPDATA || '',
    'Microsoft', 'WinGet', 'Packages',
    'Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe',
    'ffmpeg-8.1-full_build', 'bin', 'ffmpeg.exe'
  );
  if (fs.existsSync(winget)) return winget;
  throw new Error('ffmpeg not found.');
}

function runFfmpeg(ffmpeg, args, label = '') {
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed (${label}): ${(result.stderr || '').slice(0, 800)}`);
  }
  return result;
}

function getMediaDuration(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const res = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' });
  const dur = parseFloat((res.stdout || '').trim());
  return Number.isFinite(dur) ? dur : 0;
}

// Resolve a bite slug to a local mp4 file (highest version)
function resolveLocalBite(slug) {
  if (!fs.existsSync(BITES_DIR)) return null;
  const matches = fs.readdirSync(BITES_DIR)
    .filter(f => f.startsWith(`${slug}-v`) && f.endsWith('.mp4'))
    .map(f => {
      const m = f.match(/-v(\d+)\.mp4$/);
      return { f, v: m ? parseInt(m[1], 10) : 0 };
    })
    .sort((a, b) => b.v - a.v);
  if (!matches.length) return null;
  return path.join(BITES_DIR, matches[0].f);
}

function downloadTo(url, dest) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return downloadTo(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`GET ${url} -> ${res.statusCode}`));
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => out.close(() => resolve()));
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

async function fetchBiteUrls(slugs) {
  const inList = slugs.map(s => `"${s}"`).join(',');
  const url = `${SUPABASE_URL}/rest/v1/tutorial_videos?slug=in.(${encodeURIComponent(inList)})&select=slug,video_url,title,duration_seconds,voiceover_script`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`Fetch bites failed: ${res.status}`);
  const rows = await res.json();
  return new Map(rows.map(r => [r.slug, r]));
}

async function ensureBiteAvailable(slug, biteMap) {
  // 1. Prefer local
  const local = resolveLocalBite(slug);
  if (local) return local;

  // 2. Fall back to Supabase URL
  const meta = biteMap.get(slug);
  if (!meta || !meta.video_url) {
    throw new Error(`Bite not available locally or in DB: ${slug}`);
  }
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${slug}.mp4`);
  if (!fs.existsSync(file)) {
    console.log(`[reel] download ${slug}...`);
    await downloadTo(meta.video_url, file);
  }
  return file;
}

// Render a title card frame to a 1.8s MP4 (no audio) at 1080x1920.
// Uses ffmpeg drawtext over a brand blush background.
function renderTitleCard(ffmpeg, text, outFile, durationSec = 1.8) {
  // Brand colors: blush #F5E6E0 bg, coral #E8836B accent, navy #1A1A2E text.
  // Use a font copied to the project (avoids Windows colon-in-path drawtext escape hell).
  // The font is staged at scripts/_reel-font.ttf via the project bootstrap.
  const fontFile = path.join(__dirname, '_reel-font.ttf');
  if (!fs.existsSync(fontFile)) {
    throw new Error(`Missing reel font: ${fontFile} — copy a TTF (e.g. arialbd.ttf) into scripts/`);
  }
  // Use relative path (cwd-relative) so ffmpeg doesn't choke on Windows drive colon.
  const relFont = path.relative(ROOT, fontFile).replace(/\\/g, '/');

  // Sanitize text for drawtext. drawtext text is wrapped in single quotes by us;
  // escape backslashes, colons, percent; replace single quote with unicode right
  // single quotation mark (U+2019) since drawtext + single-quote escaping is a
  // known pain on Windows. Keeps the apostrophe visible without breaking ffmpeg.
  const sanitize = (s) => s
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’')
    .replace(/%/g, '\\%');

  // Wrap long lines: split on " | " for forced breaks, then word-wrap each piece
  // to a max ~20 chars so the title comfortably fits inside 1080px at fontsize 72.
  // At fontsize 72 bold, ~20-22 chars fits within ~1000px (60px L/R margin).
  const MAX_CHARS_PER_LINE = 22;
  function wordWrap(str) {
    const words = str.split(/\s+/);
    const out = [];
    let cur = '';
    for (const w of words) {
      if (!cur.length) { cur = w; continue; }
      if ((cur.length + 1 + w.length) <= MAX_CHARS_PER_LINE) {
        cur += ' ' + w;
      } else {
        out.push(cur);
        cur = w;
      }
    }
    if (cur.length) out.push(cur);
    return out;
  }
  const explicitLines = text.split(' | ');
  const wrapped = explicitLines.flatMap(wordWrap);
  const lines = wrapped.map(sanitize);
  const lineSpacing = 110;
  const totalHeight = lines.length * lineSpacing;
  const startY = `(h-${totalHeight})/2`;

  const filters = lines.map((line, i) => {
    const y = `${startY}+${i * lineSpacing}`;
    return `drawtext=fontfile=${relFont}:text='${line}':fontcolor=0x1A1A2E:fontsize=72:x=(w-text_w)/2:y=${y}`;
  }).join(',');

  runFfmpeg(ffmpeg, [
    '-f', 'lavfi',
    '-i', `color=c=0xF5E6E0:s=1080x1920:d=${durationSec.toFixed(2)}:r=30`,
    '-vf', filters,
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-y', outFile,
  ], `title-card "${text}"`);
}

// Render a silent audio track of N seconds (matches title card)
function renderSilentAudio(ffmpeg, durationSec, outFile) {
  runFfmpeg(ffmpeg, [
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=48000`,
    '-t', durationSec.toFixed(2),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-y', outFile,
  ], `silent-audio ${durationSec}s`);
}

// Mux title card MP4 with silent audio so concat works (every clip must have audio)
function muxTitleCardWithAudio(ffmpeg, videoIn, audioIn, outFile) {
  runFfmpeg(ffmpeg, [
    '-i', videoIn,
    '-i', audioIn,
    '-c:v', 'copy',
    '-c:a', 'copy',
    '-shortest',
    '-y', outFile,
  ], 'mux title card');
}

// Normalize a bite to known specs (1080x1920 30fps H.264 AAC 48kHz) so concat
// stream-copy works reliably. Bites are already rendered at 1080x1920 by the
// recording script but may vary on framerate or audio sample rate.
function normalizeBite(ffmpeg, inFile, outFile) {
  runFfmpeg(ffmpeg, [
    '-i', inFile,
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:0xF5E6E0,fps=30,setsar=1',
    '-c:v', 'libx264',
    '-preset', 'fast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-y', outFile,
  ], `normalize ${path.basename(inFile)}`);
}

function concatNormalized(ffmpeg, files, outFile) {
  const listFile = path.join(CACHE_DIR, `_concat-${Date.now()}.txt`);
  fs.writeFileSync(listFile, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
  runFfmpeg(ffmpeg, [
    '-f', 'concat',
    '-safe', '0',
    '-i', listFile,
    '-c', 'copy',
    '-movflags', '+faststart',
    '-y', outFile,
  ], 'concat');
}

async function uploadFile(filePath, storagePath, contentType = 'video/mp4') {
  const url = `${SUPABASE_URL}/storage/v1/object/videos/${storagePath}`;
  const body = fs.readFileSync(filePath);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': contentType,
      'x-upsert': 'true',
    },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Upload ${res.status}: ${t.slice(0, 300)}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;
}

async function queueSocialPost(opts) {
  const { platform, mediaUrl, caption, hashtags, title, slug } = opts;
  const account = ZERNIO_ACCOUNTS[platform];
  // Insert as draft for Sage approval next morning
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);

  const payload = {
    post_id: crypto.randomUUID(),
    platform,
    media_url: mediaUrl,
    content: caption || `${title} — see how Dossie handles your real estate transactions for Texas agents.`,
    hashtags: hashtags || [],
    persona: 'dossie',
    status: 'draft',
    scheduled_for: tomorrow.toISOString(),
    source_type: 'sage_reel',
    requires_approval: true,
    video_required: true,
    topic: `tutorial-reel-${slug}`,
    voiceover_script: title,
    zernio_account_id: account || null,
  };

  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_posts`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Queue ${platform} failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const row = await res.json();
  return Array.isArray(row) ? row[0] : row;
}

async function main() {
  const args = parseArgs();
  fs.mkdirSync(REELS_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const ffmpeg = findFfmpeg();

  console.log(`[reel] Building reel: ${args.slug}`);
  console.log(`[reel] Bites: ${args.bites.join(' -> ')}`);
  console.log(`[reel] Platforms: ${args.platforms.join(', ')}`);

  // 1. Resolve every bite to a local mp4
  const biteMap = await fetchBiteUrls(args.bites);
  const biteFiles = [];
  for (const slug of args.bites) {
    const file = await ensureBiteAvailable(slug, biteMap);
    console.log(`[reel] resolved ${slug} -> ${path.basename(file)}`);
    biteFiles.push({ slug, file });
  }

  // 2. Normalize every bite to 1080x1920 H.264 AAC 48kHz
  const normalizedBites = [];
  for (const b of biteFiles) {
    const out = path.join(CACHE_DIR, `${args.slug}__norm__${b.slug}.mp4`);
    normalizeBite(ffmpeg, b.file, out);
    normalizedBites.push(out);
  }

  // 3. Render intro + outro title cards (1.8s each)
  const introVideo = path.join(CACHE_DIR, `${args.slug}__intro-v.mp4`);
  const introAudio = path.join(CACHE_DIR, `${args.slug}__intro-a.m4a`);
  const introCard = path.join(CACHE_DIR, `${args.slug}__intro.mp4`);
  renderTitleCard(ffmpeg, args.title || args.slug, introVideo, 2.0);
  renderSilentAudio(ffmpeg, 2.0, introAudio);
  muxTitleCardWithAudio(ffmpeg, introVideo, introAudio, introCard);

  const outroVideo = path.join(CACHE_DIR, `${args.slug}__outro-v.mp4`);
  const outroAudio = path.join(CACHE_DIR, `${args.slug}__outro-a.m4a`);
  const outroCard = path.join(CACHE_DIR, `${args.slug}__outro.mp4`);
  renderTitleCard(ffmpeg, 'meetdossie.com | Texas agents', outroVideo, 2.0);
  renderSilentAudio(ffmpeg, 2.0, outroAudio);
  muxTitleCardWithAudio(ffmpeg, outroVideo, outroAudio, outroCard);

  // 4. Concat: intro -> bite1 -> bite2 -> ... -> outro
  const reelOutFile = path.join(REELS_DIR, `${args.slug}.mp4`);
  const concatList = [introCard, ...normalizedBites, outroCard];
  concatNormalized(ffmpeg, concatList, reelOutFile);
  const dur = await getMediaDuration(ffmpeg, reelOutFile);
  console.log(`[reel] Final reel duration: ${dur.toFixed(1)}s -> ${reelOutFile}`);

  // 5. Upload
  let reelUrl = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    reelUrl = await uploadFile(reelOutFile, `tutorials/reels/${args.slug}.mp4`);
    console.log(`[reel] Uploaded: ${reelUrl}`);
  }

  // 6. Queue social_posts
  const queued = [];
  if (!args.noQueue && reelUrl) {
    const hashtags = args.hashtags ? args.hashtags.split(/\s+/).map(h => h.replace(/^#/, '')) : [];
    for (const platform of args.platforms) {
      try {
        const post = await queueSocialPost({
          platform,
          mediaUrl: reelUrl,
          caption: args.caption,
          hashtags,
          title: args.title,
          slug: args.slug,
        });
        queued.push({ platform, id: post.id, post_id: post.post_id });
        console.log(`[reel] Queued for ${platform}: id=${post.id}`);
      } catch (e) {
        console.error(`[reel] Queue failed for ${platform}: ${e.message}`);
      }
    }
  }

  console.log('[reel] DONE');
  console.log(JSON.stringify({ slug: args.slug, duration: dur, url: reelUrl, queued }, null, 2));
}

main().catch(e => {
  console.error('[reel] FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
