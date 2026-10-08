#!/usr/bin/env node
'use strict';

/**
 * render-dossie-feature-video.js
 *
 * Renders a vertical Dossie PRODUCT video from a capture produced by
 * scripts/record-dossie-shortform-frames.js (--flow pipeline-to-dossier /
 * brief-only / pipeline-only).
 *
 * Companion to scripts/render-ask-dossie-video.js, which covers the "D1 /
 * Ask Dossie" format only. Everything structural is shared with that file on
 * purpose: same compositor (build-shortform-video.py), same brand config
 * (scripts/_lib/shortform-brands.json), same gate (check-video-quality-cli.js).
 *
 * ── HONESTY CONTRACT ────────────────────────────────────────────────────────
 * Per [[dossie-demo-must-match-real-capability]] and
 * docs/DOSSIE-VERIFIED-CAPABILITIES.md, no marketing may show, describe or
 * imply a capability that does not work in the live product today. So:
 *
 *   * FEATURES below is a CLOSED SET. Each entry names the verified capability
 *     number(s) it rests on, and carries its hook + narration as pre-approved
 *     copy. There is no --headline/--vo flag: improvised copy is an unverified
 *     claim, and this script refuses to be the place one gets written.
 *   * `must_be_on_screen` is asserted against the capture's OWN marks.json
 *     `on_screen` text (read off the live DOM at capture time). If the footage
 *     does not actually show what the narration says, the build aborts. That is
 *     the check that makes "the recording aged and the flow changed" loud
 *     instead of silent.
 *   * Every narration line is checked against `forbidden_claims` — the
 *     DOESN'T-EXIST / PARTIAL list (CMA, MLS, SMS, portal upload, auto-send,
 *     e-signature completion, Gmail connect). A match is a hard refusal.
 *
 * ── VOICE ───────────────────────────────────────────────────────────────────
 * Heath's clone narrates, AS HEATH, never as Dossie — identical reasoning to
 * render-ask-dossie-video.js: Dossie's own spoken voice would imply capability
 * #12 (spoken voice I/O), which is PARTIAL/UNVERIFIED. Heath describing what is
 * on screen implies nothing untrue. The compositor independently re-checks the
 * voice id against shortform-brands.json and refuses a wrong-voice build.
 *
 * ── USAGE ───────────────────────────────────────────────────────────────────
 *   node scripts/render-dossie-feature-video.js \
 *     --capture <dir> --feature <key> [--out <mp4>] [--work <dir>] [--dry-run]
 *
 * Nothing is ever queued, scheduled or posted by this script.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const BRANDS = JSON.parse(fs.readFileSync(path.join(REPO, 'scripts/_lib/shortform-brands.json'), 'utf8'));
const DOSSIE = BRANDS.brands.dossie;
const HEATH_CLONE = DOSSIE.voices.allowed_speaker_voices.Heath;

// Media/ is excluded from version control and so is absent inside a worktree;
// fall back to the main checkout so a worktree build still gets a
// licence-clean bed rather than refusing to build.
const MAIN_TREE = '/mnt/c/Users/Heath/Projects/MeetDossie';
const MUSIC_TRACK = [
  path.join(REPO, 'Media/Music/documentary-trust-piano.mp3'),
  path.join(MAIN_TREE, 'Media/Music/documentary-trust-piano.mp3'),
].find((q) => fs.existsSync(q));

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (n) => process.argv.includes('--' + n);
function die(msg) {
  console.error('\n=========================================');
  console.error('ABORT (render-dossie-feature): ' + msg);
  console.error('=========================================\n');
  process.exit(1);
}

// Phrases that would assert a capability Dossie does not have today.
// Sourced from docs/DOSSIE-VERIFIED-CAPABILITIES.md items 15-24 + the PARTIAL
// ones we are told not to feature.
const FORBIDDEN_CLAIMS = [
  [/\bCMA\b|comparative market analysis/i, 'CMA generation DOES NOT EXIST (cap #20)'],
  [/\bMLS\b/i, 'MLS integration DOES NOT EXIST (cap #21)'],
  [/\btext(s|ed|ing)? (the|your) client|\bSMS\b/i, 'member SMS DOES NOT EXIST (cap #22)'],
  [/upload(s|ed)? (it )?to (KW )?Command|compliance portal|SkySlope|Dotloop/i,
    'brokerage portal upload DOES NOT EXIST (cap #24)'],
  [/sends? (the|your|it|them) (email|emails)\b|auto[- ]?send|sends it for you/i,
    'email auto-send DOES NOT EXIST by design (cap #15)'],
  [/\be-?sign(ed|ature|ing)?\b|DocuSeal|signed and returned/i,
    'e-signature is PARTIAL — zero envelopes have ever completed in production (cap #16)'],
  [/connect(s|ed)? (your )?gmail|reads your inbox/i,
    'Gmail connect is PARTIAL — zero members have ever completed it (cap #19)'],
  [/catches every|never miss(es)? a|finds every|guarantee/i,
    'absolute-reliability claim — the audit/compliance path is not reliable enough to promise this'],
];

/**
 * CLOSED SET. One entry per feature video, each resting on verified-WORKS
 * capabilities only. `vo` lines are what Heath's clone says, verbatim.
 */
