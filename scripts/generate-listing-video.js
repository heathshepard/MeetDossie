#!/usr/bin/env node
/**
 * scripts/generate-listing-video.js
 *
 * Reusable listing-video generator. Turns a folder of MLS photos + a small
 * JSON of listing facts (+ optional voiceover/music) into two finished
 * videos (9:16 vertical for Reels/TikTok, 1:1 square for feed):
 *
 *   1. NO separate title card. The video opens directly full-bleed on the
 *      single best real photo (Ken Burns already moving) with the hook
 *      line + eyebrow animated on TOP of it (slide-in + a short
 *      "type-on" reveal) — Heath's rule: "lead with the single best
 *      frame, not a title card on white." The opening ~1.5s is the whole
 *      game on Reels.
 *   2. A curated photo sequence with Ken Burns motion, VARIED transitions
 *      (dissolve / whip-pan slide / hard cut) instead of one constant
 *      crossfade, faster cutting in the first ~5s.
 *   3. A persistent lower-third (address), a spec-line pill, and (for
 *      listings that show a price) a price pill — all slide-in + fade,
 *      not static pop-ins.
 *   4. Closing card: unchanged brand system (sage/cream, KW + Heath
 *      Shepard, TREC-required brokerage line). See PRICE DISCLOSURE below.
 *   5. Real narration (ElevenLabs, neutral non-Dossie voice — see
 *      VOICEOVER below) synced to photo sections via character-level
 *      timestamps, with a licensed Pixabay music bed ducked underneath.
 *
 * ---------------------------------------------------------------------
 * WHY FFMPEG KEN BURNS, NOT GENERATIVE AI VIDEO (fal.ai/Kling) — READ
 * BEFORE "UPGRADING" THIS TO AI B-ROLL.
 * ---------------------------------------------------------------------
 * We have fal.ai + Kling 2.5 wired (FAL_KEY, POST /api/generate-broll,
 * ~$0.84/5s) and it would be the obvious thing to reach for. Don't.
 * Generative video models warp architecture between frames — straight
 * lines bend, windows/cabinets/countertops morph. That's fine for an
 * abstract marketing b-roll clip of a laptop. It is NOT fine for a real
 * listing: the video has to depict the ACTUAL property, and an obviously
 * "off" ceiling line or warped cabinet is (a) instantly obvious to a
 * local buyer and (b) a misrepresentation risk on a TREC-regulated ad.
 * Ken Burns (slow zoompan on the real, unaltered photo) costs nothing,
 * never fabricates anything the seller didn't actually have, and is what
 * real real-estate reels actually use. If someone is reading this to
 * decide whether to swap in Kling — don't. Ask Heath first.
 *
 * ---------------------------------------------------------------------
 * MUSIC
 * ---------------------------------------------------------------------
 * Licensed tracks live in Media/Music/ (Pixabay Content License — free
 * commercial use, no attribution — see Media/Music/LICENSE.md for the
 * per-track source). Pass one with --music <path>; it's ducked under the
 * voiceover automatically (low under narration, swells under the silent
 * closing card). Pixabay's CDN throttles repeat automated downloads hard
 * after ~2 in a session — see LICENSE.md if you need more variety.
 *
 * ---------------------------------------------------------------------
 * VOICEOVER
 * ---------------------------------------------------------------------
 * Generate with scripts/gen-listing-voiceover.py (ElevenLabs, neutral
 * voice — Adam by default). NEVER use Bill/Luna here — those are Dossie's
 * product personas and using them on Heath's personal listing videos
 * conflates two separate brands. If Heath clones his own voice, point
 * that script's --voice-id at the clone; nothing else changes.
 * Pass --voiceover <mp3> --voiceover-timing <json>. The listing JSON's
 * `voice_marker` (a word that appears in the script) + `intro_photo_count`
 * tell this script which photo should be on screen when that word is
 * spoken (e.g. the kitchen photo lands under the word "kitchen").
 * If no voiceover is passed, the video renders with just music (or
 * silent, matching the old behavior) — no voiceover is not an error.
 *
 * ---------------------------------------------------------------------
 * PRICE DISCLOSURE
 * ---------------------------------------------------------------------
 * Heath's standing rule: NEVER show or state a sold price on just-sold
 * content. Set listing.show_price=false (or omit listing.price) for any
 * "Just Sold" listing — the closing card AND the mid-video price pill
 * both drop the price line entirely. The voiceover scripts must also
 * never say a sold price (checked by hand — see the .txt scripts).
 *
 * Usage:
 *   node scripts/generate-listing-video.js --listing path/to/listing.json \
 *     --photos-dir path/to/photo/folder --out-dir path/to/output \
 *     [--voiceover path.mp3] [--voiceover-timing path.json] \
 *     [--music path.mp3] [--aspect vertical|square|both]
 *
 * Listing JSON schema — see listing-video-configs/*.json for the three
 * worked examples (Fawndale, Wild Cherry, Nopalito). New fields beyond
 * the original schema: intro_photo_count, voice_marker, voiceover_mp3,
 * voiceover_timing, music (all optional; CLI flags override the JSON).
 *
 * Requirements: ffmpeg/ffprobe on PATH (or FFMPEG/FFPROBE env vars),
 * Playwright (already a repo devDependency) for card/overlay rendering.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const minimist = require("minimist");

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";
const FONTS_DIR = path.join(__dirname, "..", "public", "fonts");
const REPO_ROOT = path.join(__dirname, "..");

function fontDataUri(filename) {
  const buf = fs.readFileSync(path.join(FONTS_DIR, filename));
  return `data:font/ttf;base64,${buf.toString("base64")}`;
}
const FONT_CORMORANT_SEMIBOLD = fontDataUri("CormorantGaramond-SemiBold.ttf");
const FONT_JAKARTA_BOLD = fontDataUri("PlusJakartaSans-Bold.ttf");
const FONT_JAKARTA_REGULAR = fontDataUri("PlusJakartaSans-Regular.ttf");

// ─── Brand (matches the Canva just-listed card system) ────────────────
const SAGE = "#3d6742";
const CREAM = "#FBF6F0";
const CREAM_DIM = "#F5E6E0";
const GOLD = "#C9A96E";
const BLUSH_DEEP = "#D4A0A0";

// ─── Aspect ratios ──────────────────────────────────────────────────
const ASPECTS = {
  vertical: { w: 1080, h: 1920, suffix: "vertical" },
  square: { w: 1080, h: 1080, suffix: "square" },
};

// ─── Timing ─────────────────────────────────────────────────────────
const FPS = 30;
const T_CLOSING = 4.5; // closing card
const FAST_WINDOW_SEC = 5.0; // "faster pacing in the first 5 seconds" — Heath's ask
const FAST_PHOTO_MAX_DUR = 1.7;
const PHOTO_MIN_DUR = 2.2;
const PHOTO_MAX_DUR = 3.4;
const NO_VOICE_TARGET_MIN = 25; // fallback pacing when there's no voiceover driving length
const NO_VOICE_TARGET_MAX = 38;
const HOOK_REVEAL_DUR = 0.55; // typewriter-style reveal of the headline
const HOOK_HOLD_DUR = 2.1; // how long the hook stays fully visible before fading
const HOOK_FADE_DUR = 0.45;
const PILL_SLIDE_DUR = 0.32; // slide-in duration for lower-third / spec / price pills
const VOICE_LEAD_IN = 0.25; // small pause before narration starts
const OUTRO_PAD_AFTER_VOICE = 0.9; // breathing room between last VO word and closing card

// ─── Ken Burns direction presets ────────────────────────────────────
const KEN_BURNS_PRESETS = ["in-center", "in-pan-right", "in-pan-left", "in-pan-down", "in-pan-up"];

function kenBurnsExpr(direction, framesTotal) {
  const zoom = "min(zoom+0.0018,1.14)";
  const last = Math.max(1, framesTotal - 1);
  switch (direction) {
    case "in-pan-right":
      return { z: zoom, x: `(iw-iw/zoom)*(on/${last})`, y: "ih/2-(ih/zoom/2)" };
    case "in-pan-left":
      return { z: zoom, x: `(iw-iw/zoom)*(1-on/${last})`, y: "ih/2-(ih/zoom/2)" };
    case "in-pan-down":
      return { z: zoom, x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*(on/${last})` };
    case "in-pan-up":
      return { z: zoom, x: "iw/2-(iw/zoom/2)", y: `(ih-ih/zoom)*(1-on/${last})` };
    case "in-center":
    default:
      return { z: zoom, x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  }
}

// ─── Transition plan — varied instead of one constant crossfade.
// "cut" = near-instant hard cut (interior reveals); "whip" = fast
// directional slide (energetic, reads like a whip-pan); "fade" = classic
// dissolve (used sparingly, for the calmer beats). ─────────────────────
const TRANSITION_PLAN = [
  { type: "cut", ffmpeg: "fade", dur: 0.10 },
  { type: "whip", ffmpeg: "slideleft", dur: 0.22 },
  { type: "fade", ffmpeg: "fade", dur: 0.45 },
  { type: "whip", ffmpeg: "slideright", dur: 0.22 },
  { type: "cut", ffmpeg: "fade", dur: 0.10 },
  { type: "whip", ffmpeg: "wiperight", dur: 0.26 },
];
function pickTransition(i) {
  return TRANSITION_PLAN[i % TRANSITION_PLAN.length];
}

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : "";
    throw new Error(`Command failed: ${cmd} ${args.join(" ")}\n${stderr}`);
  }
}

function ffprobeDuration(file) {
  const out = run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file]);
  return parseFloat(out.trim());
}

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ─── Card / overlay HTML ────────────────────────────────────────────

function closingCardHtml({ w, h, showPrice, price, addressLine1, addressLine2, agentName, brokerage, phone }) {
  const priceBlock = showPrice && price
    ? `<div class="price">${escapeHtml(price)}</div><div class="rule"></div>`
    : `<div class="rule top-rule"></div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Cormorant'; src:url('${FONT_CORMORANT_SEMIBOLD}'); font-weight:600; }
  @font-face { font-family:'Jakarta'; src:url('${FONT_JAKARTA_BOLD}'); font-weight:700; }
  @font-face { font-family:'JakartaReg'; src:url('${FONT_JAKARTA_REGULAR}'); font-weight:400; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; background:${SAGE}; overflow:hidden; }
  .wrap { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:0 9%; }
  .price { font-family:'Cormorant',serif; font-weight:600; color:${CREAM}; font-size:${Math.round(w * 0.13)}px; line-height:1; margin-bottom:${Math.round(h * 0.025)}px; }
  .rule { width:${Math.round(w * 0.12)}px; height:2px; background:${GOLD}; margin-bottom:${Math.round(h * 0.03)}px; }
  .top-rule { margin-top:0; }
  .address1 { font-family:'Jakarta',sans-serif; font-weight:700; color:${CREAM}; font-size:${Math.round(w * 0.05)}px; letter-spacing:0.02em; }
  .address2 { font-family:'JakartaReg',sans-serif; font-weight:400; color:${CREAM_DIM}; font-size:${Math.round(w * 0.032)}px; margin-top:${Math.round(h * 0.008)}px; margin-bottom:${Math.round(h * 0.045)}px; }
  .agent { font-family:'Jakarta',sans-serif; font-weight:700; color:${BLUSH_DEEP}; font-size:${Math.round(w * 0.034)}px; letter-spacing:0.02em; }
  .brokerage { font-family:'JakartaReg',sans-serif; font-weight:400; color:${CREAM_DIM}; font-size:${Math.round(w * 0.028)}px; margin-top:${Math.round(h * 0.006)}px; }
  .phone { font-family:'JakartaReg',sans-serif; font-weight:400; color:${CREAM_DIM}; font-size:${Math.round(w * 0.028)}px; margin-top:${Math.round(h * 0.004)}px; }
  .kw-badge { margin-top:${Math.round(h * 0.03)}px; font-family:'Jakarta',sans-serif; font-weight:700; color:${GOLD}; font-size:${Math.round(w * 0.024)}px; letter-spacing:0.12em; text-transform:uppercase; }
  </style></head><body>
  <div class="wrap">
    ${priceBlock}
    <div class="address1">${escapeHtml(addressLine1)}</div>
    <div class="address2">${escapeHtml(addressLine2)}</div>
    <div class="agent">${escapeHtml(agentName)}</div>
    <div class="brokerage">${escapeHtml(brokerage)}</div>
    <div class="phone">${escapeHtml(phone)}</div>
    <div class="kw-badge">Keller Williams</div>
  </div>
  </body></html>`;
}

// Hook overlay (eyebrow + rule + headline + address) — rendered as a
// transparent PNG at a given reveal percentage (0-100) for the typewriter
// effect, via clip-path on the headline only (eyebrow/address are simple
// fade/slide handled in ffmpeg, not re-rendered per frame).
function hookOverlayHtml({ w, h, eyebrow, headline, addressLine, revealPct }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Cormorant'; src:url('${FONT_CORMORANT_SEMIBOLD}'); font-weight:600; }
  @font-face { font-family:'Jakarta'; src:url('${FONT_JAKARTA_BOLD}'); font-weight:700; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; background:transparent; overflow:hidden; }
  .wrap { position:absolute; left:0; right:0; top:${Math.round(h * 0.30)}px; display:flex; flex-direction:column; align-items:center; text-align:center; padding:0 8%; }
  .scrim { position:absolute; left:0; right:0; top:${Math.round(h * 0.20)}px; height:${Math.round(h * 0.40)}px; background:linear-gradient(180deg, rgba(10,15,10,0) 0%, rgba(10,15,10,0.42) 35%, rgba(10,15,10,0.42) 65%, rgba(10,15,10,0) 100%); }
  .eyebrow { font-family:'Jakarta',sans-serif; font-weight:700; letter-spacing:0.35em; text-transform:uppercase; color:${GOLD}; font-size:${Math.round(w * 0.032)}px; margin-bottom:${Math.round(h * 0.02)}px; text-shadow:0 2px 10px rgba(0,0,0,0.55); }
  .headline-wrap { overflow:hidden; }
  #headline { font-family:'Cormorant',serif; font-weight:600; color:${CREAM}; line-height:1.12; max-width:100%; font-size:${Math.round(w * 0.108)}px; white-space:pre-line; text-shadow:0 3px 16px rgba(0,0,0,0.6); clip-path: inset(0 ${100 - revealPct}% 0 0); }
  .address { font-family:'Jakarta',sans-serif; font-weight:700; color:${CREAM_DIM}; font-size:${Math.round(w * 0.028)}px; letter-spacing:0.04em; margin-top:${Math.round(h * 0.022)}px; text-transform:uppercase; text-shadow:0 2px 8px rgba(0,0,0,0.55); }
  </style></head><body>
  <div class="scrim"></div>
  <div class="wrap">
    <div class="eyebrow">${escapeHtml(eyebrow)}</div>
    <div class="headline-wrap"><div id="headline">${escapeHtml(headline)}</div></div>
    <div class="address">${escapeHtml(addressLine)}</div>
  </div>
  </body></html>`;
}

function lowerThirdHtml({ w, h, addressLine }) {
  const padX = Math.round(w * 0.06);
  const bottomY = Math.round(h * 0.06);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Jakarta'; src:url('${FONT_JAKARTA_BOLD}'); font-weight:700; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; background:transparent; overflow:hidden; }
  .pill { position:absolute; left:${padX}px; bottom:${bottomY}px; display:inline-block; padding:${Math.round(h * 0.014)}px ${Math.round(w * 0.035)}px; background:rgba(26,26,46,0.55); border-radius:999px; font-family:'Jakarta',sans-serif; font-weight:700; color:${CREAM}; font-size:${Math.round(w * 0.028)}px; letter-spacing:0.02em; }
  </style></head><body>
  <div class="pill">${escapeHtml(addressLine)}</div>
  </body></html>`;
}

function pillHtml({ w, h, text, bg, topFrac = 0.5 }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
  @font-face { font-family:'Jakarta'; src:url('${FONT_JAKARTA_BOLD}'); font-weight:700; }
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body { width:${w}px; height:${h}px; background:transparent; overflow:hidden; }
  .bar { position:absolute; left:50%; top:${Math.round(h * topFrac)}px; transform:translate(-50%,-50%); padding:${Math.round(h * 0.016)}px ${Math.round(w * 0.06)}px; background:${bg}; border-radius:${Math.round(h * 0.008)}px; font-family:'Jakarta',sans-serif; font-weight:700; color:${CREAM}; font-size:${Math.round(w * 0.036)}px; letter-spacing:0.03em; white-space:nowrap; text-align:center; }
  </style></head><body>
  <div class="bar">${escapeHtml(text)}</div>
  </body></html>`;
}

async function renderHtmlToPng({ html, w, h, outPng, transparent = false, autoFitSelector = null }) {
  const { chromium } = require("playwright");
  const MAX_ATTEMPTS = 5;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let browser;
    try {
      browser = await chromium.launch({
        args: [
          "--no-sandbox",
          "--disable-dev-shm-usage",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--use-gl=swiftshader",
          "--headless=new",
        ],
      });
      const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      if (autoFitSelector) {
        await page.evaluate(({ sel, maxW, maxH }) => {
          const el = document.querySelector(sel);
          if (!el) return;
          let size = parseFloat(getComputedStyle(el).fontSize);
          for (let i = 0; i < 30; i++) {
            const rect = el.getBoundingClientRect();
            if (rect.width <= maxW && rect.height <= maxH) break;
            size -= 4;
            el.style.fontSize = size + "px";
          }
        }, { sel: autoFitSelector, maxW: w * 0.92, maxH: h * 0.42 });
      }
      await page.screenshot({ path: outPng, omitBackground: transparent, timeout: 15000 });
      await browser.close();
      return;
    } catch (e) {
      lastErr = e;
      if (browser) {
        try { await browser.close(); } catch (_) { /* ignore */ }
      }
      console.warn(`[listing-video] card render attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message}`);
    }
  }
  throw lastErr;
}

