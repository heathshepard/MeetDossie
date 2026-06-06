'use strict';

// scripts/record-welcome-video.js
//
// Records a Playwright screen session of the Dossie Settings page,
// generates a Luna ElevenLabs voiceover, combines them with ffmpeg,
// and uploads the finished MP4 to Supabase Storage (videos bucket).
//
// Usage:
//   node scripts/record-welcome-video.js
//
// Env vars required:
//   ELEVENLABS_API_KEY
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// If ElevenLabs is unavailable (quota), saves raw .webm and exits gracefully.

const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawnSync } = require('child_process');

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
const FINAL_MP4 = path.join(OUT_DIR, `welcome-settings-${TODAY}.mp4`);

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

// ─── ElevenLabs voiceover ─────────────────────────────────────────────────────

async function generateVoiceover(text, outputPath) {
  console.log('[record-welcome-video] Generating Luna voiceover via ElevenLabs...');

  const body = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
      style: 0.0,
      use_speaker_boost: true,
    },
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${LUNA_VOICE_ID}/stream`,
      method: 'POST',
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 429 || res.statusCode === 402) {
        let errBody = '';
        res.on('data', c => (errBody += c));
        res.on('end', () => reject(new Error(`QUOTA: ElevenLabs ${res.statusCode}: ${errBody}`)));
        return;
      }
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', c => (errBody += c));
        res.on('end', () => reject(new Error(`ElevenLabs ${res.statusCode}: ${errBody}`)));
        return;
      }
      const out = fs.createWriteStream(outputPath);
      res.pipe(out);
      out.on('finish', () => {
        console.log(`[record-welcome-video] Voiceover saved: ${outputPath}`);
        resolve();
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
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

  // Public URL for the videos bucket
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/videos/${storagePath}`;
  console.log(`[record-welcome-video] Public URL: ${publicUrl}`);
  return publicUrl;
}

// ─── Playwright recording ─────────────────────────────────────────────────────

async function recordSettingsSession() {
  const { chromium } = require('playwright');

  console.log('[record-welcome-video] Starting Playwright browser recording...');

  // Ensure raw dir exists
  fs.mkdirSync(RAW_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    recordVideo: {
      dir: RAW_DIR,
      size: { width: 1280, height: 720 },
    },
    viewport: { width: 1280, height: 720 },
  });

  const page = await context.newPage();

  try {
    // Navigate to app
    console.log('[record-welcome-video] Navigating to https://meetdossie.com/app');
    await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Handle login if needed — check for email input
    const emailInput = await page.locator('input[type="email"]').first();
    const emailVisible = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (emailVisible) {
      console.log('[record-welcome-video] Login required — signing in with demo account...');
      await emailInput.fill(DEMO_EMAIL);
      const passInput = page.locator('input[type="password"]').first();
      await passInput.waitFor({ state: 'visible' });
      await passInput.fill(DEMO_PASSWORD);
      await page.keyboard.press('Enter');
    }

    // Wait for the pipeline view to load — the sidebar will have a "Pipeline" link visible
    await page.waitForSelector('text=Pipeline', { timeout: 20000 });
    console.log('[record-welcome-video] App loaded — pipeline visible');

    // 2-second pause: give viewer time to see the starting state
    await new Promise(r => setTimeout(r, 2000));

    // Click Settings in the sidebar
    console.log('[record-welcome-video] Clicking Settings...');
    await page.getByText('Settings', { exact: true }).first().click();

    // Wait for Settings page to render — the "Agent profile" section heading appears
    await page.waitForSelector('text=Agent profile', { timeout: 10000 });
    console.log('[record-welcome-video] Settings page loaded');

    // 1.5-second pause: let viewer read the page
    await new Promise(r => setTimeout(r, 1500));

    // Click the Agent name field
    console.log('[record-welcome-video] Clicking Agent name field...');
    const nameInput = page.locator('input[placeholder="Your name"]').first();
    await nameInput.waitFor({ state: 'visible' });
    await nameInput.click();
    await new Promise(r => setTimeout(r, 1000));

    // Click Brokerage field
    console.log('[record-welcome-video] Clicking Brokerage field...');
    const brokerageInput = page.locator('input[placeholder="Your brokerage"]').first();
    await brokerageInput.waitFor({ state: 'visible' });
    await brokerageInput.click();
    await new Promise(r => setTimeout(r, 1000));

    // Click Phone field
    console.log('[record-welcome-video] Clicking Phone field...');
    const phoneInput = page.locator('input[placeholder="Your phone"]').first();
    await phoneInput.waitFor({ state: 'visible' });
    await phoneInput.click();
    await new Promise(r => setTimeout(r, 1000));

    // Scroll down to reveal review links
    console.log('[record-welcome-video] Scrolling to review links...');
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 1500));

    // Click Google Review URL field
    console.log('[record-welcome-video] Clicking Google Review URL field...');
    const googleInput = page.locator('input[placeholder="https://g.page/r/yourlink/review"]').first();
    await googleInput.waitFor({ state: 'visible' });
    await googleInput.click();
    await new Promise(r => setTimeout(r, 1000));

    console.log('[record-welcome-video] Navigation script complete');
  } finally {
    // Close the page — this finalizes the video file
    await page.close();
    await context.close();
    await browser.close();
  }

  // Playwright names the file with a random hash — find the most recent .webm in RAW_DIR
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
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[record-welcome-video] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }

  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Record the Playwright session
  const webmPath = await recordSettingsSession();

  // Step 2: Generate voiceover — graceful fallback if quota is exhausted
  let voiceoverAvailable = false;
  if (!ELEVENLABS_API_KEY) {
    console.warn('[record-welcome-video] ELEVENLABS_API_KEY not set — skipping voiceover');
  } else {
    try {
      await generateVoiceover(VOICEOVER_SCRIPT, VOICEOVER_PATH);
      voiceoverAvailable = true;
    } catch (err) {
      if (err.message.startsWith('QUOTA:')) {
        console.warn('[record-welcome-video] ElevenLabs unavailable (quota/billing) — raw recording saved at:', webmPath);
        console.warn('[record-welcome-video] Run voiceover step manually when credits restore.');
      } else {
        throw err;
      }
    }
  }

  if (!voiceoverAvailable) {
    console.log('[record-welcome-video] Done (raw only). Raw webm:', webmPath);
    return;
  }

  // Step 3: Combine with ffmpeg
  const ffmpeg = findFfmpeg();
  console.log('[record-welcome-video] Combining video + audio with ffmpeg...');

  runFfmpeg(ffmpeg, [
    '-i', webmPath,
    '-i', VOICEOVER_PATH,
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-shortest',
    '-y',
    FINAL_MP4,
  ]);

  console.log(`[record-welcome-video] MP4 rendered: ${FINAL_MP4}`);

  // Step 4: Upload to Supabase Storage
  const storagePath = `instructional-videos/welcome-settings-${TODAY}.mp4`;
  const publicUrl = await uploadToSupabase(FINAL_MP4, storagePath);

  console.log('\n[record-welcome-video] ─── Complete ────────────────────────────────');
  console.log(`  Local MP4:  ${FINAL_MP4}`);
  console.log(`  Public URL: ${publicUrl}`);
}

main().catch((err) => {
  console.error('[record-welcome-video] Fatal error:', err.message);
  process.exit(1);
});
