// api/_lib/verify-video-quality.js
//
// Video quality gate for the content engine — brand-agnostic (Dossie, Rust,
// realtor page all go through this, same rules). Mirrors the
// api/_lib/verify-image-match.js gate pattern: run before a video can be
// queued for Heath's review or posted, hold on failure, alert once, never
// silently skip.
//
// Built 2026-09-15 per Heath's standing rule
// (feedback_every-video-needs-scroll-stopping-hook.md) and the
// machine-checkable rules in docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md.
// Direct evidence for the thresholds below: the 9 rejected
// Media/rust-conversations/*.mp4 files, pulled and measured for real —
// frame 0.0s and frame 1.5s came back SSIM 0.999966 (pixel-identical) and
// runtime 42.6s (outside every platform target window). See
// scripts/regression-video-quality-gate.js for the exact numbers.
//
// TWO KINDS OF CHECKS
// --------------------
// MEASURABLE (ffprobe/ffmpeg, exact math, no model call):
//   - runtime_in_platform_range   ffprobe duration vs TikTok 21-34s / IG
//                                 loop 7-15s / hard 45s ceiling.
//   - real_motion_0_to_1_5s       SSIM between frame @0.0s and frame @1.5s.
//                                 SSIM >= 0.999 = "frames are static" — this
//                                 is the exact defect measured in all 9
//                                 rejected Rust videos.
//   - resolution_readable         ffprobe can read a non-zero width/height
//                                 (corrupt-file guard).
//   - aspect_ratio_vertical_9x16  the frame really is 9:16 (0.5625 ±0.02).
//                                 Added 2026-09-16 — a 1920x1080 landscape
//                                 file passes every other rule and then gets
//                                 letterboxed into ~80% black by the platform.
//   - content_fills_frame         real content occupies >=85% of the frame;
//                                 no persistent letterbox/pillarbox bars, of
//                                 ANY colour (white bars matter here, Dossie's
//                                 palette is light). Added 2026-09-16.
//   - first_frame_not_uniform     frame 0 is not a blank/solid splash.
//                                 Added 2026-09-16.
//   - cover_asset_present         an explicit cover file/URL was supplied
//                                 and is non-empty.
//
// VISION-CHECKED (same Anthropic vision path verify-image-match.js and
// jarvis-voice.js already use — a real model call on real extracted frames,
// not a heuristic):
//   - hook_visible_frame0         large, legible on-screen hook text at
//                                 frame 0.0s.
//   - hook_cleared_by_3s          that same hook text has cleared off the
//                                 footage by ~3s (frame 0 vs frame ~3s).
//   - opening_not_login_or_empty  frames 0.0s and 1.5s show neither a real
//                                 login/sign-in screen nor a dead frame with
//                                 no legible text and no product UI. Added
//                                 2026-09-16: both bad videos opened on
//                                 Dossie's sign-in page, one with the demo
//                                 account's credentials filled in and
//                                 visible. Narrowed same day so a designed
//                                 hook/title card (solid-colour frame, large
//                                 legible text — exactly what Heath's
//                                 scroll-stopping-hook rule asks for) is
//                                 never treated as a dead opening.
//   - captions_present            burned-in captions legible across 3
//                                 sample points through the runtime.
//
// IMPORTANT — Vercel cannot run ffmpeg (see api/cron-render-videos.js's own
// note: "Vercel serverless cannot run ffmpeg"). checkVideoQuality() is
// therefore meant to run where ffmpeg/ffprobe binaries actually exist —
// today that's scripts/queue-finished-videos.py's local/CLI invocation (via
// scripts/check-video-quality-cli.js) at ingestion time, NOT inside a
// Vercel function. cron-post-videos.js (which DOES run on Vercel) gates on
// the quality_status/quality_failed_rules already recorded on the row by
// that ingestion step instead of re-probing the file — see
// gateBeforePublish() below. If ffprobe/ffmpeg genuinely isn't on PATH
// wherever checkVideoQuality() runs, every measurable rule fails CLOSED
// (not skipped) — a missing tool is not evidence a video is fine.
//
// FAIL-CLOSED BY DESIGN — this deliberately differs from
// verify-image-match.js's fail-OPEN convention (which skips quietly if
// ANTHROPIC_API_KEY is missing, because that gate is a secondary safety net
// on an otherwise-working pipeline). This gate is the one Heath asked for
// specifically so a bad video CANNOT ship — a missing API key or missing
// ffmpeg binary must hold the video, not wave it through.
//
// VISION TRANSPORT (added 2026-09-16) — ANTHROPIC_API_KEY is a write-only
// Vercel Sensitive var Heath's local machine cannot read (CLAUDE.md §19).
// callVisionModel() calls api.anthropic.com directly ONLY when a real key
// is present (ANTHROPIC_KEY_USABLE); otherwise it POSTs the same
// sampled/compressed frames to api/verify-video-vision.js (a CRON_SECRET-
// gated Vercel route — CRON_SECRET IS a real value locally) which runs the
// same call where the real key lives. Either transport failing —
// unreachable endpoint, 401, a non-2xx status, a malformed/unparseable
// response, or a payload too large to send — throws, and every call site
// below already treats a thrown vision check as a failed rule. Neither
// transport being available at all (no usable key AND no CRON_SECRET) also
// fails every vision rule closed, same as before.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const { extractVisionJson } = require('./vision-parse.js');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// Heath's local .env.local carries the literal string "[SENSITIVE]" for
// this var — it's a Vercel write-only Sensitive type (`vercel env pull`
// cannot return the real value) with no usable Bitwarden backup (CLAUDE.md
// §19). Treat that placeholder as "no usable key," never as a real one —
// otherwise this would silently try to authenticate to Anthropic with the
// literal word "[SENSITIVE]", always get a 401, and never fall through to
// the CRON_SECRET-gated proxy route below (the whole point of this file).
const ANTHROPIC_KEY_USABLE = !!ANTHROPIC_API_KEY && ANTHROPIC_API_KEY !== '[SENSITIVE]';
// CRON_SECRET IS a real value in .env.local locally (Bitwarden-backed).
// When there's no usable ANTHROPIC_API_KEY in this environment, the 4
// vision rules are run by POSTing sampled/compressed frames to
// api/verify-video-vision.js instead of calling api.anthropic.com directly
// — same approved manual-trigger pattern as any other CRON_SECRET-gated
// route (CLAUDE.md §15). Production/Vercel still takes the direct-call path
// unchanged, because ANTHROPIC_API_KEY is a real value there.
const CRON_SECRET = process.env.CRON_SECRET;
// Override for testing against a staging/preview deployment; defaults to
// production (CLAUDE.md §20, Live URLs).
const VIDEO_QUALITY_VISION_URL = process.env.VIDEO_QUALITY_VISION_URL || 'https://meetdossie.com/api/verify-video-vision';
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const VISION_MODEL = 'claude-sonnet-5';
const HOLD_STATUS = 'quality_hold';

// docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §1.5 / §4.7 / §5 item 7.
const TIKTOK_RANGE = [21, 34];
const IG_LOOP_RANGE = [7, 15];
const HARD_MAX_RUNTIME_S = 45;

// The exact sample point the 9 rejected Rust videos were frozen through
// (playbook §6: "frame 0 and frame 1.5s are pixel-identical in every video
// checked").
const MOTION_SAMPLE_T = 1.5;
// SSIM ranges 0-1, 1.0 = pixel-identical. Calibrated against real fixtures:
// the frozen Rust video measured 0.999966; a genuinely-moving synthetic
// clip measured 0.936. 0.999 cleanly separates the two with margin.
const MOTION_SSIM_FAIL_THRESHOLD = 0.999;

const HOOK_CLEAR_SAMPLE_T = 3.0;
const CAPTION_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];

// ── Full-bleed framing rules (added 2026-09-16 after the stage-checklist incident) ──
//
// WHY: feature-demo-stage-checklist-desktop-2026-09-07.mp4 and
// feature-demo-close-day-desktop-2026-09-07.mp4 shipped to Facebook/LinkedIn/
// Twitter on 2026-09-15 at 1920x1080 (landscape 16:9). Facebook renders those
// surfaces as vertical Reels, so it letterboxed our 16:9 file into a 9:16
// frame — Heath saw a thin horizontal strip with ~80% black around it. The
// gate at the time had only `resolution_readable` (a corrupt-file guard),
// which a perfectly-valid 1920x1080 file passes. Nothing in the pipeline ever
// asserted the SHAPE of the frame.
//
// Target is 9:16 = 0.5625. Measured on the real files: the four good
// `-mobile-` variants are exactly 1080x1920 (0.5625); the two bad `-desktop-`
// variants are 1920x1080 (1.7778). Tolerance is deliberately tight (±0.02,
// which still admits 1080x1912..1080x1928) because there is no legitimate
// reason for a short-form vertical post to drift off 9:16.
const TARGET_ASPECT_RATIO = 9 / 16; // 0.5625
const ASPECT_RATIO_TOLERANCE = 0.02;

// Persistent-bar content coverage. A letterboxed/pillarboxed file wastes frame
// on uniform bars; we require real content to occupy >= 85% of the frame area.
//
// Measured against real fixtures (scripts/regression-video-quality-gate.js):
//   all 6 real feature-demo videos ......... 1.0000  (no persistent bars)
//   synthetic black letterbox .............. 0.6328
//   synthetic 16:9-naively-padded-to-9:16 .. 0.3281
//   synthetic WHITE pillarbox .............. 0.3120
// 0.85 separates those two clusters with wide margin.
//
// Bars are detected on a normalised 128x128 grayscale grid, which makes the
// measurement resolution-independent and — unlike ffmpeg's `cropdetect` —
// colour-agnostic. That matters: Dossie's brand is a light/blush palette, so a
// WHITE pillarbox is a realistic failure that black-only cropdetect scores as
// a full frame. Bars are intersected across 5 sample points spread through the
// runtime, so only padding present in EVERY frame counts. A single transient
// flat UI screen (a loading state, a mostly-white modal) does not trip it —
// two of the four known-good mobile videos DO hit ~0.59 on one isolated
// sample, and the intersection correctly scores them 1.0.
const CONTENT_COVERAGE_GRID = 128;
const CONTENT_COVERAGE_FLAT_TOL = 6;      // luma spread within a row/col to call it "flat"
const CONTENT_COVERAGE_SAMPLE_FRACTIONS = [0.15, 0.3, 0.45, 0.6, 0.8];
const CONTENT_COVERAGE_MIN = 0.85;

// First frame must carry information. The bad stage-checklist video's frame 0
// was a PERFECTLY uniform white frame: luma min == max == 235, spread 0. Every
// other real video measured a spread of 237-255. 24 sits far from both.
const FIRST_FRAME_MIN_LUMA_SPREAD = 24;

// ── Small fetch/telegram/supabase helpers (same shape as verify-image-match.js) ──

async function supabaseFetch(pathSuffix, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${pathSuffix}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function telegramAlert(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[verify-video-quality] cannot alert Heath — TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing');
    return;
  }
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (err) {
    console.error('[verify-video-quality] telegram alert send failed:', err && err.message);
  }
}

// ── ffprobe / ffmpeg helpers (local files only) ──────────────────────────────

async function isHttpUrl(src) {
  return /^https?:\/\//i.test(String(src || ''));
}