// ─── ffmpeg segment builders ────────────────────────────────────────

function buildPhotoSegment({ photoPath, w, h, durationSec, direction, outMp4 }) {
  const frames = Math.round(durationSec * FPS);
  const { z, x, y } = kenBurnsExpr(direction, frames);
  const vf = [
    `scale=w=${w}:h=${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}`,
    `setsar=1`,
    `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${w}x${h}:fps=${FPS}`,
    `format=yuv420p`,
  ].join(",");
  run(FFMPEG, [
    "-y", "-loop", "1", "-i", photoPath,
    "-vf", vf,
    "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-an", outMp4,
  ]);
}

function buildStaticCardClip({ pngPath, w, h, durationSec, outMp4 }) {
  run(FFMPEG, [
    "-y", "-loop", "1", "-i", pngPath,
    "-vf", `scale=${w}:${h},format=yuv420p`,
    "-t", String(durationSec),
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-an", outMp4,
  ]);
}

// ─── Varied-transition chain — each junction gets its own ffmpeg xfade
// transition name + duration (see TRANSITION_PLAN). Returns timeline[i]
// = {start,end} of each source clip's position in the merged video. ────
function transitionChain({ clips, durations, outMp4 }) {
  if (clips.length === 1) {
    fs.copyFileSync(clips[0], outMp4);
    return { outMp4, timeline: [{ start: 0, end: durations[0] }] };
  }
  const inputs = [];
  clips.forEach((c) => inputs.push("-i", c));

  const junctions = [];
  for (let i = 0; i < clips.length - 1; i++) junctions.push(pickTransition(i));

  const timeline = [];
  let runningEnd = 0;
  for (let i = 0; i < clips.length; i++) {
    const overlapBefore = i === 0 ? 0 : junctions[i - 1].dur;
    const start = i === 0 ? 0 : runningEnd - overlapBefore;
    const end = start + durations[i];
    timeline.push({ start, end });
    runningEnd = end;
  }

  let filter = "";
  let prevLabel = "0:v";
  let offsetAcc = durations[0];
  for (let i = 1; i < clips.length; i++) {
    const j = junctions[i - 1];
    const outLabel = i === clips.length - 1 ? "vout" : `x${i}`;
    filter += `[${prevLabel}][${i}:v]xfade=transition=${j.ffmpeg}:duration=${j.dur}:offset=${(offsetAcc - j.dur).toFixed(3)}[${outLabel}];`;
    offsetAcc += durations[i] - j.dur;
    prevLabel = outLabel;
  }
  filter = filter.replace(/;$/, "");

  run(FFMPEG, [
    "-y", ...inputs,
    "-filter_complex", filter,
    "-map", "[vout]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    outMp4,
  ]);

  return { outMp4, timeline };
}

