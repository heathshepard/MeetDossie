#!/usr/bin/env node
//
// scripts/video-engine/variants.js
//
// Turns ONE spliced master into BOTH platform cuts without re-matting.
//
// WHAT THIS IS FOR
// ----------------
// docs/VIDEO-PRODUCTION-RECIPE.md §15 is a 13-step build whose single most
// expensive step is §5, the matte: hundreds of thousands of small PNG writes.
// Producing a second length by running the recipe twice pays that cost twice
// for a picture that is pixel-identical wherever both cuts keep the same
// sentence.
//
// The 2026-09-25 42-second cut proved the cheap path: slice the EXISTING rgba
// frame directory by index and re-slice the audio. Seconds, not a 5-minute
// re-matte. This module is that move, generalised and made repeatable.
//
// THE INPUT CONTRACT
// ------------------
// A variant spec names, on the MASTER timeline:
//
//   segments: [{ start, end, tag }]      tag = 'CORE' | 'OPTIONAL'
//
// One segment per spoken sentence, in master order. Sentence boundaries come
// from the splice step (docs/VIDEO-PRODUCTION-RECIPE.md §3, plan4.json) or,
// for a master built before tags existed, from the caption file — see
// segmentsFromAss(). Both land on the same timeline; the caption file is the
// more reliable of the two because plan4.json holds PRE-pad source times
// (§3.4 adds a -0.12s head pad and a scaled tail pad per splice, which is why
// plan4's durations sum to 47.08s against the master's 51.15s).
//
// WHAT EACH VARIANT NEEDS ITS OWN COPY OF
// ---------------------------------------
// Everything that is a function of time:
//
//   * frame index ranges into the shared rgba/ directory   -> frameRanges()
//   * audio segment list for the re-slice                  -> ffmpegAudioFilter()
//   * captions, remapped to the new timeline               -> remapAss()
//   * contract-scroll settle/idle cue points               -> remapCues()
//   * the circle annotation trigger                        -> remapCues()
//   * shot-plan between(t,...) ladders                     -> remapShotPlan()
//
// The annotation must land ON THE WORD, not at a fixed offset — recipe §7:
// "An early cut drew it at 4s while Heath did not say the paragraph name
// until 19s." Every cue is therefore carried as a MASTER time and pushed
// through the same remap as everything else, so a cut that removes 9 seconds
// ahead of the circle moves the circle by exactly 9 seconds.
//
// WHAT IS NOT A VARIABLE
// ----------------------
// Aspect ratio. 9:16 1080x1920 for both cuts. This module never touches
// geometry.

'use strict';

const fs = require('fs');
const path = require('path');

const { makeSourceToPost } = require('./shot-plan.js');

const EPS = 1e-6;

// ---------------------------------------------------------------- input ----

/**
 * segmentsFromAss — derive sentence boundaries on the master timeline from a
 * burned-caption .ass file.
 *
 * The caption file is definitionally on the master timeline (it was written
 * against it), so its events are the most trustworthy boundary source
 * available for a master that predates CORE/OPTIONAL tagging. Events are
 * grouped into sentences on terminal punctuation, which is the same rule
 * shot-plan.js's toSentences() uses.
 *
 * Returns [{ start, end, text }] with NO tag — the caller assigns tags.
 */
