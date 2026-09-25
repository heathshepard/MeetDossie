'use strict';
/**
 * review-lib/audio.js — measured audio signals for review.js. Everything here
 * is deterministic (ffmpeg + arithmetic); no model calls. Each function takes
 * the decoded 16 kHz mono PCM of the FINISHED video's audio track and the
 * ElevenLabs word list transcribed FROM THAT OUTPUT (not the source), so what
 * gets measured is what a viewer actually hears.
 */
const { execFileSync } = require('child_process');

const SR = 16000;

function decodePcm(file, { band = true } = {}) {
  const af = band ? ['-af', 'highpass=f=120,lowpass=f=4000'] : [];
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), ...af, '-f', 's16le', '-'], { maxBuffer: 1 << 29 });
  const a = new Float32Array(buf.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = buf.readInt16LE(i * 2) / 32768;
  return a;
}

function rmsDb(a, s, e) {
  let q = 0, n = 0;
  for (let i = Math.max(0, s | 0); i < Math.min(a.length, e | 0); i++) { q += a[i] * a[i]; n++; }
  return n ? 20 * Math.log10(Math.sqrt(q / n) + 1e-9) : -99;
}

function envelope(a, hopSec = 0.01) {
  const hop = Math.round(hopSec * SR);
  const out = new Float32Array(Math.ceil(a.length / hop));
  for (let i = 0; i < out.length; i++) out[i] = rmsDb(a, i * hop, (i + 1) * hop);
  return { env: out, hopSec };
}

function median(arr) { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; }
function percentile(arr, p) { const s = arr.slice().sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; }

