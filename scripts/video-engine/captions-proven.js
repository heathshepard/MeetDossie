#!/usr/bin/env node
/**
 * captions-proven.js — the caption generator that actually shipped.
 *
 * PROVENANCE: ported from scratchpad/mkcaps.py + caps4.ass, the generator
 * behind Downloads/dossie_water_60s_v4.mp4. captions.js remains the
 * general-purpose generator for the existing produce.js pipeline; this file
 * is the exact proven style, kept separate so porting it could not regress
 * anything already working.
 *
 * WHY THIS STYLE, SPECIFICALLY
 *   Style: Cap,DejaVu Sans,82,&H00FFFFFF,&H00FFFFFF,&H00101010,&HC0000000,
 *          -1,0,0,0,100,100,1,0,3,20,0,8,80,80,175,1
 *   - BorderStyle 3 (opaque box) not 1 (outline). Over a scrolling CONTRACT
 *     an outline is unreadable — black text on white paper behind white text
 *     with a thin outline is mush. The box guarantees contrast over anything.
 *   - Alignment 8 = TOP-centre, MarginV 175. This is the load-bearing choice.
 *     Top keeps captions off his face (he is bottom-aligned in every framing)
 *     AND out of the bottom strip where Reels/TikTok/Shorts stack their own
 *     UI, username, and caption. Bottom-centre captions get covered by the
 *     platform on all three.
 *   - 82px. Heath's note: "captions one size larger than feels right on
 *     desktop — they read small on a phone."
 *
 * CHUNKING (proven): break on 3 WORDS or 19 CHARACTERS or a >0.4 s speech
 * gap, whichever comes first. 19 characters is what keeps a chunk on ONE line
 * at 82px inside an 1080-wide frame with 80px side margins; let it run to two
 * and the box height changes shot to shot, which flickers.
 *
 * POP-IN: {\fad(40,60)\t(0,90,\fscx105\fscy105)\t(90,160,\fscx100\fscy100)}
 * A 105% overshoot settling to 100% over 160 ms. It reads as the word landing
 * rather than appearing.
 *
 * EMPHASIS: recoloured &H43C5F5& (ASS is BGR — this is a warm amber/gold).
 *
 * TIMING REMAP: when segments are cut out of the source, every word timestamp
 * is remapped onto the post-cut timeline (see remapTime). A caption file built
 * against source timings and burned onto a cut render drifts further out of
 * sync with every removed segment.
 *
 * ---------------------------------------------------------------------------
 * MODES
 *   --mode fragment   (default) the proven 3-word / 19-char cards.
 *   --mode thought    full-thought mode: groups into complete CLAUSES instead
 *                     of fragments, for sound-off viewers (~85% on Facebook).
 *                     A 3-word card is great when you can hear the sentence
 *                     it belongs to; with the sound off it is a stream of
 *                     disconnected fragments and the viewer never gets a whole
 *                     idea. Thought mode breaks on punctuation and long
 *                     pauses, wraps to <= maxCharsPerLine, and holds each
 *                     clause for its full spoken duration.
 * ---------------------------------------------------------------------------
 *
 * Usage:
 *   node scripts/video-engine/captions-proven.js --transcript stt.json \
 *     --out caps.ass [--cutlist cutlist.json] [--mode fragment|thought] \
 *     [--emphasis "july,1st,terminate,..."] [--speed 1.08] \
 *     [--maxWords 3] [--maxChars 19] [--gap 0.4] [--marginV 175] [--size 82] \
 *     [--hook "TEXT"] [--hookSec 2.6] [--cta "TEXT"] [--ctaSec 4.0]
 */
'use strict';
const fs = require('fs');

