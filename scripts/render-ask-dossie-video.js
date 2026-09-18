#!/usr/bin/env node
/**
 * render-ask-dossie-video.js
 *
 * The RENDER half of the D1 "Ask Dossie" real-question demo
 * (docs/CONTENT-FORMAT-LIBRARY.md §3 D1, §5.2).
 *
 * scripts/generate-ask-dossie-video.js captures real frames of the live app
 * answering a real question and stops there — its own header says "IT DOES NOT
 * RENDER A VIDEO". Nothing existed on the other side of that handoff, so D1
 * could only be finished by a person hand-writing a spec JSON. That is exactly
 * why zero videos went out in the last 24h with three working generators on
 * disk: the generators work, nothing connects them.
 *
 * This file is that connection, and it is deliberately unattended-safe:
 *
 *   capture dir  ->  VO (ElevenLabs)  ->  spec JSON  ->  build-shortform-video.py
 *                ->  quality gate (incl. CTA-URL resolve)  ->  watch folder
 *
 * and then scripts/queue-finished-videos.py takes it into video_library for
 * Heath's approval. Publishing is NOT this script's business.
 *
 * ── WHAT IS AND IS NOT GENERATED ────────────────────────────────────────────
 * Nothing here invents a claim about the product.
 *   * The question is the one that was actually typed (answer.json).
 *   * The answer read aloud and burned into captions is `answer_verbatim` —
 *     the exact string the app rendered. Trailing SENTENCES may be cut to fit
 *     runtime; no word is ever changed, reordered or paraphrased (playbook §5
 *     items 6 / 6a).
 *   * Hook copy comes from HOOKS below: a CLOSED, pre-approved line per
 *     verified capability, mirroring the closed question set in the capture
 *     half. An unmapped capability is a hard refusal, never an improvised hook.
 *   * The two connective narration sentences are format constants, not claims.
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * Heath's clone narrates. Luna is NOT used to read the answer aloud, on
 * purpose: capability #12 (spoken voice I/O) is PARTIAL/UNVERIFIED and a
 * Dossie-voiced answer would imply the app talks back. Heath reading what is
 * on screen implies nothing that is not true. This matches the shipped
 * reference build (Media/shortform-2026-09-16/dossie-spec.json). The
 * compositor re-checks the voice against scripts/_lib/shortform-brands.json
 * and refuses a wrong-voice build regardless of what this file asks for.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node scripts/render-ask-dossie-video.js --capture <dir> [--out <mp4>]
 *        [--work <dir>] [--slug <name>] [--no-queue] [--dry-run]
 *
 *   --capture   a directory produced by generate-ask-dossie-video.js
 *               (frames.json, marks.json, answer.json)
 *   --out       final mp4. Default: Media/finished-videos/<slug>.mp4 — the
 *               Dossie watch folder queue-finished-videos.py scans.
 *   --no-queue  render + gate, but do not run queue-finished-videos.py.
 *   --dry-run   write the spec and print the plan; render nothing, spend no
 *               ElevenLabs credits.
 *
 * Exit 0 = a gate-passed mp4 is in the watch folder (and queued unless
 * --no-queue). Any non-zero exit means NOTHING was queued — the caller is
 * expected to alert, never to shrug.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
// gen-listing-voiceover.py reads ELEVENLABS_API_KEY off the environment and
// does NOT load .env.local itself, so this script has to hand it down.
require('./_lib/load-env-local.js').loadEnvLocal(REPO);
const { computeCropY } = require('./_lib/ask-dossie-crop.js');

// ------------------------------------------------------------------ args ---
function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1] : fallback;
}
const flag = (n) => process.argv.includes('--' + n);

function die(msg) {
  console.error('\nABORT (render-ask-dossie): ' + msg + '\n');
  process.exit(1);
}

// ---------------------------------------------------------------- brands ---
const BRANDS = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts', '_lib', 'shortform-brands.json'), 'utf8'));
const DOSSIE = BRANDS.brands.dossie;
const HEATH_CLONE = DOSSIE.voices.allowed_speaker_voices.Heath;

// ----------------------------------------------------------------- hooks ---
// CLOSED SET, one entry per verified-WORKS capability that the mapper can
// select. `headline` uses the hook-generic.html [[hl]] highlight markup.
// `sub` is the second-beat line. Neither may assert anything the capture does
// not show — they describe the QUESTION, never the answer.
const HOOKS = {
  5: { headline: 'I asked Dossie for\n[[hl]]the whole file.[[/hl]]', sub: 'One question. Everything on it.' },
  6: { headline: 'I asked Dossie\n[[hl]]one deadline question.[[/hl]]', sub: 'Watch her read it off the contract.' },
  7: { headline: 'I asked Dossie\n[[hl]]what is left to do.[[/hl]]', sub: 'On a real file, not a demo script.' },
  8: { headline: 'I asked Dossie\n[[hl]]what I am missing.[[/hl]]', sub: 'She checks the file, not my memory.' },
  9: { headline: 'I asked Dossie\n[[hl]]what is on file.[[/hl]]', sub: 'Every document, one answer.' },
  10: { headline: 'I asked Dossie\n[[hl]]where every deal stands.[[/hl]]', sub: 'The whole pipeline, one question.' },
  11: { headline: 'I asked Dossie\n[[hl]]what is urgent today.[[/hl]]', sub: 'Typed it. Read the answer.' },
  13: { headline: 'I asked Dossie\n[[hl]]what needs me today.[[/hl]]', sub: 'Before the first coffee.' },
  14: { headline: 'I asked Dossie\n[[hl]]to draft the email.[[/hl]]', sub: 'I still send it myself.' },
};

// --------------------------------------------------------------- runtime ---
// Playbook runtime band for this format is 21-34s. The card/footage beats are
// fixed; the ANSWER + HOLD beats absorb however long the narration actually
// runs, so the edit never cuts Heath off mid-sentence and never sits silent.
const HOOK_A = 0.95;
const HOOK_B = 1.25;
const PANEL = 3.0;
const TYPING = 2.6;
const SEND = 2.4;
const CTA_HOLD = DOSSIE.cta.hold_seconds || 2.2;
const LOOP = 0.6;
const MIN_TOTAL = 21.0;
const MAX_TOTAL = 34.0;

// Two connective sentences. Format constants — they make no claim about what
// the product did, they just hand the viewer from beat to beat.
const LEAD_IN = 'I asked Dossie';
const HANDOFF = 'Here is what she came back with.';

// -------------------------------------------------------------- helpers ----
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...opts });
  return r;
}

function requireFile(p, what) {
  if (!fs.existsSync(p)) die(`${what} not found: ${p}`);
  return p;
}

/** Find a beat by the recorder's own note text. Beats are named in
 *  scripts/record-dossie-shortform-frames.js flowAskDossie(); a rename there
 *  must fail LOUDLY here rather than silently produce a mistimed edit. */
