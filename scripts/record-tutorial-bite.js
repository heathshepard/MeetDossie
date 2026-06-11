'use strict';

// scripts/record-tutorial-bite.js
//
// Generalized Sage/Carter tutorial bite orchestrator.
// Records a Playwright screen flow (mobile viewport by default), generates a Luna
// voiceover (ElevenLabs primary, OpenAI/nova fallback), combines with ffmpeg,
// uploads to Supabase Storage, and inserts a row in public.tutorial_videos.
//
// Usage:
//   node scripts/record-tutorial-bite.js --slug <slug> [--brief <json-path>]
//
// Tutorial briefs live at scripts/tutorial-briefs/<slug>.json with this shape:
//   {
//     "slug": "open-your-first-dossier",
//     "title": "Open Your First Dossier",
//     "description": "Watch how to start a new transaction in under 30 seconds.",
//     "voiceover_script": "Hi, I'm Dossie...",
//     "tags": ["onboarding","dossier","getting-started"],
//     "target_audience": "new-user",
//     "distribution": ["welcome-email","in-app-help","instagram-reels"],
//     "workflow_group": "general-onboarding",
//     "workflow_order": 2,
//     "viewport": { "width": 390, "height": 844 },
//     "demo_account": "demo@meetdossie.com",
//     "steps": [
//       { "action": "goto", "url": "https://meetdossie.com/app", "pause_ms": 1500 },
//       { "action": "click_text", "text": "Pipeline", "pause_ms": 1200 },
//       { "action": "click_text", "text": "New Dossier", "pause_ms": 1500 },
//       { "action": "fill", "selector": "input[placeholder='Property address']", "value": "1234 Maple Ave", "pause_ms": 800 },
//       { "action": "click_text", "text": "Create", "pause_ms": 2000 }
//     ]
//   }
//
// Steps the orchestrator runs automatically:
//   1) Launches Playwright (mobile viewport) and records the flow as .webm.
//   2) Generates the voiceover MP3 via api/_utils/tts.js (Luna or nova fallback).
//   3) ffmpeg merges video + audio into 1080x1920 H.264/AAC MP4 with auto-captions.
//   4) Uploads MP4 to Supabase Storage `videos/tutorials/<slug>-vN.mp4`.
//   5) Uploads voiceover MP3 to `videos/tutorials/voiceovers/<slug>-vN.mp3`.
//   6) Inserts/updates the row in public.tutorial_videos with status='ready'.
//   7) Optionally sends a Telegram preview if --notify is passed.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { generateSpeech } = require('../api/_utils/tts');

// ─── Load .env.local ──────────────────────────────────────────────────────────
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch (_) { /* non-fatal */ }
})();

const LUNA_VOICE_ID = 'lxYfHSkYm1EzQzGhdbfc';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';
const DEMO_PASSWORD_2 = process.env.DEMO2_PASSWORD || 'DossieDemo2-John2026';

const ROOT = path.join(__dirname, '..');
const BRIEFS_DIR = path.join(__dirname, 'tutorial-briefs');
const RAW_DIR = path.join(ROOT, 'Media', 'tutorial-videos', 'raw');
const OUT_DIR = path.join(ROOT, 'Media', 'tutorial-videos');
const VOICEOVER_DIR = path.join(ROOT, 'Media', 'tutorial-videos', 'voiceovers');

// ─── Args ─────────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { notify: false, dryRun: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--slug') out.slug = args[++i];
    else if (a === '--brief') out.briefPath = args[++i];
    else if (a === '--notify') out.notify = true;
    else if (a === '--dry-run') out.dryRun = true;
  }
  if (!out.slug && !out.briefPath) {
    throw new Error('Usage: node scripts/record-tutorial-bite.js --slug <slug> [--notify] [--dry-run]');
  }
  return out;
}

function loadBrief({ slug, briefPath }) {
  const file = briefPath || path.join(BRIEFS_DIR, `${slug}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`Brief not found: ${file}`);
  }
  const brief = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!brief.slug) brief.slug = slug;
  return brief;
}

// ─── ffmpeg ───────────────────────────────────────────────────────────────────

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
  throw new Error('ffmpeg not found.');
}

function runFfmpeg(ffmpeg, args) {
  console.log(`[tutorial] ffmpeg ${args.slice(0, 6).join(' ')} ...`);
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 800)}`);
  }
  return result;
}

// ─── Voiceover ────────────────────────────────────────────────────────────────

