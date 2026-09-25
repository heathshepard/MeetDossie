#!/usr/bin/env node
/**
 * produce.js — the loop Heath asked for: edit -> review -> fix -> review,
 * up to 3 rounds, and only a cut that PASSES gets surfaced. He is not the
 * checker; review.js is.
 *
 *   node scripts/video-engine/produce.js --src <raw.mp4> --brand dossie
 *     [--out Media/finished-videos/name.mp4] [--rounds 3] [--workdir <dir>]
 *     [--brief <override.json>] [--no-vision]
 *
 * Each round:
 *   1. edit.js renders round-N.mp4 from the current brief (stages cached
 *      with --reuse, so a padding change re-cuts, a backdrop change only
 *      re-composites).
 *   2. review.js grades it against docs/DOSSIE-CREATIVE-DIRECTOR-STANDARD.md
 *      (§17 QC table, §22 "proud?", §18 weakest moments, §19 source check),
 *      using the source take and its transcript so it can measure sync and
 *      missing words.
 *   3. PASS -> copy to --out, write a <30 MB preview next to it, stop.
 *      RESHOOT -> stop immediately: §19 says the source is the limit, and no
 *      amount of re-editing gets surfaced as if it were fixable. The
 *      statement names what the footage lacks.
 *      FAIL -> apply every fix's `brief` patch (padding, framing, backdrop,
 *      caption size, ending choice, audio chain, sync nudge, open/close
 *      line) to the brief and go again. Patches are merged, not blindly
 *      overwritten: numeric pads only ever grow, zoom only moves the way the
 *      reviewer asked.
 * After the last round without a PASS, it stops and prints exactly what it
 * could not fix, in the reviewer's words. Nothing is copied to --out.
 *
 * NEVER-SILENT RULE (2026-09-22)
 * This file used to end a round with "nothing left to change in the brief —
 * stopping early" and exit while real findings sat unaddressed. That line was
 * true about the BRIEF and false about the VIDEO: review.js had flagged a
 * 27-second static stretch in dossie_trial_06.mp4 and attached a null patch,
 * because roughly nine of its findings had no editor knob to drive. The loop
 * looked closed and wasn't.
 *
 * Now every finding is classified by scripts/video-engine/fix-registry.js:
 *   editor + patch  -> applied, named in the round's briefChanges
 *   human           -> NAMED, with the reason, and it blocks the "done" claim
 *   editor + no patch -> a REVIEWER BUG, reported as one by id
 * produce.js cannot exit without listing every unaddressed finding by name.
 *
 * Writes <workdir>/produce.json with every round's verdict + notes, and
 * prints the same summary.
 * Exit 0 = PASS surfaced. 2 = FAIL, out of rounds. 3 = RESHOOT (§19).
 * 4 = stalled: findings remain that no editor knob can address. 1 = error.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const FIXREG = require('./fix-registry.js');

const ROOT = path.join(__dirname, '..', '..');

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

// Knobs where the reviewer only ever asks for MORE — a later round must not
// undo an earlier round's ask (padding especially: a smaller pad is how a
// word gets clipped again).
const NUMERIC_GROW = new Set(['padStart', 'padEnd', 'endHoldSec', 'captionSize', 'captionMarginV', 'headroom']);
// Knobs where the reviewer only ever asks for LESS — a cap, a ceiling, or a
// volume. Ratcheting these down means round 3 can't re-loosen round 2's cap.
const NUMERIC_SHRINK = new Set(['musicVolume', 'maxShotSec', 'maxScaleRatio', 'punchZoomMax', 'denoiseStrength']);

/** Merge one fix's brief patch into the brief. Returns a list of "key: old -> new" strings for the log. */
function applyPatch(brief, patch) {
  const changes = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null) continue;
    const old = brief[k];
    let next = v;
    if (NUMERIC_GROW.has(k) && typeof old === 'number' && typeof v === 'number') next = Math.max(old, v);
    if (NUMERIC_SHRINK.has(k) && typeof old === 'number' && typeof v === 'number') next = Math.min(old, v);
    if (k === 'zoom' && typeof old === 'number' && typeof v === 'number') next = +v.toFixed(2);
    // emphasisWords is a union, never a replacement — a later round must not
    // drop the words an earlier round established.
    if (k === 'emphasisWords' && Array.isArray(old) && Array.isArray(v)) next = [...new Set([...old, ...v])];
    if (JSON.stringify(old) === JSON.stringify(next)) continue;
    brief[k] = next;
    // Record that the REVIEWER set this key, not the brief's author.
    // edit.js resolves framing as: reviewer override > recording preset >
    // brief default. Once a value is in the brief file those three are
    // indistinguishable, so without this list a preset would either always
    // beat a review fix (the loop cannot fix framing) or never beat a
    // generic default (the preset is a no-op). This is the only thing that
    // tells them apart.
    if (!Array.isArray(brief._reviewerOverrides)) brief._reviewerOverrides = [];
    if (!brief._reviewerOverrides.includes(k)) brief._reviewerOverrides.push(k);
    changes.push(`${k}: ${JSON.stringify(old)} -> ${JSON.stringify(next)}`);
  }
  return changes;
}

