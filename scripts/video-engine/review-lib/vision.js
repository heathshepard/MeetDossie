'use strict';
/**
 * review-lib/vision.js — the judgment calls review.js cannot measure, graded
 * against docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md by section number. Frames
 * go to Claude vision through api/verify-video-vision.js (CRON_SECRET-gated
 * proxy; the real ANTHROPIC_API_KEY lives only in Vercel — CLAUDE.md §15/§19),
 * the same route api/_lib/verify-video-quality.js uses. Proxy limits: <= 6
 * images per call, ~500 output tokens, JPEG/PNG/WebP, < 2 MB base64 each —
 * so every prompt asks for ONE compact JSON object and frames are sent as
 * downscaled JPEGs or contact sheets.
 *
 * Any transport or parse failure throws; review.js treats a thrown vision
 * call as "could not judge" (reported as such) — it never silently passes.
 */
const fs = require('fs');
const path = require('path');

function loadEnvLocal() {
  // See env-local.js: the old inline version resolved .env.local relative to
  // the repo root, which does not exist in a git worktree — so the key
  // silently never loaded and this took its fallback path instead.
  return require('../env-local.js').load(null, { quiet: true });
}
loadEnvLocal();

const VISION_URL = process.env.VIDEO_QUALITY_VISION_URL || 'https://meetdossie.com/api/verify-video-vision';
const MAX_IMAGE_BASE64 = 1_800_000;

function imageToPart(file) {
  const buf = fs.readFileSync(file);
  const base64 = buf.toString('base64');
  if (base64.length > MAX_IMAGE_BASE64) throw new Error(`${path.basename(file)} is ${base64.length} base64 chars — over the proxy's per-image cap; downscale it first`);
  const ext = path.extname(file).toLowerCase();
  const mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return { base64, mimeType };
}

async function ask(imageFiles, promptText, { retries = 2 } = {}) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret === '[SENSITIVE]') throw new Error('CRON_SECRET not available locally — cannot reach the vision proxy');
  if (!imageFiles.length || imageFiles.length > 6) throw new Error(`vision call needs 1-6 images, got ${imageFiles.length}`);
  const images = imageFiles.map(imageToPart);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(VISION_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
        body: JSON.stringify({ images, promptText }),
      });
      const txt = await res.text();
      if (!res.ok) throw new Error(`vision proxy ${res.status}: ${txt.slice(0, 200)}`);
      const data = JSON.parse(txt);
      if (!data.ok || !data.result || typeof data.result !== 'object') throw new Error(`vision proxy returned no result: ${txt.slice(0, 200)}`);
      return data.result;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ── Prompts. Each returns exactly one JSON object; reasons are capped short
// because the proxy caps output tokens. The voice is the standard's own:
// a creative director who would have to put this in front of thousands of
// real estate agents, not a checklist auditor.

const JSON_ONLY = 'Respond with JSON only — no markdown fences, no prose outside the JSON. Keep every string under 30 words.';

const WHO = `You are the creative director for Dossie (transaction-coordinator software for real estate agents), reviewing a founder talking-head reel by Heath, a working Texas REALTOR, against the Dossie Creative Director Standard. The bar (§22) is "would we be proud to put this in front of thousands of real estate agents?" — not "is it technically finished." A good Dossie video feels like a smart real estate professional talking to another one (§1); authenticity beats polish (§16).`;

function hookPrompt({ transcriptOpening, candidateLines, spokenOpener }) {
  return `${WHO}

Judge ONLY the first 3 seconds (§2). The 4 images are frames at 0.0s, 1.0s, 2.0s, 3.0s.
The spoken opener is: "${spokenOpener}"
The full transcript opens: "${transcriptOpening}"
Other lines from the same take that could have opened the video instead:
${candidateLines.map((l, i) => `${i + 1}. "${l}"`).join('\n')}

§2: never waste the opening — no "hey guys", no name intro, no "today I want to talk about", no logo or generic title card. Within ~1-3 s the viewer must get WHO this is for + WHY they should care, via a painful problem, a surprising statement, a mistake, a question agents instantly recognize, a curiosity gap. §3: if there is no compelling reason to stop scrolling, the problem is the concept, not the edit.

Score HOOK 1-5 ("would I stop scrolling?") and CLARITY 1-5 ("do I immediately understand who this is for?"). Say whether the spoken opener is the strongest available line; if a numbered candidate is clearly stronger, name it. If NO line in the take would stop a scroll, say hook_exists_in_footage=false.

${JSON_ONLY}
{"hook": 1-5, "clarity": 1-5, "headline_seen": "text readable at 0s or empty", "person_visible": true/false, "banned_opener": true/false, "opener_is_strongest": true/false, "better_opener": "exact candidate text or empty", "hook_exists_in_footage": true/false, "reason": "one sentence"}`;
}

