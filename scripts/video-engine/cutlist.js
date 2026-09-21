#!/usr/bin/env node
/**
 * cutlist.js — turns an ElevenLabs scribe_v1 word-timestamp transcript into
 * a cut list that drops dead air, filler words (um/uh/erm), and false
 * starts/stutters, with configurable padding so the result doesn't sound
 * robotic.
 *
 * Usage:
 *   node scripts/video-engine/cutlist.js --transcript <scribe json> --out <cutlist json> \
 *     [--silenceThreshold 0.6] [--padStart 0.08] [--padEnd 0.12] [--minKeep 0.3]
 *
 * Heuristics:
 *   - Silence: gap between word[i].end and word[i+1].start > silenceThreshold
 *     -> cut the middle of the gap, leaving `padStart`/`padEnd` seconds of
 *     natural room on each side (so it doesn't feel hard-clipped).
 *   - Filler words: um, uh, erm, uhh, umm (word-boundary, case-insensitive)
 *     -> cut the word +/- small pad.
 *   - False starts / stutters: a word ending in one or more trailing hyphens
 *     ("t-t--"), OR an immediate exact repeat of the same word/short phrase
 *     within the next 2 words -> cut the truncated/duplicate fragment only,
 *     keep the completed version.
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

const FILLER_RE = /^(um+|uh+|erm+|hm+)[.,]?$/i;

function main() {
  const args = parseArgs();
  const transcriptPath = args.transcript;
  const outPath = args.out;
  if (!transcriptPath || !outPath) {
    console.error('Usage: cutlist.js --transcript <json> --out <json>');
    process.exit(1);
  }
  const silenceThreshold = parseFloat(args.silenceThreshold || '0.6');
  const padStart = parseFloat(args.padStart || '0.08');
  const padEnd = parseFloat(args.padEnd || '0.12');
  const minKeep = parseFloat(args.minKeep || '0.3');

  const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const words = data.words.filter(w => w.type === 'word');
  const duration = data.audio_duration_secs;

  const cuts = [];

  // 1. Filler words + trailing-hyphen stutter fragments.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const stripped = w.text.trim();
    if (FILLER_RE.test(stripped)) {
      cuts.push({ start: w.start, end: w.end, reason: 'filler', text: stripped });
      continue;
    }
    if (/-{1,}$/.test(stripped) && stripped.length <= 6) {
      // truncated fragment like "t-t--" — cut this word and any immediately
      // following duplicate truncations, up to (but not including) the
      // first word that looks like a real completed word.
      cuts.push({ start: w.start, end: w.end, reason: 'false_start_fragment', text: stripped });
    }
  }

  // 2. Immediate exact-phrase repeats (e.g. "I want ... I want you to").
  //    Look for a repeated run of 1-3 words starting at i that recurs
  //    starting at some j > i within the next 6 words, with only small
  //    filler/silence between — keep the SECOND occurrence, cut the first.
  for (let i = 0; i < words.length - 1; i++) {
    for (let runLen = 3; runLen >= 1; runLen--) {
      if (i + runLen * 2 > words.length) continue;
      const a = words.slice(i, i + runLen).map(w => w.text.toLowerCase().replace(/[^a-z']/g, ''));
      const b = words.slice(i + runLen, i + runLen * 2).map(w => w.text.toLowerCase().replace(/[^a-z']/g, ''));
      const lastOfFirst = words[i + runLen - 1];
      const firstOfSecond = words[i + runLen];
      const endsSentence = /[.!?]\s*$/.test(lastOfFirst.text.trim());
      const interRunGap = firstOfSecond.start - lastOfFirst.end;
      // A real stutter/false-start repeats itself almost immediately with no
      // sentence-final punctuation in between. Two legitimately separate
      // sentences that happen to start with the same word (e.g. "Dossi.
      // Dossi is...") must NOT be treated as a false start.
      if (a.join(' ') === b.join(' ') && a.join('') !== '' && !endsSentence && interRunGap < 0.3) {
        const first = words[i];
        cuts.push({ start: first.start, end: lastOfFirst.end, reason: 'repeated_false_start', text: a.join(' ') });
        break;
      }
    }
  }

  // 3. Dead-air silence gaps between consecutive words (and lead-in/tail).
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > silenceThreshold) {
      cuts.push({
        start: words[i].end + padStart,
        end: words[i + 1].start - padEnd,
        reason: 'dead_air',
        text: null,
      });
    }
  }
  if (words.length && words[0].start > silenceThreshold) {
    cuts.push({ start: 0, end: words[0].start - padEnd, reason: 'lead_in_silence', text: null });
  }
  if (words.length && (duration - words[words.length - 1].end) > silenceThreshold) {
    cuts.push({ start: words[words.length - 1].end + padStart, end: duration, reason: 'tail_silence', text: null });
  }

  // Merge overlapping/adjacent cuts, apply pad around word-based cuts too.
  const padded = cuts.map(c => {
    if (c.reason === 'dead_air' || c.reason === 'lead_in_silence' || c.reason === 'tail_silence') return c;
    return { ...c, start: Math.max(0, c.start - padStart), end: c.end + padEnd };
  }).filter(c => c.end > c.start);

  padded.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of padded) {
    if (merged.length && c.start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, c.end);
      merged[merged.length - 1].reasons = [...new Set([...(merged[merged.length - 1].reasons || [merged[merged.length - 1].reason]), c.reason])];
    } else {
      merged.push({ ...c, reasons: [c.reason] });
    }
  }

  // Build the KEEP segments (inverse of cuts), dropping any sliver shorter than minKeep.
  const keep = [];
  let cursor = 0;
  for (const c of merged) {
    if (c.start - cursor >= minKeep) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  if (duration - cursor >= minKeep) keep.push({ start: cursor, end: duration });

  const totalCutSec = merged.reduce((s, c) => s + (c.end - c.start), 0);
  const keptSec = keep.reduce((s, k) => s + (k.end - k.start), 0);

  const result = {
    sourceDuration: duration,
    cuts: merged,
    keepSegments: keep,
    stats: {
      totalCuts: merged.length,
      totalCutSeconds: +totalCutSec.toFixed(2),
      keptSeconds: +keptSec.toFixed(2),
      reasonBreakdown: merged.reduce((acc, c) => {
        for (const r of c.reasons) acc[r] = (acc[r] || 0) + 1;
        return acc;
      }, {}),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.stats, null, 2));
}

main();
