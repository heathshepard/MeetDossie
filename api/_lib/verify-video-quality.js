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

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
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

function mimeFromPath(p) {
  const lower = String(p).toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function pngBase64(localPngPath) {
  const buf = await fs.promises.readFile(localPngPath);
  return buf.toString('base64');
}

// images: [{ base64, mimeType }, ...] in the order they should appear to the
// model. Returns the parsed JSON object the prompt asked for, or throws.
async function callVisionModel(images, promptText) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const content = images.map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
  }));
  content.push({ type: 'text', text: promptText });

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic call failed: ${res.status} ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON in vision response: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

const HOOK_VISIBLE_PROMPT = `You are grading the opening frame of a short-form vertical video (TikTok/Reels/Shorts) against a scroll-stopping-hook standard.

Look ONLY at this single frame (video time 0.0s). Is there large, legible on-screen text that makes a specific, attention-grabbing claim — the kind of bold hook overlay that stops a scroll — clearly visible in this frame? A tiny corner byline/logo/watermark does NOT count. A blank frame, a plain title card with no real claim, or illegible/too-small text does NOT count.

Respond with JSON only, no markdown fences:
{"hook_visible": true or false, "text_seen": "the exact or approximate text you can read, empty string if none", "reason": "one sentence"}`;

const HOOK_CLEARED_PROMPT = `You are comparing two frames from the same short-form video: Frame A is time 0.0s, Frame B is roughly time 3.0s.

Frame A should show a bold hook-text overlay. By Frame B, has that same hook-text overlay cleared away (moved off screen, faded out, or been replaced) so the underlying footage/content is now visible and readable — NOT still covered by the same static text block sitting in the same place?

Respond with JSON only, no markdown fences:
{"hook_cleared": true or false, "reason": "one sentence describing what changed (or didn't) between the two frames"}`;

const CAPTIONS_PRESENT_PROMPT = `These are 3 frames sampled across a short-form video's runtime (roughly 25%, 50%, and 75% of the way through), in that order.

For EACH frame, is there a legible burned-in caption/subtitle (word-level or line-level on-screen text synced to speech, NOT a title card, NOT a logo/watermark) visible on screen?

Respond with JSON only, no markdown fences:
{"frames_with_captions": <integer count 0-3>, "reason": "one sentence"}`;

// ── Main check ────────────────────────────────────────────────────────────

/**
 * Runs every quality rule against one video. Requires ffmpeg/ffprobe on PATH
 * and (for the vision rules) ANTHROPIC_API_KEY — both fail CLOSED, not
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

  // 3. Resolution sanity (corrupt-file guard).
  try {
    const { width, height } = await ffprobeResolution(localVideo);
    detail.resolution = `${width}x${height}`;
    addRule('resolution_readable', { pass: true, note: detail.resolution });
  } catch (err) {
    addRule('resolution_readable', { pass: false, note: `ffprobe resolution failed (fail-closed): ${err.message}` });
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
    addRule('captions_present', { pass: false, note: 'skipped — frame 0 could not be extracted' });
  } else if (!ANTHROPIC_API_KEY) {
    addRule('hook_visible_frame0', { pass: false, note: 'ANTHROPIC_API_KEY not set — cannot run vision check (fail-closed)' });
    addRule('hook_cleared_by_3s', { pass: false, note: 'ANTHROPIC_API_KEY not set — cannot run vision check (fail-closed)' });
    addRule('captions_present', { pass: false, note: 'ANTHROPIC_API_KEY not set — cannot run vision check (fail-closed)' });
  } else {
    let frame0B64 = null;
    try {
      frame0B64 = await pngBase64(frame0Path);
      const result = await callVisionModel(
        [{ base64: frame0B64, mimeType: mimeFromPath(frame0Path) }],
        HOOK_VISIBLE_PROMPT,
      );
      addRule('hook_visible_frame0', {
        pass: result.hook_visible === true,
        note: `"${String(result.text_seen || '').slice(0, 120)}" — ${result.reason || ''}`,
      });
    } catch (err) {
      addRule('hook_visible_frame0', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
    }

    // Hook cleared by ~3s.
    try {
      if (!frame0B64) throw new Error('frame 0 unavailable');
      const clampedT = duration ? Math.min(HOOK_CLEAR_SAMPLE_T, Math.max(0.1, duration - 0.1)) : HOOK_CLEAR_SAMPLE_T;
      const frame3Path = path.join(tmpDir, `qgate-f3-${process.pid}-${Date.now()}.png`);
      cleanupFns.push(async () => fs.promises.unlink(frame3Path).catch(() => {}));
      await extractFrame(localVideo, clampedT, frame3Path);
      const frame3B64 = await pngBase64(frame3Path);
      const result = await callVisionModel(
        [
          { base64: frame0B64, mimeType: mimeFromPath(frame0Path) },
          { base64: frame3B64, mimeType: mimeFromPath(frame3Path) },
        ],
        HOOK_CLEARED_PROMPT,
      );
      addRule('hook_cleared_by_3s', { pass: result.hook_cleared === true, note: result.reason || '' });
    } catch (err) {
      addRule('hook_cleared_by_3s', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
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
        images.push({ base64: await pngBase64(fp), mimeType: mimeFromPath(fp) });
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
};
