#!/usr/bin/env node
/**
 * cutlist.js — turns an ElevenLabs scribe_v1 word-timestamp transcript into
 * a cut list that drops dead air, filler words (um/uh/erm), and false
 * starts/stutters, with configurable padding so the result doesn't sound
 * robotic.
 *
 * Usage:
 *   node scripts/video-engine/cutlist.js --transcript <scribe json> --out <cutlist json> \
 *     [--silenceThreshold 0.6] [--padStart 0.08] [--padEnd 0.12] [--minKeep 0.3] \
 *     [--minPadBeforeOnset 0.15] [--minPadAfterWordEnd 0.30] [--breathGroupGap 0.35] \
 *     [--startAtLine "<phrase>"] [--endAfterLine "<phrase>"] [--dropLines "<a>||<b>"]
 *
 * EDITORIAL BOUNDS (the knobs review.js turns):
 *   --startAtLine   open the cut on the first word of the sentence containing
 *                   <phrase>. This is how the "§2 banned opener" and "open on
 *                   a stronger line" findings get applied.
 *   --endAfterLine  close the cut at the end of the sentence containing
 *                   <phrase>. This is how "the closing line is from a fumbled
 *                   take" gets applied.
 *   --dropLines     "||"-separated phrases; every sentence containing one is
 *                   removed wholesale. §12: remove anything that does not
 *                   contribute. Redundant restatements are the usual target.
 *   All three match case/punctuation-insensitively on a run of 3+ words, and
 *   all three produce cuts that go through the SAME boundary clamp as every
 *   other cut — an editorial bound can no more clip a word than a dead-air
 *   cut can.
 *
 * Heuristics:
 *   - Silence: gap between word[i].end and word[i+1].start > silenceThreshold
 *     -> cut the middle of the gap, leaving `padStart`/`padEnd` seconds of
 *     natural room on each side (so it doesn't feel hard-clipped).
 *   - Filler words: um, uh, erm, uhh, umm (word-boundary, case-insensitive)
 *     -> cut the word +/- small pad.
 *   - False starts / stutters: a word ending in one or more trailing hyphens
 *     ("t-t--"), OR an immediate exact repeat of the same word/short phrase
 *     within the next 2 words -> cut the truncated/duplicate fragment only,
 *     keep the completed version.
 *
 * NO-CLIPPED-WORDS DEFAULT (Heath's note 1, every trial cut so far):
 *   Every cut, whatever heuristic produced it, is run through a final
 *   safety clamp (`clampCutsAgainstWordBoundaries`) that guarantees:
 *     - >= minPadAfterWordEnd (300ms) of room is kept after the END of the
 *       nearest word before the cut,
 *     - >= minPadBeforeOnset (150ms) of room is kept before the START of the
 *       nearest word after the cut,
 *     - a cut that can't satisfy both (the words are already closer together
 *       than 450ms) is dropped entirely rather than clipping into either
 *       word — this is the "never inside a breath group" rule: as long as
 *       breathGroupGap (0.35s) < silenceThreshold (0.6s), any two words in
 *       the same breath group are already closer together than the
 *       silence-cut trigger, so a dead-air cut can structurally never land
 *       inside one; the clamp is what also protects filler/false-start
 *       cuts, which by design DO sit inside a breath group.
 *     - the FINAL kept segment always runs through the last spoken word's
 *       end + minPadAfterWordEnd (a tail_silence cut is clamped exactly
 *       like any other, so this falls out of the same rule).
 */
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

const FILLER_RE = /^(um+|uh+|erm+|hm+)[.,]?$/i;

