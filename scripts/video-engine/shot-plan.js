#!/usr/bin/env node
/**
 * shot-plan.js — the thing edit.js was missing: a SHOT PLAN.
 *
 * Before this file existed the engine produced exactly one framing for the
 * whole video. `Media/finished-videos/dossie_trial_06.mp4` is the proof:
 * 35.7 s long, first picture change at 27.0 s. review.js flagged the static
 * stretch correctly and then handed produce.js a `null` brief patch, because
 * there was no editor knob to turn. §4 of the Creative Director Standard was
 * structurally unreachable.
 *
 * WHAT THIS DOES
 * Builds a list of shots over the POST-CUT timeline, each with its own
 * framing (wide / punch), with the cut points chosen from the transcript's
 * sentence and clause boundaries so a cut lands on a change of MEANING, not
 * on a timer. face-track-crop.js consumes it and hard-cuts the crop window
 * between shots.
 *
 * WHY THIS CANNOT RE-INTRODUCE THE LIP-SYNC DRIFT (Heath's trial-01 note)
 * A shot boundary here removes ZERO time and touches ZERO audio. The audio
 * and video timelines were already locked together by render-cutlist.js,
 * which trims both streams from identical -ss/-to per segment in one
 * filter_complex pass. A framing change is a crop-rect step on frames that
 * are already in sync. It is structurally incapable of clipping a word or
 * shifting sync — which is also why the J/L offsets below are safe.
 *
 * J / L CUTS
 * A cut that lands exactly on the audio boundary reads mechanical. Real
 * edits offset the picture from the sound:
 *   L-cut  — picture changes EARLY, while the tail of the previous line is
 *            still releasing. Audio trails the picture.
 *   J-cut  — picture changes LATE, after the next line has already started.
 *            Audio leads the picture.
 * We alternate L / J so the rhythm isn't metronomic. L-cuts are clamped to
 * land >= `minPadAfterWordEnd` (default 0.20 s) after the previous word ends
 * and J-cuts >= `minPadBeforeOnset` (default 0.15 s) — the same padding
 * discipline cutlist.js applies, so the picture never changes in the middle
 * of a breath group even though nothing is being removed.
 *
 * FRAMING
 * Alternating wide / punch, never more than `maxScaleRatio` (1.3) apart so
 * consecutive shots don't read as a jarring jump (review.js's scale-jump
 * check). The punch is a real reframe, not a zoom ramp — §4 says "intentional
 * rather than frantic", and a hard cut is intentional where a slow push is
 * decoration. No oval, no vignette, no lateral drift by default.
 *
 * Usage:
 *   node scripts/video-engine/shot-plan.js --transcript <scribe json> \
 *     --cutlist <cutlist json> --out <shot-plan.json> \
 *     [--minShotSec 1.8] [--maxShotSec 5.0] [--baseZoom 1.05] \
 *     [--punchFactor 1.18] [--maxScaleRatio 1.3] [--punchZoomMax 1.6] \
 *     [--openWide 1] [--jlCutSec 0.14] [--noJL]
 */
'use strict';
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

/**
 * Map a SOURCE-timeline second to its POST-CUT second using the keep
 * segments. Returns null if the source instant was removed by the cut.
 */
function makeSourceToPost(keepSegments) {
  const segs = keepSegments.slice().sort((a, b) => a.start - b.start);
  const offsets = [];
  let acc = 0;
  for (const s of segs) { offsets.push(acc); acc += (s.end - s.start); }
  return {
    totalPostSec: acc,
    map(srcT) {
      for (let i = 0; i < segs.length; i++) {
        if (srcT >= segs[i].start && srcT <= segs[i].end) return offsets[i] + (srcT - segs[i].start);
      }
      return null;
    },
    /** Nearest post-cut time for a source instant that may sit inside a removed cut. */
    mapClamped(srcT) {
      let best = null, bestD = Infinity;
      for (let i = 0; i < segs.length; i++) {
        const clamped = Math.max(segs[i].start, Math.min(segs[i].end, srcT));
        const d = Math.abs(clamped - srcT);
        if (d < bestD) { bestD = d; best = offsets[i] + (clamped - segs[i].start); }
      }
      return best;
    },
    segs, offsets,
  };
}