function segmentsFromAss(assText, { tailEnd = null } = {}) {
  const events = [];
  for (const line of String(assText || '').split(/\r?\n/)) {
    const m = line.match(/^Dialogue:\s*\d+\s*,\s*([\d:.]+)\s*,\s*([\d:.]+)\s*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,[^,]*,(.*)$/);
    if (!m) continue;
    events.push({
      start: parseAssTime(m[1]),
      end: parseAssTime(m[2]),
      text: stripAssTags(m[3]),
    });
  }
  events.sort((a, b) => a.start - b.start);

  // A SENTENCE BOUNDARY IS NOT A CAPTION-EVENT BOUNDARY.
  //
  // The proven chunker (recipe §9) breaks on "3 words OR 19 characters OR a
  // >0.4s gap", so a sentence end lands INSIDE an event far more often than
  // at its edge — "AGO. INSPECTIONS" and "WHAT MATTERS. IF" are both single
  // events. Two naive rules were tried and both are wrong:
  //
  //   * cut only where an event ENDS with '.'  -> 16 sentences collapse to 3,
  //     one of them 38 seconds long, nothing to cut on;
  //   * cut at the END of any event CONTAINING '.'  -> boundaries land a few
  //     words late, so a dropped segment leaves a dangling "YOU'LL" hanging
  //     off the end of the segment before it.
  //
  // So the cut time is INTERPOLATED to the punctuation mark's character
  // position within the event. Caption events are 3 words long, which makes
  // linear interpolation across them accurate to well under a word.
  const segs = [];
  let curStart = events.length ? events[0].start : 0;
  let curText = '';
  for (const ev of events) {
    const span = ev.end - ev.start;
    const len = Math.max(1, ev.text.length);
    let consumed = 0;
    const punct = /[.!?](?=\s|$)/g;
    let m = punct.exec(ev.text);
    while (m) {
      const charEnd = m.index + 1;
      const cutAt = ev.start + span * (charEnd / len);
      curText += ` ${ev.text.slice(consumed, charEnd)}`;
      segs.push({ start: curStart, end: cutAt, text: curText.trim() });
      curStart = cutAt;
      curText = '';
      consumed = charEnd;
      m = punct.exec(ev.text);
    }
    curText += ` ${ev.text.slice(consumed)}`;
  }
  if (curText.trim()) {
    segs.push({ start: curStart, end: events.length ? events[events.length - 1].end : 0, text: curText.trim() });
  }

  // Close the gaps: a cut has to land on a boundary, and a boundary sitting
  // mid-breath clips the head of the next word. Extend each segment's end to
  // the next segment's start so the kept material is contiguous.
  for (let i = 0; i < segs.length - 1; i++) {
    segs[i].end = segs[i + 1].start;
  }

  // HEAD AND TAIL.
  //
  // The caption track does not cover the whole master: recipe §9 suppresses
  // caption events under the hook card for the first ~3.05s, so the first
  // event starts at 4.02s on the TREC 7.I cut. Everything before it is the
  // hook — the single most load-bearing 4 seconds in the video — and a
  // segment list that starts at 4.02 would silently drop it from BOTH cuts.
  // Same at the tail for the CTA card running past the last caption.
  const out = segs.map((s) => ({ start: round3(s.start), end: round3(s.end), text: s.text.trim() }));
  if (out.length && out[0].start > 0.01) {
    out.unshift({ start: 0, end: out[0].start, text: '[hook card / opening line — no captions, recipe §9]' });
  }
  if (tailEnd != null && out.length && tailEnd > out[out.length - 1].end + 0.01) {
    out[out.length - 1].end = round3(tailEnd);
  }
  return out;
}

function parseAssTime(str) {
  const m = String(str).match(/^(\d+):(\d+):(\d+)\.(\d+)$/);
  if (!m) return Number(str) || 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(`0.${m[4]}`);
}