/** Split words into sentences on terminal punctuation. */
function sentencesOf(words) {
  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?]['"]?$/.test(w.text.trim())) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Find the sentence containing <phrase>. Matching is case/punctuation-
 * insensitive and requires a run of 3+ words so a stray common word can't
 * silently re-point an editorial bound at the wrong line.
 */
function findSentence(sentences, phrase) {
  const needle = norm(phrase);
  if (needle.split(' ').length < 3) return null;
  for (let i = 0; i < sentences.length; i++) {
    const hay = norm(sentences[i].map(w => w.text).join(' '));
    if (hay.includes(needle)) return { idx: i, sentence: sentences[i] };
  }
  // Fall back to the longest matching prefix run of >= 3 words.
  const parts = needle.split(' ');
  for (let len = parts.length; len >= 3; len--) {
    const sub = parts.slice(0, len).join(' ');
    for (let i = 0; i < sentences.length; i++) {
      const hay = norm(sentences[i].map(w => w.text).join(' '));
      if (hay.includes(sub)) return { idx: i, sentence: sentences[i], partial: sub };
    }
  }
  return null;
}

/**
 * clampCutsAgainstWordBoundaries — Heath's note 1 default, factored out so
 * quality-gate.js can re-derive the same clamp independently from the raw
 * transcript + a candidate cutlist and flag ANY violation, not just verify
 * this function was called.
 *
 * For every cut, find the nearest word ending at/before cut.start and the
 * nearest word starting at/after cut.end. Shrink the cut so it never comes
 * within `padAfterWordEnd` of the prior word's end or `padBeforeOnset` of
 * the next word's start. If shrinking inverts the cut (the words are
 * already too close together), the cut is dropped (end <= start, filtered
 * by the caller) — this is what makes a cut structurally unable to land
 * inside a breath group.
 */
function clampCutsAgainstWordBoundaries(cuts, words, duration, padAfterWordEnd, padBeforeOnset) {
  const sortedWords = words.slice().sort((a, b) => a.start - b.start);
  const out = [];
  for (const c of cuts) {
    // The words this cut is SUPPOSED to remove. Silence cuts have none.
    // Anything else overlapping the cut is collateral and must survive.
    const targets = (c.targets && c.targets.length)
      ? c.targets.slice().sort((a, b) => a.start - b.start)
      : [];
    // The span that must end up inside the cut for it to do its job. For a
    // silence cut that's nothing, so it may shrink to zero and be dropped.
    const mustRemoveStart = targets.length ? targets[0].start : c.end;
    const mustRemoveEnd = targets.length ? targets[targets.length - 1].end : c.start;

    // Nearest surviving word on each side: the last word that ENDS at or
    // before the must-remove span, and the first that STARTS at or after it.
    // Crucially this is anchored on the TARGETS, not on the cut's own
    // (already padded) edges — anchoring on the edges is what let a cut
    // swallow a word it was never meant to touch.
    let prevEnd = 0, nextStart = duration;
    for (const w of sortedWords) {
      if (targets.some(t => t.start === w.start && t.end === w.end)) continue;
      if (w.end <= mustRemoveStart + 1e-9) prevEnd = Math.max(prevEnd, w.end);
    }
    for (let i = sortedWords.length - 1; i >= 0; i--) {
      const w = sortedWords[i];
      if (targets.some(t => t.start === w.start && t.end === w.end)) continue;
      if (w.start >= mustRemoveEnd - 1e-9) nextStart = Math.min(nextStart, w.start);
    }

    let start = Math.max(c.start, prevEnd + padAfterWordEnd);
    let end = Math.min(c.end, nextStart - padBeforeOnset);

    if (targets.length) {
      // A targeted cut is all-or-nothing. If the required padding leaves no
      // room to remove the whole target, DROP the cut and keep the stutter —
      // an audible natural restart is a far smaller sin than a chopped word,
      // which is Heath's #1 named rejection across every trial cut.
      if (start > mustRemoveStart + 1e-6 || end < mustRemoveEnd - 1e-6) {
        out.push({ ...c, start: 0, end: 0, dropped: true, droppedReason: `removing "${(c.text || '').trim()}" would need ${padAfterWordEnd * 1000}ms after "${'the previous word'}" and ${padBeforeOnset * 1000}ms before the next; only ${(mustRemoveStart - prevEnd) * 1000 | 0}ms / ${(nextStart - mustRemoveEnd) * 1000 | 0}ms exist, so the cut would clip a word it is not meant to remove` });
        continue;
      }
      // Never start a cut partway through the target either.
      start = Math.min(start, mustRemoveStart);
      end = Math.max(end, mustRemoveEnd);
      // Re-apply the outer bounds after widening to the whole target.
      start = Math.max(start, prevEnd + padAfterWordEnd);
      end = Math.min(end, nextStart - padBeforeOnset);
    }
    out.push({ ...c, start, end });
  }
  return out;
}

/**
 * verifyNoClippedWords — the alarm, built in the same change as the fix.
 *
 * Independently re-derives, from the raw word list and the final keep
 * segments, whether any word that was NOT deliberately removed is missing or
 * only partially present. A clamp that silently stops working is how
 * dossie_trial_07's first render shipped "to--" mid-sentence; a guarantee
 * with no check on it is not a guarantee.
 */
function verifyNoClippedWords(keep, words, removedTargets, tolerance = 0.005) {
  const isTarget = (w) => removedTargets.some(t => Math.abs(t.start - w.start) < 1e-6 && Math.abs(t.end - w.end) < 1e-6);
  const problems = [];
  for (const w of words) {
    if (isTarget(w)) continue;
    const seg = keep.find(k => w.start >= k.start - tolerance && w.end <= k.end + tolerance);
    if (seg) continue;
    const overlapping = keep.filter(k => w.end > k.start && w.start < k.end);
    problems.push({
      text: w.text.trim(), start: +w.start.toFixed(3), end: +w.end.toFixed(3),
      kind: overlapping.length ? 'CLIPPED' : 'MISSING',
      detail: overlapping.length
        ? `only ${overlapping.map(k => `${Math.max(k.start, w.start).toFixed(3)}-${Math.min(k.end, w.end).toFixed(3)}`).join(', ')} survives`
        : 'no keep segment contains any of it',
    });
  }
  return problems;
}

function main() {
  const args = parseArgs();
  const transcriptPath = args.transcript;
  const outPath = args.out;
  if (!transcriptPath || !outPath) {
    console.error('Usage: cutlist.js --transcript <json> --out <json>');
    process.exit(1);
  }
  const silenceThreshold = parseFloat(args.silenceThreshold || '0.6');
  const padStart = parseFloat(args.padStart || '0.08');
  const padEnd = parseFloat(args.padEnd || '0.12');
  const minKeep = parseFloat(args.minKeep || '0.3');
  // Heath's note 1 defaults — see file header. breathGroupGap MUST stay
  // below silenceThreshold or the "never inside a breath group" guarantee
  // no longer holds structurally.
  const minPadBeforeOnset = parseFloat(args.minPadBeforeOnset || '0.15');
  const minPadAfterWordEnd = parseFloat(args.minPadAfterWordEnd || '0.30');
  const breathGroupGap = parseFloat(args.breathGroupGap || '0.35');
  if (breathGroupGap >= silenceThreshold) {
    throw new Error(`breathGroupGap (${breathGroupGap}) must be < silenceThreshold (${silenceThreshold}) — otherwise a dead-air cut could land inside a breath group.`);
  }

  const data = JSON.parse(fs.readFileSync(transcriptPath, 'utf8'));
  const words = data.words.filter(w => w.type === 'word');
  const duration = data.audio_duration_secs;

  const cuts = [];

  // 1. Filler words + trailing-hyphen stutter fragments.
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const stripped = w.text.trim();
    if (FILLER_RE.test(stripped)) {
      cuts.push({ start: w.start, end: w.end, reason: 'filler', text: stripped, targets: [{ start: w.start, end: w.end, text: stripped }] });
      continue;
    }
    if (/-{1,}$/.test(stripped) && stripped.length <= 6) {
      // truncated fragment like "t-t--" — cut this word and any immediately
      // following duplicate truncations, up to (but not including) the
      // first word that looks like a real completed word.
      cuts.push({ start: w.start, end: w.end, reason: 'false_start_fragment', text: stripped, targets: [{ start: w.start, end: w.end, text: stripped }] });
    }
  }

  // 2. Immediate exact-phrase repeats (e.g. "I want ... I want you to").
  //    Look for a repeated run of 1-3 words starting at i that recurs
  //    starting at some j > i within the next 6 words, with only small
  //    filler/silence between — keep the SECOND occurrence, cut the first.
  for (let i = 0; i < words.length - 1; i++) {
    for (let runLen = 3; runLen >= 1; runLen--) {
      if (i + runLen * 2 > words.length) continue;
      const a = words.slice(i, i + runLen).map(w => w.text.toLowerCase().replace(/[^a-z']/g, ''));
      const b = words.slice(i + runLen, i + runLen * 2).map(w => w.text.toLowerCase().replace(/[^a-z']/g, ''));
      const lastOfFirst = words[i + runLen - 1];
      const firstOfSecond = words[i + runLen];
      const endsSentence = /[.!?]\s*$/.test(lastOfFirst.text.trim());
      const interRunGap = firstOfSecond.start - lastOfFirst.end;
      // A real stutter/false-start repeats itself almost immediately with no
      // sentence-final punctuation in between. Two legitimately separate
      // sentences that happen to start with the same word (e.g. "Dossi.
      // Dossi is...") must NOT be treated as a false start.
      if (a.join(' ') === b.join(' ') && a.join('') !== '' && !endsSentence && interRunGap < 0.3) {
        const first = words[i];
        cuts.push({ start: first.start, end: lastOfFirst.end, reason: 'repeated_false_start', text: a.join(' '), targets: words.slice(i, i + runLen).map(x => ({ start: x.start, end: x.end, text: x.text.trim() })) });
        break;
      }
    }
  }

  // 3. Dead-air silence gaps between consecutive words (and lead-in/tail).
  for (let i = 0; i < words.length - 1; i++) {
    const gap = words[i + 1].start - words[i].end;
    if (gap > silenceThreshold) {
      cuts.push({
        start: words[i].end + padStart,
        end: words[i + 1].start - padEnd,
        reason: 'dead_air',
        text: null,
      });
    }
  }
  if (words.length && words[0].start > silenceThreshold) {
    cuts.push({ start: 0, end: words[0].start - padEnd, reason: 'lead_in_silence', text: null });
  }
  if (words.length && (duration - words[words.length - 1].end) > silenceThreshold) {
    cuts.push({ start: words[words.length - 1].end + padStart, end: duration, reason: 'tail_silence', text: null });
  }

  // 4. Editorial bounds — startAtLine / endAfterLine / dropLines. These are
  //    the knobs review.js turns for §2 (weak or banned opener), §19 (the
  //    closing line came from a fumbled take) and §12 (cut what doesn't
  //    contribute). Each becomes an ordinary cut and is clamped like any
  //    other, so none of them can clip a word.
  const sentences = sentencesOf(words);
  const editorial = { startAtLine: null, endAfterLine: null, dropLines: [] };
  if (args.startAtLine) {
    const hit = findSentence(sentences, args.startAtLine);
    if (hit) {
      const openAt = hit.sentence[0].start;
      if (openAt > 0) cuts.push({ start: 0, end: openAt, reason: 'editorial_start', text: args.startAtLine, targets: words.filter(x => x.end <= openAt).map(x => ({ start: x.start, end: x.end, text: x.text.trim() })) });
      editorial.startAtLine = { matched: hit.sentence.map(w => w.text).join('').trim(), openAtSec: +openAt.toFixed(2), partial: hit.partial || null };
    } else {
      editorial.startAtLine = { matched: null, error: `no sentence matched "${args.startAtLine}" (need a run of 3+ words) — the open was left where it was` };
    }
  }
  if (args.endAfterLine) {
    const hit = findSentence(sentences, args.endAfterLine);
    if (hit) {
      const closeAt = hit.sentence[hit.sentence.length - 1].end;
      if (closeAt < duration) cuts.push({ start: closeAt, end: duration, reason: 'editorial_end', text: args.endAfterLine, targets: words.filter(x => x.start >= closeAt).map(x => ({ start: x.start, end: x.end, text: x.text.trim() })) });
      editorial.endAfterLine = { matched: hit.sentence.map(w => w.text).join('').trim(), closeAtSec: +closeAt.toFixed(2), partial: hit.partial || null };
    } else {
      editorial.endAfterLine = { matched: null, error: `no sentence matched "${args.endAfterLine}" — the close was left where it was` };
    }
  }
  if (args.dropLines) {
    const phrases = String(args.dropLines).split('||').map(s => s.trim()).filter(Boolean);
    for (const ph of phrases) {
      const hit = findSentence(sentences, ph);
      if (hit) {
        const s = hit.sentence[0].start, e = hit.sentence[hit.sentence.length - 1].end;
        cuts.push({ start: s, end: e, reason: 'editorial_drop', text: ph, targets: hit.sentence.map(x => ({ start: x.start, end: x.end, text: x.text.trim() })) });
        editorial.dropLines.push({ phrase: ph, matched: hit.sentence.map(w => w.text).join('').trim(), fromSec: +s.toFixed(2), toSec: +e.toFixed(2) });
      } else {
        editorial.dropLines.push({ phrase: ph, matched: null, error: 'no sentence matched (need a run of 3+ words) — nothing was dropped' });
      }
    }
  }

  // Merge overlapping/adjacent cuts, apply pad around word-based cuts too.
  const NO_EXTRA_PAD = new Set(['dead_air', 'lead_in_silence', 'tail_silence', 'editorial_start', 'editorial_end', 'editorial_drop']);
  const padded = cuts.map(c => {
    if (NO_EXTRA_PAD.has(c.reason)) return c;
    return { ...c, start: Math.max(0, c.start - padStart), end: c.end + padEnd };
  }).filter(c => c.end > c.start);

  padded.sort((a, b) => a.start - b.start);
  const preClamp = [];
  for (const c of padded) {
    const last = preClamp[preClamp.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.reasons = [...new Set([...(last.reasons || [last.reason]), c.reason])];
      // Merging must UNION the target sets. Losing a merged cut's targets
      // would make the clamp think it is removing nothing, and a cut that
      // believes it has no targets is free to shrink to zero — or worse, to
      // be anchored on its own padded edges again.
      last.targets = [...(last.targets || []), ...(c.targets || [])];
    } else {
      preClamp.push({ ...c, reasons: [c.reason], targets: [...(c.targets || [])] });
    }
  }

  // Final safety clamp — Heath's note 1 default. Shrink (or drop) every cut
  // so it never eats into the required pad around the nearest surviving
  // word on either side, then re-merge (clamping can make adjacent cuts
  // overlap or invert).
  const clampedAll = clampCutsAgainstWordBoundaries(preClamp, words, duration, minPadAfterWordEnd, minPadBeforeOnset);
  const droppedCuts = clampedAll.filter(c => c.dropped);
  const clamped = clampedAll.filter(c => !c.dropped && c.end - c.start > 0.001);
  clamped.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of clamped) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end) {
      last.end = Math.max(last.end, c.end);
      last.reasons = [...new Set([...(last.reasons || [last.reason]), ...c.reasons])];
      last.targets = [...(last.targets || []), ...(c.targets || [])];
    } else {
      merged.push({ ...c });
    }
  }

  // Build the KEEP segments (inverse of cuts).
  // minKeep drops slivers — but ONLY slivers with no speech in them. The old
  // unconditional `>= minKeep` test would silently delete a short keep
  // segment along with any word inside it, which is a second, quieter route
  // to the missing-word defect the clamp above exists to prevent.
  const hasWord = (a, b) => words.some(w => w.end > a + 1e-6 && w.start < b - 1e-6);
  const keep = [];
  let cursor = 0;
  for (const c of merged) {
    const len = c.start - cursor;
    if (len >= minKeep || (len > 0.001 && hasWord(cursor, c.start))) keep.push({ start: cursor, end: c.start });
    cursor = Math.max(cursor, c.end);
  }
  {
    const len = duration - cursor;
    if (len >= minKeep || (len > 0.001 && hasWord(cursor, duration))) keep.push({ start: cursor, end: duration });
  }

  // Heath's note 7 default — a slurred/low-confidence final sentence must
  // not be what the video ends on. Look at the LAST sentence inside the
  // last kept segment; if its average word confidence (exp(logprob)) is
  // below endingConfidenceThreshold, drop that sentence from the tail and
  // end on the previous clean sentence instead (re-applying the same
  // minPadAfterWordEnd tail rule).
  const endingConfidenceThreshold = parseFloat(args.endingConfidenceThreshold || '0.75');
  let endingTrim = null;
  if (keep.length) {
    const lastSeg = keep[keep.length - 1];
    const lastSegWords = words.filter(w => w.start >= lastSeg.start - 0.01 && w.end <= lastSeg.end + 0.01);
    // Sentences = runs of words split on terminal punctuation.
    const sentences = [];
    let cur = [];
    for (const w of lastSegWords) {
      cur.push(w);
      if (/[.!?]['"]?$/.test(w.text.trim())) { sentences.push(cur); cur = []; }
    }
    if (cur.length) sentences.push(cur);
    if (sentences.length) {
      const last = sentences[sentences.length - 1];
      const avgLogprob = last.reduce((s, w) => s + (w.logprob || 0), 0) / last.length;
      const confidence = Math.exp(avgLogprob);
      if (confidence < endingConfidenceThreshold && sentences.length > 1) {
        const prevSentence = sentences[sentences.length - 2];
        const newEnd = Math.min(lastSeg.end, prevSentence[prevSentence.length - 1].end + minPadAfterWordEnd);
        endingTrim = { droppedText: last.map(w => w.text).join('').trim(), confidence: +confidence.toFixed(3), oldEnd: lastSeg.end, newEnd };
        lastSeg.end = newEnd;
      } else if (confidence < endingConfidenceThreshold) {
        endingTrim = { note: 'last sentence is low-confidence but is the ONLY sentence in the final segment — kept it (nothing clean to fall back to), flag for human review', confidence: +confidence.toFixed(3) };
      }
    }
  }

  // THE ALARM. Re-derive, independently of every heuristic above, whether any
  // word that was not deliberately removed is missing or only partly present.
  // A guarantee with no check on it is not a guarantee: the first render of
  // dossie_trial_07 shipped an audible "to--" mid-sentence because the clamp
  // silently stopped protecting a word the cut had already swallowed.
  const removedTargets = merged.flatMap(c => c.targets || []);
  const clippedProblems = verifyNoClippedWords(keep, words, removedTargets);
  const clippedWordCheck = {
    ok: clippedProblems.length === 0,
    removedOnPurpose: removedTargets.map(t => t.text).filter(Boolean),
    problems: clippedProblems,
  };
  if (clippedProblems.length) {
    console.error('\nCLIPPED/MISSING WORDS IN THE CUT LIST — refusing to hand this downstream:');
    for (const pr of clippedProblems) console.error(`  ${pr.kind} "${pr.text}" @${pr.start}-${pr.end}s — ${pr.detail}`);
  }

  const totalCutSec = merged.reduce((s, c) => s + (c.end - c.start), 0);
  const keptSec = keep.reduce((s, k) => s + (k.end - k.start), 0);

  const result = {
    sourceDuration: duration,
    cuts: merged,
    keepSegments: keep,
    endingTrim,
    editorial,
    droppedCuts: droppedCuts.map(c => ({ reason: c.reason, text: c.text, why: c.droppedReason })),
    clippedWordCheck,
    stats: {
      totalCuts: merged.length,
      totalCutSeconds: +totalCutSec.toFixed(2),
      keptSeconds: +keptSec.toFixed(2),
      reasonBreakdown: merged.reduce((acc, c) => {
        for (const r of c.reasons) acc[r] = (acc[r] || 0) + 1;
        return acc;
      }, {}),
    },
  };
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.stats, null, 2));
  // Editorial bounds are the knobs most likely to silently no-op (a phrase
  // that doesn't match changes nothing), so say out loud what each one did.
  if (editorial.startAtLine) console.log(`  startAtLine -> ${editorial.startAtLine.error || `opens on "${editorial.startAtLine.matched}" @${editorial.startAtLine.openAtSec}s`}`);
  if (editorial.endAfterLine) console.log(`  endAfterLine -> ${editorial.endAfterLine.error || `closes after "${editorial.endAfterLine.matched}" @${editorial.endAfterLine.closeAtSec}s`}`);
  for (const d of editorial.dropLines) console.log(`  dropLines -> ${d.error ? `${d.error} ("${d.phrase}")` : `dropped "${d.matched}" (${d.fromSec}-${d.toSec}s)`}`);
  for (const d of droppedCuts) console.log(`  KEPT (cut refused): ${d.reason} "${(d.text || '').trim()}" — ${d.droppedReason}`);
  console.log(`  clipped-word check: ${clippedWordCheck.ok ? 'clean' : `${clippedProblems.length} PROBLEM(S)`}`);
  // Exit non-zero so edit.js's execFileSync aborts the render rather than
  // burning 10 minutes of ONNX inference on a cut that eats a word.
  if (!clippedWordCheck.ok) process.exit(2);
}

module.exports = { clampCutsAgainstWordBoundaries, verifyNoClippedWords, sentencesOf, findSentence };
if (require.main === module) main();