// Resolves a video/cover source (local path or http(s) URL) to a local file
// path ffprobe/ffmpeg can read. Returns { path, cleanup }.
async function resolveLocalFile(source, tmpDir) {
  if (!source) throw new Error('no source given');
  if (!(await isHttpUrl(source))) {
    await fs.promises.access(source, fs.constants.R_OK); // throws if unreadable
    return { path: source, cleanup: async () => {} };
  }
  const res = await fetch(source);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let ext = '.mp4';
  try { ext = path.extname(new URL(source).pathname) || ext; } catch (_) { /* keep default */ }
  const tmpPath = path.join(tmpDir, `qgate-src-${process.pid}-${Date.now()}${ext}`);
  await fs.promises.writeFile(tmpPath, buf);
  return { path: tmpPath, cleanup: async () => fs.promises.unlink(tmpPath).catch(() => {}) };
}

async function ffprobeDuration(localPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', localPath,
  ]);
  const d = parseFloat(String(stdout).trim());
  if (!Number.isFinite(d)) throw new Error(`ffprobe returned no parseable duration: "${stdout}"`);
  return d;
}

async function ffprobeResolution(localPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', localPath,
  ]);
  const [w, h] = String(stdout).trim().split('x').map(Number);
  if (!w || !h) throw new Error(`ffprobe returned no parseable resolution: "${stdout}"`);
  return { width: w, height: h };
}

// Decodes one frame, forced to a CONTENT_COVERAGE_GRID square of 8-bit
// grayscale, straight to a Buffer (no temp file, no image decoder dependency).
//
// Squashing to a fixed square is deliberate and safe for bar detection:
// scaling is linear, so a bar occupying 18% of the source height still
// occupies 18% of the grid's rows. That makes every measurement below a pure
// fraction of the frame, independent of the source resolution.
async function grayGridAt(localVideoPath, atSeconds) {
  const g = CONTENT_COVERAGE_GRID;
  const { stdout } = await execFileAsync(
    'ffmpeg',
    [
      '-v', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', localVideoPath,
      '-frames:v', '1', '-vf', `scale=${g}:${g},format=gray`,
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
    ],
    { encoding: 'buffer', maxBuffer: 1 << 22 },
  );
  if (!stdout || stdout.length < g * g) {
    throw new Error(`ffmpeg returned ${stdout ? stdout.length : 0} bytes, expected ${g * g}`);
  }
  return stdout;
}

// Counts uniform ("flat") rows/columns inwards from each edge of one frame.
function detectBars(grid) {
  const g = CONTENT_COVERAGE_GRID;
  const tol = CONTENT_COVERAGE_FLAT_TOL;
  const rowFlat = (r) => {
    let mn = 255; let mx = 0;
    for (let c = 0; c < g; c++) { const v = grid[r * g + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx - mn <= tol;
  };
  const colFlat = (c) => {
    let mn = 255; let mx = 0;
    for (let r = 0; r < g; r++) { const v = grid[r * g + c]; if (v < mn) mn = v; if (v > mx) mx = v; }
    return mx - mn <= tol;
  };
  let top = 0; while (top < g && rowFlat(top)) top++;
  let bottom = 0; while (bottom < g - top && rowFlat(g - 1 - bottom)) bottom++;
  let left = 0; while (left < g && colFlat(left)) left++;
  let right = 0; while (right < g - left && colFlat(g - 1 - right)) right++;
  return { top, bottom, left, right };
}

// Fraction of the frame occupied by real content, counting only bars that
// persist across EVERY sample point (see CONTENT_COVERAGE_MIN's note on why
// the intersection matters). Returns { coverage, bars, samples }.
async function analyzePersistentCoverage(localVideoPath, durationSeconds) {
  const g = CONTENT_COVERAGE_GRID;
  const d = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : null;
  const times = d
    ? CONTENT_COVERAGE_SAMPLE_FRACTIONS.map((frac) => Math.min(d - 0.05, Math.max(0.05, d * frac)))
    : [0.5, 1.0, 1.5, 2.0, 2.5];

  const samples = [];
  for (const t of times) {
    // eslint-disable-next-line no-await-in-loop
    samples.push(detectBars(await grayGridAt(localVideoPath, t)));
  }
  if (!samples.length) throw new Error('no frames could be sampled for coverage');

  const bars = {
    top: Math.min(...samples.map((s) => s.top)),
    bottom: Math.min(...samples.map((s) => s.bottom)),
    left: Math.min(...samples.map((s) => s.left)),
    right: Math.min(...samples.map((s) => s.right)),
  };
  const hFrac = (g - bars.top - bars.bottom) / g;
  const wFrac = (g - bars.left - bars.right) / g;
  return { coverage: Math.max(0, hFrac) * Math.max(0, wFrac), bars, samples };
}

// Luma min/max across a single frame, via ffmpeg's signalstats. A perfectly
// uniform frame (blank white splash, solid black, an empty page) returns a
// spread of 0.
async function frameLumaSpread(localVideoPath, atSeconds) {
  const grid = await grayGridAt(localVideoPath, atSeconds);
  let mn = 255; let mx = 0;
  for (let i = 0; i < grid.length; i++) { const v = grid[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
  return { min: mn, max: mx, spread: mx - mn };
}

async function extractFrame(localVideoPath, atSeconds, outPngPath) {
  await execFileAsync('ffmpeg', [
    '-y', '-ss', String(Math.max(0, atSeconds)), '-i', localVideoPath,
    '-frames:v', '1', outPngPath,
  ]);
  const stat = await fs.promises.stat(outPngPath);
  if (!stat.size) throw new Error(`ffmpeg produced an empty frame at t=${atSeconds}`);
}

// SSIM "All:" value between two still images, via ffmpeg's ssim filter.
// 1.0 = pixel-identical. Throws on tool failure; caller decides fail-closed.
async function computeSsim(pathA, pathB) {
  let stderr = '';
  try {
    const result = await execFileAsync('ffmpeg', ['-i', pathA, '-i', pathB, '-lavfi', 'ssim', '-f', 'null', '-']);
    stderr = result.stderr || '';
  } catch (err) {
    stderr = (err && err.stderr) || '';
    if (!stderr) throw err;
  }
  const m = stderr.match(/All:([\d.]+)/);
  if (!m) throw new Error('ssim filter produced no parseable "All:" value');
  return parseFloat(m[1]);
}

// ── Vision helper (same Anthropic Messages API shape as verify-image-match.js) ──

// Frames come out of extractFrame() at full source resolution (needed for
// the exact-pixel measurable rules). The vision checks don't need that —
// they need to be legible to a model and small enough to never risk
// Vercel's hard, non-configurable 4.5MB request-body cap (confirmed in
// api/jarvis-bridge-turn.js's own note) when proxied through
// api/verify-video-vision.js. Downscale + re-encode as JPEG before sending;
// try progressively smaller/lower-quality passes rather than silently
// sending an oversized frame that would 413 — a 413 must fail closed like
// any other transport failure, never silently pass (see
// MAX_VISION_REQUEST_BYTES below and
// scripts/regression-video-quality-vision-transport.js).
const VISION_FRAME_ATTEMPTS = [
  { width: 900, q: 5 },
  { width: 640, q: 6 },
  { width: 480, q: 8 },
];
// ~900KB base64 (~675KB decoded) per frame. 3 frames (captions_present, the
// largest call) stays comfortably under MAX_VISION_REQUEST_BYTES below.
const MAX_VISION_FRAME_BASE64 = 900_000;

async function compressFrameForVision(localPngPath) {
  const outPath = `${localPngPath}.vision.jpg`;
  let lastErr = null;
  for (const { width, q } of VISION_FRAME_ATTEMPTS) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', localPngPath,
        '-vf', `scale='min(${width},iw)':-2`,
        '-q:v', String(q),
        outPath,
      ]);
      const buf = await fs.promises.readFile(outPath);
      const base64 = buf.toString('base64');
      if (base64.length <= MAX_VISION_FRAME_BASE64) {
        return { base64, mimeType: 'image/jpeg' };
      }
      lastErr = new Error(`compressed frame still ${base64.length} base64 chars at width=${width}/q=${q} (budget ${MAX_VISION_FRAME_BASE64})`);
    } catch (err) {
      lastErr = err;
    } finally {
      // eslint-disable-next-line no-await-in-loop
      await fs.promises.unlink(outPath).catch(() => {});
    }
  }
  throw lastErr || new Error('could not compress frame for vision transport');
}