function beat(marks, needle, what) {
  const m = marks.find((x) => x.note.toLowerCase().includes(needle.toLowerCase()));
  if (!m) {
    die(`capture has no "${what}" beat (looked for ${JSON.stringify(needle)} in marks.json). `
      + 'Either the capture is incomplete or record-dossie-shortform-frames.js renamed a mark — '
      + 'fix the mapping here rather than guessing a timestamp.');
  }
  return m;
}

/** Trim answer_verbatim to whole SENTENCES that fit a character budget.
 *  Cutting trailing sentences is allowed; changing any word is not. */
function trimToSentences(text, maxChars) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  const parts = clean.match(/[^.!?]+[.!?]+(\s|$)/g) || [clean];
  let out = '';
  for (const p of parts) {
    if ((out + p).trim().length > maxChars) break;
    out += p;
  }
  out = out.trim();
  if (!out) {
    die('answer_verbatim has no sentence short enough to fit the runtime budget without '
      + 'rewording it. Rewording is not allowed (playbook §5 item 6a) — pick a different '
      + 'question or lengthen the edit.');
  }
  return out;
}

function ttsDuration(timingPath) {
  return JSON.parse(fs.readFileSync(timingPath, 'utf8')).duration;
}

// =========================================================================
(function main() {
  const CAPTURE = arg('capture', null);
  if (!CAPTURE) die('--capture <dir> is required (a directory from generate-ask-dossie-video.js)');

  const framesJson = requireFile(path.join(CAPTURE, 'frames.json'), 'frames.json');
  const answerJson = requireFile(path.join(CAPTURE, 'answer.json'), 'answer.json');
  const marksJson = requireFile(path.join(CAPTURE, 'marks.json'), 'marks.json');

  const answer = JSON.parse(fs.readFileSync(answerJson, 'utf8'));
  const marks = JSON.parse(fs.readFileSync(marksJson, 'utf8')).marks;
  const frames = JSON.parse(fs.readFileSync(framesJson, 'utf8')).frames;

  if (!answer.answer_verbatim || answer.answer_verbatim.trim().length < 20) {
    die('answer.json has no usable answer_verbatim — the capture did not record a real answer.');
  }
  const capNum = Number(answer.capability_number);
  const hook = HOOKS[capNum];
  if (!hook) {
    die(`no pre-approved hook copy for capability #${capNum} (${answer.capability_name || '?'}). `
      + 'Add one to HOOKS in this file after checking it against '
      + 'docs/DOSSIE-VERIFIED-CAPABILITIES.md — an improvised hook is an unverified claim.');
  }

  const crop = computeCropY(answer);
  if (!crop.ok) die('crop_y: ' + crop.note);

  const slug = arg('slug', `dossie-d1-cap${capNum}-${new Date().toISOString().slice(0, 10)}`);
  const outMp4 = path.resolve(arg('out', path.join(REPO, 'Media', 'finished-videos', `${slug}.mp4`)));
  const work = path.resolve(arg('work', path.join(CAPTURE, 'render-work')));
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });

  // ---- beats, read off the capture rather than assumed -------------------
  const bPanel = beat(marks, 'command panel open', 'panel open');
  const bTyped = beat(marks, 'Question typed in full', 'question typed');
  const bSend = beat(marks, 'Send tapped', 'send tapped');
  const bAnswer = beat(marks, 'answer rendered and fully in view', 'answer rendered');
  const bHold = beat(marks, 'Readable hold on the answer', 'readable hold');
  const lastTs = frames[frames.length - 1].ts;

  // ---- narration text ----------------------------------------------------
  //
  // The edit is algebraically determined by how long narration B runs:
  //   preAnswer   = the fixed card + footage beats before the answer lands
  //   total       = preAnswer + (dB + 0.9) + CTA_HOLD + LOOP
  // so the runtime band collapses to a band on dB, computed here rather than
  // guessed. Measured rate on the clone is ~11.4 chars/s (2026-09-17 proof
  // run: 233 chars -> 20.38s); CHARS_PER_SEC only picks the FIRST attempt.
  const CHARS_PER_SEC = 11.4;
  const preAnswer = HOOK_A + HOOK_B + PANEL + TYPING + SEND;
  const fixedTail = 0.9 + CTA_HOLD + LOOP;
  const dbMax = MAX_TOTAL - preAnswer - fixedTail;
  const dbMin = Math.max(0, MIN_TOTAL - preAnswer - fixedTail);
  // Aim below the ceiling so a slightly slower read than estimated still fits
  // without a second API call.
  const dbTarget = dbMax * 0.85;

  const voDir = path.join(work, 'vo');
  fs.mkdirSync(voDir, { recursive: true });
  const voA = { txt: path.join(voDir, 'a.txt'), mp3: path.join(voDir, 'a.mp3'), timing: path.join(voDir, 'a.json'), text: `${LEAD_IN}, ${answer.question_asked}` };
  const voB = { txt: path.join(voDir, 'b.txt'), mp3: path.join(voDir, 'b.mp3'), timing: path.join(voDir, 'b.json'), text: null };

  // Budget is on the WHOLE of narration B, so the connective sentence has to
  // come out of it — not be added on top of it.
  let answerSpoken = trimToSentences(
    answer.answer_verbatim,
    Math.floor(dbTarget * CHARS_PER_SEC) - HANDOFF.length - 1,
  );
  voB.text = `${HANDOFF} ${answerSpoken}`;

  console.log(`[d1] capability #${capNum} — ${answer.capability_name || ''}`);
  console.log(`[d1] question : ${answer.question_asked}`);
  console.log(`[d1] answer   : ${answer.answer_verbatim.slice(0, 160)}${answer.answer_verbatim.length > 160 ? '…' : ''}`);
  console.log(`[d1] crop_y   : ${crop.cropY}  (${crop.note})`);
  console.log(`[d1] budget   : narration B must land in ${dbMin.toFixed(1)}-${dbMax.toFixed(1)}s`);
  console.log(`[d1] vo A     : ${voA.text}`);
  console.log(`[d1] vo B     : ${voB.text}`);

  if (flag('dry-run')) {
    console.log('\n[d1] --dry-run: no synthesis, no render, nothing queued.');
    process.exit(0);
  }

  // ---- 1. voiceover ------------------------------------------------------
  function synth(vo) {
    fs.writeFileSync(vo.txt, vo.text, 'utf8');
    const r = run('python3', [
      'scripts/gen-listing-voiceover.py',
      '--script-file', vo.txt,
      '--out-mp3', vo.mp3,
      '--out-timing', vo.timing,
      '--voice-id', HEATH_CLONE,
      // The narration is sized to the ANSWER and the EDIT is sized to the
      // narration, so there is no fixed length to hit. The wide tolerance
      // stops gen-listing-voiceover.py from re-synthesising at an altered
      // speed, which would pull the clone off its locked, Heath-approved
      // settings (heath-voice-clone-settings-locked.md).
      '--target-seconds', String(Math.max(2, vo.text.length / CHARS_PER_SEC).toFixed(1)),
      '--tolerance-seconds', '999',
    ], { stdio: 'inherit' });
    if (r.status !== 0 || !fs.existsSync(vo.mp3)) {
      die(`voiceover synthesis failed (exit ${r.status}) for: ${vo.text.slice(0, 80)}`);
    }
    return ttsDuration(vo.timing);
  }

  const dA = synth(voA);
  let dB = synth(voB);

  // If the real read overran the band, drop the LAST SENTENCE and try again —
  // cutting trailing sentences is the one edit the verbatim rule allows. Two
  // retries max; a third would mean the estimate is wrong, not the text.
  for (let attempt = 0; dB > dbMax && attempt < 2; attempt++) {
    const sentences = answerSpoken.match(/[^.!?]+[.!?]+(\s|$)/g) || [answerSpoken];
    if (sentences.length <= 1) break;
    answerSpoken = sentences.slice(0, -1).join('').trim();
    voB.text = `${HANDOFF} ${answerSpoken}`;
    console.log(`[d1] narration B ran ${dB.toFixed(1)}s (> ${dbMax.toFixed(1)}s) — dropping the last `
      + `sentence and re-reading. Now: ${voB.text}`);
    dB = synth(voB);
  }
  console.log(`[d1] vo durations: A ${dA.toFixed(2)}s  B ${dB.toFixed(2)}s`);

  // ---- 2. size the edit around the real narration ------------------------
  const voAAt = HOOK_A + HOOK_B + 0.4;                 // starts as the panel appears
  const voBAt = preAnswer + 0.3;                        // starts as the answer lands
  // Everything after voice B has to hold until it finishes, plus a beat to read.
  const answerAndHold = Math.max(4.0, (voBAt + dB + 0.6) - preAnswer);
  const answerDur = Math.min(answerAndHold * 0.5, 7.0);
  const holdDur = answerAndHold - answerDur;
  const total = preAnswer + answerAndHold + CTA_HOLD + LOOP;

  if (voAAt + dA > preAnswer) {
    console.warn(`[d1] warn: narration A (${dA.toFixed(1)}s from ${voAAt.toFixed(1)}s) runs past the `
      + `send beat at ${preAnswer.toFixed(1)}s — it will overlap the answer beat.`);
  }
  if (total < MIN_TOTAL || total > MAX_TOTAL) {
    die(`edit would run ${total.toFixed(1)}s, outside the ${MIN_TOTAL}-${MAX_TOTAL}s band for this `
      + 'format even after trimming whole sentences. Rewording is not allowed — pick a different '
      + 'question.');
  }
  console.log(`[d1] runtime  : ${total.toFixed(2)}s (answer ${answerDur.toFixed(1)}s + hold ${holdDur.toFixed(1)}s)`);

  // ---- 3. spec -----------------------------------------------------------
  const cardVars = {
    BG: DOSSIE.palette.bg,
    INK: DOSSIE.palette.ink,
    ACCENT: DOSSIE.palette.accent,
    KICKER_COLOR: DOSSIE.palette.kicker,
    KICKER: 'Dossie',
    HEADLINE: hook.headline,
  };
  const spec = {
    brand: 'dossie',
    frames_json: framesJson,
    fontsdir: path.join(REPO, 'public', 'fonts'),
    cards: {
      hook_a: { template: 'hook-generic.html', vars: { ...cardVars, SUB: '' } },
      hook_b: { template: 'hook-generic.html', vars: { ...cardVars, SUB: hook.sub } },
      cta: { template: 'cta-dossie.html', vars: {} },
    },
    cover_card: 'hook_b',
    segments: [
      { name: 'hook', kind: 'card', zoom_from: 1.14, zoom_to: 1.0, pngs: [['hook_a', HOOK_A], ['hook_b', HOOK_B]] },
      { name: 'panel', kind: 'footage', src0: bPanel.ts, src1: bTyped.ts, dur: PANEL, geometry: 'content', crop_y: crop.cropY },
      { name: 'typing', kind: 'footage', src0: bTyped.ts, src1: bSend.ts, dur: TYPING, geometry: 'with_input', crop_y: crop.cropY },
      { name: 'send', kind: 'footage', src0: bSend.ts, src1: bAnswer.ts, dur: SEND, geometry: 'content', crop_y: crop.cropY, zoom_from: 1.0, zoom_to: 1.03, anchor: 'top' },
      { name: 'answer', kind: 'footage', src0: bAnswer.ts, src1: bHold.ts, dur: Number(answerDur.toFixed(2)), geometry: 'content', crop_y: crop.cropY, zoom_from: 1.0, zoom_to: 1.06, anchor: 'top' },
      { name: 'hold', kind: 'footage', src0: bHold.ts, src1: lastTs, dur: Number(holdDur.toFixed(2)), geometry: 'content', crop_y: crop.cropY, zoom_from: 1.06, zoom_to: 1.1, anchor: 'top' },
      { name: 'cta', kind: 'card', zoom_from: 1.0, zoom_to: 1.06, pngs: [['cta', CTA_HOLD]] },
      { name: 'loop', kind: 'card', zoom_from: 1.0, zoom_to: 1.14, pngs: [['hook_a', LOOP]] },
    ],
    voice: [
      { speaker: 'Heath', at: Number(voAAt.toFixed(2)), mp3: voA.mp3, timing: voA.timing, text: voA.text, voice_id: HEATH_CLONE },
      { speaker: 'Heath', at: Number(voBAt.toFixed(2)), mp3: voB.mp3, timing: voB.timing, text: voB.text, voice_id: HEATH_CLONE },
    ],
    post_caption: buildCaption(answer),
  };
  const specPath = path.join(work, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 1));
  console.log(`[d1] spec     : ${specPath}`);

  // ---- 4. render ---------------------------------------------------------
  const coverPng = path.join(work, 'cover.png');
  const r = run('python3', [
    'scripts/build-shortform-video.py',
    '--spec', specPath,
    '--out', outMp4,
    '--work', path.join(work, 'ff'),
    '--cover-out', coverPng,
  ], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(outMp4)) {
    die(`compositor failed (exit ${r.status}). Nothing was queued.`);
  }

  // ---- 5. the gate, INCLUDING the CTA-URL resolve ------------------------
  // The compositor already DNS-checks the CTA before rendering; this is the
  // stronger check (DNS + HTTP < 400) and it runs on the finished artefact, so
  // a link that died between build and queue still cannot ship.
  const gate = run('node', [
    'scripts/check-video-quality-cli.js',
    '--video', outMp4,
    '--cover', coverPng,
    '--cta-url', DOSSIE.cta.url,
    '--pretty',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  const gateLine = String(gate.stdout || '').trim().split('\n').filter(Boolean).pop();
  let verdict = null;
  try { verdict = JSON.parse(gateLine); } catch { /* handled below */ }
  if (!verdict) {
    fs.unlinkSync(outMp4);
    die('quality gate produced no parseable verdict — failing closed, mp4 deleted, nothing queued.');
  }
  fs.writeFileSync(path.join(work, 'gate.json'), JSON.stringify(verdict, null, 2));
  if (!verdict.pass) {
    // Move the failed render OUT of the watch folder so queue-finished-videos.py
    // cannot pick it up on its next scan, and leave it where a person can look.
    const held = path.join(work, path.basename(outMp4));
    fs.renameSync(outMp4, held);
    console.error(`[d1] GATE FAILED: ${(verdict.failedRules || []).join(', ')}`);
    console.error(`[d1] held at ${held}`);
    process.exit(2);
  }
  console.log(`[d1] gate     : PASS (${Object.keys(verdict.rules || {}).length} rules)`);

  // ---- 6. sidecars the queue reads --------------------------------------
  const stem = path.basename(outMp4, '.mp4');
  const dir = path.dirname(outMp4);
  fs.writeFileSync(path.join(dir, `${stem}.caption.txt`), spec.post_caption, 'utf8');
  // .meta.json lets scripts/queue-finished-videos.py re-run the CTA check with
  // the right URL on its own scan, instead of guessing one.
  fs.writeFileSync(path.join(dir, `${stem}.meta.json`), JSON.stringify({
    format: 'D1',
    brand: 'dossie',
    target_owner: 'dossie',
    cta_url: DOSSIE.cta.url,
    // It IS a screen recording of the real app; the filename carries no
    // -mobile-/-desktop- marker, so without this it falls through to
    // queue-finished-videos.py's selfie default.
    type: 'screen_recording',
    // Heath's clone narrates (as Heath, never as Dossie). That is an AI
    // disclosure obligation on YouTube/TikTok, and only this script knows it.
    uses_cloned_voice: true,
    capability_number: capNum,
    capability_name: answer.capability_name || null,
    question: answer.question_asked,
    provenance: answer.provenance || null,
    cover_png: coverPng,
    gate: { pass: true, failedRules: [] },
    rendered_at: new Date().toISOString(),
  }, null, 2), 'utf8');

  if (flag('no-queue')) {
    console.log(`\n[d1] DONE (not queued, --no-queue): ${outMp4}`);
    process.exit(0);
  }

  const q = run('python3', ['scripts/queue-finished-videos.py'], { stdio: 'inherit' });
  if (q.status !== 0) {
    console.error(`[d1] queue-finished-videos.py exited ${q.status}. The gate-passed mp4 is at `
      + `${outMp4} and will be picked up on the next scan.`);
    process.exit(3);
  }
  console.log(`\n[d1] DONE: ${outMp4}`);
  process.exit(0);
})();

/** Post caption. Real provenance, real capability, brand CTA — no invented
 *  member counts, no invented outcomes (docs/CONTENT-DO-NOT-WRITE-LIST.md). */
function buildCaption(answer) {
  const q = answer.question_asked;
  return [
    `Real question, real file: "${q}"`,
    '',
    'Typed it into Dossie. She read the answer off the transaction, not off a script.',
    '',
    DOSSIE.cta.url,
  ].join('\n');
}
