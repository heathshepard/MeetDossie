#!/usr/bin/env node
/**
 * loop-selftest.js — proves the reviewer -> editor loop cannot go silent.
 *
 * The defect this guards: produce.js used to print "nothing left to change in
 * the brief — stopping early" and exit while review.js's findings sat
 * unaddressed, because ~9 of its findings carried a null brief patch and
 * nothing distinguished "no knob" from "nothing wrong". dossie_trial_06.mp4
 * shipped 35.7 s long with its first picture change at 27.0 s that way.
 *
 * Checks, in order:
 *   1. COVERAGE — every fix id review.js can emit has a fix-registry row.
 *   2. KNOBS EXIST — every knob the registry promises is a brief field
 *      edit.js (or a stage it invokes) actually reads.
 *   3. NO MUTE FINDINGS — every editor-owned emission site attaches a brief
 *      patch. An editor-owned finding with a null patch is the original bug.
 *   4. CLASSIFICATION — replaying a real review.json, every finding lands in
 *      exactly one of applied / already-at / human / reviewer-bug, and the
 *      total is conserved.
 *
 * Usage: node scripts/video-engine/loop-selftest.js [--review <review.json>]
 * Exit 0 = the loop is closed. Non-zero = it can go silent again.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FIXREG = require('./fix-registry.js');

const args = process.argv.slice(2);
const reviewPath = args.includes('--review') ? args[args.indexOf('--review') + 1] : null;
const reviewSrc = fs.readFileSync(path.join(__dirname, 'review.js'), 'utf8');
// Stages that read brief fields. edit.js reads most of them and forwards the
// rest as CLI args; captions.js reads its own block straight off the resolved
// brief, which is why scanning edit.js alone under-reports.
const BRIEF_CONSUMERS = ['edit.js', 'captions.js', 'cutlist.js', 'shot-plan.js', 'face-track-crop.js'];
const editSrc = BRIEF_CONSUMERS.map(f => fs.readFileSync(path.join(__dirname, f), 'utf8')).join('\n');

let failures = 0;
const fail = (m) => { console.error(`FAIL  ${m}`); failures++; };
const pass = (m) => console.log(`ok    ${m}`);

// ---- 1. coverage ----
const emitted = [...reviewSrc.matchAll(/fix\('([a-z_]+\.[a-z_0-9]+)'/g)].map(m => m[1]);
const distinct = [...new Set(emitted)];
const unregistered = distinct.filter(id => !FIXREG.REGISTRY[id]);
if (unregistered.length) fail(`review.js emits ${unregistered.length} id(s) with no registry row: ${unregistered.join(', ')}`);
else pass(`all ${distinct.length} emitted fix ids are registered (${Object.keys(FIXREG.REGISTRY).length} rows total)`);

// ---- 2. knobs exist ----
const s = FIXREG.summary();
if (s.knobsNotImplemented.length) fail(`registry promises knobs that are not in EDITOR_KNOBS: ${s.knobsNotImplemented.join(', ')}`);
else pass(`all registry knobs are declared editor knobs`);
const notReadByEdit = [];
for (const id of Object.keys(FIXREG.REGISTRY)) {
  for (const k of FIXREG.REGISTRY[id].knobs) {
    // The knob must appear as brief.<k> or as a quoted key in a *_KEYS list.
    if (!new RegExp(`brief\\.${k}\\b|'${k}'`).test(editSrc)) notReadByEdit.push(`${id} -> ${k}`);
  }
}
if (notReadByEdit.length) fail(`no brief consumer reads: ${notReadByEdit.join(', ')}`);
else pass(`every knob the registry promises is read by a brief consumer (${BRIEF_CONSUMERS.join(', ')})`);

// ---- 3. no mute findings ----
// Pull each fix(...) call and check that editor-owned ones pass something
// other than a bare null as the brief patch.
const mute = [];
const callRe = /fix\('([a-z_]+\.[a-z_0-9]+)',\s*'[A-Z]+',/g;
let m;
while ((m = callRe.exec(reviewSrc)) !== null) {
  const id = m[1];
  const reg = FIXREG.REGISTRY[id];
  if (!reg || reg.owner !== 'editor') continue;
  // Walk to the matching close paren, then look at the 4th argument.
  let depth = 0, inStr = null, end = -1;
  const open = reviewSrc.indexOf('(', m.index);
  for (let i = open; i < reviewSrc.length; i++) {
    const ch = reviewSrc[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === inStr) inStr = null; continue; }
    if (ch === "'" || ch === '`') { inStr = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) continue;
  const call = reviewSrc.slice(m.index, end + 1);
  // The brief patch is the argument before the trailing section number.
  if (/,\s*null,\s*\d+\)\s*$/.test(call)) mute.push(id);
}
if (mute.length) fail(`editor-owned findings that still emit a null brief patch (the trial_06 bug): ${mute.join(', ')}`);
else pass(`no editor-owned finding emits a null brief patch`);

// ---- 4. classification on a real review ----
if (reviewPath && fs.existsSync(reviewPath)) {
  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
  const buckets = { applied: [], alreadyAt: [], human: [], bug: [] };
  // A brief that already holds every asked-for value — the hardest case,
  // because that is when produce.js used to say "nothing left to change".
  const brief = JSON.parse(JSON.stringify(review.briefSnapshot || {}));
  for (const f of review.fixes) {
    const owner = f.owner || (FIXREG.lookup(f.id) ? FIXREG.lookup(f.id).owner : 'unregistered');
    if (owner === 'human') buckets.human.push(f.id);
    else if (owner === 'unregistered' || !f.brief) buckets.bug.push(f.id);
    else {
      const changes = [];
      for (const [k, v] of Object.entries(f.brief)) if (JSON.stringify(brief[k]) !== JSON.stringify(v)) { brief[k] = v; changes.push(k); }
      (changes.length ? buckets.applied : buckets.alreadyAt).push(f.id);
    }
  }
  const total = buckets.applied.length + buckets.alreadyAt.length + buckets.human.length + buckets.bug.length;
  if (total !== review.fixes.length) fail(`classification lost findings: ${total} of ${review.fixes.length}`);
  else pass(`every one of ${review.fixes.length} findings in ${path.basename(reviewPath)} is classified`);
  console.log(`      applied=${buckets.applied.length} alreadyAt=${buckets.alreadyAt.length} human=${buckets.human.length} reviewerBug=${buckets.bug.length}`);
  if (buckets.human.length) console.log(`      human-only: ${buckets.human.join(', ')}`);
  // The silence condition: nothing applied AND findings remain. produce.js
  // must call that a STALL, not a clean finish.
  if (!buckets.applied.length && (buckets.human.length || buckets.bug.length || buckets.alreadyAt.length)) {
    const stallPath = /stalled = \{/.test(fs.readFileSync(path.join(__dirname, 'produce.js'), 'utf8'));
    if (stallPath) pass('this review would trip produce.js\'s STALL path (named findings, exit 4) — not silence');
    else fail('produce.js has no stall path; this review would exit silently');
  }
} else {
  console.log('note  no --review given; skipped the replay check');
}

console.log(`\n${failures ? `${failures} FAILURE(S) — the loop can go silent` : 'loop is closed: every finding is either applied or named'}`);
process.exit(failures ? 1 : 0);
