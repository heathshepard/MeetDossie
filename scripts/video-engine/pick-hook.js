#!/usr/bin/env node
/**
 * pick-hook.js — the one decision Heath's notes don't give a rule for:
 * which line opens the video. Proposed heuristic (this file): among the
 * transcript's sentences, score by emphasis-word density, and REQUIRE a
 * question mark when one is available — a question is what stops a scroll;
 * a flat statement with the same keyword density does not.
 *
 * Scoring:
 *   1. Split the transcript into sentences (., !, ? boundaries).
 *   2. density = (count of emphasis words in the sentence) / (word count).
 *      Emphasis words = brief.emphasisWords if given, else a built-in
 *      real-estate/SaaS pain-language bank (see EMPHASIS_BANK below).
 *   3. Candidates ending in "?" get a flat +0.5 bonus added to density —
 *      strong enough to win most ties against a non-question sentence with
 *      similar density, not so strong that a question with ZERO emphasis
 *      words beats a dense statement.
 *   4. Prefer sentences in the first 60% of the transcript (hooks belong
 *      near the top) — sentences past that point get a 0.7x multiplier.
 *   5. Highest score wins.
 *
 * HONEST LIMITATION (reported, not hidden): this is a keyword-density +
 * position heuristic, not a real "which line would stop a scroll" model.
 * It will reliably surface a relevant, early, keyword-dense line. It will
 * NOT reliably find the single best hook a human editor would pick — a
 * human hook choice also weighs delivery/energy/pause structure, none of
 * which this heuristic can see (it only has words + timestamps).
 *
 * Usage: node scripts/video-engine/pick-hook.js --transcript <json> [--emphasisWords a,b,c]
 * Prints { hookLine, scoredSentences: [...] } as JSON.
 */
const fs = require('fs');

const EMPHASIS_BANK = [
  'free', 'lose', 'losing', 'lost', 'deals', 'deal', 'paperwork', 'save', 'saves', 'saving',
  'hours', 'money', 'dossie', 'agents', 'realtor', 'realtors', 'client', 'clients', 'closing',
  'contract', 'stress', 'mistake', 'mistakes', 'automate', 'automatically', 'never', 'always',
  'why', 'how', 'transaction', 'coordinator', 'commission', 'miss', 'missed', 'deadline', 'deadlines',
];

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

function pickHook(transcript, emphasisWords) {
  const words = transcript.words.filter(w => w.type === 'word');
  const emphasisSet = new Set((emphasisWords && emphasisWords.length ? emphasisWords : EMPHASIS_BANK).map(w => w.toLowerCase()));
  const totalDuration = transcript.audio_duration_secs;

  const sentences = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]['"]?$/.test(w.text.trim())) { sentences.push(cur); cur = []; }
  }
  if (cur.length) sentences.push(cur);

  const scored = sentences.map(s => {
    const text = s.map(w => w.text).join(' ').replace(/\s+([.,!?])/g, '$1').trim();
    const emphasisCount = s.filter(w => emphasisSet.has(w.text.toLowerCase().replace(/[^a-z']/g, ''))).length;
    const density = s.length ? emphasisCount / s.length : 0;
    const isQuestion = /\?['"]?$/.test(text);
    const positionFraction = s[0].start / totalDuration;
    let score = density + (isQuestion ? 0.5 : 0);
    if (positionFraction > 0.6) score *= 0.7;
    return { text, startSec: s[0].start, endSec: s[s.length - 1].end, wordCount: s.length, emphasisCount, density: +density.toFixed(3), isQuestion, positionFraction: +positionFraction.toFixed(3), score: +score.toFixed(3) };
  });

  scored.sort((a, b) => b.score - a.score);
  return { hookLine: scored.length ? scored[0].text : null, scoredSentences: scored };
}

if (require.main === module) {
  const args = parseArgs();
  if (!args.transcript) { console.error('Usage: pick-hook.js --transcript <json> [--emphasisWords a,b,c]'); process.exit(1); }
  const transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf8'));
  const emphasisWords = args.emphasisWords ? String(args.emphasisWords).split(',') : null;
  console.log(JSON.stringify(pickHook(transcript, emphasisWords), null, 2));
}

module.exports = { pickHook, EMPHASIS_BANK };