function main() {
  const args = parseArgs();
  const src = args.src;
  const brand = args.brand || 'dossie';
  if (!src || !fs.existsSync(src)) { console.error('Usage: produce.js --src <raw.mp4> --brand dossie [--out final.mp4] [--rounds 3]'); process.exit(1); }
  const rounds = parseInt(args.rounds || '3', 10);
  const base = path.basename(src, path.extname(src));
  const workDir = args.workdir || path.join(ROOT, '.tmp', `produce-${brand}-${base}`);
  const finalOut = args.out || path.join(ROOT, 'Media', 'finished-videos', `${brand}_produce_${base}.mp4`);
  fs.mkdirSync(workDir, { recursive: true });
  const p = (n) => path.join(workDir, n);

  const brandBrief = path.join(__dirname, 'briefs', `${brand}.json`);
  if (!fs.existsSync(brandBrief)) { console.error(`no brand brief at ${brandBrief}`); process.exit(1); }
  const brief = JSON.parse(fs.readFileSync(brandBrief, 'utf8'));
  if (args.brief && fs.existsSync(args.brief)) Object.assign(brief, JSON.parse(fs.readFileSync(args.brief, 'utf8')));

  const log = [];
  const say = (m) => { console.log(m); log.push(m); };
  const history = [];
  let passed = null, reshoot = null, stalled = null;

  for (let round = 1; round <= rounds; round++) {
    const briefPath = p(`brief-round-${round}.json`);
    fs.writeFileSync(briefPath, JSON.stringify(brief, null, 2));
    const cut = p(`round-${round}.mp4`);
    say(`\n=== produce ${brand}/${base}: round ${round}/${rounds} ===`);
    say(`brief: zoom ${brief.zoom} pad ${brief.padStart}/${brief.padEnd} matte ${!!brief.matte}/${brief.backdrop} captions ${brief.captionSize}px ending ${brief.ending} deroom ${!!brief.deroom} offset ${brief.audioOffsetMs || 0}ms`);

    const edit = spawnSync('node', [path.join(__dirname, 'edit.js'), '--src', src, '--brief', briefPath, '--out', cut, '--workdir', p('edit'), '--reuse'], { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT });
    if (edit.status !== 0) { say(`round ${round}: edit.js failed (exit ${edit.status})`); history.push({ round, edit: 'failed' }); break; }

    const reviewJson = p(`review-round-${round}.json`);
    const rArgs = [path.join(__dirname, 'review.js'), '--video', cut, '--src', src, '--transcript', p('edit/transcript.json'), '--cutlist', p('edit/cutlist.json'), '--brief', briefPath, '--out', reviewJson, '--workdir', p(`review-${round}`), '--label', `${base}-r${round}`];
    if (args['no-vision']) rArgs.push('--no-vision');
    const rev = spawnSync('node', rArgs, { stdio: ['ignore', 'inherit', 'inherit'], cwd: ROOT });
    if (!fs.existsSync(reviewJson)) { say(`round ${round}: review.js produced no verdict (exit ${rev.status})`); history.push({ round, review: 'failed' }); break; }
    const review = JSON.parse(fs.readFileSync(reviewJson, 'utf8'));
    const scoreLine = Object.entries(review.qc).map(([k, v]) => `${k} ${v.score}`).join(', ');
    say(`round ${round}: ${review.verdict} (avg ${review.average}; §22 proud: ${review.proud.answer ? 'yes' : 'no'} — ${review.proud.reason}) — ${scoreLine}`);
    for (const w of review.weakest || []) say(`  §18 weakest: ${w.atSec != null ? w.atSec + 's' : '—'} ${w.what} [${w.cause}]`);
    const entry = { round, verdict: review.verdict, average: review.average, proud: review.proud, scores: Object.fromEntries(Object.entries(review.qc).map(([k, v]) => [k, v.score])), failedOn: review.failedOn, weakest: review.weakest, fixes: review.fixes.map(f => f.instruction), briefChanges: [] };
    history.push(entry);

    if (review.verdict === 'PASS') { passed = { round, cut, review }; break; }
    if (review.verdict === 'RESHOOT') {
      reshoot = { round, review };
      say(`  §19 RESHOOT: ${review.source.reason || 'the source footage is the limiting factor'} (signals: ${(review.source.signals || []).join(', ')})`);
      say('  stopping — re-editing will not fix the source; nothing surfaced');
      break;
    }

    // Feed the notes back into the brief. Every finding lands in exactly one
    // of these four buckets and every bucket gets said out loud.
    const applied = [];      // editor knob turned this round
    const alreadyAt = [];    // editor knob, but the brief already holds that value
    const humanNeeded = [];  // no editor knob will ever fix it
    const reviewerBugs = []; // editor-owned but the reviewer sent no patch
    for (const f of review.fixes) {
      const owner = f.owner || (FIXREG.lookup(f.id) ? FIXREG.lookup(f.id).owner : 'unregistered');
      if (owner === 'human') {
        humanNeeded.push({ id: f.id, check: f.check, section: f.section, instruction: f.instruction, reason: f.humanReason || FIXREG.humanReasonFor(f.id) });
        continue;
      }
      if (owner === 'unregistered') {
        reviewerBugs.push({ id: f.id || '(no id)', instruction: f.instruction, why: 'finding has no fix-registry row — it can be neither applied nor escalated' });
        continue;
      }
      if (!f.brief) {
        reviewerBugs.push({ id: f.id, instruction: f.instruction, why: `registry says editor-fixable via ${(f.knobs || []).join('/') || '(no knobs listed)'} but the reviewer attached no brief patch` });
        continue;
      }
      const ch = applyPatch(brief, f.brief);
      if (ch.length) { applied.push({ id: f.id, changes: ch }); entry.briefChanges.push(...ch); }
      else alreadyAt.push({ id: f.id, instruction: f.instruction, brief: f.brief });
    }
    entry.applied = applied; entry.alreadyAt = alreadyAt; entry.humanNeeded = humanNeeded; entry.reviewerBugs = reviewerBugs;

    for (const k of review.failedOn) say(`  fail ${k}: ${(review.qc[k] && review.qc[k].reason) || ''}`);
    if (entry.briefChanges.length) say(`  brief changes for next round: ${entry.briefChanges.join('; ')}`);
    if (alreadyAt.length) say(`  already at the asked-for value (the knob did not help): ${alreadyAt.map(a => a.id).join(', ')}`);
    if (humanNeeded.length) {
      say(`  NEEDS A HUMAN (${humanNeeded.length}) — no editor knob fixes these:`);
      for (const h of humanNeeded) say(`    - ${h.id} (§${h.section} ${h.check}): ${h.instruction}\n      why: ${h.reason}`);
    }
    if (reviewerBugs.length) {
      say(`  REVIEWER BUG (${reviewerBugs.length}) — a finding that can be neither applied nor escalated:`);
      for (const b of reviewerBugs) say(`    - ${b.id}: ${b.why}`);
    }

    if (!entry.briefChanges.length && round < rounds) {
      // The old "nothing left to change" exit. It is only an honest ending
      // when there is genuinely nothing left to say. Otherwise it is a stall
      // with a name attached.
      const outstanding = [...humanNeeded.map(h => h.id), ...reviewerBugs.map(b => b.id), ...alreadyAt.map(a => a.id)];
      if (outstanding.length) {
        stalled = { round, humanNeeded, reviewerBugs, alreadyAt, failedOn: review.failedOn, review };
        say(`  no editor knob left to turn, but ${outstanding.length} finding(s) are still unaddressed: ${outstanding.join(', ')}`);
        say('  stopping — this is a STALL, not a clean finish. Nothing surfaced.');
      } else {
        say('  no findings left and no knob changed — the brief has converged.');
      }
      break;
    }
  }

  const result = { src, brand, workDir, finalOut, rounds: history, passed: !!passed, reshoot: !!reshoot, stalled: !!stalled };
  if (passed) {
    fs.mkdirSync(path.dirname(finalOut), { recursive: true });
    fs.copyFileSync(passed.cut, finalOut);
    const preview = finalOut.replace(/\.mp4$/i, '-preview.mp4');
    // < 30 MB preview: CRF 26 at 720x1280 lands ~8-12 MB for a 35 s reel.
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', finalOut, '-vf', 'scale=720:1280', '-c:v', 'libx264', '-crf', '26', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', preview]);
    result.preview = preview;
    result.previewBytes = fs.statSync(preview).size;
    say(`\nPASS on round ${passed.round} -> ${finalOut}\npreview ${(result.previewBytes / 1e6).toFixed(1)} MB -> ${preview}`);
  } else if (reshoot) {
    const r = reshoot.review;
    say(`\nRESHOOT on round ${reshoot.round}: ${r.source.reason || r.proud.reason}`);
    say(`Source: hook ${r.source.hookUsable === false ? 'NOT usable' : 'usable'}, audio ${r.source.audioUsable === false ? 'NOT usable' : 'usable'}, delivery ${r.source.delivery || '?'}${r.source.brollMissing ? `, missing B-roll: ${r.source.brollMissing}` : ''}`);
    say(`One change that matters most: ${r.oneChange || 'see review json'}`);
  } else if (stalled) {
    say(`\nSTALLED on round ${stalled.round}. Every editor knob the reviewer asked for is already set, and these are still open:`);
    for (const h of stalled.humanNeeded) say(`  HUMAN  ${h.id} (§${h.section}): ${h.instruction}\n         ${h.reason}`);
    for (const b of stalled.reviewerBugs) say(`  BUG    ${b.id}: ${b.why}`);
    for (const a of stalled.alreadyAt) say(`  NOOP   ${a.id}: the brief already holds ${JSON.stringify(a.brief)} and the finding persists — that knob does not address it`);
    say(`Still failing: ${(stalled.failedOn || []).join(', ') || 'n/a'}. Nothing was copied to ${finalOut}.`);
  } else {
    const last = history[history.length - 1] || {};
    say(`\nNO PASS after ${history.length} round(s). Still failing: ${(last.failedOn || []).join(', ') || 'n/a'}.`);
    if ((last.humanNeeded || []).length) { say('Needs a human:'); for (const h of last.humanNeeded) say(`  ${h.id} (§${h.section}): ${h.instruction}\n    ${h.reason}`); }
    if ((last.reviewerBugs || []).length) { say('Reviewer bugs (findings with nowhere to go):'); for (const b of last.reviewerBugs) say(`  ${b.id}: ${b.why}`); }
    say(`Could not fix: ${(last.fixes || []).join(' | ') || 'see review json'}`);
  }
  // Roll every human-only finding across all rounds up to the top level, so
  // whoever reads produce.json sees them without walking the round history.
  result.needsHuman = [...new Map(history.flatMap(h => (h.humanNeeded || []).map(x => [x.id, x]))).values()];
  result.reviewerBugs = [...new Map(history.flatMap(h => (h.reviewerBugs || []).map(x => [x.id, x]))).values()];
  fs.writeFileSync(p('produce.json'), JSON.stringify(result, null, 2));
  say(`log -> ${p('produce.json')}`);
  if (result.needsHuman.length && !passed) say(`\n${result.needsHuman.length} finding(s) need a person, not another round: ${result.needsHuman.map(h => h.id).join(', ')}`);
  process.exit(passed ? 0 : reshoot ? 3 : stalled ? 4 : 2);
}

main();