function fmtAssTime(t) {
  const s = Math.max(0, t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${sec.toFixed(2).padStart(5, '0')}`;
}

function stripAssTags(text) {
  return String(text || '').replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').trim();
}

function round3(n) { return Math.round(n * 1000) / 1000; }

// -------------------------------------------------------------- variant ----

/**
 * buildVariant — the whole timeline maths for one cut.
 *
 * @param {object} opts
 * @param {Array}  opts.segments  [{start,end,tag}] on the master timeline
 * @param {Array}  opts.includeTags e.g. ['CORE'] or ['CORE','OPTIONAL']
 * @param {number} opts.fps
 * @param {number} opts.masterDuration
 * @param {string} opts.which  'core' | 'full' (labelling only)
 */
function buildVariant(opts) {
  const {
    segments, includeTags, fps = 30, masterDuration, which = 'variant',
  } = opts;

  if (!Array.isArray(segments) || !segments.length) {
    throw new Error('buildVariant: segments is required and must be non-empty');
  }
  for (const s of segments) {
    if (!(s.end > s.start)) throw new Error(`buildVariant: segment ${JSON.stringify(s)} has end <= start`);
    if (!includeTagsValid(s.tag)) throw new Error(`buildVariant: segment tag must be CORE or OPTIONAL, got ${JSON.stringify(s.tag)}`);
  }

  const kept = segments.filter((s) => includeTags.includes(String(s.tag).toUpperCase()));
  if (!kept.length) throw new Error(`buildVariant(${which}): no segments matched tags [${includeTags.join(',')}]`);

  // Merge adjacent kept segments so the cut list is the smallest set of real
  // splices. Two sentences that were already contiguous must not become a
  // hard cut just because they are listed separately.
  const keep = [];
  for (const s of kept.slice().sort((a, b) => a.start - b.start)) {
    const last = keep[keep.length - 1];
    if (last && Math.abs(s.start - last.end) < 1e-3) last.end = s.end;
    else keep.push({ start: s.start, end: s.end });
  }

  const s2p = makeSourceToPost(keep);
  const duration = round3(s2p.totalPostSec);

  return {
    which,
    includeTags: includeTags.slice(),
    fps,
    masterDuration: masterDuration != null ? round3(masterDuration) : null,
    keep: keep.map((k) => ({ start: round3(k.start), end: round3(k.end) })),
    droppedSeconds: masterDuration != null ? round3(masterDuration - duration) : null,
    duration,
    frameCount: Math.round(duration * fps),
    /** master time -> variant time; null if the instant was cut away */
    map: (t) => s2p.map(t),
    /** master time -> nearest surviving variant time (never null) */
    mapClamped: (t) => s2p.mapClamped(t),
    keptTexts: kept.map((s) => s.text).filter(Boolean),
  };
}

function includeTagsValid(tag) {
  return ['CORE', 'OPTIONAL'].includes(String(tag || '').toUpperCase());
}

// ------------------------------------------------------------- captions ----

/**
 * remapAss — rewrite a caption file onto the variant timeline.
 *
 * Events wholly inside a removed span are DROPPED, not clamped to zero — a
 * clamped event stacks a sentence that is no longer spoken on top of one that
 * is, which is the unreadable-mush failure recipe §9 already names for the
 * hook card. Events that straddle a cut boundary are trimmed to the surviving
 * side; if less than `minEventSec` survives they are dropped too.
 *
 * The [Script Info] and [V4+ Styles] blocks pass through verbatim. Recipe §9:
 * "The style line ships verbatim — do not re-derive it."
 */
function remapAss(assText, variant, { minEventSec = 0.12 } = {}) {
  const out = [];
  let dropped = 0;
  let kept = 0;

  for (const line of String(assText || '').split(/\r?\n/)) {
    const m = line.match(/^(Dialogue:\s*\d+\s*,\s*)([\d:.]+)(\s*,\s*)([\d:.]+)(\s*,.*)$/);
    if (!m) { out.push(line); continue; }

    const start = parseAssTime(m[2]);
    const end = parseAssTime(m[4]);

    const seg = variant.keep.find((k) => start < k.end - EPS && end > k.start + EPS);
    if (!seg) { dropped++; continue; }

    const clippedStart = Math.max(start, seg.start);
    const clippedEnd = Math.min(end, seg.end);
    if (clippedEnd - clippedStart < minEventSec) { dropped++; continue; }

    const ns = variant.map(clippedStart);
    const ne = variant.map(clippedEnd);
    if (ns == null || ne == null || ne <= ns) { dropped++; continue; }

    kept++;
    out.push(`${m[1]}${fmtAssTime(ns)}${m[3]}${fmtAssTime(ne)}${m[5]}`);
  }

  return { text: out.join('\n'), kept, dropped };
}

// ------------------------------------------------------------ shot plan ----

/**
 * remapShotPlan — rewrite a `between(t,a,b)` ladder onto the variant timeline.
 *
 * recipes/trec-7i/shot-plan/w4b.txt and x4b.txt are ffmpeg expressions built
 * out of `between(t,START,END)*VALUE` terms plus an `if(between(t,a,b),V,...)`
 * CTA override. Framing is a function of WHICH SENTENCE is on screen, so when
 * a sentence is cut the framing window that belonged to it goes with it, and
 * every later window slides earlier by the same amount.
 *
 * A window wholly inside a removed span collapses to zero length and is
 * removed — leaving it in place would emit `between(t,20.5,20.5)`, which is
 * true for exactly one instant and reads as a one-frame flash.
 */
function remapShotPlan(expr, variant, { minWindowSec = 0.1 } = {}) {
  let removed = 0;
  const rewritten = String(expr || '').replace(
    /between\(\s*t\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g,
    (whole, a, b) => {
      const start = Number(a);
      const end = Number(b);
      const seg = variant.keep.find((k) => start < k.end - EPS && end > k.start + EPS);
      if (!seg) { removed++; return 'between(t,0,0)'; }
      const ns = variant.map(Math.max(start, seg.start));
      const ne = variant.map(Math.min(end, seg.end));
      if (ns == null || ne == null || ne - ns < minWindowSec) { removed++; return 'between(t,0,0)'; }
      return `between(t,${ns.toFixed(2)},${ne.toFixed(2)})`;
    },
  );

  // Collapse the dead terms rather than shipping `between(t,0,0)*440`, which
  // is a live term at t=0 and would fight the real first window.
  const cleaned = rewritten
    .replace(/between\(t,0,0\)\*\d+(\.\d+)?\s*\+\s*/g, '')
    .replace(/\+\s*between\(t,0,0\)\*\d+(\.\d+)?/g, '')
    .replace(/if\(between\(t,0,0\),\s*\d+(\.\d+)?\s*,\s*/g, '(');

  return { expr: cleaned, removedWindows: removed };
}

// ----------------------------------------------------------------- cues ----

/**
 * remapCues — push every timed cue through the same remap.
 *
 * Cue shape: { name, t }  or  { name, t0, d } for a settle.
 * A cue whose instant was cut away is reported, never silently moved: the
 * caller decides whether to clamp it to the nearest surviving moment or drop
 * the move entirely. Silently keeping a circle whose word is gone is the
 * recipe §7 failure — "it annotated the wrong moment and told the viewer the
 * wrong thing was important."
 */
function remapCues(cues, variant) {
  const out = [];
  const orphaned = [];
  for (const cue of cues || []) {
    if (cue.t != null) {
      const nt = variant.map(cue.t);
      if (nt == null) { orphaned.push({ ...cue, reason: 'instant was cut away' }); continue; }
      out.push({ ...cue, t: round3(nt), tMaster: cue.t });
      continue;
    }
    if (cue.t0 != null) {
      const ns = variant.map(cue.t0);
      const neSrc = cue.t0 + (cue.d || 0);
      const ne = variant.map(neSrc);
      if (ns == null) { orphaned.push({ ...cue, reason: 'settle start was cut away' }); continue; }
      const d = (ne == null ? variant.mapClamped(neSrc) : ne) - ns;
      if (!(d > 0)) { orphaned.push({ ...cue, reason: 'settle collapsed to zero' }); continue; }
      out.push({ ...cue, t0: round3(ns), d: round3(d), t0Master: cue.t0 });
      continue;
    }
    orphaned.push({ ...cue, reason: 'cue has neither t nor t0' });
  }
  return { cues: out, orphaned };
}

// -------------------------------------------------------------- ffmpeg -----

/**
 * frameRanges — inclusive 1-based frame index ranges into the SHARED rgba
 * directory. This is the whole point of the module: the same matte output
 * feeds both cuts, so §5's cost is paid once per recording, not once per cut.
 *
 * matte.js --mode rgba writes 1-based %06d.png, so range .from is
 * floor(start*fps)+1.
 */
function frameRanges(variant) {
  return variant.keep.map((k) => ({
    from: Math.floor(k.start * variant.fps) + 1,
    to: Math.floor(k.end * variant.fps),
  })).filter((r) => r.to >= r.from);
}

/**
 * copyFrameSlice — materialise a variant's frame directory from the shared
 * rgba directory using hard links (no copy, no re-encode, no re-matte).
 *
 * Falls back to a real copy when the filesystem refuses a link — /mnt/c under
 * WSL does. Recipe §5 already says to stage frames on the native Linux
 * filesystem for exactly this class of reason.
 */
function copyFrameSlice(srcDir, dstDir, variant, { pattern = (n) => `${String(n).padStart(6, '0')}.png` } = {}) {
  fs.mkdirSync(dstDir, { recursive: true });
  let out = 0;
  let linked = 0;
  let copied = 0;
  for (const range of frameRanges(variant)) {
    for (let n = range.from; n <= range.to; n++) {
      const src = path.join(srcDir, pattern(n));
      if (!fs.existsSync(src)) continue;
      out += 1;
      const dst = path.join(dstDir, pattern(out));
      try { fs.linkSync(src, dst); linked += 1; } catch (_) { fs.copyFileSync(src, dst); copied += 1; }
    }
  }
  return { frames: out, linked, copied, dir: dstDir };
}

/**
 * ffmpegAudioFilter — one filter_complex that re-slices the master audio to
 * the variant's keep list and concatenates. Applied to the MASTER audio, not
 * to per-take source audio: the master has already been through recipe §11's
 * chain and §4's sync assertion, and re-running either would drift.
 */
function ffmpegAudioFilter(variant, { inLabel = '0:a', outLabel = 'aout' } = {}) {
  const parts = variant.keep.map((k, i) => `[${inLabel}]atrim=start=${k.start}:end=${k.end},asetpts=PTS-STARTPTS[a${i}]`);
  const concat = `${variant.keep.map((_, i) => `[a${i}]`).join('')}concat=n=${variant.keep.length}:v=0:a=1[${outLabel}]`;
  return `${parts.join(';')};${concat}`;
}

/**
 * ffmpegVideoTrimFilter — same idea for a video stream, used when slicing a
 * finished mp4 rather than a frame directory.
 */
function ffmpegVideoTrimFilter(variant, { inLabel = '0:v', outLabel = 'vout' } = {}) {
  const parts = variant.keep.map((k, i) => `[${inLabel}]trim=start=${k.start}:end=${k.end},setpts=PTS-STARTPTS[v${i}]`);
  const concat = `${variant.keep.map((_, i) => `[v${i}]`).join('')}concat=n=${variant.keep.length}:v=1:a=0[${outLabel}]`;
  return `${parts.join(';')};${concat}`;
}

module.exports = {
  segmentsFromAss,
  buildVariant,
  remapAss,
  remapShotPlan,
  remapCues,
  frameRanges,
  copyFrameSlice,
  ffmpegAudioFilter,
  ffmpegVideoTrimFilter,
  parseAssTime,
  fmtAssTime,
};
