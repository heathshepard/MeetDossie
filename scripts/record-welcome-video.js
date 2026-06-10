'use strict';

// scripts/record-welcome-video.js
//
// Records a Playwright screen session of the Dossie Settings page,
// optionally generates a Luna ElevenLabs voiceover, combines with ffmpeg,
// and sends the finished MP4 to Heath via Telegram.
//
// Usage:
//   node scripts/record-welcome-video.js
//
// Env vars required (from .env.local):
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   ELEVENLABS_API_KEY  (optional — skipped gracefully if unavailable)

const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');

const { generateSpeech } = require('../api/_utils/tts');

// Load .env.local when running locally
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
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
  }
} catch (e) {
  // Non-fatal
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Luna voice ID
const LUNA_VOICE_ID = 'lxYfHSkYm1EzQzGhdbfc';

const VOICEOVER_SCRIPT = `Welcome to Dossie. I'm Dossie - your AI transaction coordinator. Let's get your account set up so I can start working for you.

First, head to Settings. This is where I learn who you are - your name, your brokerage, and how clients can reach you.

Fill in your full name and brokerage exactly as they should appear on your files.

Add your phone number so I can include it in documents I prepare for you.

Then scroll down to your review links. Add your Google and Zillow profile URLs here - I'll include them automatically on every closing milestone card I send.

That's it. Once your profile is complete, come back to the dashboard and let's add your first deal. I'll take it from there.`;

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = 'DossieDemo-VaIiAt6Bab';

const TODAY = new Date().toISOString().slice(0, 10);
const RAW_DIR = path.join(__dirname, '..', 'Media', 'instructional-videos', 'raw');
const OUT_DIR = path.join(__dirname, '..', 'Media', 'instructional-videos');
const VOICEOVER_PATH = path.join(RAW_DIR, 'welcome-voiceover.mp3');
const FINAL_MP4 = path.join(OUT_DIR, `welcome-settings-demo-${TODAY}.mp4`);

// ─── ffmpeg helpers ───────────────────────────────────────────────────────────

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

  throw new Error('ffmpeg not found in PATH or WinGet install location. Install via: winget install Gyan.FFmpeg');
}

function runFfmpeg(ffmpeg, args) {
  console.log(`[record-welcome-video] ffmpeg ${args.join(' ')}`);
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status}: ${result.stderr || result.stdout}`);
  }
  return result;
}

// ─── Voiceover (ElevenLabs with OpenAI fallback) ─────────────────────────────

async function generateVoiceover(text, outputPath) {
  console.log('[record-welcome-video] Generating Luna voiceover...');
  const { buffer, provider } = await generateSpeech(text, {
    elevenLabsVoiceId: LUNA_VOICE_ID,
    persona: 'luna',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  fs.writeFileSync(outputPath, buffer);
  console.log(`[record-welcome-video] Voiceover saved (provider: ${provider}): ${outputPath}`);
}

// ─── Supabase Storage upload ──────────────────────────────────────────────────

async function uploadToSupabase(filePath, storagePath) {
  console.log(`[record-welcome-video] Uploading to Supabase Storage: videos/${storagePath}`);

  const fileBuffer = fs.readFileSync(filePath);
  const url = `${SUPABASE_URL}/storage/v1/object/videos/${storagePath}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'video/mp4',
      'x-upsert': 'true',
    },
    body: fileBuffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase upload failed ${res.status}: ${text}`);
  }

  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;
  console.log(`[record-welcome-video] Public URL: ${publicUrl}`);
  return publicUrl;
}

// ─── Telegram send ────────────────────────────────────────────────────────────

function sendToTelegram(filePath, caption) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[record-welcome-video] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping Telegram send');
    return;
  }

  console.log('[record-welcome-video] Sending video to Telegram...');

  const result = spawnSync('curl', [
    '-F', `chat_id=${TELEGRAM_CHAT_ID}`,
    '-F', `video=@${filePath}`,
    '-F', `caption=${caption}`,
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVideo`,
  ], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });

  if (result.status !== 0) {
    console.warn('[record-welcome-video] Telegram send failed:', result.stderr || result.stdout);
  } else {
    const parsed = JSON.parse(result.stdout || '{}');
    if (parsed.ok) {
      console.log('[record-welcome-video] Telegram send OK');
    } else {
      console.warn('[record-welcome-video] Telegram API error:', parsed.description);
    }
  }
}

// ─── Natural mouse move helper ────────────────────────────────────────────────

async function moveToElement(page, element) {
  const box = await element.boundingBox();
  if (!box) return;
  const targetX = box.x + box.width / 2;
  const targetY = box.y + box.height / 2;
  await page.mouse.move(targetX, targetY, { steps: 15 });
  await page.waitForTimeout(200);
}

// ─── Playwright recording ─────────────────────────────────────────────────────

