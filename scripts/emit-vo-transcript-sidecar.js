#!/usr/bin/env node
'use strict';

// scripts/emit-vo-transcript-sidecar.js
//
// Writes the `<video-stem>.transcript.json` sidecar that the quality gate
// looks for next to a local video (api/_lib/verify-video-quality.js,
// loadWordTimestampsSidecar / pickCaptionSampleTimes).
//
// WHY IT MATTERS. The `captions_present` rule samples 5 moments and checks the
// burned-in caption is legible AND has CHANGED 1s later. Without a sidecar it
// falls back to fixed fractions of runtime, which land wherever they land —
// including inside a deliberate silent hold, where the caption is correctly
// frozen because nobody is speaking. That scored a correctly-captioned cut
// 2-3/5 and failed it. With the sidecar the gate samples REAL SPOKEN WORDS,
// which is what the rule is actually trying to measure.
//
// This does not fake anything: the timings come from the ElevenLabs
// with-timestamps alignment that produced the voiceover, offset onto the
// output timeline by each voice segment's own `at`.
//
// Usage:
//   node scripts/emit-vo-transcript-sidecar.js --spec <spec.json> --video <final.mp4>

const fs = require('fs');
const path = require('path');

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Group an ElevenLabs character alignment into word-level {text,start,end}. */
function wordsFromCharAlignment(timing, offsetSec) {
  const chars = timing.characters || [];
  const cs = timing.char_start || timing.character_start_times_seconds || [];
  const ce = timing.char_end || timing.character_end_times_seconds || [];
  if (!chars.length || chars.length !== cs.length) return [];

  const words = [];
  let cur = null;
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (/\s/.test(ch)) {
      if (cur) { words.push(cur); cur = null; }
      continue;
    }
    if (!cur) cur = { type: 'word', text: '', start: cs[i] + offsetSec, end: ce[i] + offsetSec };
    cur.text += ch;
    cur.end = ce[i] + offsetSec;
  }
  if (cur) words.push(cur);
  return words.filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start);
}

function main() {
  const specPath = arg('spec');
  const videoPath = arg('video');
  if (!specPath || !videoPath) {
    console.error('Usage: node scripts/emit-vo-transcript-sidecar.js --spec <spec.json> --video <final.mp4>');
    process.exit(1);
  }
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const voices = spec.voice || [];
  if (!voices.length) { console.error('spec has no voice[] segments'); process.exit(1); }

  let words = [];
  for (const v of voices) {
    if (!v.timing || !fs.existsSync(v.timing)) {
      console.error(`! voice segment at ${v.at}s has no readable timing file (${v.timing}) — skipped`);
      continue;
    }
    const timing = JSON.parse(fs.readFileSync(v.timing, 'utf8'));
    const got = wordsFromCharAlignment(timing, Number(v.at) || 0);
    console.error(`  + ${got.length} words from ${path.basename(v.timing)} at +${v.at}s`);
    words = words.concat(got);
  }
  if (!words.length) { console.error('no word timings recovered — refusing to write an empty sidecar'); process.exit(1); }
  words.sort((a, b) => a.start - b.start);

  const out = videoPath.replace(/\.[^./\\]+$/, '') + '.transcript.json';
  fs.writeFileSync(out, JSON.stringify({ words }, null, 1));
  console.error(`wrote ${out} (${words.length} words, ${words[0].start.toFixed(2)}s - ${words[words.length - 1].end.toFixed(2)}s)`);
}

main();
