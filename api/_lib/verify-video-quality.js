// api/_lib/verify-video-quality.js
//
// Video quality gate for the content engine — brand-agnostic (Dossie, Rust,
// realtor page all go through this, same rules). Mirrors the
// api/_lib/verify-image-match.js gate pattern: run before a video can be
// queued for Heath's review or posted, hold on failure, alert once, never
// silently skip.
//
// ORIENTATION-AWARE (added 2026-09-17): every rule below was originally
// written for ONE shape — 9:16 vertical Reels/TikTok. That's still the
// default when a caller supplies neither `platforms` nor `orientation` (see
// classifyOrientation() below), so nothing that already used this gate
// changed. A caller that DOES pass the row's real `platforms` array gets
// graded against the matching rule family instead: vertical (tiktok/
// instagram) keeps every existing 9:16/hook-then-clear/Reels-runtime rule
// unchanged; horizontal (facebook/twitter/linkedin/youtube) gets its own
// 16:9/legible-UI/feed-runtime rule family. Pass `opts.platforms` (preferred
// — the real DB array) or `opts.orientation` explicitly; never both absent
// and never guessed from anything else.
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
//   - captions_present            burned-in captions legible AND CHANGING
//                                 across 5 speech-timed sample pairs
//                                 (>= 4/5 required). Rewritten 2026-09-26
//                                 (Cole relay) after dossie_trec_p22_
//                                 district_notice.mp4 was held on this rule
//                                 despite using the IDENTICAL caption
//                                 pipeline as dossie_trec_p8_disclosure.mp4,
//                                 which passed — a gate reliability defect,
//                                 not a content one. Two fixes: (1) sample
//                                 times are no longer arbitrary fractions of
//                                 runtime (25/50/75%, which could land inside
//                                 the hook window, a CTA card, or a ~20ms gap
//                                 between caption events) — they now come
//                                 from real word timestamps when a
//                                 `{stem}.transcript.json` sidecar exists
//                                 (scripts/video-engine/transcribe.js's own
//                                 output), always at least 1.5s after the
//                                 hook clears and before any CTA card;
//                                 falling back to fixed 25/40/55/70/85%
//                                 fractions (never before 3.5s) only when no
//                                 sidecar is present. (2) the vision prompt
//                                 no longer rejects on font/box style — a
//                                 short, boxed, word-synced caption chunk IS
//                                 what synced captions look like in this
//                                 format. Each sample pairs with a frame 1s
//                                 later; the discriminator is whether the
//                                 text CHANGES between them — static text
//                                 across the pair means a title card, not a
//                                 caption, regardless of font weight.
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

// The LONG vertical lane (Atlas 2026-09-25 — the dual-cut production process,
// scripts/video-engine/variants.js).
//
// One recording now produces two cuts from the same master. Both are 9:16
// 1080x1920 — aspect ratio is NOT the variable, length is:
//
//   CORE only        ~30s  -> tiktok, instagram          (the 'vertical' lane)
//   CORE + OPTIONAL  ~50-60s -> youtube, facebook, linkedin
//
// The long cut had nowhere to be graded before this. Passing
// orientation='vertical' capped it at HARD_MAX_RUNTIME_S=45 and failed every
// 50-60s cut; passing platforms ['youtube','facebook','linkedin'] classified
// it HORIZONTAL (see HORIZONTAL_PLATFORMS below) and demanded a 16:9 frame
// this pipeline deliberately does not produce for it.
//
// 90s is the binding real ceiling across the three surfaces, not a guess:
// Facebook Reels caps at 90s, YouTube Shorts at 3 minutes, LinkedIn native
// video far longer. The floor is 40s because below that the core-only cut is
// the correct product and a "long" cut that short means the CORE/OPTIONAL
// tagging produced two near-identical videos — a script-time defect worth
// failing on.
//
// This lane is EXPLICIT-ONLY: no platform array maps to it. Existing callers
// (queue-finished-videos.py, cron-post-videos.js, the regression fixtures)
// never pass it, so none of them change shape.
const VERTICAL_LONG_RUNTIME_RANGE = [40, 90];
const VERTICAL_LONG_HARD_MAX_RUNTIME_S = 90;

// speed_applied_once — see the rule's own comment at its call site for the
// full rationale. Calibrated against v7_FINAL/v7b_SPLICED/v7c_SPLICED:
// video/audio stream duration drift measured 0.07-0.10s on all three real
// known-good files (container rounding); the real defect this catches was
// an 18s drift.
const AV_DURATION_DRIFT_MAX_S = 0.75;

// The exact sample point the 9 rejected Rust videos were frozen through
// (playbook §6: "frame 0 and frame 1.5s are pixel-identical in every video
// checked").
const MOTION_SAMPLE_T = 1.5;
// SSIM ranges 0-1, 1.0 = pixel-identical. Calibrated against real fixtures:
// the frozen Rust video measured 0.999966; a genuinely-moving synthetic
// clip measured 0.936. 0.999 cleanly separates the two with margin.
const MOTION_SSIM_FAIL_THRESHOLD = 0.999;

const HOOK_CLEAR_SAMPLE_T = 3.0;

// NOTE on frame0 "no fade" / "not stacked over another large-type card"
// (founder-video-production-standard.md §6): a pixel-SSIM check comparing
// frame 0.0s to a frame a fraction of a second later was prototyped here and
// DROPPED — it false-failed both real approved fixtures (v7b_SPLICED.mp4
// SSIM 0.87, v7c_SPLICED.mp4 SSIM 0.86, well under any reasonable "stable"
// threshold) because the caption/hook style's own intentional pop-in
// animation (`\t(0,90,\fscx105...)`, ~90-160ms) makes the hook region
// legitimately still changing in that exact window — the same signature a
// genuine fade-in bug would produce. The two are not reliably
// distinguishable from pixels alone without knowing the pop-in's own
// timing, which varies per build. "Blank frame 0" (the actual historical
// defect — a still PNG fed into a `fade` filter never animated, so it just
// stayed invisible) is already caught by first_frame_not_uniform below and
// hook_visible_frame0 in the vision section — both pass on the real
// fixtures, which is the behavior that matters. "Not stacked over another
// large-type card" is a composition/design judgement (a legitimate 2-line
// hook, like v7c's own "SENDING THE NOTICE MONDAY? / IT WAS DUE SATURDAY.",
// looks exactly like two stacked large-type elements) — see
// founder-video-production-standard.md §7's own mandatory human-equivalent
// frame inspection for this one; it is called out, not silently dropped.