// ─── Duration allocation ────────────────────────────────────────────
// Photos before the voice-marker word ("intro" group) and photos from the
// marker onward ("main" group) each get a target total span; durations
// within a group are split evenly then clamped so nothing inside the
// first FAST_WINDOW_SEC runs long (Heath's "faster pacing first 5s" ask).
function allocateGroupDurations({ count, targetTotal, junctionDurs, startOffset }) {
  const overlap = junctionDurs.reduce((a, b) => a + b, 0);
  const needed = targetTotal + overlap;
  let per = needed / count;
  per = Math.max(1.0, Math.min(PHOTO_MAX_DUR, per));
  const durations = Array.from({ length: count }, () => per);

  // Clamp anything whose clip falls (even partially) inside the fast
  // window, redistributing saved time to later same-group clips.
  let t = startOffset;
  let savedTime = 0;
  for (let i = 0; i < durations.length; i++) {
    const clipStart = i === 0 ? t : t - junctionDurs[i - 1];
    if (clipStart < FAST_WINDOW_SEC && durations[i] > FAST_PHOTO_MAX_DUR) {
      savedTime += durations[i] - FAST_PHOTO_MAX_DUR;
      durations[i] = FAST_PHOTO_MAX_DUR;
    }
    t = clipStart + durations[i];
  }
  if (savedTime > 0) {
    const laterIdx = durations.map((_, i) => i).filter((i) => {
      const clipStart = i === 0 ? startOffset : null; // recomputed below
      return true;
    });
    // Spread saved time across clips NOT clamped (simple even add-back).
    const eligible = [];
    let tt = startOffset;
    for (let i = 0; i < durations.length; i++) {
      const clipStart = i === 0 ? tt : tt - junctionDurs[i - 1];
      if (!(clipStart < FAST_WINDOW_SEC)) eligible.push(i);
      tt = clipStart + durations[i];
    }
    if (eligible.length > 0) {
      const add = savedTime / eligible.length;
      eligible.forEach((i) => { durations[i] = Math.min(PHOTO_MAX_DUR + 1.0, durations[i] + add); });
    }
  }
  return durations;
}