/** Split the word list into sentences on terminal punctuation. */
function toSentences(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]['"]?$/.test(w.text.trim())) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Collect candidate picture-cut points on the SOURCE timeline, each with a
 * tier (lower = stronger editorial reason) and the gap it sits in.
 *   tier 1 — sentence boundary
 *   tier 2 — clause boundary (previous word ends in , ; : — or is a
 *            coordinating conjunction lead-in) with a real pause
 *   tier 3 — any inter-word pause long enough to hide a cut in
 */
const CLAUSE_LEAD = /^(and|but|so|because|then|which|that's|plus|or)$/i;
function collectCandidates(words, opts) {
  const cands = [];
  const sentenceEnds = new Set();
  for (const s of toSentences(words)) sentenceEnds.add(s[s.length - 1].end);

  for (let i = 0; i < words.length - 1; i++) {
    const prev = words[i], next = words[i + 1];
    const gap = next.start - prev.end;
    if (gap < opts.minGapSec) continue;
    const prevTxt = prev.text.trim();
    const nextTxt = next.text.trim().replace(/[^A-Za-z']/g, '');
    let tier = 3, why = `pause ${gap.toFixed(2)}s`;
    if (sentenceEnds.has(prev.end)) { tier = 1; why = `sentence end after "${prevTxt}"`; }
    else if (/[,;:]$/.test(prevTxt) || CLAUSE_LEAD.test(nextTxt)) { tier = 2; why = `clause boundary "${prevTxt}" | "${nextTxt}"`; }
    cands.push({ prevEnd: prev.end, nextStart: next.start, gap, tier, why, prevText: prevTxt, nextText: next.text.trim() });
  }
  return cands;
}

/**
 * Place the picture cut inside a candidate gap, offset for a J or L cut.
 *   style 'L' — early (picture leads, audio trails)
 *   style 'J' — late  (picture trails, audio leads)
 *   style 'M' — mid-gap, used when the gap is too tight for a real offset
 * Always clamped inside [prevEnd + padAfter, nextStart - padBefore] when the
 * gap allows it; a J-cut is allowed to sit just past nextStart only when the
 * gap is genuinely too small, and even then it changes no audio.
 */
function placeCut(c, style, jlSec, padAfter, padBefore) {
  const lo = c.prevEnd + padAfter;
  const hi = c.nextStart - padBefore;
  if (hi <= lo) return { t: (c.prevEnd + c.nextStart) / 2, style: 'M', note: 'gap too tight for a J/L offset; cut mid-gap' };
  if (style === 'L') return { t: Math.max(lo, Math.min(hi, c.prevEnd + Math.max(padAfter, jlSec))), style: 'L', note: 'picture leads; tail of the previous line still releasing' };
  if (style === 'J') return { t: Math.max(lo, Math.min(hi, c.nextStart - Math.max(padBefore, jlSec))), style: 'J', note: 'picture trails; the next line has already started' };
  return { t: (lo + hi) / 2, style: 'M', note: 'mid-gap' };
}

function buildShotPlan(transcript, cutlist, opts) {
  const words = transcript.words.filter(w => w.type === 'word');
  const s2p = makeSourceToPost(cutlist.keepSegments || []);
  const totalPost = s2p.totalPostSec;

  const cands = collectCandidates(words, opts)
    // Only candidates that survived the cut are usable.
    .filter(c => s2p.map(c.prevEnd) != null || s2p.map(c.nextStart) != null);

  // Junctions between kept segments are already hard audio cuts, so a picture
  // change there is free. Landing the picture EXACTLY on the audio splice is
  // the mechanical-feeling option though — offsetting it by a frame or two
  // either side is what a J or L cut actually is. The offset is bounded by
  // the padding that already exists around the splice (cutlist.js guarantees
  // >= minPadAfterWordEnd before it and >= minPadBeforeOnset after it), so
  // the picture still changes inside silence, never over a word.
  const junctions = [];
  let jjl = 0;
  for (let i = 0; i < s2p.segs.length - 1; i++) {
    const at = s2p.offsets[i] + (s2p.segs[i].end - s2p.segs[i].start);
    const style = opts.jl ? (jjl++ % 2 === 0 ? 'L' : 'J') : 'M';
    // The splice has padAfterWordEnd of room before it and padBeforeOnset
    // after it; stay inside the smaller of the two so neither side clips.
    const room = Math.min(opts.padAfterWordEnd, opts.padBeforeOnset, opts.jlCutSec);
    const off = style === 'L' ? -room : style === 'J' ? +room : 0;
    junctions.push({
      postT: Math.max(0.05, Math.min(totalPost - 0.05, at + off)),
      tier: 0,
      why: 'keep-segment junction (audio already cuts here)',
      style,
      note: style === 'M' ? 'on the audio splice' : `${style}-cut: picture ${style === 'L' ? 'leads' : 'trails'} the audio splice by ${Math.round(room * 1000)} ms`,
    });
  }

  // Everything into post-cut time, deduped, sorted.
  const pool = [];
  let jl = 0;
  for (const c of cands) {
    const style = opts.jl ? (jl++ % 2 === 0 ? 'L' : 'J') : 'M';
    const placed = placeCut(c, style, opts.jlCutSec, opts.padAfterWordEnd, opts.padBeforeOnset);
    const postT = s2p.mapClamped(placed.t);
    if (postT == null) continue;
    pool.push({ postT, tier: c.tier, why: c.why, style: placed.style, note: placed.note, gap: +c.gap.toFixed(3) });
  }
  for (const j of junctions) pool.push({ ...j, gap: null });
  pool.sort((a, b) => a.postT - b.postT);
  // Drop candidates that collapse onto each other.
  const uniq = [];
  for (const c of pool) {
    if (uniq.length && c.postT - uniq[uniq.length - 1].postT < 0.25) {
      if (c.tier < uniq[uniq.length - 1].tier) uniq[uniq.length - 1] = c;
      continue;
    }
    uniq.push(c);
  }

  // Greedy shot assembly.
  const boundaries = [];
  let cursor = 0;
  let guard = 0;
  while (cursor < totalPost - opts.minShotSec && guard++ < 500) {
    const window = uniq.filter(c => c.postT >= cursor + opts.minShotSec && c.postT <= cursor + opts.maxShotSec);
    let pickCand = null;
    if (window.length) {
      // Strongest editorial reason first; among equals, the one closest to
      // the middle of the allowed window so shot lengths stay even.
      const target = cursor + (opts.minShotSec + opts.maxShotSec) / 2;
      window.sort((a, b) => (a.tier - b.tier) || (Math.abs(a.postT - target) - Math.abs(b.postT - target)));
      pickCand = window[0];
    } else {
      // Nothing inside the window. Take the next candidate of any kind even
      // if it overruns maxShotSec — better one long shot than a cut that
      // lands mid-word. This overrun is reported, not hidden.
      const after = uniq.filter(c => c.postT > cursor + opts.minShotSec);
      if (!after.length) break;
      pickCand = { ...after[0], overran: true };
    }
    if (totalPost - pickCand.postT < opts.minShotSec) break; // don't orphan a sliver at the end
    boundaries.push(pickCand);
    cursor = pickCand.postT;
  }

  // Framings: alternate wide / punch, opening on whichever the brief asks.
  const shots = [];
  let prevT = 0;
  const seq = [...boundaries.map(b => b.postT), totalPost];
  const meta = [...boundaries, null];
  const punchZoom = Math.min(opts.punchZoomMax, +(opts.baseZoom * opts.punchFactor).toFixed(4));
  // Never let two consecutive shots differ by more than maxScaleRatio.
  const ratio = punchZoom / opts.baseZoom;
  const cappedPunch = ratio > opts.maxScaleRatio ? +(opts.baseZoom * opts.maxScaleRatio).toFixed(4) : punchZoom;
  for (let i = 0; i < seq.length; i++) {
    const isWide = opts.openWide ? (i % 2 === 0) : (i % 2 === 1);
    shots.push({
      index: i,
      startSec: +prevT.toFixed(3),
      endSec: +seq[i].toFixed(3),
      durationSec: +(seq[i] - prevT).toFixed(3),
      framing: isWide ? 'wide' : 'punch',
      zoom: isWide ? +opts.baseZoom.toFixed(4) : cappedPunch,
      cutIn: i === 0 ? { style: 'OPEN', why: 'first shot' } : { style: meta[i - 1].style, why: meta[i - 1].why, note: meta[i - 1].note, tier: meta[i - 1].tier, gap: meta[i - 1].gap, overran: !!meta[i - 1].overran },
    });
    prevT = seq[i];
  }

  const durs = shots.map(s => s.durationSec);
  return {
    totalPostSec: +totalPost.toFixed(3),
    baseZoom: opts.baseZoom,
    punchZoom: cappedPunch,
    scaleRatio: +(cappedPunch / opts.baseZoom).toFixed(3),
    minShotSec: opts.minShotSec,
    maxShotSec: opts.maxShotSec,
    jl: opts.jl,
    shots,
    stats: {
      shotCount: shots.length,
      pictureCuts: shots.length - 1,
      longestShotSec: durs.length ? +Math.max(...durs).toFixed(2) : 0,
      shortestShotSec: durs.length ? +Math.min(...durs).toFixed(2) : 0,
      meanShotSec: durs.length ? +(durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(2) : 0,
      overrunShots: shots.filter(s => s.cutIn.overran).length,
      byCutStyle: shots.slice(1).reduce((a, s) => { a[s.cutIn.style] = (a[s.cutIn.style] || 0) + 1; return a; }, {}),
      byTier: shots.slice(1).reduce((a, s) => { a[`tier${s.cutIn.tier}`] = (a[`tier${s.cutIn.tier}`] || 0) + 1; return a; }, {}),
    },
  };
}

/* ===========================================================================
 * PROVEN SIZE/POSITION LOOKS — ported from the hand-built 60 s cut
 * (Downloads/dossie_water_60s_v4.mp4, scratchpad sw2.txt / sx2.txt).
 *
 * The zoom model above describes a CROP of a full-frame talking head. The
 * shipped cut is a different composite: he is a matted CUTOUT laid over a
 * scrolling contract, so a "shot" is a WIDTH and an X, bottom-aligned. The
 * two models coexist — `looks` is only used when the renderer is compositing
 * a cutout, and it is what produces the sw/sx expressions ffmpeg consumes.
 *
 * Measured working values:
 *   minimum segment                       2.3 s
 *   cut on gap > 0.42 s OR sentence end
 *   looks, as (width, x) bottom-aligned   (470,560) (860,70) (640,360) (740,190)
 *   forced look during doc emphasis       (430,600)
 *   y                                     always H - h
 *
 * WHY THE FORCED SMALL LOOK MATTERS: during a document-emphasis window the
 * evidence IS the shot. An 860-wide cutout covers the clause he is talking
 * about. Forcing (430,600) keeps him bottom-right and small so the circled
 * paragraph stays visible — §3, the visual has to carry the claim.
 * =========================================================================== */
const PROVEN_LOOKS = {
  minShotSec: 2.3,
  gapSec: 0.42,
  looks: [[470, 560], [860, 70], [640, 360], [740, 190]],
  emphasisLook: [430, 600],
};

/**
 * assignLooks — attach a (w, x) look to each shot and build the ffmpeg
 * `between(t,a,b)*V` sum expressions for width and x.
 *
 * @param shots             from buildShotPlan
 * @param emphasisWindows   [{startSec, endSec}] — doc-emphasis windows that
 *                          force the small look
 * @returns { shots, swExpr, sxExpr }
 */
function assignLooks(shots, {
  looks = PROVEN_LOOKS.looks,
  emphasisLook = PROVEN_LOOKS.emphasisLook,
  emphasisWindows = [],
} = {}) {
  const overlaps = (s) => emphasisWindows.some(w => s.startSec < w.endSec && s.endSec > w.startSec);
  let i = 0;
  const out = shots.map((s) => {
    let w, x, forced = false;
    if (overlaps(s)) {
      [w, x] = emphasisLook; forced = true;
    } else {
      [w, x] = looks[i % looks.length]; i++;
    }
    return { ...s, look: { w, x, y: 'H-h', forcedByEmphasis: forced } };
  });

  const terms = (pick) => out.map(s =>
    `between(t,${s.startSec.toFixed(2)},${s.endSec.toFixed(2)})*${pick(s)}`
  ).join('+');

  // max(minWidth, ...) mirrors sw2.txt: `between` returns 0 outside its
  // window, so on the exact boundary instant every term can be 0 and the
  // width would collapse to 0 for one frame. The floor prevents that.
  const minW = Math.min(...out.map(s => s.look.w));
  return {
    shots: out,
    swExpr: `max(${minW},${terms(s => s.look.w)})`,
    sxExpr: `(${terms(s => s.look.x)})`,
  };
}

function main() {
  const args = parseArgs();
  if (!args.transcript || !args.cutlist || !args.out) {
    console.error('Usage: shot-plan.js --transcript <json> --cutlist <json> --out <json> [--minShotSec 1.8] [--maxShotSec 5.0] [--baseZoom 1.05] [--punchFactor 1.18] [--looks proven] [--emphasisWindows <json>]');
    process.exit(1);
  }
  const provenLooks = args.looks === 'proven';
  const opts = {
    // --looks proven also adopts the proven cut discipline: 2.3s minimum
    // segment and a 0.42s gap threshold. Those numbers travel together with
    // the looks; a 1.8s minimum with an 860-wide cutout reads frantic.
    minShotSec: parseFloat(args.minShotSec || (provenLooks ? String(PROVEN_LOOKS.minShotSec) : '1.8')),
    maxShotSec: parseFloat(args.maxShotSec || '5.0'),
    baseZoom: parseFloat(args.baseZoom || '1.05'),
    punchFactor: parseFloat(args.punchFactor || '1.18'),
    maxScaleRatio: parseFloat(args.maxScaleRatio || '1.3'),
    punchZoomMax: parseFloat(args.punchZoomMax || '1.6'),
    openWide: args.openWide === undefined ? true : String(args.openWide) !== '0' && String(args.openWide) !== 'false',
    jl: !args.noJL,
    jlCutSec: parseFloat(args.jlCutSec || '0.14'),
    // Same padding discipline cutlist.js uses (Heath's note 1).
    padAfterWordEnd: parseFloat(args.minPadAfterWordEnd || '0.20'),
    padBeforeOnset: parseFloat(args.minPadBeforeOnset || '0.15'),
    minGapSec: parseFloat(args.minGapSec || (provenLooks ? String(PROVEN_LOOKS.gapSec) : '0.22')),
  };
  const transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf8'));
  const cutlist = JSON.parse(fs.readFileSync(args.cutlist, 'utf8'));
  const plan = buildShotPlan(transcript, cutlist, opts);

  if (provenLooks) {
    const emphasisWindows = args.emphasisWindows && args.emphasisWindows !== true
      ? JSON.parse(args.emphasisWindows) : [];
    const looked = assignLooks(plan.shots, { emphasisWindows });
    plan.shots = looked.shots;
    plan.looks = { swExpr: looked.swExpr, sxExpr: looked.sxExpr, emphasisWindows, model: 'cutout-bottom-aligned' };
    console.log(`[shot-plan] proven looks: ${plan.shots.length} shots, ${plan.shots.filter(s => s.look.forcedByEmphasis).length} forced small by doc emphasis`);
  }

  fs.writeFileSync(args.out, JSON.stringify(plan, null, 2));
  console.log(JSON.stringify(plan.stats, null, 2));
  for (const s of plan.shots) {
    console.log(`  shot ${s.index}: ${s.startSec}-${s.endSec}s (${s.durationSec}s) ${s.framing} z=${s.zoom} <- ${s.cutIn.style} ${s.cutIn.why || ''}`);
  }
}

module.exports = { buildShotPlan, makeSourceToPost, toSentences, collectCandidates, assignLooks, PROVEN_LOOKS };
if (require.main === module) main();
