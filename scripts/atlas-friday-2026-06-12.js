'use strict';

// scripts/atlas-friday-2026-06-12.js
//
// Atlas-only one-shot: executes Heath's Friday content brief end-to-end.
//   • Records desktop 1920x1080 Playwright session of Sarah Whitley's
//     Pipeline view with a slow scroll across all stages
//   • Generates Luna voiceover via ElevenLabs (OpenAI nova fallback)
//   • ffmpeg merges to H.264/yuv420p + AAC, freezing the last frame if the
//     voiceover is longer than the recording
//   • Writes Media/screen-recordings/pipeline-view-desktop-2026-06-12.mp4
//
// No tutorial brief JSON — the brief is hardcoded here because this video
// only ships once.

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
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';

const VOICEOVER_TEXT = [
  "Two years ago I was a burned-out solo agent.",
  "Sixty-hour weeks, the showings and the relationships getting squeezed by coordination work, everything else eating my Sundays.",
  "That was the problem I was building Dossie to solve.",
  "Over the last few weeks I have been running my whole pipeline through her — six active files, weekends back, Sundays mine again.",
  "She did not add a day to my week. She gave one back. The one with my family.",
  "Texas agents — meetdossie.com slash founding.",
].join(' ');

const ROOT = path.join(__dirname, '..');
const TMP_DIR = path.join(ROOT, 'tmp');
const OUT_DIR = path.join(ROOT, 'Media', 'screen-recordings');
const OUT_FILE = path.join(OUT_DIR, 'pipeline-view-desktop-2026-06-12.mp4');
const VOICEOVER_FILE = path.join(TMP_DIR, 'voiceover-brenda-2026-06-12.mp3');

// ─── ffmpeg discovery ────────────────────────────────────────────────────────

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
  console.log(`[friday] ffmpeg ${args.slice(0, 6).join(' ')} ...`);
  const result = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg exited ${result.status}: ${(result.stderr || result.stdout).slice(0, 800)}`);
  }
  return result;
}

async function getMediaDuration(ffmpeg, file) {
  const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
  const res = spawnSync(ffprobe, [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', file,
  ], { encoding: 'utf8' });
  const dur = parseFloat((res.stdout || '').trim());
  return Number.isFinite(dur) ? dur : 0;
}

// ─── Voiceover ────────────────────────────────────────────────────────────────

async function generateVoiceover() {
  fs.mkdirSync(path.dirname(VOICEOVER_FILE), { recursive: true });
  console.log('[friday] Requesting Luna voiceover from ElevenLabs...');
  const { buffer, provider } = await generateSpeech(VOICEOVER_TEXT, {
    elevenLabsVoiceId: LUNA_VOICE_ID,
    persona: 'luna',
    voiceSettings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
  });
  fs.writeFileSync(VOICEOVER_FILE, buffer);
  console.log(`[friday] Voiceover saved (provider=${provider}, ${buffer.length} bytes)`);
  return provider;
}

// ─── Pre-auth (skip login UI entirely) ──────────────────────────────────────

async function preAuthSession() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Pre-auth requires SUPABASE_URL + SUPABASE_ANON_KEY.');
  }
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pre-auth failed ${res.status}: ${t.slice(0, 300)}`);
  }
  const s = await res.json();
  return {
    access_token: s.access_token,
    token_type: s.token_type || 'bearer',
    expires_in: s.expires_in || 3600,
    expires_at: s.expires_at || Math.floor(Date.now() / 1000) + (s.expires_in || 3600),
    refresh_token: s.refresh_token,
    user: s.user,
    weak_password: null,
  };
}

// ─── Playwright recording ────────────────────────────────────────────────────