async function generateVoiceover(text, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  console.log('[tutorial] Generating Luna voiceover...');
  const { buffer, provider } = await generateSpeech(text, {
    elevenLabsVoiceId: LUNA_VOICE_ID,
    persona: 'luna',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  fs.writeFileSync(outputPath, buffer);
  console.log(`[tutorial] Voiceover saved (provider=${provider}): ${outputPath}`);
  return provider;
}

// ─── Playwright recording ────────────────────────────────────────────────────

async function recordFlow(brief) {
  const { chromium } = require('playwright');

  const viewport = brief.viewport || { width: 390, height: 844 }; // iPhone 14 portrait
  const demoEmail = brief.demo_account || 'demo@meetdossie.com';
  const demoPassword = demoEmail === 'demo2@meetdossie.com' ? DEMO_PASSWORD_2 : DEMO_PASSWORD;

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });
  const context = await browser.newContext({
    recordVideo: { dir: RAW_DIR, size: viewport },
    viewport,
    deviceScaleFactor: 2,
    isMobile: viewport.width < 500,
    hasTouch: viewport.width < 500,
    userAgent: viewport.width < 500
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });

  const page = await context.newPage();

  async function moveToElement(element) {
    const box = await element.boundingBox();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
    await page.waitForTimeout(150);
  }

  async function maybeLogin(targetUrl) {
    if (!/\/(app|workspace)/.test(targetUrl)) return;
    const emailInput = page.locator('input[type="email"]').first();
    const visible = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (!visible) return;
    console.log(`[tutorial] Login required — signing in as ${demoEmail}`);
    await moveToElement(emailInput);
    await emailInput.click();
    await emailInput.fill(demoEmail);
    const passInput = page.locator('input[type="password"]').first();
    await passInput.waitFor({ state: 'visible' });
    await moveToElement(passInput);
    await passInput.click();
    await passInput.fill(demoPassword);
    const signInBtn = page.locator('button[type="submit"]').first();
    await signInBtn.waitFor({ state: 'visible' });
    await moveToElement(signInBtn);
    await signInBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }

  try {
    for (const step of (brief.steps || [])) {
      const pause = step.pause_ms || 1000;
      switch (step.action) {
        case 'goto':
          console.log(`[tutorial] goto ${step.url}`);
          await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await maybeLogin(step.url);
          await page.waitForTimeout(pause);
          break;
        case 'click_text': {
          const exact = step.exact !== false;
          // Try each match until we find a visible one (mobile nav may hide some)
          const locator = page.getByText(step.text, { exact });
          const count = await locator.count();
          let clicked = false;
          for (let idx = 0; idx < count; idx++) {
            const el = locator.nth(idx);
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            try {
              await moveToElement(el);
              await el.click({ timeout: 5000 });
              clicked = true;
              break;
            } catch (_) { /* try next match */ }
          }
          if (!clicked) {
            // Last resort: scroll into view and force-click the first match
            const el = locator.first();
            await el.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
            await el.click({ force: true, timeout: 5000 });
          }
          await page.waitForTimeout(pause);
          break;
        }
        case 'click': {
          const el = page.locator(step.selector).first();
          await el.waitFor({ state: 'visible', timeout: 10000 });
          await moveToElement(el);
          await el.click();
          await page.waitForTimeout(pause);
          break;
        }
        case 'fill': {
          const el = page.locator(step.selector).first();
          await el.waitFor({ state: 'visible', timeout: 10000 });
          await moveToElement(el);
          await el.click();
          await el.fill(step.value || '');
          await page.waitForTimeout(pause);
          break;
        }
        case 'scroll':
          await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), step.y || 300);
          await page.waitForTimeout(pause);
          break;
        case 'wait':
          await page.waitForTimeout(pause);
          break;
        case 'wait_for_selector':
          await page.waitForSelector(step.selector, { timeout: step.timeout_ms || 10000 });
          await page.waitForTimeout(pause);
          break;
        case 'wait_for_text':
          await page.waitForSelector(`text=${step.text}`, { timeout: step.timeout_ms || 10000 });
          await page.waitForTimeout(pause);
          break;
        case 'hover': {
          const el = page.locator(step.selector).first();
          await moveToElement(el);
          await page.waitForTimeout(pause);
          break;
        }
        default:
          console.warn(`[tutorial] Unknown step action: ${step.action}`);
      }
    }
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  const webms = fs.readdirSync(RAW_DIR)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({ f, mtime: fs.statSync(path.join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!webms.length) throw new Error('No .webm recorded.');
  return path.join(RAW_DIR, webms[0].f);
}

// ─── ffmpeg merge to 1080x1920 H.264/AAC ─────────────────────────────────────

async function getMediaDuration(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const res = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' });
  const dur = parseFloat((res.stdout || '').trim());
  return Number.isFinite(dur) ? dur : 0;
}

async function mergeToMP4(ffmpeg, webmPath, voiceoverPath, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Pad video to match voiceover length so audio never truncates (extends last frame).
  const audioDur = voiceoverPath ? await getMediaDuration(ffmpeg, voiceoverPath) : 0;
  const tpadSec = Math.max(0, Math.ceil(audioDur + 0.5));

  if (voiceoverPath) {
    runFfmpeg(ffmpeg, [
      '-i', webmPath,
      '-i', voiceoverPath,
      '-filter_complex',
      `[0:v]tpad=stop_mode=clone:stop_duration=${tpadSec},scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1[v]`,
      '-map', '[v]',
      '-map', '1:a',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-shortest',
      '-movflags', '+faststart',
      '-y', outPath,
    ]);
  } else {
    runFfmpeg(ffmpeg, [
      '-i', webmPath,
      '-vf', 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,fps=30,setsar=1',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-movflags', '+faststart',
      '-y', outPath,
    ]);
  }
}

// ─── Supabase upload + DB insert ─────────────────────────────────────────────

async function uploadFile(filePath, storagePath, contentType) {
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
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload ${res.status}: ${text.slice(0, 400)}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;
}

async function upsertTutorialRow(brief, videoUrl, voiceoverUrl, durationSeconds) {
  const url = `${SUPABASE_URL}/rest/v1/tutorial_videos?on_conflict=slug`;
  const row = {
    slug: brief.slug,
    title: brief.title,
    description: brief.description || null,
    video_url: videoUrl,
    voiceover_url: voiceoverUrl,
    voiceover_script: brief.voiceover_script || null,
    duration_seconds: durationSeconds,
    tags: brief.tags || [],
    target_audience: brief.target_audience || 'new-user',
    distribution: brief.distribution || [],
    workflow_group: brief.workflow_group || null,
    workflow_order: brief.workflow_order || null,
    status: 'ready',
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upsert ${res.status}: ${text.slice(0, 400)}`);
  }
  return res.json();
}

// ─── Telegram preview ────────────────────────────────────────────────────────

function sendToTelegram(filePath, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const result = spawnSync('curl', [
    '-F', `chat_id=${TELEGRAM_CHAT_ID}`,
    '-F', `video=@${filePath}`,
    '-F', `caption=${caption}`,
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) {
    console.warn('[tutorial] Telegram send failed:', (result.stderr || '').slice(0, 200));
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs();
  const brief = loadBrief(args);

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(VOICEOVER_DIR, { recursive: true });

  if (args.dryRun) {
    console.log('[tutorial] Dry run — printing brief and exiting.');
    console.log(JSON.stringify(brief, null, 2));
    return;
  }

  const version = brief.version || 1;
  const finalMP4 = path.join(OUT_DIR, `${brief.slug}-v${version}.mp4`);
  const voiceoverMP3 = path.join(VOICEOVER_DIR, `${brief.slug}-v${version}.mp3`);

  // 1. Record
  const webmPath = await recordFlow(brief);
  console.log(`[tutorial] Raw recording: ${webmPath}`);

  // 2. Voiceover
  let voiceoverAvailable = false;
  try {
    await generateVoiceover(brief.voiceover_script, voiceoverMP3);
    voiceoverAvailable = true;
  } catch (e) {
    console.warn('[tutorial] Voiceover failed — video-only:', e.message);
  }

  // 3. Merge → MP4
  const ffmpeg = findFfmpeg();
  await mergeToMP4(ffmpeg, webmPath, voiceoverAvailable ? voiceoverMP3 : null, finalMP4);
  const durationSeconds = Math.round(await getMediaDuration(ffmpeg, finalMP4));
  console.log(`[tutorial] Final MP4 (${durationSeconds}s): ${finalMP4}`);

  // 4. Upload
  let videoUrl = null;
  let voiceoverUrl = null;
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    videoUrl = await uploadFile(finalMP4, `tutorials/${brief.slug}-v${version}.mp4`, 'video/mp4');
    if (voiceoverAvailable) {
      voiceoverUrl = await uploadFile(voiceoverMP3, `tutorials/voiceovers/${brief.slug}-v${version}.mp3`, 'audio/mpeg');
    }
    console.log(`[tutorial] Uploaded: ${videoUrl}`);
  } else {
    console.warn('[tutorial] Supabase env missing — skipping upload.');
  }

  // 5. Upsert row
  if (videoUrl) {
    const row = await upsertTutorialRow(brief, videoUrl, voiceoverUrl, durationSeconds);
    console.log('[tutorial] tutorial_videos row:', Array.isArray(row) ? row[0]?.slug : row.slug);
  }

  // 6. Telegram preview (optional)
  if (args.notify) {
    sendToTelegram(finalMP4, `Tutorial bite ready: ${brief.title}\n${videoUrl || '(local only)'}`);
  }

  console.log('[tutorial] Done.');
}

main().catch((err) => {
  console.error('[tutorial] FAILED:', err.message);
  process.exit(1);
});
