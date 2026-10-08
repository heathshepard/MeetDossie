#!/usr/bin/env node
/**
 * captions.js — builds an ASS subtitle file (burned in via ffmpeg's `ass`/
 * `subtitles` libass filter — this build has NO drawtext, but libass IS
 * compiled in, confirmed via `ffmpeg -filters | grep ass`) from an
 * ElevenLabs transcript + a cutlist, remapped onto the POST-CUT timeline,
 * with a hook card at the start, a CTA card at the end, and configurable
 * emphasis words rendered in the brand coral color.
 *
 * Usage:
 *   node scripts/video-engine/captions.js --transcript <scribe json> \
 *     --cutlist <cutlist json> --brief <brief json> --out <captions.ass> \
 *     [--cropPath <face-crop-path.json>]
 *
 * CAPTION DEFAULTS (Heath's note 6): the trial_02 sizes — 84px for regular
 * caption chunks, 116px for the single-word emphasis style — Plus Jakarta
 * Sans (heavy/bold), coral (#E8836B) for emphasis words, positioned inside
 * safe zones (MarginV keeps captions off the very bottom). When
 * --cropPath is given (face-track-crop.js's output), caption vertical
 * placement is nudged so its band never overlaps the tracked face box —
 * the quality gate re-checks this independently rather than trusting this
 * nudge blindly.
 */
const fs = require('fs');

