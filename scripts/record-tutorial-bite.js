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
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';
const DEMO_PASSWORD_2 = process.env.DEMO2_PASSWORD || 'DossieDemo2-John2026';

// ─── Pre-auth (skip the login UI entirely) ─────────────────────────────────────
// Exchanges email+password for a Supabase session via the auth REST API, then
// injects the session into localStorage under the exact key the React app reads
// (`supabase.auth.token`). When the browser navigates to /app, the app sees an
// authenticated session immediately and skips the login screen.

async function preAuthSession(email, password) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Pre-auth requires SUPABASE_URL + SUPABASE_ANON_KEY.');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pre-auth failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const session = await res.json();
  // Shape matches what the app stores in localStorage under "supabase.auth.token".
  return {
    access_token: session.access_token,
    token_type: session.token_type || 'bearer',
    expires_in: session.expires_in || 3600,
    expires_at: session.expires_at || Math.floor(Date.now() / 1000) + (session.expires_in || 3600),
    refresh_token: session.refresh_token,
    user: session.user,
    weak_password: null,
  };
}

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
  const isMobileViewport = viewport.width < 500;

  // Guardrail: tutorial bites are vertical (1080x1920). Hard-warn on landscape briefs.
  if (viewport.width > viewport.height) {
    console.warn(`[tutorial] WARNING: brief viewport ${viewport.width}x${viewport.height} is landscape. Tutorial bites render at 1080x1920 portrait — content will be cropped. Use { width: 390, height: 844 }.`);
  }

  const demoEmail = brief.demo_account || 'demo@meetdossie.com';
  const demoPassword = demoEmail === 'demo2@meetdossie.com' ? DEMO_PASSWORD_2 : DEMO_PASSWORD;

  fs.mkdirSync(RAW_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    slowMo: 500,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'],
  });

  // ─── Pre-auth path: skips the login screen entirely ────────────────────────
  // When brief.pre_auth === true, we run a SEPARATE non-recording context first
  // to inject the Supabase session into localStorage, save the storageState to
  // disk, then start the recording context with that storageState. This ensures
  // the recording's very first frame is already on a logged-in /app page —
  // no blank intro, no login screen, no UI flash.
  let storageStateFile = null;
  if (brief.pre_auth === true) {
    try {
      console.log(`[tutorial] Pre-authenticating ${demoEmail} via Supabase auth REST...`);
      const session = await preAuthSession(demoEmail, demoPassword);
      const setupCtx = await browser.newContext({
        viewport,
        deviceScaleFactor: isMobileViewport ? 3 : 2,
        isMobile: isMobileViewport,
        hasTouch: isMobileViewport,
        userAgent: isMobileViewport
          ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
          : undefined,
      });
      const setupPage = await setupCtx.newPage();
      await setupPage.goto('https://meetdossie.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await setupPage.evaluate((sess) => {
        localStorage.setItem('supabase.auth.token', JSON.stringify(sess));
      }, session);
      // Visit /app once in the setup context so the SPA finishes bootstrapping
      // and any session-derived cookies get set.
      await setupPage.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await setupPage.waitForTimeout(2500);
      storageStateFile = path.join(RAW_DIR, `auth-${brief.slug}-${Date.now()}.json`);
      await setupCtx.storageState({ path: storageStateFile });
      await setupCtx.close();
      console.log(`[tutorial] Pre-auth session saved: ${path.basename(storageStateFile)}`);
    } catch (e) {
      console.warn('[tutorial] Pre-auth failed — falling back to UI login:', e.message);
    }
  }

  const context = await browser.newContext({
    recordVideo: { dir: RAW_DIR, size: viewport },
    viewport,
    deviceScaleFactor: isMobileViewport ? 3 : 2,
    isMobile: isMobileViewport,
    hasTouch: isMobileViewport,
    userAgent: isMobileViewport
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
    storageState: storageStateFile || undefined,
  });

  const page = await context.newPage();

  // ─── Record-start trim (Sage v4 fix) ─────────────────────────────────────────
  // Playwright begins recording the moment recordVideo is set on the context, so
  // the first frame is unavoidably "Loading your files..." (the SPA hydration
  // skeleton). We can't pause/start recording mid-context — Playwright doesn't
  // expose that API.
  //
  // Instead we capture two timestamps:
  //   recordStartMs  — set NOW, when the first page is created (≈ when recording starts)
  //   dashboardReadyMs — set when the brief's `record_start_after_text` first appears
  // The delta is later passed to ffmpeg as `-ss <delta> -i <webm>`, trimming the
  // pre-render frames from the final MP4. First visible frame is then the
  // fully-rendered dashboard skeleton — NOT a spinner, NOT a blank frame.
  const recordStartMs = Date.now();
  let dashboardReadyMs = null;
  const startGateText = brief.record_start_after_text || null;
  if (startGateText) {
    console.log(`[tutorial] Will trim recording until text appears: "${startGateText}"`);
  }

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
        case 'click_aria': {
          // For mobile: nav uses emoji buttons with aria-label="Pipeline" / "Settings" etc.
          const locator = page.locator(`[aria-label="${step.aria}"]`);
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
            } catch (_) { /* try next */ }
          }
          if (!clicked) {
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
        case 'fill_placeholder': {
          // Find an <input> or <textarea> by its placeholder attribute. The Dossie
          // app's Settings + dossier forms expose placeholders like "Your name",
          // "Your brokerage", "compliance@yourbrokerage.com", so this is the most
          // reliable way to target the right field on a multi-input page.
          const sel = `input[placeholder*="${step.placeholder.replace(/"/g, '\\"')}"], textarea[placeholder*="${step.placeholder.replace(/"/g, '\\"')}"]`;
          const el = page.locator(sel).first();
          await el.waitFor({ state: 'visible', timeout: 10000 });
          await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
          await moveToElement(el);
          await el.click();
          if (step.clear !== false) await el.fill('');
          if (step.typed === true) {
            // Visible per-character typing — feels more "human" on camera.
            await el.pressSequentially(step.value || '', { delay: step.delay_ms || 40 });
          } else {
            await el.fill(step.value || '');
          }
          await page.waitForTimeout(pause);
          break;
        }
        case 'type': {
          // Type into the currently focused element with visible per-char delay.
          await page.keyboard.type(step.value || '', { delay: step.delay_ms || 50 });
          await page.waitForTimeout(pause);
          break;
        }
        case 'press': {
          await page.keyboard.press(step.key);
          await page.waitForTimeout(pause);
          break;
        }
        case 'click_button_text': {
          // Many edit-mode buttons in the dossier carry the value as visible text
          // (e.g. "Buyer's full name ✎"). getByRole('button') with a name filter
          // is more reliable for those than getByText alone.
          const btn = page.getByRole('button', { name: new RegExp(step.text, 'i') }).first();
          // Scroll-into-view BEFORE waitFor so off-screen buttons (below fold on
          // mobile viewport) become hit-testable. waitFor(visible) requires the
          // element to be in the viewport.
          await btn.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
          await btn.waitFor({ state: 'visible', timeout: 8000 });
          await moveToElement(btn);
          await btn.click();
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
          // If the brief's record-start gate is a selector (passed as `record_start_after_text`
          // matching a selector string), this captures the timing too.
          if (startGateText && dashboardReadyMs === null && step.selector === startGateText) {
            dashboardReadyMs = Date.now();
            console.log(`[tutorial] Record-start gate hit (selector): dashboard ready at +${((dashboardReadyMs - recordStartMs) / 1000).toFixed(2)}s`);
          }
          await page.waitForTimeout(pause);
          break;
        case 'wait_for_text':
          await page.waitForSelector(`text=${step.text}`, { timeout: step.timeout_ms || 10000 });
          // Capture record-start trim point the first time the gate text appears.
          if (startGateText && dashboardReadyMs === null && step.text === startGateText) {
            dashboardReadyMs = Date.now();
            console.log(`[tutorial] Record-start gate hit: dashboard ready at +${((dashboardReadyMs - recordStartMs) / 1000).toFixed(2)}s`);
          }
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

  // Compute trim seconds for the loading-frame fix. If the gate was never hit
  // (no `record_start_after_text` in the brief, or text never appeared) the trim
  // is 0 and we keep the full recording.
  let recordTrimSec = 0;
  if (dashboardReadyMs !== null) {
    recordTrimSec = Math.max(0, (dashboardReadyMs - recordStartMs) / 1000);
    // Cap trim at 10s — Settings + Pipeline routes hydrate around 6-8s in
    // headless Chromium. Anything longer suggests the recording is broken
    // and we shouldn't blindly delete most of it.
    if (recordTrimSec > 10) {
      console.warn(`[tutorial] Computed trim ${recordTrimSec.toFixed(2)}s exceeds 10s safety cap — using 10s.`);
      recordTrimSec = 10;
    }
  }
  return { webmPath: path.join(RAW_DIR, webms[0].f), recordTrimSec };
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

async function mergeToMP4(ffmpeg, webmPath, voiceoverPath, outPath, recordTrimSec = 0) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const audioDur = voiceoverPath ? await getMediaDuration(ffmpeg, voiceoverPath) : 0;
  const fullWebmDur = await getMediaDuration(ffmpeg, webmPath);
  const visibleVideoDur = Math.max(0, fullWebmDur - recordTrimSec);

  // Final mp4 = max(visible action, audio + 1.5s outro hold). Whichever is
  // shorter gets padded:
  //   - video shorter → tpad freezes last frame
  //   - audio shorter → apad adds silence
  // This guarantees the Save click + completion state are always visible AND
  // the voiceover never cuts mid-word.
  const targetDur = Math.max(visibleVideoDur, audioDur + 1.5);
  const tpadSec = Math.max(0, targetDur - visibleVideoDur);
  const apadMs = Math.max(0, (targetDur - audioDur) * 1000);

  // Scale-to-fit + pad with blush brand background. Preserves the full mobile frame
  // (no horizontal crop). Source is recorded at the brief's viewport; we fit it
  // inside 1080x1920 without cropping content off the sides or top.
  // Blush hex #F5E6E0 — matches Dossie brand letterbox color.
  const padFilter = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:0xF5E6E0,fps=30,setsar=1';

  // `-ss` before `-i` is fast-seek (keyframe-aligned). For our short bites that's
  // fine and avoids re-encoding the trimmed segment.
  const trimArgs = recordTrimSec > 0.1 ? ['-ss', recordTrimSec.toFixed(2)] : [];
  if (recordTrimSec > 0.1) {
    console.log(`[tutorial] Trimming first ${recordTrimSec.toFixed(2)}s of recording (loading-frame fix).`);
  }
  console.log(`[tutorial] Lengths: webm=${fullWebmDur.toFixed(2)}s visible=${visibleVideoDur.toFixed(2)}s audio=${audioDur.toFixed(2)}s target=${targetDur.toFixed(2)}s vPad=${tpadSec.toFixed(2)}s aPad=${apadMs.toFixed(0)}ms`);

  if (voiceoverPath) {
    runFfmpeg(ffmpeg, [
      ...trimArgs, '-i', webmPath,
      '-i', voiceoverPath,
      '-filter_complex',
      `[0:v]tpad=stop_mode=clone:stop_duration=${tpadSec.toFixed(2)},${padFilter}[v];[1:a]apad=pad_dur=${(apadMs / 1000).toFixed(2)}[a]`,
      '-map', '[v]',
      '-map', '[a]',
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-t', targetDur.toFixed(2),
      '-movflags', '+faststart',
      '-y', outPath,
    ]);
  } else {
    runFfmpeg(ffmpeg, [
      ...trimArgs, '-i', webmPath,
      '-vf', padFilter,
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
  const { webmPath, recordTrimSec } = await recordFlow(brief);
  console.log(`[tutorial] Raw recording: ${webmPath}`);

  // 2. Voiceover
  let voiceoverAvailable = false;
  try {
    await generateVoiceover(brief.voiceover_script, voiceoverMP3);
    voiceoverAvailable = true;
  } catch (e) {
    console.warn('[tutorial] Voiceover failed — video-only:', e.message);
  }

  // 3. Merge → MP4 (trim loading frames per brief.record_start_after_text)
  const ffmpeg = findFfmpeg();
  await mergeToMP4(ffmpeg, webmPath, voiceoverAvailable ? voiceoverMP3 : null, finalMP4, recordTrimSec);
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