// ── captions_present sampling (rewritten 2026-09-26 — see file header) ──────
// Fallback fractions ONLY — used when no word-timestamp sidecar exists.
// 5 points, deliberately never landing in the hook window (see
// CAPTION_MIN_START_S below) or past CAPTION_END_MARGIN_FRACTION of runtime.
const CAPTION_SAMPLE_FRACTIONS = [0.25, 0.40, 0.55, 0.70, 0.85];
// Absolute floor regardless of source: never sample inside the first 3.5s —
// that's the hook card's window (hook_visible_frame0/hook_cleared_by_3s).
const CAPTION_MIN_START_S = 3.5;
// "At least 1.5s after the hook window ends" — HOOK_CLEAR_SAMPLE_T (3.0) is
// this pipeline's own definition of when the hook has cleared.
const CAPTION_HOOK_CLEAR_MARGIN_S = 1.5;
// Stay before any CTA card — this pipeline puts the CTA in the final stretch
// of runtime, so cap sampling at this fraction rather than guess a fixed
// second count that would be wrong for a 20s clip and a 90s one alike.
const CAPTION_END_MARGIN_FRACTION = 0.90;
// The changed-text discriminator's companion offset: does the caption differ
// 1s later? A static title card never changes; a 3-word word-synced chunk
// almost always has moved on by then.
const CAPTION_PAIR_GAP_S = 1.0;
// >= 4 of 5 pairs must show a legible, CHANGING caption. Not 5/5 — a synced
// chunk occasionally spans slightly more than 1s, so one pair coincidentally
// landing inside the same chunk is tolerated; systemic staticness is not.
const CAPTION_MIN_PASS = 4;

/**
 * Word-level timestamps for a video, from the SAME sidecar
 * scripts/video-engine/transcribe.js already writes
 * (`{stem}.transcript.json`, ElevenLabs scribe_v1 shape: {words:[{text,
 * start,end,type}]}) — never re-transcribed here. Only checked next to a
 * LOCAL video path; a downloaded/remote video has no local sibling to check,
 * which is fine — pickCaptionSampleTimes() falls back cleanly.
 * @returns {Array<{start:number,end:number}>|null}
 */
function loadWordTimestampsSidecar(originalVideoPath) {
  if (!originalVideoPath) return null;
  try {
    const p = originalVideoPath.replace(/\.[^./\\]+$/, '') + '.transcript.json';
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const words = (data.words || [])
      .filter((w) => w && w.type === 'word' && Number.isFinite(w.start) && Number.isFinite(w.end))
      .map((w) => ({ start: w.start, end: w.end }))
      .sort((a, b) => a.start - b.start);
    return words.length ? words : null;
  } catch {
    return null; // malformed/unreadable sidecar — treat as absent, never throw
  }
}

/**
 * Picks 5 sample times for captions_present. Prefers real word timestamps
 * (known speech times) inside the safe window; falls back to fixed fractions
 * of runtime, also clamped to the safe window, when no sidecar is usable.
 * @returns {{times:number[], source:string, windowStart:number, windowEnd:number}}
 */
function pickCaptionSampleTimes(duration, words) {
  const windowStart = Math.max(CAPTION_MIN_START_S, HOOK_CLEAR_SAMPLE_T + CAPTION_HOOK_CLEAR_MARGIN_S);
  const windowEnd = Math.max(windowStart + 0.5, duration * CAPTION_END_MARGIN_FRACTION);

  if (words && words.length) {
    const eligible = words.filter((w) => w.start >= windowStart && w.end <= windowEnd);
    if (eligible.length >= 5) {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const idx = Math.min(eligible.length - 1, Math.round((i / 4) * (eligible.length - 1)));
        const w = eligible[idx];
        times.push((w.start + w.end) / 2);
      }
      return { times, source: 'word_timestamps', windowStart, windowEnd };
    }
  }

  const times = CAPTION_SAMPLE_FRACTIONS.map((f) => Math.min(windowEnd, Math.max(windowStart, duration * f)));
  return { times, source: 'fallback_fractions', windowStart, windowEnd };
}

/**
 * The companion time for the changed-text discriminator: 1s later, unless
 * that would leave the safe window, in which case 1s earlier (still clamped
 * inside the window). Always at least ~0.3s from `t` so a real transition has
 * a chance to show — if the window is too narrow even for that, returns null
 * and the caller skips the "changed" half of that pair's judgement.
 */
function pickCaptionPairCompanion(t, windowStart, windowEnd) {
  const forward = t + CAPTION_PAIR_GAP_S;
  if (forward <= windowEnd) return forward;
  const backward = t - CAPTION_PAIR_GAP_S;
  if (backward >= windowStart) return backward;
  return null;
}

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

// ── Orientation-aware gating (added 2026-09-17) ──────────────────────────────
//
// WHY: this gate shipped 2026-09-15/16 written entirely against 9:16 vertical
// Reels/TikTok fixtures (see the constants above) and its aspect/coverage/
// runtime/hook rules are hard-coded to that shape. That's correct for
// Instagram/TikTok, but 9 real feature-demo `video_library` rows sat stuck at
// `pending_approval` for up to 4 months (2026-05-27 to 2026-08-23) — desktop
// 16:9 videos legitimately bound for facebook/twitter/linkedin, where
// horizontal is the right shape, not a defect. Recording this gate's rules
// against them the way they stood would have failed every one of them for
// being 16:9 instead of 9:16 — i.e. for being exactly the shape they were
// built to be. This section makes the gate ask "which shape is this row
// SUPPOSED to be" before grading it, without touching a single vertical rule,
// threshold, or prompt above.
//
// classifyOrientation() takes the row's real `platforms` array (never
// guessed) and returns 'vertical' | 'horizontal'. tiktok/instagram are
// Reels-native vertical surfaces; facebook/twitter/linkedin/youtube are fed
// the desktop 16:9 cut in this pipeline (docs/FEATURE-VIDEO-DAILY-PLAN.md §1
// — "Desktop cut ... Facebook, Twitter, LinkedIn"). A platforms array mixing
// both families, or one with no recognized platform, is refused rather than
// guessed — an ingestion caller must always pass real platforms.
const VERTICAL_PLATFORMS = ['tiktok', 'instagram'];
const HORIZONTAL_PLATFORMS = ['facebook', 'twitter', 'linkedin', 'youtube'];

// Runtime range for the HORIZONTAL (16:9, facebook/twitter/linkedin) lane.
// Calibrated against the real feature-demo output this gate exists to
// unblock: the 7 real desktop feature-demo files on disk run 26.5s-38.1s
// (measured directly via ffprobe against the actual files, 2026-09-17). This
// is a native-feed desktop demo, not a Reels loop — it has no TikTok/IG-style
// completion-rate window, so the range is generous, not tuned to a retention
// curve the way TIKTOK_RANGE/IG_LOOP_RANGE are.
const HORIZONTAL_RUNTIME_RANGE = [10, 90];
const HORIZONTAL_HARD_MAX_RUNTIME_S = 120;

// Target is 16:9 = 1.7778. Same tolerance discipline as the vertical rule.
const TARGET_ASPECT_RATIO_HORIZONTAL = 16 / 9;
const ASPECT_RATIO_TOLERANCE_HORIZONTAL = 0.02;

