#!/usr/bin/env node
/**
 * review-calibration.js — the acceptance test for review.js. Runs the
 * reviewer on dossie_trial_01..05 (Heath's own five cuts of the same take)
 * and checks that it flags exactly what he flagged, on the right trial,
 * AND that its §22 verdict on each is "not proud" — he rejected all five:
 *
 *   01  rough, lip sync off, hollow room audio, sentences chopped,
 *       slurred last line, eyes flicking
 *   02  (no notes)
 *   03  laundry room still visible
 *   04  oval blur "kind of scary", clipped ending
 *   05  ending clips mid-word ("follow alo—"), face too close with blur around
 *
 * Every expectation is a predicate over review.json, so a prompt or
 * threshold change that loses one shows up here, not in Heath's inbox.
 * Over-strictness is checked too: 02 must not hard-fail on AUDIO, PACING,
 * CAPTIONS or TECHNICAL (VISUALS may fail — the room is visible in 02 as
 * well, and §5 says no original background).
 *
 * Usage:
 *   node scripts/video-engine/review-calibration.js [--reuse] [--no-vision]
 *     [--src /mnt/c/Users/Heath/Downloads/22054.mp4] [--workdir <dir>]
 * --reuse keeps existing review JSONs under the workdir.
 * Exit 0 when every expectation holds.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : true] : null).filter(Boolean));
const SRC = args.src || '/mnt/c/Users/Heath/Downloads/22054.mp4';
const TRANSCRIPT = path.join(ROOT, 'Media/finished-videos/dossie_trial_01.transcript.json'); // scribe of the source take
const OUT = args.workdir || path.join(ROOT, '.tmp', 'review-calibration');
fs.mkdirSync(OUT, { recursive: true });

const has = (r, k, re) => new RegExp(re, 'i').test((r.qc[k] && r.qc[k].reason) || '');
const blurOrHalo = (r) => r.vision && r.vision.framing && r.vision.framing.blur_or_halo && r.vision.framing.blur_or_halo !== 'none';
const notProud = ['§22 not proud', r => r.proud && r.proud.answer === false];
const notPass = ['verdict not PASS', r => r.verdict !== 'PASS'];

const CASES = [
  { trial: '01', heath: 'rough; lip sync off; hollow room audio; sentences chopped; slurred last line; eyes flicking', expect: [
    ['hollow room audio', r => has(r, 'AUDIO', 'hollow')],
    ['sentences chopped', r => has(r, 'AUDIO', 'chopped|hard splice')],
    ['slurred last line', r => has(r, 'TECHNICAL', 'fumbled|slurred')],
    ['eyes flicking', r => has(r, 'HUMAN', 'flicking|reading|looking away|down')],
    ['lip sync off', r => r.measured.sync && Math.abs(r.measured.sync.medianOffsetMs) >= 60, 'measured -17..-33 ms; attributed to the two mid-word splices'],
    notProud, notPass,
  ] },
  { trial: '02', heath: '(no notes)', expect: [
    ['no hard fail on AUDIO', r => r.qc.AUDIO.score >= 3],
    ['no hard fail on PACING', r => r.qc.PACING.score >= 3],
    ['no hard fail on CAPTIONS', r => r.qc.CAPTIONS.score >= 3],
    ['no hard fail on TECHNICAL', r => r.qc.TECHNICAL.score >= 3],
    notProud, notPass,
  ] },
  { trial: '03', heath: 'laundry room still visible', expect: [
    ['room visible', r => r.vision && r.vision.framing && r.vision.framing.room_visible === true],
    notProud, notPass,
  ] },
  { trial: '04', heath: 'oval blur "kind of scary"; clipped ending', expect: [
    ['oval blur / blur band', r => blurOrHalo(r) || has(r, 'VISUALS', 'vignette|blur')],
    ['clipped ending', r => r.measured.ending.truncated === true],
    notProud, notPass,
  ] },
  { trial: '05', heath: 'ending clips mid-word ("follow alo—"); face too close with blur around', expect: [
    ['ending clips mid-word', r => r.measured.ending.truncated === true && /along/i.test(r.measured.ending.lastWord)],
    ['face too close', r => has(r, 'VISUALS', 'tight|too close')],
    ['blur around', r => blurOrHalo(r) || (r.vision && r.vision.edge && !['clean', 'natural'].includes(r.vision.edge.edge))],
    notProud, notPass,
  ] },
];

let failures = 0;
const rows = [];
for (const c of CASES) {
  const video = path.join(ROOT, 'Media/finished-videos', `dossie_trial_${c.trial}.mp4`);
  const out = path.join(OUT, `trial${c.trial}.json`);
  if (!(args.reuse && fs.existsSync(out))) {
    const a = [path.join(__dirname, 'review.js'), '--video', video, '--src', SRC, '--transcript', TRANSCRIPT, '--label', `trial${c.trial}`, '--workdir', path.join(OUT, `trial${c.trial}`), '--out', out];
    if (args['no-vision']) a.push('--no-vision');
    spawnSync('node', a, { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT });
  }
  if (!fs.existsSync(out)) { rows.push([c.trial, c.heath, 'REVIEW DID NOT RUN', 'MISS', '']); failures++; continue; }
  const r = JSON.parse(fs.readFileSync(out, 'utf8'));
  const said = Object.entries(r.qc).map(([k, v]) => `${k} ${v.score}`).join(', ');
  const results = c.expect.map(([name, pred, note]) => { const ok = !!pred(r); if (!ok && !note) failures++; return `${ok ? 'HIT ' : (note ? 'miss (' + note + ')' : 'MISS')} ${name}`; });
  const s22 = `${r.verdict} — proud: ${r.proud.answer ? 'YES' : 'NO'} (${r.proud.reason})${r.source && r.source.recommendReshoot ? ` — §19 reshoot: ${r.source.reason}` : ''}`;
  rows.push([c.trial, c.heath, `avg ${r.average}: ${said}`, results.join('\n'), s22]);
}

console.log('\nCALIBRATION — trial x what Heath said x what the reviewer said\n');
for (const [t, h, s, e, v] of rows) console.log(`trial_${t}\n  Heath:    ${h}\n  Reviewer: ${s}\n  §22:      ${v}\n  ${e.split('\n').join('\n  ')}\n`);
console.log(failures ? `${failures} expectation(s) MISSED` : 'all expectations hit');
process.exit(failures ? 2 : 0);