// Stringified-body budget for either transport (direct Anthropic call or
// the proxy route). Dominated by image bytes either way, so checking the
// direct-call shape is a safe (slightly conservative) proxy for both. Well
// under Vercel's hard 4.5MB request-body cap, with real margin for JSON
// framing/headers.
const MAX_VISION_REQUEST_BYTES = 3_500_000;

// images: [{ base64, mimeType }, ...] in the order they should appear to the
// model (already compressed via compressFrameForVision). Returns the parsed
// JSON object the prompt asked for, or throws — every throw here is a
// fail-closed vision-rule failure at the call site.
async function callVisionModel(images, promptText) {
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
  }));
  content.push({ type: 'text', text: promptText });
  const anthropicBody = { model: VISION_MODEL, max_tokens: 500, messages: [{ role: 'user', content }] };
  const serialized = JSON.stringify(anthropicBody);
  if (serialized.length > MAX_VISION_REQUEST_BYTES) {
    throw new Error(`vision request too large (${serialized.length} bytes, budget ${MAX_VISION_REQUEST_BYTES}) — refusing to send (fail-closed, avoids a platform 413)`);
  }

  if (ANTHROPIC_KEY_USABLE) {
    // Direct call — unchanged from before. Taken whenever a real key IS
    // present in this environment (Vercel prod/preview today; any future
    // machine that legitimately has one).
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: serialized,
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic call failed: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    return extractVisionJson(data);
  }

  if (CRON_SECRET) {
    // Proxy through api/verify-video-vision.js so this machine never needs
    // ANTHROPIC_API_KEY locally. Any non-ok status, network failure, or
    // malformed { ok, result } shape throws here — caught by the caller's
    // try/catch exactly like a direct-call failure, so it fails the rule
    // closed rather than passing.
    const res = await fetch(VIDEO_QUALITY_VISION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CRON_SECRET}` },
      body: JSON.stringify({ images, promptText }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`vision proxy ${VIDEO_QUALITY_VISION_URL} failed: ${res.status} ${errText.slice(0, 300)}`);
    }
    const data = await res.json().catch((err) => {
      throw new Error(`vision proxy returned non-JSON: ${err.message}`);
    });
    if (!data || data.ok !== true || !data.result) {
      throw new Error(`vision proxy returned a malformed response: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return data.result;
  }

  throw new Error('neither a usable ANTHROPIC_API_KEY nor CRON_SECRET is set — cannot run vision check (fail-closed)');
}

const HOOK_VISIBLE_PROMPT = `You are grading the opening frame of a short-form vertical video (TikTok/Reels/Shorts) against a scroll-stopping-hook standard.

Look ONLY at this single frame (video time 0.0s). Is there large, legible on-screen text that makes a specific, attention-grabbing claim — the kind of bold hook overlay that stops a scroll — clearly visible in this frame? A tiny corner byline/logo/watermark does NOT count. A blank frame, a plain title card with no real claim, or illegible/too-small text does NOT count.

Respond with JSON only, no markdown fences:
{"hook_visible": true or false, "text_seen": "the exact or approximate text you can read, empty string if none", "reason": "one sentence"}`;