/**
 * @param {string|undefined} explicitOrientation - 'vertical' | 'horizontal', if the caller already knows.
 * @param {string[]|undefined} platforms - the video_library row's real platforms array.
 * @returns {'vertical'|'horizontal'}
 * @throws if orientation can't be determined (no signal, or a platforms array
 *   mixing vertical and horizontal platforms) — fail-closed, never guessed.
 */
function classifyOrientation(explicitOrientation, platforms) {
  if (explicitOrientation === 'vertical' || explicitOrientation === 'horizontal'
    || explicitOrientation === 'vertical_long') {
    return explicitOrientation;
  }
  const list = Array.isArray(platforms) ? platforms.map((p) => String(p).toLowerCase()) : [];
  const hasVertical = list.some((p) => VERTICAL_PLATFORMS.includes(p));
  const hasHorizontal = list.some((p) => HORIZONTAL_PLATFORMS.includes(p));
  if (hasVertical && !hasHorizontal) return 'vertical';
  if (hasHorizontal && !hasVertical) return 'horizontal';
  if (hasVertical && hasHorizontal) {
    throw new Error(`platforms [${list.join(', ')}] mix vertical (${VERTICAL_PLATFORMS.join('/')}) and horizontal (${HORIZONTAL_PLATFORMS.join('/')}) surfaces — this pipeline ships one shape per video_library row (see docs/FEATURE-VIDEO-DAILY-PLAN.md §1), so a mixed array means the row is misconfigured, not that orientation is ambiguous`);
  }
  throw new Error(`no opts.orientation and platforms [${list.join(', ') || 'empty'}] contain no recognized platform — cannot determine 9:16 vs 16:9 without guessing`);
}

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

// Per-stream (not container-format) durations — the video and audio streams
// of one finished file, read independently. See speed_applied_once below for
// why this matters.
async function ffprobeStreamDurations(localPath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=codec_type,duration', '-of', 'compact=p=0',
    localPath,
  ]);
  let videoDuration = null;
  let audioDuration = null;
  for (const line of String(stdout).split('\n')) {
    const m = line.match(/codec_type=(\w+)\|duration=([\d.]+)/);
    if (!m) continue;
    const d = parseFloat(m[2]);
    if (m[1] === 'video' && videoDuration === null) videoDuration = d;
    if (m[1] === 'audio' && audioDuration === null) audioDuration = d;
  }
  if (videoDuration === null || audioDuration === null) {
    throw new Error(`could not read both stream durations: video=${videoDuration} audio=${audioDuration}`);
  }
  return { videoDuration, audioDuration };
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

// ── Caption box contrast/opacity/position (added 2026-10-01) ────────────────
//
// WHY: captions_present (below, in the vision section) asks a model "is
// there legible, changing caption text in this frame" — which a model
// reading pixels directly answers correctly even when a HUMAN reading a
// phone screen cannot, because a low-contrast or crowded-position caption
// blends into a busy background in a way a model's pixel-level read doesn't
// struggle with the way human foveal reading does. v7b_SPLICED.mp4
// (2026-09-30 — Heath: "I can't read it") scored captions_present 3/3
// while genuinely being hard to read. This rule replaces "does a model see
// text" with a direct pixel measurement of what actually determines human
// readability: contrast between the caption's text and its immediate
// background, whether that background is a flat opaque fill (not bleeding
// the underlying footage through it), and WHERE on screen it sits — see
// founder-video-production-standard.md §4/§7: top-aligned (Alignment 8,
// MarginV 175) sits in the part of a scrolling-document video that's
// busiest with body text; bottom-centre (Alignment 2, MarginV 1005) does
// not. Runs independently of vision-transport availability — it's pure
// ffmpeg/pixel math, same style as detectBars()/frameLumaSpread() above.
//
// CALIBRATED against the real fixtures (scripts/regression-video-caption-box.js):
// v7b_SPLICED.mp4's top-aligned captions measure vertical centre 9-18% of
// frame height; v7c_SPLICED.mp4's bottom-centre captions measure 43-57%.
// CAPTION_BOX_MIN_CENTER_FRAC sits at 0.30, comfortably between the two
// clusters with margin on both sides.
//
// Contrast and opacity ARE measured too — median "text ink" luma minus
// median "box fill" luma for contrast; std-dev of the box-fill luma as the
// opacity signal (a translucent box bleeding the video through it reads as
// HIGH local variance; a flat opaque fill reads as near-zero) — because
// they are the direct, general-purpose defect this rule exists to catch.
// On these two specific fixtures both already measure opaque/high-contrast:
// the ffmpeg/libass build this pipeline renders with fills a BorderStyle=3
// box from OutlineColour, not BackColour's alpha, so neither fixture is
// actually translucent at the pixel level — the real defect in v7b was
// POSITION, not alpha, confirmed by direct measurement against both files
// and a synthetic ASS render. Both sub-metrics stay in this rule as a real
// regression guard for any future caption-burn path (different ffmpeg
// build, different tool) where BackColour's alpha DOES control the fill.
const CAPTION_BOX_DARK_LUMA = 50; // "box fill" candidate pixel, row-scan pass
const CAPTION_BOX_ROW_DARK_FRACTION = 0.35; // row counts as "box" at >=35% dark
const CAPTION_BOX_MIN_HEIGHT_FRAC = 0.015; // excludes 1-2px noise rows
const CAPTION_BOX_MAX_HEIGHT_FRAC = 0.10; // excludes CTA/hook cards (measured 0.12 on both fixtures)
const CAPTION_BOX_MIN_CENTER_FRAC = 0.30; // top-band cutoff — see header note
const CAPTION_TEXT_LUMA_MIN = 190; // "text ink" candidate pixel (bright caption glyphs)
const CAPTION_FILL_LUMA_MAX = 70; // "box fill" candidate pixel for contrast/opacity stats
const CAPTION_MIN_TEXT_CONTRAST = 100; // median text luma - median fill luma, out of 255
const CAPTION_MAX_FILL_STD = 35; // std-dev of box-fill luma — opacity/bleed-through signal
const CAPTION_BOX_MIN_PASS = 4; // same 4-of-5 tolerance as CAPTION_MIN_PASS above

// Full-resolution grayscale raw buffer for one frame — same ffmpeg shape as
// grayGridAt() above, but NOT forced to a fixed grid, because the
// contrast/opacity measurement needs native-resolution pixels to be
// meaningful (a downscaled grid would average text and box fill together).
async function grayFrameBuffer(localVideoPath, atSeconds, width, height) {
  const { stdout } = await execFileAsync(
    'ffmpeg',
    ['-v', 'error', '-ss', String(Math.max(0, atSeconds)), '-i', localVideoPath,
      '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'],
    { encoding: 'buffer', maxBuffer: 1 << 24 },
  );
  if (!stdout || stdout.length < width * height) {
    throw new Error(`ffmpeg returned ${stdout ? stdout.length : 0} bytes, expected ${width * height}`);
  }
  return stdout;
}