/** ebur128 integrated loudness / LRA / true peak of the whole track. */
function loudness(file) {
  const out = execFileSync('ffmpeg', ['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    + '';
  return parseEbu(out);
}
function loudnessFromStderr(file) {
  let txt = '';
  try { execFileSync('ffmpeg', ['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { txt = String(e.stderr || ''); }
  return txt;
}
function parseEbu(txt) {
  const tail = txt.slice(-1500);
  const I = /I:\s+([\-\d.]+) LUFS/.exec(tail);
  const LRA = /LRA:\s+([\-\d.]+) LU/.exec(tail);
  const peak = /Peak:\s+([\-\d.]+) dBFS/.exec(tail);
  return { integratedLufs: I ? +I[1] : null, lra: LRA ? +LRA[1] : null, truePeakDb: peak ? +peak[1] : null };
}
function measureLoudness(file) {
  // ffmpeg prints the ebur128 summary on stderr and exits 0, so run it and read stderr either way.
  const r = require('child_process').spawnSync('ffmpeg', ['-i', file, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return parseEbu((r.stderr || '') + (r.stdout || ''));
}

/**
 * Speech level + noise floor + music-under-voice estimate.
 * speechMedianDb: median RMS over transcribed words.
 * gapMedianDb: median RMS of the middle of inter-word gaps >= 250 ms — with
 * music mixed in this is the music bed level; without it's the noise floor.
 */
function levels(a, words) {
  const speech = words.map(w => rmsDb(a, w.start * SR, w.end * SR));
  const gaps = [];
  for (let i = 0; i < words.length - 1; i++) {
    const g = words[i + 1].start - words[i].end;
    if (g >= 0.25) gaps.push(rmsDb(a, (words[i].end + g * 0.35) * SR, (words[i + 1].start - g * 0.35) * SR));
  }
  return { speechMedianDb: median(speech), speechP10Db: percentile(speech, 0.1), gapMedianDb: gaps.length ? median(gaps) : null, gapCount: gaps.length };
}

/**
 * Room echo proxy: how long the energy takes to fall 20 dB after a word ends
 * into a real gap (>= 300 ms, next word not sooner). Dry / treated audio
 * decays in ~40-80 ms; a hollow untreated room or a long compressor release
 * holds the tail for 150 ms+. Also reports the tail energy 80-200 ms after
 * word end relative to the word itself.
 */
function roomTail(a, words) {
  const { env, hopSec } = envelope(a, 0.005);
  const hop = hopSec;
  const decays = [], tails = [];
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i];
    if (words[i + 1].start - w.end < 0.3) continue;
    if (w.end - w.start < 0.12) continue;
    const wordDb = rmsDb(a, w.start * SR, w.end * SR);
    const startIdx = Math.round(w.end / hop);
    let t20 = null;
    for (let k = startIdx; k < Math.min(env.length, startIdx + Math.round(0.4 / hop)); k++) {
      if (env[k] <= wordDb - 20) { t20 = (k - startIdx) * hop; break; }
    }
    decays.push(t20 == null ? 0.4 : t20);
    tails.push(rmsDb(a, (w.end + 0.08) * SR, (w.end + 0.2) * SR) - wordDb);
  }
  return { decay20MsMedian: decays.length ? Math.round(median(decays) * 1000) : null, tailDbMedian: tails.length ? +median(tails).toFixed(1) : null, samples: decays.length };
}

/** Low-mid "boxiness": 200-500 Hz energy vs 1-4 kHz energy over speech, in dB. */
function boxiness(file, words) {
  const lo = decodeBandPcm(file, 200, 500), hi = decodeBandPcm(file, 1000, 4000);
  const d = words.map(w => rmsDb(lo, w.start * SR, w.end * SR) - rmsDb(hi, w.start * SR, w.end * SR));
  return d.length ? +median(d).toFixed(1) : null;
}
function decodeBandPcm(file, f1, f2) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-af', `highpass=f=${f1},lowpass=f=${f2}`, '-f', 's16le', '-'], { maxBuffer: 1 << 29 });
  const a = new Float32Array(buf.length / 2);
  for (let i = 0; i < a.length; i++) a[i] = buf.readInt16LE(i * 2) / 32768;
  return a;
}

/**
 * Hard cuts inside speech: the envelope falls >= 18 dB within 20 ms from
 * speech level and stays down for 50 ms. Natural word endings decay over
 * 60-300 ms; a step like this only comes from a splice that landed on a
 * phoneme. Returns each event with the word it truncated.
 */
function hardDrops(a, words, speechMedianDb) {
  const { env, hopSec } = envelope(a, 0.01);
  const drops = [];
  for (let i = 2; i < env.length; i++) {
    if (env[i - 2] >= speechMedianDb - 10 && env[i] <= env[i - 2] - 18 && env[i] <= speechMedianDb - 26) {
      let low = true;
      for (let k = i; k < Math.min(env.length, i + 5); k++) if (env[k] > speechMedianDb - 20) low = false;
      if (!low) continue;
      const t = i * hopSec;
      const word = words.find(w => t >= w.start - 0.03 && t <= w.end + 0.03) || words.slice().reverse().find(w => w.end <= t + 0.03);
      drops.push({ atSec: +t.toFixed(2), fromDb: +env[i - 2].toFixed(1), toDb: +env[i].toFixed(1), word: word ? { text: word.text, start: word.start, end: word.end } : null });
      i += 5;
    }
  }
  return drops;
}

/**
 * Ending: is the last spoken word intact and does the voice get a clean
 * release before whatever follows (silence, card, music)?
 */
function ending(a, words, durationSec, sourceWords) {
  const last = words[words.length - 1];
  if (!last) return { ok: false, reason: 'no speech transcribed' };
  const { env, hopSec } = envelope(a, 0.01);
  const endIdx = Math.round(last.end / hopSec);
  // Largest single-hop drop in the 60 ms window around the transcribed word end.
  let maxStep = 0, stepAt = null;
  for (let k = Math.max(1, endIdx - 4); k < Math.min(env.length - 1, endIdx + 6); k++) {
    const step = env[k - 1] - env[k + 1];
    if (step > maxStep) { maxStep = step; stepAt = k * hopSec; }
  }
  const hardStop = maxStep >= 18;
  // Compare the last word's length with the same word in the source take when we have it.
  let sourceMatch = null;
  if (Array.isArray(sourceWords) && sourceWords.length) {
    const norm = s => s.toLowerCase().replace(/[^a-z']/g, '');
    const tailN = Math.min(3, words.length);
    const tail = words.slice(-tailN).map(w => norm(w.text));
    for (let i = sourceWords.length - tailN; i >= 0; i--) {
      if (sourceWords.slice(i, i + tailN).map(w => norm(w.text)).join(' ') === tail.join(' ')) {
        const sw = sourceWords[i + tailN - 1];
        sourceMatch = { text: sw.text, sourceDurMs: Math.round((sw.end - sw.start) * 1000), outputDurMs: Math.round((last.end - last.start) * 1000) };
        sourceMatch.shortByMs = sourceMatch.sourceDurMs - sourceMatch.outputDurMs;
        break;
      }
    }
  }
  const truncated = hardStop || (sourceMatch && sourceMatch.shortByMs >= 90);
  return {
    lastWord: last.text, lastWordStart: last.start, lastWordEnd: last.end,
    tailAfterVoiceSec: +(durationSec - last.end).toFixed(2),
    hardStop, stepDb: +maxStep.toFixed(1), stepAtSec: stepAt != null ? +stepAt.toFixed(2) : null,
    sourceMatch, truncated: !!truncated,
  };
}

/**
 * Word-level diff of what was intended vs what the output actually says.
 * intended = source transcript words that fall inside keepSegments (when a
 * cutlist is given) or the whole source transcript (then only fragments /
 * extra words are meaningful, since the editor chose what to drop).
 */
// Spoken number words -> value. Used to make a numeral in one transcript
// comparable to the same number spelled out in the other.
const NUM_WORDS = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * collapseNumberWords — merge a run of spoken number words into ONE token
 * holding the digits, so "twenty nineteen" and "2019" compare equal.
 *
 * WHY. ElevenLabs scribe renders the same spoken year differently depending
 * on the audio it is given: the SOURCE take came back "TREC 2019 replaced
 * 2018" and the rendered OUTPUT came back "TREC twenty nineteen replaced
 * twenty eighteen". The old norm() stripped every non-letter, so "2019"
 * normalised to the EMPTY STRING, could never match anything, and wordDiff
 * reported both years as words lost in the edit. They were not: the keep
 * segment covering 0.84-18.76 s contains both.
 *
 * That false positive is expensive, not cosmetic. It drove AUDIO to 1/5 and
 * emitted an audio.missing_words fix, which tells produce.js to widen
 * padStart/padEnd — so the loop would have spent rounds growing pads to
 * recover words that were never missing, and every one of those rounds would
 * have reported the same failure again.
 */
/**
 * splitNumberCompounds — "twenty-nineteen" is ONE token, not two.
 *
 * Scribe hyphenates spoken number compounds, so the real output for this
 * take was ["TREC", "twenty-nineteen", "replaced", "twenty-eighteen,"].
 * A first pass at the fix assumed two separate tokens and was verified
 * against a hand-written example rather than the actual transcript, so it
 * passed its test and changed nothing on real data. Split on hyphens first,
 * but ONLY when every part is a number word — "well-known" must stay one
 * token.
 */
function splitNumberCompounds(tokens) {
  const out = [];
  for (const t of tokens) {
    const parts = t.norm.split('-').filter(Boolean);
    if (parts.length > 1 && parts.every(p => p in NUM_WORDS || p === 'hundred' || p === 'thousand')) {
      parts.forEach((p, k) => out.push({ ...t, norm: p, splitFrom: t.text, partIndex: k }));
    } else {
      out.push(t);
    }
  }
  return out;
}

function collapseNumberWords(tokensIn) {
  const tokens = splitNumberCompounds(tokensIn);
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const bare = t.norm;
    if (!(bare in NUM_WORDS)) { out.push(t); continue; }
    // Greedily take the run of number words and turn it into digits. Handles
    // the two ways a year gets said: "twenty nineteen" (20,19 -> 2019) and
    // "two thousand nineteen".
    const run = [];
    let j = i;
    while (j < tokens.length && (tokens[j].norm in NUM_WORDS || tokens[j].norm === 'hundred' || tokens[j].norm === 'thousand')) { run.push(tokens[j]); j++; }
    if (run.length < 2) { out.push(t); continue; }
    const vals = run.map(r => r.norm === 'hundred' ? 'H' : r.norm === 'thousand' ? 'K' : NUM_WORDS[r.norm]);
    let digits = null;
    if (vals.length === 2 && typeof vals[0] === 'number' && typeof vals[1] === 'number' && vals[0] >= 10 && vals[0] % 10 === 0 && vals[1] < 100) {
      digits = String(vals[0] * 100 + vals[1]);               // twenty nineteen -> 2019
    } else if (vals.length === 2 && typeof vals[0] === 'number' && typeof vals[1] === 'number' && vals[0] >= 20 && vals[0] % 10 === 0) {
      digits = String(vals[0] + vals[1]);                     // twenty five -> 25
    } else if (vals[1] === 'K' && typeof vals[0] === 'number') {
      const rest = vals.slice(2).filter(v => typeof v === 'number').reduce((a, b) => a + b, 0);
      digits = String(vals[0] * 1000 + rest);                 // two thousand nineteen -> 2019
    }
    if (digits == null) { out.push(t); continue; }
    out.push({ ...run[0], norm: digits, end: run[run.length - 1].end, collapsedFrom: run.length });
    i = j - 1;
  }
  return out;
}

function wordDiff(outputWords, sourceWords, keepSegments) {
  // Digits are KEPT (the old version stripped them, which is the bug above).
  const norm = s => s.toLowerCase().replace(/[^a-z0-9'\-]/g, '');
  let intended = sourceWords;
  if (Array.isArray(keepSegments) && keepSegments.length) {
    intended = sourceWords.filter(w => keepSegments.some(seg => w.start >= seg.start - 0.02 && w.end <= seg.end + 0.02));
  }
  // Collapse spoken numbers on BOTH sides so either transcript's rendering
  // of the same number lines up.
  const intendedTok = collapseNumberWords(intended.map(w => ({ text: w.text, start: w.start, end: w.end, norm: norm(w.text) })));
  const outputTok = collapseNumberWords(outputWords.map(w => ({ text: w.text, start: w.start, end: w.end, norm: norm(w.text) })));
  intended = intendedTok;
  outputWords = outputTok;
  const A = intendedTok.map(t => t.norm), B = outputTok.map(t => t.norm);
  const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const missing = [], extra = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { missing.push({ text: intended[i].text, start: intended[i].start, end: intended[i].end }); i++; }
    else { extra.push({ text: outputWords[j].text, start: outputWords[j].start, end: outputWords[j].end }); j++; }
  }
  while (i < A.length) { missing.push({ text: intended[i].text, start: intended[i].start, end: intended[i].end }); i++; }
  while (j < B.length) { extra.push({ text: outputWords[j].text, start: outputWords[j].start, end: outputWords[j].end }); j++; }
  const fragments = extra.filter(e => /-$/.test(e.text.trim()) || e.text.replace(/[^a-z']/gi, '').length <= 2 && !/^(a|i|an|to|of|in|is|it|my|we|do|so|or|at|on|if|be|me|up|no|by|us)$/i.test(e.text.replace(/[^a-z']/gi, '')));
  return { intendedCount: intended.length, outputCount: outputWords.length, missing, extra, fragments, hadKeepSegments: !!(keepSegments && keepSegments.length) };
}

/**
 * §6 delivery-chain proxies, all over transcribed words of the OUTPUT:
 *   crestDb  — median peak-to-RMS of each word. Natural speech sits ~12-18 dB;
 *              a squashed, "excessively compressed" voice drops under ~9 dB.
 *   hfBalanceDb — 4-8 kHz vs 1-4 kHz energy. Under ~-28 dB reads muffled /
 *              underwater (over-denoised); over ~-8 dB reads harsh / metallic.
 *   deadAir  — gaps >= 0.8 s between consecutive output words (pauses the
 *              cut left in), with their positions.
 */
function deliveryChain(file, words) {
  const full = decodePcm(file, { band: false });
  const crests = [];
  for (const w of words) {
    const s = Math.round(w.start * SR), e = Math.round(w.end * SR);
    if (e - s < SR * 0.08) continue;
    let peak = 0, q = 0, n = 0;
    for (let i = Math.max(0, s); i < Math.min(full.length, e); i++) { const v = Math.abs(full[i]); if (v > peak) peak = v; q += v * v; n++; }
    if (n && q > 0) crests.push(20 * Math.log10(peak / Math.sqrt(q / n)));
  }
  const hf = decodeBandPcm(file, 4000, 7800), mf = decodeBandPcm(file, 1000, 4000);
  const hfd = words.map(w => rmsDb(hf, w.start * SR, w.end * SR) - rmsDb(mf, w.start * SR, w.end * SR)).filter(Number.isFinite);
  const deadAir = [];
  for (let i = 0; i < words.length - 1; i++) { const g = words[i + 1].start - words[i].end; if (g >= 0.8) deadAir.push({ atSec: +words[i].end.toFixed(2), gapSec: +g.toFixed(2), after: words[i].text }); }
  return { crestDb: crests.length ? +median(crests).toFixed(1) : null, hfBalanceDb: hfd.length ? +median(hfd).toFixed(1) : null, deadAir };
}

/** Speaking-rate per sentence, to spot a rushed / trailing last line. */
function sentenceRates(words) {
  const sentences = [];
  let cur = [];
  for (const w of words) { cur.push(w); if (/[.!?]$/.test(w.text.trim())) { sentences.push(cur); cur = []; } }
  if (cur.length) sentences.push(cur);
  return sentences.map(s => ({ text: s.map(w => w.text).join(' '), start: s[0].start, end: s[s.length - 1].end, wps: +(s.length / Math.max(0.2, s[s.length - 1].end - s[0].start)).toFixed(2) }));
}

module.exports = { SR, decodePcm, rmsDb, envelope, median, measureLoudness, levels, roomTail, boxiness, hardDrops, ending, wordDiff, sentenceRates, deliveryChain };