async function recordFlow() {
  const { chromium } = require('playwright');

  const viewport = { width: 1920, height: 1080 };
  fs.mkdirSync(TMP_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });

  // Pre-auth via Supabase REST → inject session into localStorage in a setup
  // context so the recording starts on a logged-in /app frame, not the login
  // screen.
  console.log('[friday] Pre-authing Sarah Whitley...');
  const session = await preAuthSession();

  const setupCtx = await browser.newContext({ viewport });
  const setupPage = await setupCtx.newPage();
  await setupPage.goto('https://meetdossie.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await setupPage.evaluate((sess) => {
    localStorage.setItem('supabase.auth.token', JSON.stringify(sess));
  }, session);
  await setupPage.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await setupPage.waitForTimeout(3000);
  const storageStateFile = path.join(TMP_DIR, `auth-friday-2026-06-12-${Date.now()}.json`);
  await setupCtx.storageState({ path: storageStateFile });
  await setupCtx.close();
  console.log('[friday] Pre-auth session captured.');

  const context = await browser.newContext({
    recordVideo: { dir: TMP_DIR, size: viewport },
    viewport,
    storageState: storageStateFile,
  });
  const page = await context.newPage();

  try {
    console.log('[friday] Navigating to /app...');
    await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Allow SPA hydration + first paint of dashboard
    await page.waitForTimeout(4000);

    // Click into Pipeline view. The Dossie sidebar lists "Pipeline" as the
    // primary nav target; getByText handles the desktop sidebar reliably.
    console.log('[friday] Clicking Pipeline...');
    const pipelineNav = page.getByText('Pipeline', { exact: true }).first();
    const pipelineVisible = await pipelineNav.isVisible({ timeout: 8000 }).catch(() => false);
    if (pipelineVisible) {
      await pipelineNav.click();
    } else {
      // Already on a pipeline-style dashboard? Continue without clicking.
      console.warn('[friday] Pipeline nav not visible — assuming default route already shows it.');
    }
    await page.waitForTimeout(2500);

    // Slow human-paced scroll across all stages.
    // ~22 scroll ticks × 1.4s ≈ 30s of pipeline content + intro/outro pad
    // brings us into the ~45-50s target window. We use page.evaluate +
    // window.scrollBy with smooth behavior so the scroll animates fluidly
    // instead of jumping. We DO NOT use page.mouse.wheel because it doesn't
    // animate — produces a stuttery recording.
    console.log('[friday] Scrolling pipeline...');
    for (let i = 0; i < 22; i++) {
      await page.evaluate(() => window.scrollBy({ top: 180, behavior: 'smooth' }));
      await page.waitForTimeout(1400);
    }

    // Scroll back to the top to end on the dashboard summary (per brief).
    console.log('[friday] Scrolling back to top to end on dashboard...');
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'smooth' }));
    await page.waitForTimeout(3500);
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }

  // Newest .webm in TMP_DIR is our recording.
  const webms = fs.readdirSync(TMP_DIR)
    .filter(f => f.endsWith('.webm'))
    .map(f => ({ f, mtime: fs.statSync(path.join(TMP_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!webms.length) throw new Error('No .webm recorded.');
  return path.join(TMP_DIR, webms[0].f);
}

// ─── ffmpeg merge to 1920x1080 H.264 yuv420p + AAC ───────────────────────────

async function mergeToMP4(ffmpeg, webmPath, voiceoverPath) {
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });

  const audioDur = voiceoverPath ? await getMediaDuration(ffmpeg, voiceoverPath) : 0;
  const videoDur = await getMediaDuration(ffmpeg, webmPath);

  // Sync rule: final duration = max(video, audio + 1s outro hold).
  //   • If video shorter → freeze last frame (tpad clone)
  //   • If audio shorter → pad silence (apad)
  // This matches the "silence-trim rule" in the brief: voiceover never gets
  // cut mid-word, and the screen recording never ends before the voiceover.
  const targetDur = Math.max(videoDur, audioDur + 1.0);
  const tpadSec = Math.max(0, targetDur - videoDur);
  const apadMs = Math.max(0, (targetDur - audioDur) * 1000);

  console.log(`[friday] Lengths: video=${videoDur.toFixed(2)}s audio=${audioDur.toFixed(2)}s target=${targetDur.toFixed(2)}s vPad=${tpadSec.toFixed(2)}s aPad=${apadMs.toFixed(0)}ms`);

  // Output: 1920x1080 H.264 yuv420p baseline-compatible + AAC 128k.
  // The yuv420p pixel format + +faststart flag = max compatibility across
  // Facebook, Zernio, and the macOS QuickTime preview Heath uses to spot-check.
  const filter = `[0:v]tpad=stop_mode=clone:stop_duration=${tpadSec.toFixed(2)},scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:0xF5E6E0,fps=30,setsar=1,format=yuv420p[v];[1:a]apad=pad_dur=${(apadMs / 1000).toFixed(2)}[a]`;

  runFfmpeg(ffmpeg, [
    '-i', webmPath,
    '-i', voiceoverPath,
    '-filter_complex', filter,
    '-map', '[v]',
    '-map', '[a]',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.0',
    '-preset', 'medium',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-t', targetDur.toFixed(2),
    '-movflags', '+faststart',
    '-y', OUT_FILE,
  ]);
}

// ─── LIBRARY.md update ──────────────────────────────────────────────────────

function updateLibrary() {
  const libraryPath = path.join(OUT_DIR, 'LIBRARY.md');
  const original = fs.readFileSync(libraryPath, 'utf8');

  // Insert a new row in the table. We anchor on the LAST `| *-mobile-*` or
  // `| *-desktop-*` row above the "## Pairing Rule" header. Simplest reliable
  // anchor: insert right before the "## Pairing Rule" line.
  const newRow = `| pipeline-view-desktop-2026-06-12.mp4 | brenda/patricia | Luna | Sarah Whitley (demo@) | Desktop landscape, full pipeline scroll across deal stages, Facebook ("From burned out solo agent to six deals running clean.") |`;

  if (original.includes('pipeline-view-desktop-2026-06-12.mp4')) {
    console.log('[friday] LIBRARY.md already has the new row — skipping update.');
    return;
  }

  const updated = original.replace(
    /\n## Pairing Rule/,
    `\n${newRow}\n\n## Pairing Rule`
  );

  if (updated === original) {
    console.warn('[friday] Could not locate Pairing Rule anchor in LIBRARY.md — appending row to table block instead.');
    // Fallback: append after the last existing table row containing .mp4
    const fallback = original.replace(/(\|[^\n]*\.mp4 \|[^\n]*\|\n)(\n## )/, `$1${newRow}\n$2`);
    fs.writeFileSync(libraryPath, fallback);
  } else {
    fs.writeFileSync(libraryPath, updated);
  }
  console.log('[friday] LIBRARY.md updated.');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. Voiceover (do this first — if Luna quota is exhausted we know early
  //    and can flag to Heath before burning a Playwright recording).
  const voiceoverProvider = await generateVoiceover();

  // 2. Playwright recording (with retry — login redirects + slow loads
  //    happen on production occasionally).
  let webmPath = null;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      console.log(`[friday] Recording attempt ${attempt}/3...`);
      webmPath = await recordFlow();
      console.log(`[friday] Raw recording: ${webmPath}`);
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[friday] Recording attempt ${attempt} failed: ${e.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (!webmPath) throw new Error(`All 3 recording attempts failed. Last error: ${lastErr && lastErr.message}`);

  // 3. ffmpeg merge → 1920x1080 H.264 + AAC, silence-trim aligned.
  const ffmpeg = findFfmpeg();
  await mergeToMP4(ffmpeg, webmPath, VOICEOVER_FILE);
  const finalDur = await getMediaDuration(ffmpeg, OUT_FILE);
  console.log(`[friday] FINAL MP4 (${finalDur.toFixed(2)}s): ${OUT_FILE}`);

  // 4. LIBRARY.md row.
  updateLibrary();

  console.log('[friday] DONE.');
  console.log(`[friday] Voiceover provider: ${voiceoverProvider}`);
  console.log(`[friday] Output: ${OUT_FILE}`);
  console.log(`[friday] Duration: ${finalDur.toFixed(2)}s`);
}

main().catch((err) => {
  console.error('[friday] FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