const FEATURES = {
  'trec-deadlines': {
    capabilities: [6],
    hook: {
      headline: 'Every deadline on the file.\n[[hl]]And the paragraph it came from.[[/hl]]',
      sub: 'Real file. Real contract dates.',
    },
    // Each beat: which capture mark to use, and how long to hold it.
    beats: [
      // BOTH beats stay inside the "TREC deadlines" scroll window. The next
      // mark ("Deadline rows plus the compliance gaps") actually scrolls the
      // view back UP to the dossier identity block, so using it here put the
      // file header on screen while the narration talked about deadline rows.
      // Caught by frame inspection, not by the gate.
      { match: /TREC deadlines" header lands/i, src0_ms: 29465, src1_ms: 31100, dur: 7.0, zoom: [1.0, 1.06] },
      { match: /TREC deadlines" header lands/i, src0_ms: 31100, src1_ms: 32695, dur: 7.0, zoom: [1.04, 1.10] },
    ],
    must_be_on_screen: ['TREC deadlines', '5A', '5B', '6A', '9A'],
    vo: [
      'Every deadline on this file was computed from the contract dates, and every one of them shows the TREC paragraph it came from.',
      'Earnest money, paragraph five A. Option period expires, five B. Title commitment, six A. Closing, nine A. I am not tracking that in my head anymore.',
    ],
  },

  'compliance-gaps': {
    capabilities: [8],
    hook: {
      headline: 'The three things\n[[hl]]your broker will bounce.[[/hl]]',
      sub: 'Flagged with the statute, before they ask.',
    },
    beats: [
      { match: /Dossier detail header/i, dur: 5.5, zoom: [1.0, 1.05] },
      { match: /Deadline rows plus the compliance gaps/i, dur: 8.5, zoom: [1.02, 1.08] },
    ],
    // Texas Property Code 5.008 is NOT asserted: on this capture the
    // "Seller's Disclosure (OP-H)" row is the last thing on screen and its
    // statute line sits below the fold, so the narration names the document
    // but never reads out a citation the viewer cannot see. The IABS row and
    // its TRELA cite ARE fully visible (frame 00330).
    must_be_on_screen: ['IABS', 'TRELA', 'disclosure'],
    vo: [
      'This file is eleven days from closing, and Dossie is flagging three things on it that nobody has done yet.',
      'The IABS, not yet recorded as delivered, with the TRELA section it is required by. The executed contract, not uploaded. The seller\'s disclosure, not received. Named before a broker ever asks for them.',
    ],
  },

  'morning-brief': {
    capabilities: [13],
    hook: {
      headline: 'Eight files.\n[[hl]]Nothing needs me today.[[/hl]]',
      sub: 'And she can show her work.',
    },
    beats: [
      { match: /Today tab, top/i, dur: 7.5, zoom: [1.0, 1.05] },
      { match: /counters and the start of the urgent list/i, dur: 10.0, zoom: [1.02, 1.08] },
    ],
    must_be_on_screen: ['Morning, Sarah', 'CLEAR'],
    vo: [
      'This is the first thing I read in the morning. Eight live files, and she has already been through all of them.',
      'Zero need me. Zero to watch. Eight clear. And under it, every file with the days left on it, so I can check her work in about ten seconds.',
    ],
  },
};

// ---------------------------------------------------------------- runtime ---
const HOOK_A = 0.95;
const HOOK_B = 1.25;
const CTA_HOLD = DOSSIE.cta.hold_seconds || 2.2;
const LOOP = 0.6;
const MIN_TOTAL = 21.0;
const MAX_TOTAL = 34.0;

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', ...opts });
}

function loadEnvLocal() {
  const p = path.join(REPO, '.env.local');
  if (!fs.existsSync(p)) return;
  const txt = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    if (!process.env[k]) process.env[k] = t.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
}

function main() {
  const captureDir = arg('capture');
  const featureKey = arg('feature');
  if (!captureDir || !featureKey) {
    die('usage: --capture <dir> --feature <' + Object.keys(FEATURES).join('|') + '>');
  }
  const feature = FEATURES[featureKey];
  if (!feature) die(`unknown --feature "${featureKey}". Known: ${Object.keys(FEATURES).join(', ')}`);

  const framesJson = path.join(captureDir, 'frames.json');
  const marksJson = path.join(captureDir, 'marks.json');
  for (const f of [framesJson, marksJson]) if (!fs.existsSync(f)) die('missing ' + f);
  const marks = JSON.parse(fs.readFileSync(marksJson, 'utf8'));

  // ---- 1. honesty checks -------------------------------------------------
  const allOnScreen = (marks.marks || []).map((m) => m.on_screen || '').join(' | ');
  const haystack = allOnScreen.toLowerCase();
  for (const needle of feature.must_be_on_screen) {
    // Case-insensitive: the app renders the same row as both "Seller's
    // Disclosure (OP-H)" and "Seller disclosure (OP-H)" depending on where it
    // appears, and a case mismatch is not a capability problem.
    if (!haystack.includes(String(needle).toLowerCase())) {
      die(`capture does not actually show "${needle}" anywhere in marks.json on_screen text. `
        + 'The narration would be describing something the footage does not contain — '
        + 'recapture, or fix the beat selection. (This is the "the flow changed under us" guard.)');
    }
  }
  for (const line of feature.vo) {
    for (const [re, why] of FORBIDDEN_CLAIMS) {
      if (re.test(line)) die(`narration line trips a forbidden-capability claim: ${why}\n  line: "${line}"`);
    }
  }
  console.log(`[feat] ${featureKey} — capabilities #${feature.capabilities.join(', #')}`);
  console.log(`[feat] on-screen assertions OK: ${feature.must_be_on_screen.join(', ')}`);

  // ---- 2. beats ----------------------------------------------------------
  const beats = feature.beats.map((b) => {
    const m = (marks.marks || []).find((x) => b.match.test(x.note || ''));
    if (!m) die(`no capture mark matches ${b.match} — the capture flow changed. Marks present:\n  `
      + (marks.marks || []).map((x) => x.note).join('\n  '));
    // A beat may narrow to a sub-range of its mark when only part of that
    // scroll window actually shows what the narration describes.
    const ts = b.src0_ms != null ? b.src0_ms : m.ts;
    const end = b.src1_ms != null ? b.src1_ms : m.end;
    if (ts < m.ts || end > m.end) {
      die(`beat sub-range ${ts}-${end}ms falls outside its mark (${m.ts}-${m.end}ms) — `
        + 'that would film a moment the mark never vouched for.');
    }
    return { ...b, ts, end, note: m.note };
  });
  beats.forEach((b) => console.log(`[feat] beat ${b.ts}-${b.end}ms  ${b.dur}s  ${b.note}`));

  // ---- 3. voiceover ------------------------------------------------------
  const work = arg('work', path.join('/tmp', `dossie-feat-${featureKey}-${Date.now()}`));
  fs.mkdirSync(path.join(work, 'vo'), { recursive: true });
  loadEnvLocal();

  const vos = [];
  feature.vo.forEach((text, i) => {
    const txt = path.join(work, 'vo', `${i}.txt`);
    const mp3 = path.join(work, 'vo', `${i}.mp3`);
    const timing = path.join(work, 'vo', `${i}.json`);
    fs.writeFileSync(txt, text, 'utf8');
    if (flag('dry-run')) { vos.push({ mp3, timing, text, dur: text.length / 11.4 }); return; }
    // Heath's clone settings are LOCKED (heath-voice-clone-settings-locked.md):
    // eleven_v3, stability 0.3, similarity 0.75, style 0.4. gen-listing-
    // voiceover.py normally applies those automatically, but ONLY when it can
    // read scripts/config/heath-voice-clone.json to confirm the id is the
    // clone. That file is untracked and absent from this checkout, so the
    // script falls back to stock narration settings (multilingual_v2 / 0.5 /
    // 0.15) with a warning. Pass them explicitly so the clone is never
    // rendered off its approved settings.
    //
    // --tolerance-seconds is deliberately huge: the default 30s target made
    // the script SLOW THE VOICE to speed 0.70 trying to stretch a 9s line to
    // 30s, which drags audibly. Runtime is controlled by the beat durations
    // here, not by deforming Heath's delivery.
    const r = run('python3', [
      'scripts/gen-listing-voiceover.py',
      '--script-file', txt, '--out-mp3', mp3, '--out-timing', timing,
      '--voice-id', HEATH_CLONE,
      '--model', 'eleven_v3',
      '--stability', '0.3',
      '--similarity', '0.75',
      '--style', '0.4',
      '--tolerance-seconds', '999',
    ], { stdio: 'inherit' });
    if (r.status !== 0 || !fs.existsSync(mp3)) die(`voiceover ${i} failed (exit ${r.status})`);
    const dur = JSON.parse(fs.readFileSync(timing, 'utf8')).duration;
    vos.push({ mp3, timing, text, dur });
    console.log(`[feat] vo ${i}: ${dur.toFixed(2)}s  "${text.slice(0, 60)}…"`);
  });

  // ---- 4. timeline -------------------------------------------------------
  // VO line 0 runs under the hook card + first beat; line 1 under the rest.
  const hookDur = HOOK_A + HOOK_B;
  const vo0At = 0.55;
  let t = hookDur;
  const segs = [];
  const footageTotal = beats.reduce((a, b) => a + b.dur, 0);
  // Stretch the last beat so narration never gets cut off mid-sentence.
  const narrationEnd = Math.max(vo0At + vos[0].dur, 0) + 0.35 + vos[1].dur;
  const needFootage = Math.max(footageTotal, narrationEnd - hookDur + 0.6);
  const stretch = needFootage / footageTotal;

  beats.forEach((b, i) => {
    const dur = Number((b.dur * stretch).toFixed(2));
    segs.push({
      name: `beat${i}`, kind: 'footage', src0: b.ts, src1: b.end, dur,
      geometry: 'content', zoom_from: b.zoom[0], zoom_to: b.zoom[1], anchor: 'top',
    });
    t += dur;
  });
  const vo1At = Number((hookDur + 0.35).toFixed(2));
  const total = Number((t + CTA_HOLD + LOOP).toFixed(2));
  console.log(`[feat] runtime : ${total.toFixed(2)}s (footage ${(t - hookDur).toFixed(1)}s)`);
  if (total < MIN_TOTAL || total > MAX_TOTAL) {
    die(`runtime ${total.toFixed(1)}s is outside the 21-34s playbook band. Adjust beat durations.`);
  }

  // ---- 5. spec -----------------------------------------------------------
  const cardVars = {
    BG: DOSSIE.palette.bg, INK: DOSSIE.palette.ink, ACCENT: DOSSIE.palette.accent,
    KICKER_COLOR: DOSSIE.palette.kicker, KICKER: 'Dossie', HEADLINE: feature.hook.headline,
  };
  const spec = {
    brand: 'dossie',
    frames_json: framesJson,
    fontsdir: path.join(REPO, 'public', 'fonts'),
    cards: {
      hook_a: { template: 'hook-generic.html', vars: { ...cardVars, SUB: '' } },
      hook_b: { template: 'hook-generic.html', vars: { ...cardVars, SUB: feature.hook.sub } },
      cta: { template: 'cta-dossie.html', vars: {} },
    },
    cover_card: 'hook_b',
    segments: [
      { name: 'hook', kind: 'card', zoom_from: 1.14, zoom_to: 1.0, pngs: [['hook_a', HOOK_A], ['hook_b', HOOK_B]] },
      ...segs,
      { name: 'cta', kind: 'card', zoom_from: 1.0, zoom_to: 1.06, pngs: [['cta', CTA_HOLD]] },
      { name: 'loop', kind: 'card', zoom_from: 1.0, zoom_to: 1.14, pngs: [['hook_a', LOOP]] },
    ],
    voice: [
      { speaker: 'Heath', at: vo0At, mp3: vos[0].mp3, timing: vos[0].timing, text: vos[0].text, voice_id: HEATH_CLONE },
      { speaker: 'Heath', at: vo1At, mp3: vos[1].mp3, timing: vos[1].timing, text: vos[1].text, voice_id: HEATH_CLONE },
    ],
    music: { file: MUSIC_TRACK, lufs: -35, lowpass: 4500 },
    post_caption: `${feature.hook.sub} Real screen recording of the live app, demo account. ${DOSSIE.cta.url}`,
  };
  const specPath = path.join(work, 'spec.json');
  fs.writeFileSync(specPath, JSON.stringify(spec, null, 1));
  console.log(`[feat] spec    : ${specPath}`);
  if (flag('dry-run')) { console.log('[feat] --dry-run: nothing synthesised, nothing rendered.'); return; }

  // ---- 6. render ---------------------------------------------------------
  const outMp4 = arg('out', path.join(work, `dossie-${featureKey}.mp4`));
  const coverPng = path.join(work, 'cover.png');
  fs.mkdirSync(path.dirname(outMp4), { recursive: true });
  const r = run('python3', [
    'scripts/build-shortform-video.py',
    '--spec', specPath, '--out', outMp4, '--work', path.join(work, 'ff'), '--cover-out', coverPng,
  ], { stdio: 'inherit' });
  if (r.status !== 0 || !fs.existsSync(outMp4)) die(`compositor failed (exit ${r.status}).`);

  // Word-timestamp sidecar so the gate samples real speech, not fixed fractions.
  run('node', ['scripts/emit-vo-transcript-sidecar.js', '--spec', specPath, '--video', outMp4], { stdio: 'inherit' });

  const gate = run('node', [
    'scripts/check-video-quality-cli.js',
    '--video', outMp4, '--cover', coverPng, '--cta-url', DOSSIE.cta.url, '--pretty',
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`\n[feat] DONE: ${outMp4}`);
  console.log('[feat] NOTHING was queued, scheduled or posted.');
  try {
    const g = JSON.parse((gate.stdout || '').trim().split('\n').pop());
    console.log(`[feat] gate: ${g.pass ? 'PASS' : 'FAIL'}${g.failedRules?.length ? ' — ' + g.failedRules.join(', ') : ''}`);
  } catch { /* gate already printed its own table */ }
}

main();
