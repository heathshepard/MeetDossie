#!/usr/bin/env node
//
// scripts/regression-video-variants.js
//
// Locks the timeline maths behind the dual-cut production process
// (scripts/video-engine/variants.js + script-format.js).
//
// Everything here is arithmetic and string rewriting — no ffmpeg, no network,
// no API key. The rendering and the vision rules are proven by actually
// running scripts/video-engine/produce-variants.js against a real master; this
// file exists so the part that silently produces a WRONG but plausible video
// (a caption two seconds late, an annotation on the wrong word, a framing
// window that outlived the sentence it belonged to) cannot regress unnoticed.
//
//   node scripts/regression-video-variants.js

'use strict';

const path = require('path');
const fs = require('fs');

const V = require('./video-engine/variants.js');
const SF = require('./video-engine/script-format.js');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  PASS  ${name}`); return; }
  failures += 1;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}
function near(a, b, tol = 0.011) { return Math.abs(a - b) <= tol; }

// A 20-second master: five 4-second sentences, alternating tags.
const SEGMENTS = [
  { start: 0, end: 4, tag: 'CORE', text: 'hook' },
  { start: 4, end: 8, tag: 'OPTIONAL', text: 'context' },
  { start: 8, end: 12, tag: 'CORE', text: 'the rule' },
  { start: 12, end: 16, tag: 'OPTIONAL', text: 'second example' },
  { start: 16, end: 20, tag: 'CORE', text: 'cta' },
];

console.log('\n1. buildVariant — durations and keep spans');
const core = V.buildVariant({ segments: SEGMENTS, includeTags: ['CORE'], fps: 30, masterDuration: 20, which: 'core' });
const full = V.buildVariant({ segments: SEGMENTS, includeTags: ['CORE', 'OPTIONAL'], fps: 30, masterDuration: 20, which: 'full' });
{
  check('core keeps 3 spans', core.keep.length === 3, JSON.stringify(core.keep));
  check('core duration 12s', near(core.duration, 12), String(core.duration));
  check('core drops 8s', near(core.droppedSeconds, 8), String(core.droppedSeconds));
  check('core frame count 360', core.frameCount === 360, String(core.frameCount));
  check('full MERGES into a single contiguous span', full.keep.length === 1, JSON.stringify(full.keep));
  check('full duration 20s', near(full.duration, 20), String(full.duration));
}

console.log('\n2. timeline remap — master time -> variant time');
{
  check('t=0 -> 0', near(core.map(0), 0));
  check('t=3.9 (in span 1) -> 3.9', near(core.map(3.9), 3.9));
  check('t=6 (inside a CUT) -> null, not a guess', core.map(6) === null);
  check('t=8 (start of span 2) -> 4', near(core.map(8), 4));
  check('t=11 -> 7', near(core.map(11), 7));
  check('t=16 (start of span 3) -> 8', near(core.map(16), 8));
  check('t=19.9 -> 11.9', near(core.map(19.9), 11.9));
  check('mapClamped never returns null inside a cut', core.mapClamped(6) !== null);
}

console.log('\n3. captions remap — dropped, not clamped');
{
  const ass = [
    '[Script Info]', 'PlayResX: 1080', '', '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    'Dialogue: 0,0:00:01.00,0:00:02.00,Cap,,0,0,0,,IN SPAN ONE',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Cap,,0,0,0,,IN A CUT',
    'Dialogue: 0,0:00:09.00,0:00:10.00,Cap,,0,0,0,,IN SPAN TWO',
    'Dialogue: 0,0:00:17.00,0:00:18.00,Cap,,0,0,0,,IN SPAN THREE',
  ].join('\n');
  const r = V.remapAss(ass, core);
  check('3 events kept, 1 dropped', r.kept === 3 && r.dropped === 1, `kept ${r.kept} dropped ${r.dropped}`);
  check('the cut-away event is GONE (not stacked at 0)', !r.text.includes('IN A CUT'));
  check('span-1 event keeps its time', r.text.includes('0:00:01.00,0:00:02.00'));
  check('span-2 event shifts 4s earlier', r.text.includes('0:00:05.00,0:00:06.00') && r.text.includes('IN SPAN TWO'), r.text);
  check('span-3 event shifts 8s earlier', r.text.includes('0:00:09.00,0:00:10.00') && r.text.includes('IN SPAN THREE'));
  check('style/header block passes through verbatim', r.text.includes('PlayResX: 1080') && r.text.includes('[Script Info]'));
  const times = [...r.text.matchAll(/^Dialogue: 0,([\d:.]+),([\d:.]+)/gm)].map((m) => V.parseAssTime(m[2]));
  check('no event ends after the variant does', Math.max(...times) <= core.duration + 0.01, String(Math.max(...times)));
}

console.log('\n4. shot-plan remap — windows follow their sentences');
{
  const expr = 'max(440,between(t,0.00,4.00)*620+between(t,4.00,8.00)*980+between(t,8.00,12.00)*780+between(t,12.00,16.00)*880+between(t,16.00,20.00)*430)';
  const r = V.remapShotPlan(expr, core);
  check('2 windows removed (the two OPTIONAL ones)', r.removedWindows === 2, `removed ${r.removedWindows}`);
  check('no dead between(t,0,0) term survives', !r.expr.includes('between(t,0,0)'), r.expr);
  check('first window unchanged', r.expr.includes('between(t,0.00,4.00)'), r.expr);
  check('the rule window moved to 4-8', r.expr.includes('between(t,4.00,8.00)*780'), r.expr);
  check('the CTA window moved to 8-12', r.expr.includes('between(t,8.00,12.00)*430'), r.expr);
}

console.log('\n5. cues — the annotation lands on the WORD, not a fixed offset');
{
  // recipe §7: an early cut drew the circle at 4s while the words it annotated
  // were at 19s. A cue is a master time and gets the same remap as everything
  // else, so removing 4s ahead of it moves it by exactly 4s.
  const r = V.remapCues([
    { name: 'circle', t: 9.0 },
    { name: 'orphan', t: 6.0 },
    { name: 'settle', t0: 8.0, d: 2.0 },
  ], core);
  const circle = r.cues.find((c) => c.name === 'circle');
  check('circle 9.0 -> 5.0 (4s of OPTIONAL removed ahead of it)', near(circle.t, 5.0), String(circle.t));
  check('circle records its master time for audit', near(circle.tMaster, 9.0));
  check('a cue inside a cut is ORPHANED, not silently moved', r.orphaned.length === 1 && r.orphaned[0].name === 'orphan');
  const settle = r.cues.find((c) => c.name === 'settle');
  check('settle start 8.0 -> 4.0 and keeps its 2s duration', near(settle.t0, 4.0) && near(settle.d, 2.0), JSON.stringify(settle));
}

console.log('\n6. frame ranges — indices into the SHARED rgba directory');
{
  const ranges = V.frameRanges(core);
  check('3 ranges', ranges.length === 3, JSON.stringify(ranges));
  check('first range 1..120 (1-based, matte.js --mode rgba naming)', ranges[0].from === 1 && ranges[0].to === 120, JSON.stringify(ranges[0]));
  check('second range 241..360', ranges[1].from === 241 && ranges[1].to === 360, JSON.stringify(ranges[1]));
  const total = ranges.reduce((a, r) => a + (r.to - r.from + 1), 0);
  check('360 frames total = 12s @30fps', total === 360, String(total));
}

console.log('\n7. ffmpeg filters — video and audio cut on the SAME boundaries');
{
  const af = V.ffmpegAudioFilter(core);
  const vf = V.ffmpegVideoTrimFilter(core);
  const aTimes = [...af.matchAll(/start=([\d.]+):end=([\d.]+)/g)].map((m) => `${m[1]}-${m[2]}`);
  const vTimes = [...vf.matchAll(/start=([\d.]+):end=([\d.]+)/g)].map((m) => `${m[1]}-${m[2]}`);
  check('identical boundaries (recipe §4: they cannot drift if cut together)', JSON.stringify(aTimes) === JSON.stringify(vTimes), `${aTimes} vs ${vTimes}`);
  check('audio concat has n=3', af.includes('concat=n=3:v=0:a=1'));
  check('video concat has n=3', vf.includes('concat=n=3:v=1:a=0'));
}

console.log('\n8. refusals — a bad spec fails loudly');
{
  let threw = false;
  try { V.buildVariant({ segments: [{ start: 5, end: 1, tag: 'CORE' }], includeTags: ['CORE'], fps: 30 }); } catch (_) { threw = true; }
  check('end <= start throws', threw);
  threw = false;
  try { V.buildVariant({ segments: [{ start: 0, end: 1, tag: 'MAYBE' }], includeTags: ['CORE'], fps: 30 }); } catch (_) { threw = true; }
  check('an unknown tag throws (no silent default)', threw);
  threw = false;
  try { V.buildVariant({ segments: SEGMENTS, includeTags: ['NOPE'], fps: 30 }); } catch (_) { threw = true; }
  check('zero matching segments throws rather than emitting an empty cut', threw);
}

console.log('\n9. segmentsFromAss — sentence boundaries INSIDE caption events');
{
  const ass = [
    '[Events]',
    'Dialogue: 0,0:00:04.00,0:00:05.00,Cap,,0,0,0,,AGO. INSPECTIONS',
    'Dialogue: 0,0:00:05.00,0:00:06.00,Cap,,0,0,0,,ARE BEHIND YOU.',
    'Dialogue: 0,0:00:06.00,0:00:07.00,Cap,,0,0,0,,HERE IS HOW.',
  ].join('\n');
  const segs = V.segmentsFromAss(ass, { tailEnd: 8 });
  check('a head segment covers 0 -> first caption', segs[0].start === 0 && near(segs[0].end, 4), JSON.stringify(segs[0]));
  check('"AGO." becomes its own short segment', segs[1].text === 'AGO.' && segs[1].end < 4.6, JSON.stringify(segs[1]));
  check('the boundary is interpolated INSIDE the event, not at its end', segs[1].end > 4.0 && segs[1].end < 5.0, String(segs[1].end));
  check('tailEnd extends the last segment', near(segs[segs.length - 1].end, 8), String(segs[segs.length - 1].end));
  check('segments are contiguous', segs.every((s, i) => i === 0 || near(s.start, segs[i - 1].end)));
}

console.log('\n10. script-format — tags, must-carry, and the pace band');
{
  const md = [
    '# VIDEO 9 — A TEST',
    '',
    '### SCRIPT',
    '',
    '`[CORE]`',
    '',
    '`[FACE]`',
    'Hook line one two three four five six seven eight nine ten.',
    '',
    '`[OPTIONAL]`',
    '',
    'Context that can go away without breaking anything at all here ok.',
    '',
    '`[CORE]`',
    '',
    'The rule, and it may apply only sometimes.',
    '',
    'Follow and save this one.',
    '',
    '### CORE MUST CARRY',
    '- "may"',
    '',
    '---',
  ].join('\n');
  const { scripts, errors } = SF.parse(md);
  check('one script parsed', scripts.length === 1, String(scripts.length));
  check('no errors', errors.length === 0, errors.join(' | '));
  const s = scripts[0];
  check('3 CORE chunks, 1 OPTIONAL', s.core.length === 3 && s.optional.length === 1, `${s.core.length}/${s.optional.length}`);
  check('the tag never reaches the spoken text', !SF.selectVariant(s, 'core').text.includes('CORE'));
  check('core < full word count', SF.selectVariant(s, 'core').wordCount < SF.selectVariant(s, 'full').wordCount);
  check('must-carry "may" is satisfied', SF.checkMustCarry(s).length === 0);

  // Drop the qualifier -> the parse must FAIL, not warn.
  const broken = md.replace('The rule, and it may apply only sometimes.', 'The rule, and it applies.');
  const r2 = SF.parse(broken);
  check('removing the qualifier from CORE is a parse ERROR', r2.errors.some((e) => /CORE MUST CARRY/.test(e)), r2.errors.join(' | '));

  // Hook/CTA structural rules.
  const noHook = md.replace('`[CORE]`\n\n`[FACE]`\nHook line', '`[OPTIONAL]`\n\n`[FACE]`\nHook line');
  check('an OPTIONAL opening chunk is an error (core would have no hook)',
    SF.parse(noHook).errors.some((e) => /no hook/.test(e)), SF.parse(noHook).errors.join(' | '));

  const band = SF.paceBand(s);
  check('paceBand returns a decision', typeof band.feasible === 'boolean' && typeof band.note === 'string');
}

console.log('\n11. the checked-in TREC 7.I spec is internally consistent');
{
  const specPath = path.join(__dirname, 'video-engine', 'recipes', 'trec-7i', 'variants.json');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  check('segments are contiguous and ordered',
    spec.segments.every((s, i) => i === 0 || near(s.start, spec.segments[i - 1].end)),
    'gap between segments');
  const c = V.buildVariant({ segments: spec.segments, includeTags: ['CORE'], fps: spec.fps, masterDuration: 51.1667, which: 'core' });
  const f = V.buildVariant({ segments: spec.segments, includeTags: ['CORE', 'OPTIONAL'], fps: spec.fps, masterDuration: 51.1667, which: 'full' });
  check('core is shorter than full', c.duration < f.duration, `${c.duration} vs ${f.duration}`);
  check('full covers the whole master', near(f.duration, 51.1667, 0.02), String(f.duration));
  check('core keeps the hook (starts at 0)', c.keep[0].start === 0, JSON.stringify(c.keep[0]));
  check('core keeps the CTA (ends at the master end)', near(c.keep[c.keep.length - 1].end, 51.1667, 0.02), JSON.stringify(c.keep[c.keep.length - 1]));
  const ruleSeg = spec.segments.find((s) => s.text.startsWith('IF THE SELLER OWES'));
  check('the rule sentence WITH its conditions is CORE', ruleSeg && ruleSeg.tag === 'CORE');
  check('the rule sentence is one unsplit segment', ruleSeg && ruleSeg.end - ruleSeg.start > 12, ruleSeg && String(ruleSeg.end - ruleSeg.start));
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}\n`);
process.exit(failures === 0 ? 0 : 1);