const HOOK_CLEARED_PROMPT = `You are comparing two frames from the same short-form video: Frame A is time 0.0s, Frame B is roughly time 3.0s.

Frame A should show a bold hook-text overlay. By Frame B, has that same hook-text overlay cleared away (moved off screen, faded out, or been replaced) so the underlying footage/content is now visible and readable — NOT still covered by the same static text block sitting in the same place?

Respond with JSON only, no markdown fences:
{"hook_cleared": true or false, "reason": "one sentence describing what changed (or didn't) between the two frames"}`;

// Added 2026-09-16. The two bad desktop feature-demo videos spent their first
// ~3 seconds sitting on the Dossie sign-in page — one of them with the demo
// account's email and password visibly filled in. A product demo must open on
// the product doing something, never on the front door.
//
// Narrowed same day: the original wording also disqualified a "blank/
// solid-colour frame", which caught our OWN designed hook cards (the Rust
// readiness-marcus-v3 cut and a Dossie hook-card cut) — a hook card is
// deliberately a solid-colour frame carrying large title text
// (feedback_every-video-needs-scroll-stopping-hook.md: frame 1 must carry a
// text hook). The rule's actual intent is to catch a login screen or a
// dead/blank/loading opening with NOTHING on it — not a designed title card.
// So: fail on a real auth screen, OR on a frame with neither legible text
// nor product UI. A frame with large hook text, or real populated product
// UI, passes either way.
const OPENING_MEANINGFUL_PROMPT = `These are two frames from the very start of a short-form product-demo video: Frame A is time 0.0s, Frame B is roughly 1.5s in.

An opening frame is BAD ONLY if it is one of these:
- a login / sign-in / sign-up / "welcome back" / password / magic-link / authentication screen — a real screen asking someone to enter or confirm credentials. This is bad even if the credentials are already pre-filled in.
- a frame with NEITHER legible on-screen text NOR visible product/app UI — e.g. a blank/near-blank frame, a bare loading spinner or skeleton placeholder, or an "empty state" / "no data yet" screen with no real text or content on it.

An opening frame is GOOD if it shows EITHER of these — judge generously, this is the common and desired case:
- a designed hook/title card: large, legible on-screen text making a claim, even on a plain solid-colour background. This is a deliberate scroll-stopping opening, not a dead one, and must NOT be flagged just for having a solid-colour background.
- real product content/UI: an actual populated app screen, chat, dashboard, or data view.

Judge the TWO frames together: if EITHER frame shows one of the two disqualifying screens above, the opening is bad. Otherwise it's good.

Respond with JSON only, no markdown fences:
{"opening_meaningful": true or false, "screen_seen": "short description of what each frame shows", "disqualifier": "login|blank_or_empty|none", "reason": "one sentence"}`;

const CAPTIONS_PRESENT_PROMPT = `These are 3 frames sampled across a short-form video's runtime (roughly 25%, 50%, and 75% of the way through), in that order.

For EACH frame, is there a legible burned-in caption/subtitle (word-level or line-level on-screen text synced to speech, NOT a title card, NOT a logo/watermark) visible on screen?

Respond with JSON only, no markdown fences:
{"frames_with_captions": <integer count 0-3>, "reason": "one sentence"}`;

// ── Main check ────────────────────────────────────────────────────────────

/**
 * Runs every quality rule against one video. Requires ffmpeg/ffprobe on PATH
 * and (for the vision rules) either a usable ANTHROPIC_API_KEY or a
 * CRON_SECRET (to reach api/verify-video-vision.js) — all fail CLOSED, not
 * skipped, if unavailable (see file header).
 *
 * @param {object} opts
 * @param {string} [opts.videoUrl] - remote URL to the video (downloaded to tmp)
 * @param {string} [opts.videoPath] - local path to the video
 * @param {string} [opts.coverUrl] - remote URL to the explicit cover asset
 * @param {string} [opts.coverPath] - local path to the explicit cover asset
 * @returns {Promise<{pass: boolean, rules: object, failedRules: string[], detail: object}>}
 */