function framingPrompt({ sheetLayout, faceFacts }) {
  return `${WHO}

The images are contact sheets of frames sampled across the runtime, ${sheetLayout}. Ignore the caption text for this pass; judge the picture (§4 VISUALS, §5 talking-head, §16 authenticity).

Measured facts you can trust: ${faceFacts}

VISUALS 1-5 ("is the screen visually interesting?"): head-and-shoulders with a little headroom; no clipped head; not a tight "floating head" filling the frame; consistent scale shot to shot; no visible halo, fringe or blur band from a bad cutout; no blurred/darkened vignette oval; and the ORIGINAL ROOM must not be visible (shelves, cabinets, washer/dryer, monitors, clutter) — a clean plain or navy backdrop is what we want. Do the shots CHANGE with purpose (punch-ins, b-roll, product screens) or is it one static shot? If the room shows in ANY tile, say so and name what you see.

HUMAN 1-5 ("does Heath feel like a real person?"): real founder talking to a peer, or an ad / AI avatar? Penalize over-smoothed skin, over-zoom, cheesy transitions, logo intros, stock-footage feel. Natural phone footage with real lighting is a 5, not a flaw.

${JSON_ONLY}
{"visuals": 1-5, "visuals_reason": "one sentence", "room_visible": true/false, "room_detail": "what and roughly which tiles, or empty", "blur_or_halo": "none|halo/fringe|blur band|vignette oval", "face_scale": "good|too tight|too loose|inconsistent", "clipped_head": true/false, "shot_variety": "static|some|purposeful|frantic", "human": 1-5, "human_reason": "one sentence"}`;
}

function gazePrompt({ n, times }) {
  return `${WHO}

This image is a grid of ${n} close face crops from the same reel, one roughly every ${times} — read left-to-right, top-to-bottom, in time order. §5: hide obvious script reading and long periods of looking away; do NOT fake eye contact.

For each tile decide whether he is looking INTO the lens (at the viewer) or away/down (reading a script, glancing at a screen, eyes flicking). Count the tiles with real eye contact. Also say whether the face looks naturally imperfect (good) or smoothed/plastic/processed.

${JSON_ONLY}
{"eye_contact_tiles": 0-${n}, "reading_or_looking_away": true/false, "pattern": "steady|flicking|reading|mostly down", "natural_skin": true/false, "reason": "one sentence"}`;
}

function edgePrompt({ n }) {
  return `These ${n} images are close crops around the top of a person's head from a 9:16 talking-head reel — hair and forehead against the background. The subject was cut out with a video matte and placed over a plain backdrop (or, if the original room is behind them, not cut out at all).

Judge ONLY the cutout edge, the way a picky editor would at 100% zoom: is there a soft blurry band or glow hugging the outline (feathered matte), a light or coloured fringe/halo, a hard jagged or flickery edge, or a vignette (the area around the head blurred/darkened in an oval)? A clean edge looks like the hair simply ends against the backdrop with fine strands intact. If the real room is visible behind the hair there is no cutout at all — say "natural".

${JSON_ONLY}
{"edge": "clean|blur band|halo/fringe|jagged|vignette|natural", "severity": 0-3, "reason": "one sentence"}`;
}

function captionsPrompt({ n, emphasisWords }) {
  return `${WHO}

These ${n} frames are from the reel at roughly phone size, sampled while a caption should be on screen. §8: captions are a storytelling tool, not a transcript — concise, big enough for mobile, high contrast, inside platform-safe areas, away from the face, emphasis words highlighted${emphasisWords ? ` (expected emphasis words include: ${emphasisWords})` : ''}; never cover the screen with text.

CAPTIONS 1-5 ("can I understand the video with the sound off?"). "legible" means ONLY: can you read the words at this size. A readable caption over a busy screenshot is still legible — report that as busy_background. A missing caption where he is clearly mid-sentence is a real fault. Also say whether the captions carry the POINT (a viewer with sound off would get it) or are just small verbatim text.

${JSON_ONLY}
{"score": 1-5, "frames_with_caption": 0-${n}, "legible": true/false, "busy_background": true/false, "over_face": true/false, "in_safe_zone": true/false, "emphasis_present": true/false, "carries_point_without_sound": true/false, "reason": "one sentence"}`;
}