// Finds the tallest contiguous run of "mostly dark" rows sized like a
// single caption line/chunk (not a CTA/hook card, which is much taller) —
// a caption's opaque/near-opaque box reads as a horizontal band where a
// large fraction of pixels are near-black. Returns null if nothing in the
// caption-sized height range is found (no caption visible at this instant —
// not itself a failure, see call site).
function locateCaptionBox(buf, w, h) {
  const rows = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let dark = 0;
    let n = 0;
    for (let x = 0; x < w; x += 2) { if (buf[y * w + x] < CAPTION_BOX_DARK_LUMA) dark++; n++; }
    rows[y] = n ? dark / n : 0;
  }
  let bestStart = -1;
  let bestEnd = -1;
  let curStart = -1;
  const closeRun = (end) => {
    if (curStart === -1) return;
    const heightFrac = (end - curStart + 1) / h;
    if (heightFrac >= CAPTION_BOX_MIN_HEIGHT_FRAC && heightFrac <= CAPTION_BOX_MAX_HEIGHT_FRAC) {
      if (bestStart === -1 || (end - curStart) > (bestEnd - bestStart)) { bestStart = curStart; bestEnd = end; }
    }
    curStart = -1;
  };
  for (let y = 0; y < h; y++) {
    if (rows[y] >= CAPTION_BOX_ROW_DARK_FRACTION) {
      if (curStart === -1) curStart = y;
    } else {
      closeRun(y - 1);
    }
  }
  closeRun(h - 1);
  if (bestStart === -1) return null;
  return { top: bestStart, bottom: bestEnd };
}