async function checkVideoQuality(opts = {}) {
  const tmpDir = opts.tmpDir || os.tmpdir();
  const rules = {};
  const detail = {};
  const cleanupFns = [];

  const addRule = (name, { pass, blocking = true, note = '' }) => {
    rules[name] = { pass: !!pass, blocking, note };
  };

  const finalize = async () => {
    for (const fn of cleanupFns) {
      // eslint-disable-next-line no-await-in-loop
      try { await fn(); } catch (_) { /* best-effort cleanup */ }
    }
    const failedRules = Object.entries(rules)
      .filter(([, r]) => r.blocking && !r.pass)
      .map(([name]) => name);
    return {
      pass: failedRules.length === 0,
      rules,
      failedRules,
      detail: {
        duration_seconds: detail.duration_seconds ?? null,
        resolution: detail.resolution ?? null,
        motion_ssim: detail.motion_ssim ?? null,
        aspect_ratio: detail.aspect_ratio ?? null,
        content_coverage: detail.content_coverage ?? null,
        persistent_bars: detail.persistent_bars ?? null,
        first_frame_luma_spread: detail.first_frame_luma_spread ?? null,
        opening_disqualifier: detail.opening_disqualifier ?? null,
      },
    };
  };

  // Resolve the video file locally.
  let localVideo;
  try {
    const videoSource = opts.videoUrl || opts.videoPath;
    if (!videoSource) throw new Error('no videoUrl/videoPath supplied');
    const resolved = await resolveLocalFile(videoSource, tmpDir);
    localVideo = resolved.path;
    cleanupFns.push(resolved.cleanup);
  } catch (err) {
    addRule('video_file_accessible', { pass: false, note: `could not access video: ${err.message}` });
    return finalize();
  }
  addRule('video_file_accessible', { pass: true });

  // 1. Runtime.
  let duration = null;
  try {
    duration = await ffprobeDuration(localVideo);
    detail.duration_seconds = Math.round(duration * 10) / 10;
    const inTikTok = duration >= TIKTOK_RANGE[0] && duration <= TIKTOK_RANGE[1];
    const inIgLoop = duration >= IG_LOOP_RANGE[0] && duration <= IG_LOOP_RANGE[1];
    const pass = duration <= HARD_MAX_RUNTIME_S && (inTikTok || inIgLoop);
    addRule('runtime_in_platform_range', {
      pass,
      note: pass
        ? `${detail.duration_seconds}s fits ${inTikTok ? `TikTok narrative (${TIKTOK_RANGE.join('-')}s)` : `IG loop (${IG_LOOP_RANGE.join('-')}s)`}`
        : `${detail.duration_seconds}s fits neither TikTok's ${TIKTOK_RANGE.join('-')}s window nor IG's ${IG_LOOP_RANGE.join('-')}s loop window (hard ceiling ${HARD_MAX_RUNTIME_S}s)`,
    });
  } catch (err) {
    addRule('runtime_in_platform_range', { pass: false, note: `ffprobe duration failed (fail-closed): ${err.message}` });
  }

  // 2. Real motion between frame 0.0s and frame 1.5s.
  let frame0Path = null;
  try {
    frame0Path = path.join(tmpDir, `qgate-f0-${process.pid}-${Date.now()}.png`);
    const frameMotionPath = path.join(tmpDir, `qgate-fmotion-${process.pid}-${Date.now()}.png`);
    cleanupFns.push(async () => fs.promises.unlink(frame0Path).catch(() => {}));
    cleanupFns.push(async () => fs.promises.unlink(frameMotionPath).catch(() => {}));
    await extractFrame(localVideo, 0, frame0Path);
    await extractFrame(localVideo, MOTION_SAMPLE_T, frameMotionPath);
    const ssim = await computeSsim(frame0Path, frameMotionPath);
    detail.motion_ssim = Math.round(ssim * 1e6) / 1e6;
    const pass = ssim < MOTION_SSIM_FAIL_THRESHOLD;
    addRule('real_motion_0_to_1_5s', {
      pass,
      note: pass
        ? `SSIM ${detail.motion_ssim} between 0.0s and ${MOTION_SAMPLE_T}s — real motion detected`
        : `SSIM ${detail.motion_ssim} between 0.0s and ${MOTION_SAMPLE_T}s — frames are static/near-identical (the exact defect measured in all 9 rejected Rust videos)`,
    });
  } catch (err) {
    frame0Path = null;
    addRule('real_motion_0_to_1_5s', { pass: false, note: `motion check failed (fail-closed): ${err.message}` });
  }

  // 3. Resolution sanity (corrupt-file guard) + 3b. the frame is actually 9:16.
  let resolutionOk = false;
  try {
    const { width, height } = await ffprobeResolution(localVideo);
    detail.resolution = `${width}x${height}`;
    resolutionOk = true;
    addRule('resolution_readable', { pass: true, note: detail.resolution });

    const ratio = width / height;
    detail.aspect_ratio = Math.round(ratio * 1e4) / 1e4;
    const delta = Math.abs(ratio - TARGET_ASPECT_RATIO);
    const pass = delta <= ASPECT_RATIO_TOLERANCE;
    addRule('aspect_ratio_vertical_9x16', {
      pass,
      note: pass
        ? `${detail.resolution} (${detail.aspect_ratio}) is 9:16 full-bleed vertical`
        : `${detail.resolution} has aspect ratio ${detail.aspect_ratio}, not 9:16 (${Math.round(TARGET_ASPECT_RATIO * 1e4) / 1e4} ±${ASPECT_RATIO_TOLERANCE}). ${ratio > 1 ? 'This is a LANDSCAPE file — Facebook/Instagram/TikTok will letterbox it into a vertical Reel with black bars (the 2026-09-15 stage-checklist defect).' : 'Off-target vertical frame.'}`,
    });
  } catch (err) {
    addRule('resolution_readable', { pass: false, note: `ffprobe resolution failed (fail-closed): ${err.message}` });
    addRule('aspect_ratio_vertical_9x16', { pass: false, note: `cannot verify aspect ratio without a readable resolution (fail-closed): ${err.message}` });
  }

  // 3c. Content actually fills the frame — no baked-in letterbox/pillarbox.
  // Complements the aspect-ratio rule: a 16:9 source naively padded to
  // 1080x1920 passes 9:16 but is still 66% dead bars, which is exactly the
  // wrong "fix" for this defect.
  try {
    if (!resolutionOk) throw new Error('resolution unreadable — coverage would be meaningless');
    const { coverage, bars } = await analyzePersistentCoverage(localVideo, duration);
    detail.content_coverage = Math.round(coverage * 1e4) / 1e4;
    detail.persistent_bars = bars;
    const pass = coverage >= CONTENT_COVERAGE_MIN;
    const barDesc = [
      bars.top ? `top ${Math.round((bars.top / CONTENT_COVERAGE_GRID) * 100)}%` : null,
      bars.bottom ? `bottom ${Math.round((bars.bottom / CONTENT_COVERAGE_GRID) * 100)}%` : null,
      bars.left ? `left ${Math.round((bars.left / CONTENT_COVERAGE_GRID) * 100)}%` : null,
      bars.right ? `right ${Math.round((bars.right / CONTENT_COVERAGE_GRID) * 100)}%` : null,
    ].filter(Boolean).join(', ');
    addRule('content_fills_frame', {
      pass,
      note: pass
        ? `content occupies ${(detail.content_coverage * 100).toFixed(1)}% of the frame (min ${CONTENT_COVERAGE_MIN * 100}%)`
        : `content occupies only ${(detail.content_coverage * 100).toFixed(1)}% of the frame (min ${CONTENT_COVERAGE_MIN * 100}%) — persistent uniform bars: ${barDesc || 'none located'}. The video is letterboxed/pillarboxed.`,
    });
  } catch (err) {
    addRule('content_fills_frame', { pass: false, note: `coverage check failed (fail-closed): ${err.message}` });
  }

  // 3d. Frame 0 carries information (not a blank/solid splash).
  try {
    const { min, max, spread } = await frameLumaSpread(localVideo, 0);
    detail.first_frame_luma_spread = spread;
    const pass = spread >= FIRST_FRAME_MIN_LUMA_SPREAD;
    addRule('first_frame_not_uniform', {
      pass,
      note: pass
        ? `frame 0 luma spread ${spread} (min ${min}, max ${max}) — frame carries content`
        : `frame 0 is near-uniform: luma spread ${spread} (min ${min}, max ${max}), below ${FIRST_FRAME_MIN_LUMA_SPREAD}. This is a blank opening frame — the exact defect in feature-demo-stage-checklist-desktop-2026-09-07 (spread 0, solid white).`,
    });
  } catch (err) {
    addRule('first_frame_not_uniform', { pass: false, note: `first-frame uniformity check failed (fail-closed): ${err.message}` });
  }

  // 4. Cover asset present (docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md §3 — every
  // platform needs an explicit cover carrying the hook claim; a missing
  // cover fails the gate outright, it is never optional).
  const coverSource = opts.coverUrl || opts.coverPath;
  if (!coverSource) {
    addRule('cover_asset_present', { pass: false, note: 'no cover_url/cover_path supplied — every video needs an explicit cover asset before it can queue' });
  } else {
    try {
      const resolvedCover = await resolveLocalFile(coverSource, tmpDir);
      if (!opts.coverPath) cleanupFns.push(resolvedCover.cleanup); // only clean up what we downloaded
      const stat = await fs.promises.stat(resolvedCover.path);
      addRule('cover_asset_present', {
        pass: stat.size > 0,
        note: stat.size > 0 ? `cover asset OK (${(stat.size / 1024).toFixed(0)}KB)` : 'cover asset is 0 bytes',
      });
    } catch (err) {
      addRule('cover_asset_present', { pass: false, note: `cover asset unreachable (fail-closed): ${err.message}` });
    }
  }

  // 5-7. Vision checks — only meaningful if we got a usable frame 0.
  if (!frame0Path) {
    addRule('hook_visible_frame0', { pass: false, note: 'skipped — frame 0 could not be extracted, see real_motion_0_to_1_5s' });
    addRule('hook_cleared_by_3s', { pass: false, note: 'skipped — frame 0 could not be extracted' });
    addRule('opening_not_login_or_empty', { pass: false, note: 'skipped — frame 0 could not be extracted' });
    addRule('captions_present', { pass: false, note: 'skipped — frame 0 could not be extracted' });
  } else if (!ANTHROPIC_KEY_USABLE && !CRON_SECRET) {
    const note = 'no usable ANTHROPIC_API_KEY and no CRON_SECRET — cannot run vision check via either transport (fail-closed)';
    addRule('hook_visible_frame0', { pass: false, note });
    addRule('hook_cleared_by_3s', { pass: false, note });
    addRule('opening_not_login_or_empty', { pass: false, note });
    addRule('captions_present', { pass: false, note });
  } else {
    let frame0Vision = null;
    try {
      frame0Vision = await compressFrameForVision(frame0Path);
      const result = await callVisionModel([frame0Vision], HOOK_VISIBLE_PROMPT);
      addRule('hook_visible_frame0', {
        pass: result.hook_visible === true,
        note: `"${String(result.text_seen || '').slice(0, 120)}" — ${result.reason || ''}`,
      });
    } catch (err) {
      addRule('hook_visible_frame0', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
    }

    // Hook cleared by ~3s.
    try {
      if (!frame0Vision) throw new Error('frame 0 unavailable');
      const clampedT = duration ? Math.min(HOOK_CLEAR_SAMPLE_T, Math.max(0.1, duration - 0.1)) : HOOK_CLEAR_SAMPLE_T;
      const frame3Path = path.join(tmpDir, `qgate-f3-${process.pid}-${Date.now()}.png`);
      cleanupFns.push(async () => fs.promises.unlink(frame3Path).catch(() => {}));
      await extractFrame(localVideo, clampedT, frame3Path);
      const frame3Vision = await compressFrameForVision(frame3Path);
      const result = await callVisionModel([frame0Vision, frame3Vision], HOOK_CLEARED_PROMPT);
      addRule('hook_cleared_by_3s', { pass: result.hook_cleared === true, note: result.reason || '' });
    } catch (err) {
      addRule('hook_cleared_by_3s', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
    }

    // Opening is a meaningful moment — not a login page, blank, or empty state.
    // Uses frame 0 plus a frame at MOTION_SAMPLE_T (1.5s), because the
    // 2026-09-15 defect was a blank frame 0 followed by the sign-in page: one
    // frame alone would have missed one half of it.
    try {
      if (!frame0Vision) throw new Error('frame 0 unavailable');
      const openingT = duration ? Math.min(MOTION_SAMPLE_T, Math.max(0.1, duration - 0.1)) : MOTION_SAMPLE_T;
      const openingPath = path.join(tmpDir, `qgate-open-${process.pid}-${Date.now()}.png`);
      cleanupFns.push(async () => fs.promises.unlink(openingPath).catch(() => {}));
      await extractFrame(localVideo, openingT, openingPath);
      const openingVision = await compressFrameForVision(openingPath);
      const result = await callVisionModel([frame0Vision, openingVision], OPENING_MEANINGFUL_PROMPT);
      detail.opening_disqualifier = result.disqualifier || null;
      addRule('opening_not_login_or_empty', {
        pass: result.opening_meaningful === true,
        note: result.opening_meaningful === true
          ? `opening is meaningful — ${result.reason || ''}`
          : `opening disqualified (${result.disqualifier || 'unknown'}): ${result.screen_seen || ''} — ${result.reason || ''}`,
      });
    } catch (err) {
      addRule('opening_not_login_or_empty', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
    }

    // Captions present across the runtime.
    try {
      if (!duration) throw new Error('duration unknown — cannot sample runtime');
      const framePaths = [];
      for (const frac of CAPTION_SAMPLE_FRACTIONS) {
        const t = Math.max(0.1, Math.min(duration - 0.1, duration * frac));
        const fp = path.join(tmpDir, `qgate-cap-${Math.round(frac * 100)}-${process.pid}-${Date.now()}.png`);
        cleanupFns.push(async () => fs.promises.unlink(fp).catch(() => {}));
        // eslint-disable-next-line no-await-in-loop
        await extractFrame(localVideo, t, fp);
        framePaths.push(fp);
      }
      const images = [];
      for (const fp of framePaths) {
        // eslint-disable-next-line no-await-in-loop
        images.push(await compressFrameForVision(fp));
      }
      const result = await callVisionModel(images, CAPTIONS_PRESENT_PROMPT);
      const count = Number(result.frames_with_captions) || 0;
      addRule('captions_present', {
        pass: count >= 2, // majority of the 3 sample points
        note: `${count}/3 sampled frames showed captions — ${result.reason || ''}`,
      });
    } catch (err) {
      addRule('captions_present', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
    }
  }

  return finalize();
}

// ── Publish-time gate (Vercel-safe — no ffmpeg, reads recorded quality_status) ──

/**
 * Call immediately before a video_library row is queued for Heath's review
 * OR posted to Zernio (api/cron-post-videos.js). Vercel cannot run ffmpeg
 * (see file header), so this does NOT re-probe the file — it trusts the
 * quality_status/quality_failed_rules the ingestion-time gate
 * (scripts/queue-finished-videos.py via scripts/check-video-quality-cli.js)
 * already recorded on the row. Anything other than quality_status='passed'
 * is treated as fail-closed: holds the row, alerts Heath once, returns
 * false. Caller MUST NOT proceed on a false return.
 *
 * @param {object} video - video_library row (needs id, quality_status, quality_failed_rules, platforms, topic)
 * @returns {Promise<boolean>} true = proceed, false = held, do not proceed
 */
async function gateBeforePublish(video) {
  if (!video || !video.id) return true;
  if (video.quality_status === 'passed') return true;

  const failedRules = Array.isArray(video.quality_failed_rules) ? video.quality_failed_rules : [];
  const reason = failedRules.length
    ? `Failed at ingestion: ${failedRules.join(', ')}`
    : `quality_status='${video.quality_status || 'unchecked'}' — never passed the ingestion-time gate (legacy row, manual insert, or the gate was skipped)`;

  console.warn(`[verify-video-quality] HOLD ${video.id}: ${reason}`);

  await supabaseFetch(`/rest/v1/video_library?id=eq.${encodeURIComponent(video.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ status: HOLD_STATUS }),
  }).catch((err) => console.error('[verify-video-quality] hold patch failed:', err && err.message));

  const alertText = [
    `held: ${video.id} — video quality gate blocked (${video.status === 'approved' ? 'review queue' : 'publish'})`,
    '',
    `owner: ${video.target_owner || 'dossie'}   platforms: ${(video.platforms || []).join(', ') || 'unknown'}   topic: ${video.topic || 'unknown'}`,
    '',
    reason,
    '',
    `Row status set to '${HOLD_STATUS}' — will not retry into review/posting on its own. Fix and re-run the ingestion quality check (scripts/queue-finished-videos.py) to clear it.`,
  ].join('\n');
  await telegramAlert(alertText);

  return false;
}

module.exports = {
  checkVideoQuality,
  gateBeforePublish,
  HOLD_STATUS,
  VISION_MODEL,
  MOTION_SSIM_FAIL_THRESHOLD,
  TIKTOK_RANGE,
  IG_LOOP_RANGE,
  HARD_MAX_RUNTIME_S,
  // Full-bleed framing rules (2026-09-16). Exported so
  // scripts/regression-video-quality-gate.js asserts against the same
  // constants the gate enforces, rather than hard-coding copies.
  TARGET_ASPECT_RATIO,
  ASPECT_RATIO_TOLERANCE,
  CONTENT_COVERAGE_MIN,
  FIRST_FRAME_MIN_LUMA_SPREAD,
  // Measurement primitives, exported for the regression fixtures.
  analyzePersistentCoverage,
  frameLumaSpread,
  // Vision transport (2026-09-16), exported for
  // scripts/regression-video-quality-vision-transport.js.
  VIDEO_QUALITY_VISION_URL,
  MAX_VISION_REQUEST_BYTES,
  MAX_VISION_FRAME_BASE64,
  ANTHROPIC_KEY_USABLE,
  compressFrameForVision,
  callVisionModel,
};