// ─── Voiceover timing helpers ───────────────────────────────────────
function loadVoiceTiming(timingPath) {
  const data = JSON.parse(fs.readFileSync(timingPath, "utf8"));
  return data;
}

function markerTime(timing, marker) {
  if (!marker) return null;
  const idx = timing.text.toLowerCase().indexOf(marker.toLowerCase());
  if (idx < 0) {
    console.warn(`[listing-video] voice_marker "${marker}" not found in script text — falling back to 35% mark.`);
    return timing.duration * 0.35;
  }
  return timing.char_start[idx];
}

// ─── Audio mix: voiceover (if any) + music (ducked), or fallback to
// silence/music-only. Returns the audio filter output label name "aout"
// and the list of extra ffmpeg -i args the caller must add BEFORE this
// filter is used (kept simple: caller always adds inputs in a fixed
// order — see overlayAndFinalize). ───────────────────────────────────
function buildAudioFilter({ hasVoice, voiceLabel, musicLabel, totalDuration, voiceEnd }) {
  if (hasVoice && musicLabel) {
    const duckEnd = voiceEnd.toFixed(2);
    const musicChain =
      `[${musicLabel}]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,` +
      `volume=0.55,` +
      `volume=enable='lt(t,${duckEnd})':volume=0.13,` +
      `volume=enable='gte(t,${duckEnd})':volume=0.42,` +
      `afade=t=in:st=0:d=0.6,afade=t=out:st=${(totalDuration - 1.2).toFixed(2)}:d=1.2[music]`;
    const voiceChain = `[${voiceLabel}]adelay=${Math.round(VOICE_LEAD_IN * 1000)}|${Math.round(VOICE_LEAD_IN * 1000)},apad=whole_dur=${totalDuration.toFixed(3)}[voice]`;
    const mix = `[voice][music]amix=inputs=2:duration=first:normalize=0[aout]`;
    return `${musicChain};${voiceChain};${mix}`;
  }
  if (hasVoice && !musicLabel) {
    return `[${voiceLabel}]adelay=${Math.round(VOICE_LEAD_IN * 1000)}|${Math.round(VOICE_LEAD_IN * 1000)},apad=whole_dur=${totalDuration.toFixed(3)}[aout]`;
  }
  if (!hasVoice && musicLabel) {
    return `[${musicLabel}]atrim=0:${totalDuration.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.3,afade=t=in:st=0:d=0.6,afade=t=out:st=${(totalDuration - 1.2).toFixed(2)}:d=1.2[aout]`;
  }
  return null; // caller falls back to anullsrc
}