// Within the located box: (a) contrast = median "text ink" luma minus
// median "box fill" luma; (b) opacity = std-dev of the box-fill luma
// (near-zero = flat opaque colour; high = the underlying footage is
// bleeding through a translucent fill).
function measureCaptionBoxReadability(buf, w, box) {
  const textVals = [];
  const fillVals = [];
  for (let y = box.top; y <= box.bottom; y++) {
    for (let x = 0; x < w; x += 2) {
      const v = buf[y * w + x];
      if (v >= CAPTION_TEXT_LUMA_MIN) textVals.push(v);
      else if (v <= CAPTION_FILL_LUMA_MAX) fillVals.push(v);
    }
  }
  const median = (arr) => {
    if (!arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  const textMedian = median(textVals);
  const fillMedian = median(fillVals);
  let fillStd = null;
  if (fillVals.length) {
    const mean = fillVals.reduce((a, b) => a + b, 0) / fillVals.length;
    fillStd = Math.sqrt(fillVals.reduce((s, v) => s + (v - mean) ** 2, 0) / fillVals.length);
  }
  const contrast = (textMedian != null && fillMedian != null) ? textMedian - fillMedian : null;
  return { textMedian, textN: textVals.length, fillMedian, fillN: fillVals.length, fillStd, contrast };
}

// ── End decay tail (added 2026-10-01) ────────────────────────────────────────
//
// founder-video-production-standard.md §6: "End of video needs a real decay
// tail (~0.33s); a cut from −34 dB to digital silence in one frame reads as
// truncation." Measured on v7c_SPLICED.mp4's real audio tail: level sits
// around -33dB at t=33.13s, decays steadily (not a cliff) to true digital
// silence (-120dB, the floor of 16-bit PCM) by t=33.43s — a 0.30s decay,
// matching the standard almost exactly. This rule re-derives that same
// measurement from the finished file's own audio, frame-by-frame (one
// "frame" = 1/30s, matching the standard's own unit), independent of
// whatever rendering approach produced it.
const END_DECAY_FRAME_S = 1 / 30;
const END_DECAY_LOUD_DB = -34; // the standard's own reference point
const END_DECAY_MIN_S = 0.15; // real margin below the ~0.33s target; still well above a single-frame (0.033s) cliff
const END_DECAY_SEARCH_WINDOW_S = 3.0; // how far back from the end to look for the last loud frame

async function decodeMonoPcm(localPath, sr) {
  const { stdout } = await execFileAsync('ffmpeg', [
    '-nostdin', '-v', 'error', '-i', localPath,
    '-ac', '1', '-ar', String(sr), '-f', 's16le', '-',
  ], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const n = Math.floor(stdout.length / 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = stdout.readInt16LE(i * 2);
  return samples;
}

function pcmRmsDb(samples, i, j) {
  const jj = Math.min(j, samples.length);
  const ii = Math.max(0, i);
  if (jj <= ii) return -120;
  let s = 0;
  for (let k = ii; k < jj; k++) s += samples[k] * samples[k];
  const r = Math.sqrt(s / (jj - ii));
  return r > 0 ? 20 * Math.log10(r / 32768.0) : -120;
}

/**
 * Measures how long the audio takes to decay from "still audible"
 * (>= END_DECAY_LOUD_DB) to the end of the file. A real fade/natural decay
 * spans multiple frames; an abrupt truncation has its last loud frame
 * immediately adjacent to the file's end.
 * @returns {{decaySeconds:number|null, lastLoudFrameT:number|null, finalFrameDb:number, totalDurationS:number}}
 */
async function measureEndDecayTail(localPath) {
  const SR = 8000;
  const samples = await decodeMonoPcm(localPath, SR);
  const totalDurationS = samples.length / SR;
  const F = Math.round(END_DECAY_FRAME_S * SR);
  const searchStart = Math.max(0, totalDurationS - END_DECAY_SEARCH_WINDOW_S);

  let lastLoudFrameT = null;
  for (let t = totalDurationS - END_DECAY_FRAME_S; t >= searchStart; t -= END_DECAY_FRAME_S) {
    const c = Math.round(t * SR);
    const level = pcmRmsDb(samples, c, c + F);
    if (level >= END_DECAY_LOUD_DB) { lastLoudFrameT = t; break; }
  }
  const finalFrameDb = pcmRmsDb(samples, samples.length - F, samples.length);
  const decaySeconds = lastLoudFrameT === null ? null : totalDurationS - lastLoudFrameT;
  return { decaySeconds, lastLoudFrameT, finalFrameDb, totalDurationS };
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

// Smaller ladder + tighter per-frame budget for calls that send MANY frames
// in one request (captions_present sends 10 — 5 pairs — since 2026-09-26).
// A caption bar is a few words of large bold text; it doesn't need
// VISION_FRAME_ATTEMPTS' full-detail sizes to stay legible. Budget: 10
// frames x 300,000 base64 chars = 3,000,000, leaving ~500,000 of
// MAX_VISION_REQUEST_BYTES headroom for the prompt + JSON overhead — found
// live 2026-09-26 when the default 900,000/frame budget produced a real
// "vision request too large (4,910,231 bytes, budget 3,500,000)" failure on
// dossie_trec_p8_disclosure.mp4's 10-frame captions_present call.
const VISION_FRAME_ATTEMPTS_MANY = [
  { width: 480, q: 7 },
  { width: 360, q: 8 },
  { width: 240, q: 10 },
];
const MAX_VISION_FRAME_BASE64_MANY = 300_000;

async function compressFrameForVision(localPngPath, opts = {}) {
  const attempts = opts.attempts || VISION_FRAME_ATTEMPTS;
  const budget = opts.maxBase64 || MAX_VISION_FRAME_BASE64;
  const outPath = `${localPngPath}.vision.jpg`;
  let lastErr = null;
  for (const { width, q } of attempts) {
    try {
      await execFileAsync('ffmpeg', [
        '-y', '-i', localPngPath,
        '-vf', `scale='min(${width},iw)':-2`,
        '-q:v', String(q),
        outPath,
      ]);
      const buf = await fs.promises.readFile(outPath);
      const base64 = buf.toString('base64');
      if (base64.length <= budget) {
        return { base64, mimeType: 'image/jpeg' };
      }
      lastErr = new Error(`compressed frame still ${base64.length} base64 chars at width=${width}/q=${q} (budget ${budget})`);
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

// HORIZONTAL-lane only. Vertical's "hook_visible_frame0"/"hook_cleared_by_3s"
// pair enforces the Reels-specific hook-then-clear formula (docs/SCROLL-
// STOPPING-VIDEO-PLAYBOOK.md §5a checks 1-2) — that formula assumes a title-
// card overlay that then clears, which is not how a desktop feature demo is
// built or how FB/LinkedIn native video is judged. What DOES matter for a
// 16:9 product demo, per the task this gate exists to satisfy, is that real,
// readable application UI is actually on screen partway through — not
// blurry, not cut off, not a dead/loading frame.
const LEGIBLE_UI_PROMPT = `This is a single frame sampled from partway through a desktop product-demo video (16:9, intended for Facebook/LinkedIn/Twitter).

Is real, readable application UI clearly visible in this frame — legible text, distinguishable buttons/fields/cards/data, not blurry, not cut off, not obscured by a loading state? A frame that is mostly empty white space, a spinner, or illegible/tiny text does NOT count.

Respond with JSON only, no markdown fences:
{"legible": true or false, "reason": "one sentence"}`;

// Rewritten 2026-09-26 (Cole relay — see file header for the p22 defect this
// closes). The discriminator is CHANGE, not appearance: a short, boxed,
// word-synced caption chunk (2-4 words, bold, top- or bottom-aligned) IS what
// synced captions look like in this pipeline's format — do not reject it for
// looking like a "title card". A real title card and a real caption can look
// nearly identical in a single frame; the only reliable tell is whether the
// text is the SAME 1 second later. Static across the pair = a card. Changed
// = a caption.
const CAPTIONS_PRESENT_PROMPT = `You are shown 5 PAIRS of frames (10 images total, in order: pair 1 frame A, pair 1 frame B, pair 2 frame A, pair 2 frame B, ...). Within each pair, frame A and frame B are about 1 second apart in the same video.

For EACH pair, answer two questions:
1. caption_present: is there a legible burned-in caption bar/box (any number of words, synced to speech) visible in frame A? A short 2-4 word bold boxed caption chunk counts as a caption — do NOT reject it for being short, bold, or boxed. Only reject if there is genuinely no on-screen text, or the only text is a logo/watermark/permanent UI chrome that never changes across the whole video.
2. text_changed: does the caption TEXT in frame B differ from the caption text in frame A? (Different words, or one has text and the other doesn't.) This is the real discriminator: a static title card shows IDENTICAL text a second later; a genuine synced caption has usually moved to the next word or phrase.

Respond with JSON only, no markdown fences:
{"pairs": [{"caption_present": true or false, "text_changed": true or false}, ... exactly 5 entries, one per pair, in order], "reason": "one sentence summary"}`;

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
 * @param {string[]} [opts.platforms] - the video_library row's real platforms
 *   array (preferred way to select vertical vs horizontal rules — see
 *   classifyOrientation()).
 * @param {'vertical'|'horizontal'|'vertical_long'} [opts.orientation] - explicit
 *   override, only when platforms isn't available. 'vertical_long' is the
 *   EXPLICIT-ONLY long 9:16 lane (see VERTICAL_LONG_RUNTIME_RANGE) — no
 *   platforms array maps to it.
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
        orientation: detail.orientation ?? null,
        caption_box_samples: detail.caption_box_samples ?? null,
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

  // 0. Orientation — which rule family this row is graded against. Fail
  // closed (one blocking rule, everything else skipped) rather than guess:
  // an ingestion caller must supply a real platforms array or an explicit
  // orientation. See classifyOrientation()'s header comment.
  let orientation;
  try {
    orientation = classifyOrientation(opts.orientation, opts.platforms);
    detail.orientation = orientation;
    addRule('orientation_determined', { pass: true, note: `${orientation} (${opts.orientation ? 'explicit' : `from platforms [${(opts.platforms || []).join(', ')}]`})` });
  } catch (err) {
    // Backward-compat: existing callers (regression fixtures, anything built
    // before 2026-09-17) that pass neither platforms nor orientation default
    // to 'vertical' — the gate's original and only behavior — so nothing
    // that already relied on this gate silently changes shape. A caller that
    // DOES pass a platforms array but gets a real classification error
    // (mixed or unrecognized platforms) fails closed for real: that's a
    // misconfigured row, not an absent one.
    if (opts.platforms === undefined && opts.orientation === undefined) {
      orientation = 'vertical';
      detail.orientation = orientation;
      addRule('orientation_determined', { pass: true, note: 'vertical (default — no platforms/orientation supplied, preserving pre-2026-09-17 behavior)' });
    } else {
      addRule('orientation_determined', { pass: false, note: err.message });
      return finalize();
    }
  }
  // Both vertical lanes are graded against the SAME frame rules (9:16,
  // full-bleed, top-aligned captions). Only the runtime window differs.
  const isVerticalLong = orientation === 'vertical_long';
  const isVertical = orientation === 'vertical' || isVerticalLong;

  // 1. Runtime.
  let duration = null;
  try {
    duration = await ffprobeDuration(localVideo);
    detail.duration_seconds = Math.round(duration * 10) / 10;
    if (isVerticalLong) {
      const pass = duration >= VERTICAL_LONG_RUNTIME_RANGE[0]
        && duration <= VERTICAL_LONG_HARD_MAX_RUNTIME_S;
      addRule('runtime_in_platform_range', {
        pass,
        note: pass
          ? `${detail.duration_seconds}s fits the long vertical window (${VERTICAL_LONG_RUNTIME_RANGE.join('-')}s — YouTube Shorts / Facebook Reels / LinkedIn)`
          : `${detail.duration_seconds}s is outside the long vertical window (${VERTICAL_LONG_RUNTIME_RANGE.join('-')}s, hard ceiling ${VERTICAL_LONG_HARD_MAX_RUNTIME_S}s = Facebook Reels' cap). ${duration < VERTICAL_LONG_RUNTIME_RANGE[0] ? 'Under the floor means CORE+OPTIONAL is barely longer than CORE — the script tagging, not the edit, is what needs fixing.' : 'Over the ceiling means Facebook Reels will refuse it.'}`,
      });
    } else if (isVertical) {
      const inTikTok = duration >= TIKTOK_RANGE[0] && duration <= TIKTOK_RANGE[1];
      const inIgLoop = duration >= IG_LOOP_RANGE[0] && duration <= IG_LOOP_RANGE[1];
      const pass = duration <= HARD_MAX_RUNTIME_S && (inTikTok || inIgLoop);
      addRule('runtime_in_platform_range', {
        pass,
        note: pass
          ? `${detail.duration_seconds}s fits ${inTikTok ? `TikTok narrative (${TIKTOK_RANGE.join('-')}s)` : `IG loop (${IG_LOOP_RANGE.join('-')}s)`}`
          : `${detail.duration_seconds}s fits neither TikTok's ${TIKTOK_RANGE.join('-')}s window nor IG's ${IG_LOOP_RANGE.join('-')}s loop window (hard ceiling ${HARD_MAX_RUNTIME_S}s)`,
      });
    } else {
      const pass = duration >= HORIZONTAL_RUNTIME_RANGE[0] && duration <= HORIZONTAL_HARD_MAX_RUNTIME_S;
      addRule('runtime_in_platform_range', {
        pass,
        note: pass
          ? `${detail.duration_seconds}s fits the horizontal feed-video window (${HORIZONTAL_RUNTIME_RANGE.join('-')}s typical, ${HORIZONTAL_HARD_MAX_RUNTIME_S}s hard ceiling)`
          : `${detail.duration_seconds}s is outside the horizontal feed-video window (${HORIZONTAL_RUNTIME_RANGE.join('-')}s typical, ${HORIZONTAL_HARD_MAX_RUNTIME_S}s hard ceiling)`,
      });
    }
  } catch (err) {
    addRule('runtime_in_platform_range', { pass: false, note: `ffprobe duration failed (fail-closed): ${err.message}` });
  }

  // 1b. Speed applied exactly once — founder-video-production-standard.md
  // §3: "Speed is applied in exactly ONE place... Twice caused an
  // 18-second A/V drift." This gate never sees the build's internal speed
  // stage, so it checks the one thing a double-application always leaves
  // behind in the FINISHED file: the video stream and audio stream no
  // longer agree on how long the render is. Calibrated against the three
  // known-good fixtures, whose video/audio streams differ by 0.07-0.10s
  // (container/keyframe rounding, not a defect) — AV_DURATION_DRIFT_MAX_S
  // sits at 0.75s, comfortably above that noise floor and light years below
  // the 18s real defect this exists to catch.
  try {
    const { videoDuration, audioDuration } = await ffprobeStreamDurations(localVideo);
    const driftS = Math.abs(videoDuration - audioDuration);
    const pass = driftS <= AV_DURATION_DRIFT_MAX_S;
    addRule('speed_applied_once', {
      pass,
      note: pass
        ? `video/audio stream durations agree within ${driftS.toFixed(2)}s (video ${videoDuration.toFixed(2)}s, audio ${audioDuration.toFixed(2)}s)`
        : `video stream (${videoDuration.toFixed(2)}s) and audio stream (${audioDuration.toFixed(2)}s) differ by ${driftS.toFixed(2)}s — exceeds ${AV_DURATION_DRIFT_MAX_S}s tolerance, the signature of a speed-change filter applied to one track but not the other (or twice to one of them)`,
    });
  } catch (err) {
    addRule('speed_applied_once', { pass: false, note: `stream-duration check failed (fail-closed): ${err.message}` });
  }

  // 1c. End decay tail — founder-video-production-standard.md §6: a real
  // decay (~0.33s), not a cliff from ~-34dB to digital silence in one
  // frame.
  try {
    const { decaySeconds, lastLoudFrameT, finalFrameDb, totalDurationS } = await measureEndDecayTail(localVideo);
    if (lastLoudFrameT === null) {
      addRule('end_decay_tail', {
        pass: true,
        note: `no frame at or above ${END_DECAY_LOUD_DB}dB found in the final ${END_DECAY_SEARCH_WINDOW_S}s — audio was already quiet well before the end, nothing to check a cliff against (final frame ${finalFrameDb.toFixed(1)}dB)`,
      });
    } else {
      const pass = decaySeconds >= END_DECAY_MIN_S;
      addRule('end_decay_tail', {
        pass,
        note: pass
          ? `${decaySeconds.toFixed(2)}s decay from ${END_DECAY_LOUD_DB}dB (last loud frame at ${lastLoudFrameT.toFixed(2)}s) to end (${totalDurationS.toFixed(2)}s, final frame ${finalFrameDb.toFixed(1)}dB) — real tail, not a cliff`
          : `only ${decaySeconds.toFixed(2)}s between the last loud frame (${lastLoudFrameT.toFixed(2)}s, ${END_DECAY_LOUD_DB}dB) and the end (${totalDurationS.toFixed(2)}s) — reads as a truncation, not a fade (min ${END_DECAY_MIN_S}s)`,
      });
    }
  } catch (err) {
    addRule('end_decay_tail', { pass: false, note: `end-decay check failed (fail-closed): ${err.message}` });
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
  let frameWidth = null;
  let frameHeight = null;
  try {
    const { width, height } = await ffprobeResolution(localVideo);
    frameWidth = width;
    frameHeight = height;
    detail.resolution = `${width}x${height}`;
    resolutionOk = true;
    addRule('resolution_readable', { pass: true, note: detail.resolution });

    const ratio = width / height;
    detail.aspect_ratio = Math.round(ratio * 1e4) / 1e4;
    if (isVertical) {
      const delta = Math.abs(ratio - TARGET_ASPECT_RATIO);
      const pass = delta <= ASPECT_RATIO_TOLERANCE;
      addRule('aspect_ratio_vertical_9x16', {
        pass,
        note: pass
          ? `${detail.resolution} (${detail.aspect_ratio}) is 9:16 full-bleed vertical`
          : `${detail.resolution} has aspect ratio ${detail.aspect_ratio}, not 9:16 (${Math.round(TARGET_ASPECT_RATIO * 1e4) / 1e4} ±${ASPECT_RATIO_TOLERANCE}). ${ratio > 1 ? 'This is a LANDSCAPE file — Facebook/Instagram/TikTok will letterbox it into a vertical Reel with black bars (the 2026-09-15 stage-checklist defect).' : 'Off-target vertical frame.'}`,
      });
    } else {
      const delta = Math.abs(ratio - TARGET_ASPECT_RATIO_HORIZONTAL);
      const pass = delta <= ASPECT_RATIO_TOLERANCE_HORIZONTAL;
      addRule('aspect_ratio_horizontal_16x9', {
        pass,
        note: pass
          ? `${detail.resolution} (${detail.aspect_ratio}) is 16:9 full-bleed horizontal`
          : `${detail.resolution} has aspect ratio ${detail.aspect_ratio}, not 16:9 (${Math.round(TARGET_ASPECT_RATIO_HORIZONTAL * 1e4) / 1e4} ±${ASPECT_RATIO_TOLERANCE_HORIZONTAL}). ${ratio < 1 ? 'This is a PORTRAIT file targeting facebook/twitter/linkedin, which expect the desktop 16:9 cut.' : 'Off-target horizontal frame.'}`,
      });
    }
  } catch (err) {
    addRule('resolution_readable', { pass: false, note: `ffprobe resolution failed (fail-closed): ${err.message}` });
    const aspectRuleName = isVertical ? 'aspect_ratio_vertical_9x16' : 'aspect_ratio_horizontal_16x9';
    addRule(aspectRuleName, { pass: false, note: `cannot verify aspect ratio without a readable resolution (fail-closed): ${err.message}` });
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

  // 4b. Caption box readability — measured contrast + opacity + on-screen
  // position, not a vision-model judgement (see the block comment above
  // locateCaptionBox() for the full rationale). Runs independently of
  // vision-transport availability. Vertical lane only — this pipeline does
  // not burn captions into the horizontal desktop cut (same assumption
  // captions_present below already makes).
  if (!isVertical) {
    addRule('captions_box_readable', { pass: true, blocking: false, note: 'skipped — horizontal lane does not burn captions into this pipeline\'s desktop cut' });
  } else if (!duration || !resolutionOk || !frameWidth || !frameHeight) {
    addRule('captions_box_readable', { pass: false, note: 'duration or resolution unknown — cannot sample caption frames (fail-closed)' });
  } else {
    try {
      const words = loadWordTimestampsSidecar(opts.videoPath);
      const { times, source } = pickCaptionSampleTimes(duration, words);
      const samples = [];
      for (const t of times) {
        const tClamped = Math.max(0.1, Math.min(duration - 0.1, t));
        // eslint-disable-next-line no-await-in-loop
        const buf = await grayFrameBuffer(localVideo, tClamped, frameWidth, frameHeight);
        const box = locateCaptionBox(buf, frameWidth, frameHeight);
        if (!box) { samples.push({ t: tClamped, box: null }); continue; }
        const centerFrac = ((box.top + box.bottom) / 2) / frameHeight;
        const r = measureCaptionBoxReadability(buf, frameWidth, box);
        samples.push({ t: tClamped, box, centerFrac, ...r });
      }
      const withBox = samples.filter((s) => s.box);
      if (withBox.length < 3) {
        addRule('captions_box_readable', {
          pass: false,
          note: `could not locate a caption box in enough samples (${withBox.length}/${samples.length}, sample source: ${source}) — cannot verify legibility (fail-closed)`,
        });
      } else {
        const okSamples = samples.filter((s) => s.box
          && s.centerFrac >= CAPTION_BOX_MIN_CENTER_FRAC
          && s.contrast != null && s.contrast >= CAPTION_MIN_TEXT_CONTRAST
          && s.fillStd != null && s.fillStd <= CAPTION_MAX_FILL_STD);
        const pass = okSamples.length >= CAPTION_BOX_MIN_PASS;
        const worstCenter = withBox.reduce((m, s) => Math.min(m, s.centerFrac), 1);
        const worstContrast = withBox.reduce((m, s) => (s.contrast != null ? Math.min(m, s.contrast) : m), Infinity);
        const worstFillStd = withBox.reduce((m, s) => (s.fillStd != null ? Math.max(m, s.fillStd) : m), 0);
        addRule('captions_box_readable', {
          pass,
          note: `${okSamples.length}/${samples.length} samples pass (sample source: ${source}) — worst vertical position ${(worstCenter * 100).toFixed(0)}% of frame height (min ${(CAPTION_BOX_MIN_CENTER_FRAC * 100).toFixed(0)}%), worst contrast ${worstContrast === Infinity ? 'n/a' : worstContrast.toFixed(0)} (min ${CAPTION_MIN_TEXT_CONTRAST}), worst box-fill std-dev ${worstFillStd.toFixed(1)} (max ${CAPTION_MAX_FILL_STD})${pass ? '' : ' — caption box sits too high on screen and/or has insufficient contrast/opacity to read on a phone'}`,
        });
        detail.caption_box_samples = samples.map((s) => ({
          t: Math.round(s.t * 100) / 100,
          box: s.box,
          centerFrac: s.centerFrac != null ? Math.round(s.centerFrac * 1000) / 1000 : null,
          contrast: s.contrast != null ? s.contrast : null,
          fillStd: s.fillStd != null ? Math.round(s.fillStd * 10) / 10 : null,
        }));
      }
    } catch (err) {
      addRule('captions_box_readable', { pass: false, note: `caption box check failed (fail-closed): ${err.message}` });
    }
  }

  // 5-7. Vision checks — only meaningful if we got a usable frame 0.
  // hook_visible_frame0/hook_cleared_by_3s enforce the Reels-specific hook-
  // then-clear formula (playbook §5a checks 1-2) and apply to the VERTICAL
  // lane only — a desktop 16:9 feature demo isn't built around a clearing
  // title-card overlay, and grading it against that formula is exactly the
  // "wrong ruleset for the shape" problem this section exists to fix.
  // Horizontal gets legible_ui_frame instead (defined below). Both lanes
  // still get opening_not_login_or_empty and captions_present — a bad
  // opening or a missing caption's a real defect in either shape — but
  // captions_present is advisory-only (non-blocking) on horizontal, since
  // this pipeline doesn't burn captions into the desktop cut today (unlike
  // the vertical cut, which is built caption-first).
  if (!frame0Path) {
    if (isVertical) {
      addRule('hook_visible_frame0', { pass: false, note: 'skipped — frame 0 could not be extracted, see real_motion_0_to_1_5s' });
      addRule('hook_cleared_by_3s', { pass: false, note: 'skipped — frame 0 could not be extracted' });
    } else {
      addRule('legible_ui_frame', { pass: false, note: 'skipped — frame 0 could not be extracted' });
    }
    addRule('opening_not_login_or_empty', { pass: false, note: 'skipped — frame 0 could not be extracted' });
    addRule('captions_present', { pass: false, blocking: isVertical, note: 'skipped — frame 0 could not be extracted' });
  } else if (!ANTHROPIC_KEY_USABLE && !CRON_SECRET) {
    const note = 'no usable ANTHROPIC_API_KEY and no CRON_SECRET — cannot run vision check via either transport (fail-closed)';
    if (isVertical) {
      addRule('hook_visible_frame0', { pass: false, note });
      addRule('hook_cleared_by_3s', { pass: false, note });
    } else {
      addRule('legible_ui_frame', { pass: false, note });
    }
    addRule('opening_not_login_or_empty', { pass: false, note });
    addRule('captions_present', { pass: false, blocking: isVertical, note });
  } else {
    let frame0Vision = null;
    try {
      frame0Vision = await compressFrameForVision(frame0Path);
    } catch (err) {
      const note = `vision check failed (fail-closed): ${err.message}`;
      if (isVertical) {
        addRule('hook_visible_frame0', { pass: false, note });
        addRule('hook_cleared_by_3s', { pass: false, note: 'skipped — frame 0 could not be prepared' });
      } else {
        addRule('legible_ui_frame', { pass: false, note: 'skipped — frame 0 could not be prepared' });
      }
    }

    if (isVertical) {
      try {
        if (!frame0Vision) throw new Error('frame 0 unavailable');
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
    } else {
      // Horizontal: legible UI partway through the video, in place of the
      // Reels hook-then-clear pair.
      try {
        const midT = duration ? Math.max(0.5, duration * 0.5) : 5;
        const midPath = path.join(tmpDir, `qgate-mid-${process.pid}-${Date.now()}.png`);
        cleanupFns.push(async () => fs.promises.unlink(midPath).catch(() => {}));
        await extractFrame(localVideo, midT, midPath);
        const midVision = await compressFrameForVision(midPath);
        const result = await callVisionModel([midVision], LEGIBLE_UI_PROMPT);
        addRule('legible_ui_frame', { pass: result.legible === true, note: result.reason || '' });
      } catch (err) {
        addRule('legible_ui_frame', { pass: false, note: `vision check failed (fail-closed): ${err.message}` });
      }
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

    // Captions present AND changing, sampled at known-safe speech times.
    // See file header + pickCaptionSampleTimes()/pickCaptionPairCompanion()
    // for the 2026-09-26 rewrite (Cole relay, p22 gate-reliability defect).
    try {
      if (!duration) throw new Error('duration unknown — cannot sample runtime');
      const words = loadWordTimestampsSidecar(opts.videoPath);
      const { times, source, windowStart, windowEnd } = pickCaptionSampleTimes(duration, words);

      const pairs = []; // { tA, tB|null }
      for (const t of times) {
        const tA = Math.max(0.1, Math.min(duration - 0.1, t));
        const companion = pickCaptionPairCompanion(tA, windowStart, windowEnd);
        const tB = companion === null ? null : Math.max(0.1, Math.min(duration - 0.1, companion));
        pairs.push({ tA, tB });
      }

      const images = [];
      for (let i = 0; i < pairs.length; i++) {
        const { tA, tB } = pairs[i];
        const fpA = path.join(tmpDir, `qgate-cap-${i}a-${process.pid}-${Date.now()}.png`);
        cleanupFns.push(async () => fs.promises.unlink(fpA).catch(() => {}));
        // eslint-disable-next-line no-await-in-loop
        await extractFrame(localVideo, tA, fpA);
        // eslint-disable-next-line no-await-in-loop
        images.push(await compressFrameForVision(fpA, { attempts: VISION_FRAME_ATTEMPTS_MANY, maxBase64: MAX_VISION_FRAME_BASE64_MANY }));

        // No safe companion time (a very short clip) — reuse frame A as
        // frame B so the model still gets a pair; text_changed will
        // correctly read false (same frame), which is the honest answer
        // when we couldn't actually sample 1s away.
        const bTime = tB === null ? tA : tB;
        const fpB = path.join(tmpDir, `qgate-cap-${i}b-${process.pid}-${Date.now()}.png`);
        cleanupFns.push(async () => fs.promises.unlink(fpB).catch(() => {}));
        // eslint-disable-next-line no-await-in-loop
        await extractFrame(localVideo, bTime, fpB);
        // eslint-disable-next-line no-await-in-loop
        images.push(await compressFrameForVision(fpB, { attempts: VISION_FRAME_ATTEMPTS_MANY, maxBase64: MAX_VISION_FRAME_BASE64_MANY }));
      }

      const result = await callVisionModel(images, CAPTIONS_PRESENT_PROMPT);
      const resultPairs = Array.isArray(result.pairs) ? result.pairs : [];
      const passCount = resultPairs.filter((p) => p && p.caption_present === true && p.text_changed === true).length;
      const presentCount = resultPairs.filter((p) => p && p.caption_present === true).length;
      addRule('captions_present', {
        pass: passCount >= CAPTION_MIN_PASS,
        blocking: isVertical,
        note: `${passCount}/5 pairs showed a legible, CHANGING caption (${presentCount}/5 had any legible caption) — sample source: ${source} — ${result.reason || ''}${isVertical ? '' : ' (advisory only on the horizontal lane — this pipeline does not burn captions into the desktop cut)'}`,
      });
    } catch (err) {
      addRule('captions_present', { pass: false, blocking: isVertical, note: `vision check failed (fail-closed): ${err.message}` });
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
  // Orientation-aware gating (2026-09-17), exported for
  // scripts/regression-video-quality-gate.js and any ingestion caller that
  // needs to classify a row before calling checkVideoQuality().
  classifyOrientation,
  VERTICAL_PLATFORMS,
  HORIZONTAL_PLATFORMS,
  TARGET_ASPECT_RATIO_HORIZONTAL,
  ASPECT_RATIO_TOLERANCE_HORIZONTAL,
  HORIZONTAL_RUNTIME_RANGE,
  HORIZONTAL_HARD_MAX_RUNTIME_S,
  // Measurement primitives, exported for the regression fixtures.
  analyzePersistentCoverage,
  frameLumaSpread,
  // Caption box contrast/opacity/position (2026-10-01), exported for
  // scripts/regression-video-caption-box.js.
  grayFrameBuffer,
  locateCaptionBox,
  measureCaptionBoxReadability,
  CAPTION_BOX_MIN_CENTER_FRAC,
  CAPTION_MIN_TEXT_CONTRAST,
  CAPTION_MAX_FILL_STD,
  CAPTION_BOX_MIN_PASS,
  // Speed-applied-once / end-decay-tail (2026-10-01), exported for
  // scripts/regression-video-structural-assertions.js.
  ffprobeStreamDurations,
  AV_DURATION_DRIFT_MAX_S,
  measureEndDecayTail,
  END_DECAY_LOUD_DB,
  END_DECAY_MIN_S,
  // Vision transport (2026-09-16), exported for
  // scripts/regression-video-quality-vision-transport.js.
  VIDEO_QUALITY_VISION_URL,
  MAX_VISION_REQUEST_BYTES,
  MAX_VISION_FRAME_BASE64,
  ANTHROPIC_KEY_USABLE,
  compressFrameForVision,
  callVisionModel,
};
