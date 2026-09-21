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
 *     --cutlist <cutlist json> --brief <brief json> --out <captions.ass>
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

const ASS_HEADER = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Caption,Arial,56,&H00FFFFFF,&H000000FF,&H00000000,&H90000000,1,0,0,0,100,100,0,0,1,4,0,2,80,80,220,1
Style: Hook,Cormorant Garamond,60,&H00E6E5F5,&H000000FF,&H001A1A1A,&H00000000,1,0,0,0,100,100,0,0,1,0,3,5,90,90,300,1
Style: CTA,Cormorant Garamond,56,&H006B83E8,&H000000FF,&H001A1A1A,&H00000000,1,0,0,0,100,100,0,0,1,0,3,5,90,90,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

// ASS BGR hex for the Dossie coral (#E8836B) used to emphasize words.
const EMPHASIS_COLOR = '&H006B83E8&'; // BGR order: 6b 83 e8 = coral

function main() {
  const args = parseArgs();
  const transcriptPath = args.transcript, cutlistPath = args.cutlist, briefPath = args.brief, outPath = args.out;
  if (!transcriptPath || !cutlistPath || !outPath) {
    console.error('Usage: captions.js --transcript <json> --cutlist <json> [--brief <json>] --out <ass>');
    process.exit(1);
  }
  const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const cutlist = JSON.parse(fs.readFileSync(cutlistPath, 'utf8'));
  const brief = briefPath && fs.existsSync(briefPath) ? JSON.parse(fs.readFileSync(briefPath, 'utf8')) : {};
  const emphasis = new Set((brief.emphasisWords || []).map(w => w.toLowerCase()));

  const words = transcript.words.filter(w => w.type === 'word');
  // Keep only words that fall inside a kept segment (i.e. survived the cut).
  const kept = words.filter(w => cutlist.keepSegments.some(seg => w.start >= seg.start - 0.01 && w.end <= seg.end + 0.01));

  const events = [];

  // Hook card: first ~2.2s, or up to the first caption chunk if shorter.
  if (brief.hookLine) {
    const hookEnd = Math.min(2.2, kept.length ? remapTime(kept[0].start, cutlist.keepSegments) + 1.4 : 2.2);
    events.push(`Dialogue: 0,${fmtAssTime(0)},${fmtAssTime(hookEnd)},Hook,,0,0,0,,${brief.hookLine.replace(/\n/g, '\\N')}`);
  }

  // Caption chunks: group kept words into ~4-word / ~2.2s chunks.
  let chunk = [];
  let chunkStart = null;
  const flush = () => {
    if (!chunk.length) return;
    const start = remapTime(chunk[0].start, cutlist.keepSegments);
    const end = remapTime(chunk[chunk.length - 1].end, cutlist.keepSegments);
    const text = chunk.map(w => {
      const clean = w.text.trim();
      const isEmphasis = emphasis.has(clean.toLowerCase().replace(/[^a-z']/gi, ''));
      return isEmphasis ? `{\\c${EMPHASIS_COLOR}}${clean}{\\c&H00FFFFFF&}` : clean;
    }).join(' ');
    events.push(`Dialogue: 0,${fmtAssTime(start)},${fmtAssTime(Math.max(end, start + 0.3))},Caption,,0,0,0,,${text}`);
    chunk = [];
  };
  for (const w of kept) {
    if (chunk.length === 0) chunkStart = w.start;
    chunk.push(w);
    const dur = w.end - chunkStart;
    if (chunk.length >= 4 || dur >= 2.2 || /[.!?]$/.test(w.text.trim())) flush();
  }
  flush();

  // CTA card: last 2.5s of the post-cut timeline.
  const totalKeptSec = cutlist.stats.keptSeconds;
  if (brief.cta) {
    const ctaStart = Math.max(0, totalKeptSec - 2.5);
    events.push(`Dialogue: 1,${fmtAssTime(ctaStart)},${fmtAssTime(totalKeptSec)},CTA,,0,0,0,,${brief.cta.replace(/\n/g, '\\N')}`);
  }

  fs.writeFileSync(outPath, ASS_HEADER + events.join('\n') + '\n');
  console.log(`Wrote ${events.length} caption events to ${outPath}`);
}

main();