// ─── Main render for one aspect ─────────────────────────────────────
async function renderAspect({ listing, photosDir, aspectKey, outDir, workDir, voiceoverPath, voiceTiming, musicPath }) {
  const { w, h } = ASPECTS[aspectKey];
  const addressLine = `${listing.address_line1}${listing.address_line2 ? ", " + listing.address_line2 : ""}`;
  const introCount = Math.max(1, listing.intro_photo_count || 1);

  const hasVoice = !!(voiceoverPath && voiceTiming);
  const voiceDuration = hasVoice ? voiceTiming.duration : null;
  const markerT = hasVoice ? markerTime(voiceTiming, listing.voice_marker) : null;

  const bodyTotal = hasVoice
    ? voiceDuration + VOICE_LEAD_IN + OUTRO_PAD_AFTER_VOICE
    : (NO_VOICE_TARGET_MIN + NO_VOICE_TARGET_MAX) / 2 - T_CLOSING;

  // ── Junction transitions for the FULL chain (photos + closing card) ──
  const totalClips = listing.photo_order.length + 1; // + closing card
  const allJunctions = [];
  for (let i = 0; i < totalClips - 1; i++) allJunctions.push(pickTransition(i));
  const photoJunctionDurs = allJunctions.slice(0, listing.photo_order.length - 1).map((j) => j.dur);

  // Natural, EVEN pacing across every photo first (fast-window clamp still
  // applies near t=0) — this is what "the sequence would look like" before
  // we worry about the marker word at all.
  const photoDurations = allocateGroupDurations({
    count: listing.photo_order.length,
    targetTotal: bodyTotal,
    junctionDurs: photoJunctionDurs,
    startOffset: 0,
  });

  // ── Sync the marker photo to the marker word ──
  // Rather than forcing pacing to hit an exact time (which fights the
  // fast-open clamp when the marker lands late, e.g. "kitchen" at 13s in),
  // find where markerT actually falls in the NATURAL pacing above, then
  // move the marker photo (configured as the first photo of the "main"
  // group, i.e. index `introCount` in the original curated order) to that
  // slot. Sync stays accurate; pacing stays natural and fast-opening.
  let order = listing.photo_order;
  if (hasVoice && markerT != null && introCount < order.length) {
    let cum = 0;
    let syncIdx = order.length - 1;
    for (let i = 0; i < photoDurations.length; i++) {
      const overlapBefore = i === 0 ? 0 : photoJunctionDurs[i - 1];
      const start = cum - overlapBefore;
      if (markerT <= start + photoDurations[i] || i === photoDurations.length - 1) { syncIdx = i; break; }
      cum = start + photoDurations[i];
    }
    if (syncIdx !== introCount) {
      const reordered = order.slice();
      const [markerPhoto] = reordered.splice(introCount, 1);
      reordered.splice(syncIdx, 0, markerPhoto);
      order = reordered;
      console.log(`[listing-video] synced voice_marker "${listing.voice_marker}" (t=${markerT.toFixed(1)}s) to photo slot ${syncIdx} (was ${introCount})`);
    }
  }

  // ── 1. Photo segments (Ken Burns), hero photo first — NO title card ──
  const photoClips = [];
  order.forEach((idx, i) => {
    const n = String(idx).padStart(2, "0");
    const photoPath = path.join(photosDir, `${listing.photo_prefix}${n}.jpg`);
    if (!fs.existsSync(photoPath)) throw new Error(`Missing photo: ${photoPath}`);
    const direction = KEN_BURNS_PRESETS[i % KEN_BURNS_PRESETS.length];
    const outMp4 = path.join(workDir, `photo-${aspectKey}-${i}.mp4`);
    buildPhotoSegment({ photoPath, w, h, durationSec: photoDurations[i], direction, outMp4 });
    photoClips.push(outMp4);
  });

  // ── 2. Closing card ──
  const closingPng = path.join(workDir, `closing-${aspectKey}.png`);
  await renderHtmlToPng({
    html: closingCardHtml({
      w, h,
      showPrice: listing.show_price !== false && !!listing.price,
      price: listing.price,
      addressLine1: listing.address_line1,
      addressLine2: listing.address_line2,
      agentName: listing.agent.name,
      brokerage: listing.agent.brokerage,
      phone: listing.agent.phone,
    }),
    w, h, outPng: closingPng,
  });
  const closingMp4 = path.join(workDir, `closing-${aspectKey}.mp4`);
  buildStaticCardClip({ pngPath: closingPng, w, h, durationSec: T_CLOSING, outMp4: closingMp4 });

  // ── 3. Chain everything: photos + closing, varied transitions ──
  const allClips = [...photoClips, closingMp4];
  const allDurations = [...photoDurations, T_CLOSING];
  const mergedMp4 = path.join(workDir, `merged-${aspectKey}.mp4`);
  const { timeline } = transitionChain({ clips: allClips, durations: allDurations, outMp4: mergedMp4 });

  const heroWindow = timeline[0];
  const lastPhotoIdx = order.length - 1;
  const lowerThirdWindow = [timeline[0].start + 0.15, timeline[lastPhotoIdx].end - 0.15];
  const photoSpan = lowerThirdWindow[1] - lowerThirdWindow[0];
  const specStart = lowerThirdWindow[0] + photoSpan * 0.30;
  const priceStart = lowerThirdWindow[0] + photoSpan * 0.72;

  // ── 4. Overlay PNGs ──
  const lowerThirdPng = path.join(workDir, `lower-third-${aspectKey}.png`);
  await renderHtmlToPng({ html: lowerThirdHtml({ w, h, addressLine }), w, h, outPng: lowerThirdPng, transparent: true });

  const SPEC_TOP_FRAC = 0.44;
  const PRICE_TOP_FRAC = 0.58;
  const specPng = path.join(workDir, `spec-${aspectKey}.png`);
  await renderHtmlToPng({ html: pillHtml({ w, h, text: listing.specs, bg: "rgba(61,103,66,0.88)", topFrac: SPEC_TOP_FRAC }), w, h, outPng: specPng, transparent: true });

  const showPricePill = listing.show_price !== false && !!listing.price;
  let pricePng = null;
  if (showPricePill) {
    pricePng = path.join(workDir, `price-${aspectKey}.png`);
    await renderHtmlToPng({ html: pillHtml({ w, h, text: listing.price, bg: "rgba(201,169,110,0.92)", topFrac: PRICE_TOP_FRAC }), w, h, outPng: pricePng, transparent: true });
  }

  // Hook overlay — typewriter reveal frames (5 steps) composited onto the
  // hero photo's opening window.
  const HOOK_STEPS = [15, 35, 55, 75, 100];
  const hookPngs = [];
  for (const pct of HOOK_STEPS) {
    const p = path.join(workDir, `hook-${aspectKey}-${pct}.png`);
    await renderHtmlToPng({
      html: hookOverlayHtml({ w, h, eyebrow: listing.eyebrow, headline: listing.hook, addressLine, revealPct: pct }),
      w, h, outPng: p, transparent: true,
    });
    hookPngs.push(p);
  }

  // ── 5. Final overlay pass ──
  fs.mkdirSync(outDir, { recursive: true });
  const outMp4 = path.join(outDir, `${listing.id}-${aspectKey}.mp4`);

  const baseDuration = ffprobeDuration(mergedMp4);
  const inputs = ["-i", mergedMp4];
  let inputIdx = 1;
  const hookIdxs = [];
  for (const p of hookPngs) { inputs.push("-loop", "1", "-i", p); hookIdxs.push(inputIdx++); }
  inputs.push("-loop", "1", "-i", lowerThirdPng); const ltIdx = inputIdx++;
  inputs.push("-loop", "1", "-i", specPng); const specIdx = inputIdx++;
  let priceIdx = null;
  if (pricePng) { inputs.push("-loop", "1", "-i", pricePng); priceIdx = inputIdx++; }

  let voiceIdx = null, musicIdx = null;
  if (voiceoverPath) { inputs.push("-i", voiceoverPath); voiceIdx = inputIdx++; }
  if (musicPath) { inputs.push("-i", musicPath); musicIdx = inputIdx++; }
  if (voiceIdx === null && musicIdx === null) { inputs.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"); }

  const filters = [];
  // Hook typewriter: each frame visible for a slice of HOOK_REVEAL_DUR,
  // last frame holds for HOOK_HOLD_DUR then fades out.
  const stepDur = HOOK_REVEAL_DUR / HOOK_STEPS.length;
  let prevV = "0:v";
  hookIdxs.forEach((idx, i) => {
    const t0 = heroWindow.start + i * stepDur;
    const isLast = i === hookIdxs.length - 1;
    const t1 = isLast ? heroWindow.start + HOOK_REVEAL_DUR + HOOK_HOLD_DUR : t0 + stepDur;
    const fadeOutStart = t1;
    const fadeOutEnd = t1 + HOOK_FADE_DUR;
    const label = `hk${i}`;
    if (isLast) {
      filters.push(`[${idx}:v]format=rgba,fade=t=out:st=${fadeOutStart.toFixed(2)}:d=${HOOK_FADE_DUR}:alpha=1[${label}f]`);
      filters.push(`[${prevV}][${label}f]overlay=0:0:enable='between(t,${t0.toFixed(2)},${fadeOutEnd.toFixed(2)})'[${label}]`);
    } else {
      filters.push(`[${idx}:v]format=rgba[${label}f]`);
      filters.push(`[${prevV}][${label}f]overlay=0:0:enable='between(t,${t0.toFixed(2)},${t1.toFixed(2)})'[${label}]`);
    }
    prevV = label;
  });

  // Lower-third: slide up from below + fade in, holds through the photo
  // sequence, fades out just before the closing card.
  const [lt0, lt1] = lowerThirdWindow;
  const ltFinalY = h - Math.round(h * 0.06) - Math.round(h * 0.06); // approx pill height offset baked into the PNG itself (pill positions itself)
  filters.push(
    `[${ltIdx}:v]format=rgba,` +
      `fade=t=in:st=${lt0.toFixed(2)}:d=${PILL_SLIDE_DUR}:alpha=1,` +
      `fade=t=out:st=${(lt1 - 0.4).toFixed(2)}:d=0.4:alpha=1[ltf]`
  );
  const ltSlideExpr = `if(lt(t,${lt0.toFixed(2)}),${h},if(lt(t,${(lt0 + PILL_SLIDE_DUR).toFixed(2)}),${h}-(${h}-0)*((t-${lt0.toFixed(2)})/${PILL_SLIDE_DUR}),0))`;
  filters.push(`[${prevV}][ltf]overlay=0:'${ltSlideExpr}':enable='between(t,${lt0.toFixed(2)},${lt1.toFixed(2)})'[withlt]`);
  prevV = "withlt";

  // Spec pill: slide in from bottom, hold, fade out.
  const specHold = 3.0;
  const specEnd = Math.min(lt1, specStart + specHold);
  filters.push(
    `[${specIdx}:v]format=rgba,` +
      `fade=t=in:st=${specStart.toFixed(2)}:d=${PILL_SLIDE_DUR}:alpha=1,` +
      `fade=t=out:st=${(specEnd - 0.4).toFixed(2)}:d=0.4:alpha=1[specf]`
  );
  // Pill PNGs are full-canvas (content already positioned via CSS top:),
  // so the overlay's own y is a small SLIDE DELTA around 0 — not an
  // absolute screen position (that would double-apply the position).
  const specSlideExpr = `if(lt(t,${specStart.toFixed(2)}),70,if(lt(t,${(specStart + PILL_SLIDE_DUR).toFixed(2)}),70-70*((t-${specStart.toFixed(2)})/${PILL_SLIDE_DUR}),0))`;
  filters.push(`[${prevV}][specf]overlay=0:'${specSlideExpr}':enable='between(t,${specStart.toFixed(2)},${specEnd.toFixed(2)})'[withspec]`);
  prevV = "withspec";

  if (priceIdx !== null) {
    const priceHold = 2.6;
    const priceEnd = Math.min(lt1, priceStart + priceHold);
    filters.push(
      `[${priceIdx}:v]format=rgba,` +
        `fade=t=in:st=${priceStart.toFixed(2)}:d=${PILL_SLIDE_DUR}:alpha=1,` +
        `fade=t=out:st=${(priceEnd - 0.4).toFixed(2)}:d=0.4:alpha=1[pricef]`
    );
    const priceSlideExpr = `if(lt(t,${priceStart.toFixed(2)}),70,if(lt(t,${(priceStart + PILL_SLIDE_DUR).toFixed(2)}),70-70*((t-${priceStart.toFixed(2)})/${PILL_SLIDE_DUR}),0))`;
    filters.push(`[${prevV}][pricef]overlay=0:'${priceSlideExpr}':enable='between(t,${priceStart.toFixed(2)},${priceEnd.toFixed(2)})'[withprice]`);
    prevV = "withprice";
  }

  filters.push(`[${prevV}]copy[vout]`);

  // Audio
  let audioMapLabel = null;
  if (voiceIdx !== null || musicIdx !== null) {
    const voiceLabel = voiceIdx !== null ? `${voiceIdx}:a` : null;
    const musicLabel = musicIdx !== null ? `${musicIdx}:a` : null;
    const voiceEnd = hasVoice ? VOICE_LEAD_IN + voiceDuration + 0.3 : 0;
    const audioFilter = buildAudioFilter({
      hasVoice: voiceIdx !== null,
      voiceLabel,
      musicLabel,
      totalDuration: baseDuration,
      voiceEnd,
    });
    if (audioFilter) {
      filters.push(audioFilter);
      audioMapLabel = "aout";
    }
  }

  const filterComplex = filters.join(";");
  const args = ["-y", ...inputs, "-filter_complex", filterComplex, "-map", "[vout]"];
  if (audioMapLabel) {
    args.push("-map", `[${audioMapLabel}]`);
  } else {
    // anullsrc is always the last input if we got here with no voice/music
    args.push("-map", `${inputIdx}:a`);
  }
  args.push(
    "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-r", String(FPS),
    "-c:a", "aac", "-b:a", "160k",
    "-shortest", "-t", baseDuration.toFixed(3),
    outMp4
  );
  run(FFMPEG, args);

  const totalDuration = ffprobeDuration(outMp4);
  const stat = fs.statSync(outMp4);
  return { outMp4, totalDuration, sizeBytes: stat.size, photoCount: order.length };
}

async function main() {
  const argv = minimist(process.argv.slice(2), {
    string: ["listing", "photos-dir", "out-dir", "aspect", "voiceover", "voiceover-timing", "music"],
    default: { aspect: "both" },
  });
  if (!argv.listing || !argv["photos-dir"] || !argv["out-dir"]) {
    console.error(
      "Usage: node scripts/generate-listing-video.js --listing <listing.json> --photos-dir <dir> --out-dir <dir> [--aspect vertical|square|both] [--voiceover mp3] [--voiceover-timing json] [--music mp3]"
    );
    process.exit(1);
  }

  const listing = JSON.parse(fs.readFileSync(path.resolve(argv.listing), "utf8"));
  const photosDir = path.resolve(argv["photos-dir"]);
  const outDir = path.resolve(argv["out-dir"]);
  const aspects = argv.aspect === "both" ? ["vertical", "square"] : [argv.aspect];
  for (const a of aspects) if (!ASPECTS[a]) throw new Error(`Unknown aspect '${a}'. Use vertical, square, or both.`);

  const resolveMaybe = (cliVal, jsonVal) => {
    const v = cliVal || jsonVal;
    if (!v) return null;
    return path.isAbsolute(v) ? v : path.join(REPO_ROOT, v);
  };
  const voiceoverPath = resolveMaybe(argv.voiceover, listing.voiceover_mp3);
  const voiceTimingPath = resolveMaybe(argv["voiceover-timing"], listing.voiceover_timing);
  const musicPath = resolveMaybe(argv.music, listing.music);

  if (voiceoverPath && !fs.existsSync(voiceoverPath)) throw new Error(`Voiceover not found: ${voiceoverPath}`);
  if (voiceTimingPath && !fs.existsSync(voiceTimingPath)) throw new Error(`Voiceover timing not found: ${voiceTimingPath}`);
  if (musicPath && !fs.existsSync(musicPath)) throw new Error(`Music not found: ${musicPath}`);

  const voiceTiming = voiceTimingPath ? loadVoiceTiming(voiceTimingPath) : null;

  const workDir = mkTmp("listing-video-");
  console.log(`[listing-video] ${listing.id}: workDir=${workDir}`);
  if (voiceoverPath) console.log(`[listing-video] voiceover: ${voiceoverPath}`);
  if (musicPath) console.log(`[listing-video] music: ${musicPath}`);

  const results = [];
  for (const aspectKey of aspects) {
    console.log(`[listing-video] rendering ${aspectKey}...`);
    const res = await renderAspect({ listing, photosDir, aspectKey, outDir, workDir, voiceoverPath, voiceTiming, musicPath });
    results.push({ aspectKey, ...res });
    console.log(
      `[listing-video] ${aspectKey} done: ${res.outMp4} (${res.totalDuration.toFixed(1)}s, ${(res.sizeBytes / 1024 / 1024).toFixed(2)} MB, ${res.photoCount} photos)`
    );
  }

  fs.rmSync(workDir, { recursive: true, force: true });

  console.log("\n[listing-video] SUMMARY");
  for (const r of results) {
    console.log(`  ${r.aspectKey}: ${r.outMp4} — ${r.totalDuration.toFixed(1)}s — ${(r.sizeBytes / 1024 / 1024).toFixed(2)} MB`);
  }
}

main().catch((e) => {
  console.error("[listing-video] FAILED:", e.message);
  process.exit(1);
});