function endingPrompt({ lastLine, audioFacts, ctaExpected }) {
  return `${WHO}

These 4 frames are the END of the reel: roughly -2.0s, -1.0s, -0.4s, and the last frame.
The last spoken line is: "${lastLine}"
Measured audio facts you can trust: ${audioFacts}
${ctaExpected ? `The video is supposed to end on this CTA: "${ctaExpected}".` : 'A CTA (follow / link / next step) should be readable on screen when one is appropriate (§17 CTA).'}

Judge the ending: the last line lands cleanly (complete sentence, nothing cut or slurred — use the audio facts), a CTA is present and readable for at least 1.5s, and the picture is clean (not a mid-blink freeze, not a half-drawn card, not cut off mid-gesture). If the audio facts say the last word was truncated, ending_clean must be false.

${JSON_ONLY}
{"ending_clean": true/false, "cta_seen": "text or empty", "cta_readable_long_enough": true/false, "cta_score": 1-5, "last_frame": "what the final frame shows", "reason": "one sentence"}`;
}

function storyPrompt({ transcript, sourceTranscript, durationSec, facts }) {
  return `${WHO}

The image is a contact sheet of the reel for context. Judge STORY, PAYOFF and the SOURCE FOOTAGE from the words and the measured facts.

What the finished reel says (${durationSec}s):
"${transcript}"
${sourceTranscript ? `The full raw take it was cut from:\n"${sourceTranscript}"` : ''}

Measured facts you can trust: ${facts}

§11 story: HOOK -> PROBLEM -> ESCALATION/INSIGHT -> SOLUTION -> PAYOFF -> CTA (not every stage is required; do not force a formula). §12: the shortest version that communicates the idea; a strong 22s beats a weak 55s. §3: accurate information is not content. §19: if the footage has no usable hook, unusable audio, weak delivery (script reading, eyes down, flat energy, stumbles), or is missing the B-roll the story needs, SAY SO and recommend a reshoot instead of polishing.

STORY 1-5 ("is there a reason to watch until the end?"). PAYOFF 1-5 ("does the video deliver what the opening promised?"). Then the §19 source assessment.

Answer with JSON only, no markdown fences. Keep "story_reason", "payoff_reason" and "reshoot_reason" to at most 15 words each and "broll_missing" to at most 8 words — the response is truncated past ~400 tokens and a truncated answer is discarded.
{"story": 1-5, "story_reason": "<=15 words", "payoff": 1-5, "payoff_reason": "<=15 words", "stages": "hook,problem,escalation,solution,payoff,cta (only those present)", "source_hook_usable": true/false, "source_audio_usable": true/false, "source_delivery": "strong|ok|weak", "broll_missing": "<=8 words or empty", "recommend_reshoot": true/false, "reshoot_reason": "<=15 words or empty"}`;
}

function verdictPrompt({ qcSummary, transcript, weakCandidates }) {
  return `${WHO}

The image is a contact sheet of the finished reel. You have already graded it section by section; here is the §17 QC table with reasons:
${qcSummary}

What it says: "${transcript}"

Moments the measurements flagged (use these, add your own from the sheet and the words):
${weakCandidates.map((w, i) => `${i + 1}. ${w}`).join('\n')}

§18 self-critique: name the THREE weakest moments (with a time in seconds) and attribute each to exactly one cause: source footage / editing / audio / captions / pacing / storytelling / missing B-roll. That attribution decides whether to re-edit or re-record.
§22: answer honestly — would we be proud to put THIS cut in front of thousands of real estate agents? A technically correct video can still fail this. §19: if the weaknesses are mostly in the source footage, the verdict is RESHOOT, not "fix in the edit".

${JSON_ONLY}
{"proud": true/false, "proud_reason": "one sentence", "verdict": "PASS|FAIL|RESHOOT", "weakest": [{"atSec": number, "what": "short", "cause": "source footage|editing|audio|captions|pacing|storytelling|missing B-roll"}, {...}, {...}], "one_change_that_matters_most": "one sentence"}`;
}

module.exports = { ask, hookPrompt, framingPrompt, gazePrompt, edgePrompt, captionsPrompt, endingPrompt, storyPrompt, verdictPrompt, VISION_URL };