async function recordSettingsSession() {
  const { chromium } = require('playwright');

  console.log('[record-welcome-video] Starting Playwright browser recording...');

  fs.mkdirSync(RAW_DIR, { recursive: true });

  // slowMo: 600 makes every action 600ms apart — looks human
  const browser = await chromium.launch({
    headless: false,
    slowMo: 600,
    args: [
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
  });
  const context = await browser.newContext({
    recordVideo: {
      dir: RAW_DIR,
      size: { width: 1280, height: 720 },
    },
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    // 1. Navigate to app
    console.log('[record-welcome-video] Navigating to https://meetdossie.com/app');
    await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 2. Login if required
    const emailInput = await page.locator('input[type="email"]').first();
    const emailVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (emailVisible) {
      console.log('[record-welcome-video] Login required — signing in with demo account...');

      // Move to email field, click, type
      await moveToElement(page, emailInput);
      await emailInput.click();
      await emailInput.fill(DEMO_EMAIL);

      // Move to password field, click, type
      const passInput = page.locator('input[type="password"]').first();
      await passInput.waitFor({ state: 'visible' });
      await moveToElement(page, passInput);
      await passInput.click();
      await passInput.fill(DEMO_PASSWORD);

      // Move to Sign In button, click
      const signInBtn = page.locator('button[type="submit"]').first();
      await signInBtn.waitFor({ state: 'visible' });
      await moveToElement(page, signInBtn);
      await signInBtn.click();
    }

    // 3. Wait for Pipeline to load
    await page.waitForSelector('text=Pipeline', { timeout: 20000 });
    console.log('[record-welcome-video] App loaded — pipeline visible');

    // 4. Pause 1.5s — let viewer see the dashboard
    await page.waitForTimeout(1500);

    // 5. Move to Settings in sidebar, click
    console.log('[record-welcome-video] Clicking Settings...');
    const settingsLink = page.getByText('Settings', { exact: true }).first();
    await settingsLink.waitFor({ state: 'visible' });
    await moveToElement(page, settingsLink);
    await settingsLink.click();

    // 6. Wait for Settings to render
    await page.waitForSelector('text=Agent profile', { timeout: 10000 });
    console.log('[record-welcome-video] Settings page loaded');

    // 7. Pause 1.5s — let viewer read the page
    await page.waitForTimeout(1500);

    // 8. Move to Full Name field, click, pause
    console.log('[record-welcome-video] Clicking Full Name field...');
    const nameInput = page.locator('input[placeholder="Your name"]').first();
    await nameInput.waitFor({ state: 'visible' });
    await moveToElement(page, nameInput);
    await nameInput.click();
    await page.waitForTimeout(1000);

    // 9. Move to Brokerage Name field, click, pause
    console.log('[record-welcome-video] Clicking Brokerage field...');
    const brokerageInput = page.locator('input[placeholder="Your brokerage"]').first();
    await brokerageInput.waitFor({ state: 'visible' });
    await moveToElement(page, brokerageInput);
    await brokerageInput.click();
    await page.waitForTimeout(1000);

    // 10. Move to Phone field, click, pause
    console.log('[record-welcome-video] Clicking Phone field...');
    const phoneInput = page.locator('input[placeholder="Your phone"]').first();
    await phoneInput.waitFor({ state: 'visible' });
    await moveToElement(page, phoneInput);
    await phoneInput.click();
    await page.waitForTimeout(1000);

    // 11. Smooth scroll down to review links section
    console.log('[record-welcome-video] Scrolling to review links...');
    await page.evaluate(() => window.scrollBy({ top: 300, behavior: 'smooth' }));
    await page.waitForTimeout(800);

    // 12. Move to Google Review URL field, click, pause
    console.log('[record-welcome-video] Clicking Google Review URL field...');
    const googleInput = page.locator('input[placeholder="https://g.page/r/yourlink/review"]').first();
    await googleInput.waitFor({ state: 'visible' });
    await moveToElement(page, googleInput);
    await googleInput.click();
    await page.waitForTimeout(1500);

    console.log('[record-welcome-video] Navigation script complete');
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Find the most recent .webm Playwright wrote
  const webmFiles = fs.readdirSync(RAW_DIR)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({ f, mtime: fs.statSync(path.join(RAW_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!webmFiles.length) throw new Error('No .webm file found after recording. Playwright video recording may have failed.');

  const webmPath = path.join(RAW_DIR, webmFiles[0].f);
  console.log(`[record-welcome-video] Raw recording: ${webmPath}`);
  return webmPath;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Record the Playwright session
  const webmPath = await recordSettingsSession();

  // Step 2: Generate voiceover (ElevenLabs with OpenAI fallback)
  let voiceoverAvailable = false;
  if (!process.env.ELEVENLABS_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn('[record-welcome-video] No TTS keys set — skipping voiceover');
  } else {
    try {
      await generateVoiceover(VOICEOVER_SCRIPT, VOICEOVER_PATH);
      voiceoverAvailable = true;
    } catch (err) {
      console.warn('[record-welcome-video] TTS failed — proceeding with video only:', err.message);
    }
  }

  // Step 3: Convert to MP4 via ffmpeg (video-only or with audio)
  const ffmpeg = findFfmpeg();
  console.log('[record-welcome-video] Converting to MP4 with ffmpeg...');

  if (voiceoverAvailable) {
    runFfmpeg(ffmpeg, [
      '-i', webmPath,
      '-i', VOICEOVER_PATH,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-shortest',
      '-y',
      FINAL_MP4,
    ]);
  } else {
    // No voiceover — convert raw webm to mp4, video only
    runFfmpeg(ffmpeg, [
      '-i', webmPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-y',
      FINAL_MP4,
    ]);
  }

  console.log(`[record-welcome-video] MP4 rendered: ${FINAL_MP4}`);

  // Step 4: Upload to Supabase Storage (optional — skip if env vars missing)
  if (SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY) {
    const storagePath = `instructional-videos/welcome-settings-demo-${TODAY}.mp4`;
    await uploadToSupabase(FINAL_MP4, storagePath);
  } else {
    console.warn('[record-welcome-video] Supabase env vars not set — skipping upload');
  }

  // Step 5: Send to Telegram
  const caption = voiceoverAvailable
    ? `Welcome video - Settings walkthrough. Navigation looks like a real person.`
    : `Welcome video - Settings walkthrough. No voiceover (ElevenLabs down). Navigation looks like a real person.`;
  sendToTelegram(FINAL_MP4, caption);

  console.log('\n[record-welcome-video] Done.');
  console.log(`  Local MP4: ${FINAL_MP4}`);
}

main().catch((err) => {
  console.error('[record-welcome-video] Fatal error:', err.message);
  process.exit(1);
});