const PROVEN = {
  font: 'DejaVu Sans',
  size: 82,
  primary: '&H00FFFFFF',
  outlineColour: '&H00101010',
  backColour: '&HC0000000',
  borderStyle: 3,      // opaque box
  outline: 20,         // box padding, in this BorderStyle
  shadow: 0,
  alignment: 8,        // top-centre
  marginL: 80, marginR: 80, marginV: 175,
  spacing: 1,
  emphasisColour: '&H43C5F5&',
  popIn: '{\\fad(40,60)\\t(0,90,\\fscx105\\fscy105)\\t(90,160,\\fscx100\\fscy100)}',
  maxWords: 3,
  maxChars: 19,
  gapSec: 0.4,
  tailPad: 0.12,       // hold each card this long past the last word's end
  // thought mode
  thoughtMaxChars: 30,     // per line
  thoughtMaxLines: 2,
  thoughtMaxSec: 3.2,
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

function fmtAssTime(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

/**
 * remapTime — SOURCE second -> POST-CUT second.
 *
 * This is the piece mkcaps.py grew last and the piece most likely to be
 * dropped in a re-implementation. Without it, a caption file built from the
 * source transcript and burned onto a cut render is correct for the first
 * kept segment and progressively wrong for every one after.
 */
function makeRemap(keepSegments, speed = 1) {
  if (!keepSegments || !keepSegments.length) return (t) => t / speed;
  const segs = keepSegments.slice().sort((a, b) => a.start - b.start);
  return (t) => {
    let acc = 0;
    for (const seg of segs) {
      if (t < seg.start) return acc / speed;              // inside a removed gap
      if (t <= seg.end) return (acc + (t - seg.start)) / speed;
      acc += seg.end - seg.start;
    }
    return acc / speed;
  };
}

/** Words that survived the cut. */
function keptWords(words, keepSegments) {
  if (!keepSegments || !keepSegments.length) return words;
  return words.filter(w => keepSegments.some(s => w.start >= s.start - 0.01 && w.end <= s.end + 0.01));
}

function cleanKey(t) {
  return t.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/**
 * chunkFragments — the PROVEN chunker: 3 words OR 19 chars OR a >gap pause.
 * Order matters: the check runs BEFORE the word is added, so a chunk is
 * flushed when adding the next word would break a rule.
 */
function chunkFragments(words, { maxWords, maxChars, gapSec }) {
  const chunks = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const cand = cur.concat([w]).map(x => x.text.trim()).join(' ');
      const gap = w.start - cur[cur.length - 1].end;
      if (cur.length >= maxWords || cand.length > maxChars || gap > gapSec) {
        chunks.push(cur); cur = [];
      }
    }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * chunkThoughts — full-thought mode (sound-off).
 *
 * Breaks on real clause boundaries — terminal punctuation, then comma /
 * semicolon / colon, then a long pause — instead of a word count, and wraps
 * the result to at most `maxLines` lines of `maxCharsPerLine`. A clause that
 * would run past `maxSec` or past the line budget is split at the last
 * clause-ish boundary inside it rather than mid-phrase.
 */
function chunkThoughts(words, { maxCharsPerLine, maxLines, maxSec, gapSec }) {
  const budget = maxCharsPerLine * maxLines;
  const chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; } };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (cur.length) {
      const cand = cur.concat([w]).map(x => x.text.trim()).join(' ');
      const dur = w.end - cur[0].start;
      const gap = w.start - cur[cur.length - 1].end;
      if (cand.length > budget || dur > maxSec || gap > gapSec * 2.2) flush();
    }
    cur.push(w);
    const t = w.text.trim();
    if (/[.!?]["')\]]?$/.test(t)) { flush(); continue; }
    // A comma break only counts once the clause has enough weight to stand
    // alone — otherwise "Texas," becomes its own card and we are back to
    // fragments with extra steps.
    if (/[,;:]$/.test(t)) {
      const len = cur.map(x => x.text.trim()).join(' ').length;
      if (len >= Math.round(maxCharsPerLine * 0.8)) flush();
    }
  }
  flush();

  // Orphan merge. Splitting on a hard budget leaves tails like a lone
  // "FIVE." on its own card — which in sound-off mode is the exact failure
  // this mode exists to prevent: the viewer reads "...CAN COST YOU A DEAL IN
  // WEEK" and then, separately, "FIVE." Pull a 1-2 word tail back onto the
  // previous card whenever the merged card still fits the budget.
  const merged = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    if (prev && c.length <= 2) {
      const cand = prev.concat(c);
      const len = cand.map(x => x.text.trim()).join(' ').length;
      const dur = cand[cand.length - 1].end - cand[0].start;
      if (len <= budget && dur <= maxSec * 1.25) { merged[merged.length - 1] = cand; continue; }
    }
    merged.push(c);
  }
  return merged;
}

/** Greedy wrap to \N-separated ASS lines. */
function wrapAss(text, maxCharsPerLine) {
  const words = text.split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    // Measure against the VISIBLE text, ignoring ASS override tags, or a
    // recoloured word blows the line budget with markup nobody can see.
    const visible = s => s.replace(/\{[^}]*\}/g, '');
    const next = cur ? `${cur} ${w}` : w;
    if (visible(next).length > maxCharsPerLine && cur) { lines.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.join('\\N');
}

function buildHeader(opt) {
  const styles = [
    `Style: Cap,${opt.font},${opt.size},${opt.primary},${opt.primary},${opt.outlineColour},${opt.backColour},-1,0,0,0,100,100,${opt.spacing},0,${opt.borderStyle},${opt.outline},${opt.shadow},${opt.alignment},${opt.marginL},${opt.marginR},${opt.marginV},1`,
  ];
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
${styles.join('\n')}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/**
 * build — returns { ass, events, chunks, stats }.
 */
function build(opts) {
  const {
    transcript, cutlist = null, mode = 'fragment', speed = 1,
    emphasis = new Set(), upper = true,
    maxWords = PROVEN.maxWords, maxChars = PROVEN.maxChars, gapSec = PROVEN.gapSec,
    tailPad = PROVEN.tailPad,
    thoughtMaxChars = PROVEN.thoughtMaxChars, thoughtMaxLines = PROVEN.thoughtMaxLines,
    thoughtMaxSec = PROVEN.thoughtMaxSec,
    hookSuppressUntil = 0,
    style = {},
  } = opts;

  const styleOpt = { ...PROVEN, ...style };
  const words = (transcript.words || []).filter(w => w.type === 'word');
  const keep = cutlist && cutlist.keepSegments ? cutlist.keepSegments : null;
  const kept = keptWords(words, keep);
  const remap = makeRemap(keep, speed);

  const chunks = mode === 'thought'
    ? chunkThoughts(kept, { maxCharsPerLine: thoughtMaxChars, maxLines: thoughtMaxLines, maxSec: thoughtMaxSec, gapSec })
    : chunkFragments(kept, { maxWords, maxChars, gapSec });

  const events = [];
  let covered = 0;
  for (const c of chunks) {
    const st = remap(c[0].start);
    const en = remap(c[c.length - 1].end) + tailPad;
    covered += c.length;
    const parts = c.map(w => {
      const t = w.text.trim();
      const shown = upper ? t.toUpperCase() : t;
      return emphasis.has(cleanKey(t))
        ? `{\\c${styleOpt.emphasisColour}}${shown}{\\c&HFFFFFF&}`
        : shown;
    });
    let text = parts.join(' ');
    if (mode === 'thought') text = wrapAss(text, thoughtMaxChars);
    // Don't stack a caption under a standing hook overlay.
    if (en <= hookSuppressUntil) continue;
    const start = Math.max(st, hookSuppressUntil);
    events.push(`Dialogue: 0,${fmtAssTime(start)},${fmtAssTime(Math.max(en, start + 0.25))},Cap,,0,0,0,,${styleOpt.popIn}${text}`);
  }

  const stats = {
    mode, chunks: chunks.length, events: events.length,
    keptWords: kept.length, coveredWords: covered,
    sourceWords: words.length,
    lastEndSec: chunks.length ? +remap(chunks[chunks.length - 1].slice(-1)[0].end).toFixed(2) : 0,
    avgWordsPerCard: chunks.length ? +(covered / chunks.length).toFixed(2) : 0,
  };
  if (covered !== kept.length) {
    // Every kept word must appear on some card. A dropped word is a word the
    // sound-off viewer never gets.
    throw new Error(`caption coverage ${covered}/${kept.length} — a kept word has no card. Refusing to write a lossy caption file.`);
  }
  return { ass: buildHeader(styleOpt) + events.join('\n') + '\n', events, chunks, stats };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.transcript || !args.out) {
    console.error('Usage: captions-proven.js --transcript <json> --out <ass> [--cutlist <json>] [--mode fragment|thought] [--emphasis "a,b,c"] [--speed 1.08]');
    process.exit(1);
  }
  const transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf8'));
  const cutlist = args.cutlist && args.cutlist !== true && fs.existsSync(args.cutlist)
    ? JSON.parse(fs.readFileSync(args.cutlist, 'utf8')) : null;
  const emphasis = new Set(
    (args.emphasis && args.emphasis !== true ? String(args.emphasis).split(',') : [])
      .map(s => cleanKey(s)).filter(Boolean)
  );
  const style = {};
  if (args.marginV != null) style.marginV = +args.marginV;
  if (args.size != null) style.size = +args.size;

  const res = build({
    transcript, cutlist,
    mode: args.mode === 'thought' ? 'thought' : 'fragment',
    speed: args.speed != null ? +args.speed : 1,
    emphasis,
    maxWords: args.maxWords != null ? +args.maxWords : PROVEN.maxWords,
    maxChars: args.maxChars != null ? +args.maxChars : PROVEN.maxChars,
    gapSec: args.gap != null ? +args.gap : PROVEN.gapSec,
    hookSuppressUntil: args.hookSec != null ? +args.hookSec : 0,
    style,
  });
  fs.writeFileSync(args.out, res.ass);
  console.log(JSON.stringify(res.stats, null, 2));
}

module.exports = { build, chunkFragments, chunkThoughts, makeRemap, keptWords, wrapAss, fmtAssTime, PROVEN };
if (require.main === module) main();