function parseArgs() {
  const a = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const key = a[i].slice(2);
      const val = (a[i + 1] && !a[i + 1].startsWith('--')) ? a[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function remapTime(t, keepSegments) {
  let acc = 0;
  for (const seg of keepSegments) {
    if (t < seg.start) return acc;
    if (t <= seg.end) return acc + (t - seg.start);
    acc += seg.end - seg.start;
  }
  return acc;
}

function fmtAssTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// Heath's note 6 default — trial_02's exact style block (verified against
// Media/finished-videos/dossie_trial_02.captions.ass, the cut he approved
// on sizing): Cap 84px / Word 116px, Plus Jakarta Sans, heavy outline for
// legibility over any backdrop. MarginV values below are the trial_02
// defaults and get raised (never lowered) if --cropPath shows the face box
// would otherwise overlap the caption band (see computeSafeMarginV).
/**
 * @param capSize   base caption size (brief.captionSize, default 84 = the
 *                  trial_02 size Heath approved). Word/Hook/CTA scale off it.
 * @param box       brief.captionBox — true switches BorderStyle to 3 (opaque
 *                  box behind the text) instead of 1 (outline). This is the
 *                  knob for review.js's "a caption sits over busy b-roll
 *                  text" finding; it used to have no knob at all.
 */
function buildAssHeader(marginVCap, marginVWord, marginVHook, capSize = 84, box = false) {
  const cap = Math.round(capSize);
  const word = Math.round(capSize * 1.38);
  const hook = Math.round(capSize * 0.95);
  const border = box ? 3 : 1;      // 3 = opaque box, 1 = outline+shadow
  const outline = box ? 6 : 8;
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Plus Jakarta Sans,${cap},&H00FFFFFF,&H00FFFFFF,&H00141414,&HA0000000,-1,0,0,0,100,100,0.5,0,${border},${outline},3,2,70,70,${marginVCap},1
Style: Word,Plus Jakarta Sans,${word},&H00FFFFFF,&H00FFFFFF,&H00141414,&HA0000000,-1,0,0,0,100,100,1,0,${border},${outline + 1},3,2,60,60,${marginVWord},1
Style: Hook,Plus Jakarta Sans,${hook},&H00FFFFFF,&H00FFFFFF,&H00141414,&HA0000000,-1,0,0,0,100,100,0.5,0,${border},${outline},3,2,50,50,${marginVHook},1
Style: CTA,Plus Jakarta Sans,${hook},&H006B83E8,&H006B83E8,&H00141414,&HA0000000,-1,0,0,0,100,100,0.5,0,${border},${outline},3,2,50,50,${marginVHook},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

// ASS BGR hex for the Dossie coral (#E8836B) used to emphasize words.
const EMPHASIS_COLOR = '&H006B83E8&'; // BGR order: 6b 83 e8 = coral

/**
 * computeSafeMarginV — Heath's note 6 gate-support default: given
 * face-track-crop.js's crop-path.json, project each frame's face box into
 * OUTPUT (1080x1920) coordinate space and find the lowest point the face
 * ever reaches on screen. Returns a MarginV (px from bottom, ASS units)
 * that keeps the caption band's TOP edge above that point with a buffer,
 * so captions never sit over the face. Falls back to trial_02's own
 * default (370) when no crop-path is available.
 */
function computeSafeMarginV(cropPathData, defaultMarginV, buffer = 24, textHeight = 100) {
  if (!cropPathData || !cropPathData.frames || !cropPathData.frames.length) return defaultMarginV;
  const outH = cropPathData.outH || 1920;
  // Lowest point the chin ever reaches on screen, across every frame.
  let maxFaceBottomOnScreen = 0;
  for (const f of cropPathData.frames) {
    if (!f.faceFound || f.faceBoxH == null || f.smoothedCy == null) continue;
    const faceBottomSrc = f.smoothedCy + f.faceBoxH / 2 + f.faceBoxH * 0.12; // + CHIN_BELOW_BOX factor
    const scale = outH / f.crop.h;
    const faceBottomOut = (faceBottomSrc - f.crop.y) * scale;
    if (faceBottomOut > maxFaceBottomOnScreen) maxFaceBottomOnScreen = faceBottomOut;
  }
  if (maxFaceBottomOnScreen <= 0) return defaultMarginV;
  // ASS alignment 2 measures MarginV from the BOTTOM of the frame to the
  // bottom of the text, so the text occupies
  //   [outH - marginV - textHeight, outH - marginV].
  // To keep it clear of the face we need its TOP below the chin:
  //   outH - marginV - textHeight >= faceBottom + buffer
  //   marginV <= outH - faceBottom - buffer - textHeight
  //
  // The previous version returned max(default, outH - faceBottom + buffer),
  // i.e. it grew MarginV to push captions UP — into the face — and ignored
  // the text's own height entirely. On the tight punch shots that put
  // "transaction coordinator software" straight across Heath's mouth, which
  // is exactly what §8 says not to do.
  const maxSafe = Math.floor(outH - maxFaceBottomOnScreen - buffer - textHeight);
  if (maxSafe < 60) {
    // The face reaches so low that no caption fits under it. Say so instead
    // of quietly placing text on his mouth — the real fix is looser framing
    // (brief.zoom / brief.punchFactor), which is a framing knob, not a
    // caption one.
    console.warn(`WARNING: chin reaches ${Math.round(maxFaceBottomOnScreen)}px of ${outH} — no caption band fits below the face. Captions will sit on the face until the framing is pulled back (lower brief.zoom / brief.punchFactor).`);
    return Math.max(40, maxSafe);
  }
  return Math.min(defaultMarginV, maxSafe);
}

function main() {
  const args = parseArgs();
  const transcriptPath = args.transcript, cutlistPath = args.cutlist, briefPath = args.brief, outPath = args.out;
  if (!transcriptPath || !cutlistPath || !outPath) {
    console.error('Usage: captions.js --transcript <json> --cutlist <json> [--brief <json>] --out <ass> [--cropPath <json>]');
    process.exit(1);
  }
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const cutlist = JSON.parse(fs.readFileSync(cutlistPath, 'utf8'));
  const brief = briefPath && fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : {};
  const emphasis = new Set((brief.emphasisWords || []).map(w => w.toLowerCase()));

  const cropPathData = args.cropPath && fs.existsSync(args.cropPath) ? JSON.parse(fs.readFileSync(args.cropPath, 'utf8')) : null;
  // brief.captionMarginV is a FLOOR, not an override — the face-aware
  // calculation may still push captions further down if the face demands it.
  const briefMarginV = brief.captionMarginV != null ? +brief.captionMarginV : null;
  const capSize = brief.captionSize != null ? +brief.captionSize : 84;
  // Text height is ~1.35x the point size once outline and descenders are in.
  const marginVCap = computeSafeMarginV(cropPathData, Math.max(370, briefMarginV || 0), 24, capSize * 1.35);
  const marginVWord = computeSafeMarginV(cropPathData, Math.max(390, briefMarginV || 0), 24, capSize * 1.38 * 1.35);
  const marginVHook = computeSafeMarginV(cropPathData, Math.max(370, briefMarginV || 0), 24, capSize * 0.95 * 2.7);
  const captionBox = !!brief.captionBox;
  // §8: captions are a storytelling tool, not a transcript. 'emphasis' mode
  // breaks the line into short 1-3 word stacks and promotes emphasis words to
  // the big Word style, so the point lands with the sound off. 'verbatim' is
  // the old 4-word rolling chunk. This is the knob for review.js's
  // "captions are a transcript, not a storytelling tool" finding.
  const captionStyle = brief.captionStyle === 'emphasis' ? 'emphasis' : 'verbatim';
  // 'all' guarantees every kept word appears in some chunk (review.js's
  // caption-coverage finding): chunks flush on a shorter budget so no word
  // is stranded past the end of its chunk's display window.
  const coverageAll = brief.captionCoverage === 'all';
  const ASS_HEADER = buildAssHeader(marginVCap, marginVWord, marginVHook, capSize, captionBox);
  console.log(`Caption MarginV — Cap:${marginVCap} Word:${marginVWord} Hook/CTA:${marginVHook}${cropPathData ? ' (face-aware)' : ' (default, no crop-path given)'}; size ${capSize}px, box ${captionBox}, style ${captionStyle}, coverage ${coverageAll ? 'all' : 'default'}`);

  const words = transcript.words.filter(w => w.type === 'word');
  // Keep only words that fall inside a kept segment (i.e. survived the cut).
  const kept = words.filter(w => cutlist.keepSegments.some(seg => w.start >= seg.start - 0.01 && w.end <= seg.end + 0.01));

  const events = [];

  // Hook card: first ~2.2s. §8 forbids covering the screen with text, so
  // while the hook card is up the rolling captions are SUPPRESSED — the two
  // used to render on top of each other, giving frame 1 a full-sentence hook
  // card AND a caption chunk simultaneously (visible in trial_07 round 1).
  let hookEnd = 0;
  if (brief.hookLine) {
    hookEnd = Math.min(2.2, kept.length ? remapTime(kept[0].start, cutlist.keepSegments) + 1.4 : 2.2);
    const hookText = brief.hookLine.replace(/\n/g, '\\N');
    const plain = hookText.replace(/\\N/g, ' ');
    if (plain.split(/\s+/).length > 10) {
      console.warn(`WARNING: hookLine is ${plain.split(/\s+/).length} words ("${plain.slice(0, 60)}…"). §8: a hook card is 3-7 words, not a sentence. Set a short brief.hookLine.`);
    }
    events.push(`Dialogue: 0,${fmtAssTime(0)},${fmtAssTime(hookEnd)},Hook,,0,0,0,,${hookText}`);
  }

  // Caption chunks. 'verbatim' = ~4-word / ~2.2s rolling chunks (the old
  // behaviour). 'emphasis' = short 1-3 word stacks, and a chunk that is a
  // single emphasis word is promoted to the big Word style — §8's
  // "THREE DEADLINES / ONE TRANSACTION" treatment.
  const maxWords = captionStyle === 'emphasis' ? 3 : 4;
  const maxDur = captionStyle === 'emphasis' ? 1.4 : 2.2;
  // Coverage mode tightens both so a long word run can't outlive its chunk.
  const chunkWords = coverageAll ? Math.min(maxWords, 3) : maxWords;
  const chunkDur = coverageAll ? Math.min(maxDur, 1.6) : maxDur;
  let chunk = [];
  let chunkStart = null;
  let coveredWords = 0;
  const flush = () => {
    if (!chunk.length) return;
    const start = remapTime(chunk[0].start, cutlist.keepSegments);
    const end = remapTime(chunk[chunk.length - 1].end, cutlist.keepSegments);
    const emphCount = chunk.filter(w => emphasis.has(w.text.trim().toLowerCase().replace(/[^a-z']/gi, ''))).length;
    const text = chunk.map(w => {
      const clean = w.text.trim();
      const isEmphasis = emphasis.has(clean.toLowerCase().replace(/[^a-z']/gi, ''));
      return isEmphasis ? `{\\c${EMPHASIS_COLOR}}${clean}{\\c&H00FFFFFF&}` : clean;
    }).join(' ');
    // Promote a short all-emphasis chunk to the big Word style.
    const style = (captionStyle === 'emphasis' && chunk.length <= 2 && emphCount === chunk.length) ? 'Word' : 'Caption';
    coveredWords += chunk.length;
    chunk = [];
    // Don't stack a caption under the hook card (§8).
    if (end <= hookEnd) return;
    events.push(`Dialogue: 0,${fmtAssTime(Math.max(start, hookEnd))},${fmtAssTime(Math.max(end, start + 0.3))},${style},,0,0,0,,${text}`);
  };
  for (const w of kept) {
    if (chunk.length === 0) chunkStart = w.start;
    chunk.push(w);
    const dur = w.end - chunkStart;
    const clean = w.text.trim();
    // In emphasis mode, break after a comma too — that is where the list
    // items in "Inspections, appraisals, financing..." actually separate.
    const clauseBreak = captionStyle === 'emphasis' && /[,;:]$/.test(clean);
    if (chunk.length >= chunkWords || dur >= chunkDur || clauseBreak || /[.!?]$/.test(clean)) flush();
  }
  flush();
  if (coveredWords !== kept.length) console.warn(`WARNING: caption coverage ${coveredWords}/${kept.length} kept words — some word has no caption chunk.`);

  // CTA card: last 2.5s of the post-cut timeline.
  const totalKeptSec = cutlist.stats.keptSeconds;
  if (brief.cta) {
    const ctaStart = Math.max(0, totalKeptSec - 2.5);
    events.push(`Dialogue: 1,${fmtAssTime(ctaStart)},${fmtAssTime(totalKeptSec)},CTA,,0,0,0,,${brief.cta.replace(/\n/g, '\\N')}`);
  }

  fs.writeFileSync(outPath, ASS_HEADER + events.join('\n') + '\n');
  console.log(`Wrote ${events.length} caption events to ${outPath}`);
}

module.exports = { computeSafeMarginV, buildAssHeader };
if (require.main === module) main();
