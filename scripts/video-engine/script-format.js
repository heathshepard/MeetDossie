#!/usr/bin/env node
//
// scripts/video-engine/script-format.js
//
// Parses the CORE/OPTIONAL-tagged verbatim camera script format into the two
// target sentence-sets that scripts/video-engine/variants.js assembles.
//
// WHY THIS EXISTS
// ---------------
// The 2026-09-25 42-second cut is the reason. A script was written with no
// length target, hand-trimmed toward one at edit time, and then rejected by
// scripts/check-video-quality-cli.js for fitting neither TikTok's 21-34s
// window nor Instagram's. That is a script-time failure being paid for at
// edit time, by hand, once per video. Tagging the script fixes it once.
//
// THE FORMAT
// ----------
// The existing verbatim format (docs/SCRIPT-TREC-20-19-WHAT-CHANGED-VERBATIM.md
// and docs/SCRIPTS-TREC-20-19-SERIES.md) is already built out of:
//
//   * 3-line chunks separated by a blank line — the teleprompter unit;
//   * backticked marker lines — `[FACE]`, `[SCREEN: page 7, ¶12.B]`;
//   * `[pause]` on a line of its own;
//   * **bold** on the one word that carries the line.
//
// Heath's eyes already skip everything in backticks. So the length tag joins
// that family and nothing else changes:
//
//   `[CORE]`       every chunk after this line is CORE, until the next tag
//   `[OPTIONAL]`   every chunk after this line is OPTIONAL, until the next tag
//
// A tag line is NEVER spoken and never reaches the teleprompter text. Parsing
// is the same as `[pause]`: recognise it, consume it, drop it.
//
// The two cuts:
//   CORE only          -> ~30s -> TikTok, Instagram Reels
//   CORE + OPTIONAL    -> ~50-60s -> YouTube Shorts, Facebook, LinkedIn
//
// Aspect ratio is NOT a variable. 9:16 1080x1920 for both. This is length only.
//
// THE ACCURACY CONSTRAINT — THE PART THAT MATTERS
// -----------------------------------------------
// Every script in docs/SCRIPTS-TREC-20-19-SERIES.md carries a MUST BE EXACT
// and a MUST NOT SAY table. Those tables exist because dropping one qualifier
// turns a true statement into a false one on camera:
//
//   "may provide Buyer with remedies"     -> "will give your buyer a right to terminate"
//   "more than 10%"                       -> "ten percent"
//   "other than brokerage compensation"   -> "brokerage compensation"
//
// A trimmer that does not know this will cheerfully cut the qualifier, because
// the qualifier is short and reads like filler. So each script declares a
//
//   ### CORE MUST CARRY
//   - "may"
//   - "more than ten percent"
//
// block, and parse() FAILS when a listed phrase is missing from the core-only
// text. A core-only cut that would state a rule without its condition is a
// parse error, not a judgement call made later by whoever is editing.
//
// USAGE
//   node scripts/video-engine/script-format.js <script.md> [--video 4] [--json]
//
// EXPORTS
//   parse(markdown)         -> { scripts: [...], errors: [...] }
//   parseScript(section)    -> one script object
//   selectVariant(s, which) -> { which, chunks, text, words, estSeconds }

'use strict';

const fs = require('fs');

// Delivery pace. 200 wpm is the short-form punchy read; 140 wpm is the pace
// the published Video 1 file actually measures Heath at. Both are carried
// because the SERIES doc's own runtime table is stated at both and the two
// disagree by nearly 2x — see its "RUNTIME — READ THIS BEFORE SHOOTING".
const WPM_SHORTFORM = 200;
const WPM_MEASURED = 140;

// The two variants and the surfaces each one ships to. Kept here rather than
// in the producer so the script author can see, in the same file as the tags,
// what the tag decides.
const VARIANTS = {
  core: {
    which: 'core',
    includes: ['CORE'],
    label: 'short',
    platforms: ['tiktok', 'instagram'],
    // Graded by the gate's existing vertical lane: TIKTOK_RANGE [21,34].
    gateOrientation: 'vertical',
    targetSeconds: [21, 34],
  },
  full: {
    which: 'full',
    includes: ['CORE', 'OPTIONAL'],
    label: 'long',
    platforms: ['youtube', 'facebook', 'linkedin'],
    // Graded by the vertical_long lane added to api/_lib/verify-video-quality.js
    // — same 9:16 frame, longer runtime window. Passing 'vertical' here would
    // cap it at 45s; passing the platforms array would classify it HORIZONTAL
    // and demand a 16:9 frame we are deliberately not producing.
    gateOrientation: 'vertical_long',
    targetSeconds: [40, 90],
  },
};

const TAG_LINE_RE = /^\s*`?\[(CORE|OPTIONAL)\]`?\s*$/i;
const MARKER_LINE_RE = /^\s*`\[[^\]]*\]`\s*$/;
const PAUSE_LINE_RE = /^\s*\[pause\]\s*$/i;
const VIDEO_HEADING_RE = /^#\s+(?:VIDEO\s+(\d+)\s*[—\-–:]\s*)?(.+)$/;
// Lines that sit inside a SCRIPT block but are apparatus, not speech:
// blockquote callouts, the word-count/runtime footers, and markdown rules.
const NOTE_LINE_RE = /^\s*(?:>|---\s*$|\*\*(?:Word count|CORE only|CORE \+ OPTIONAL|Runtime|Cover hook text|Hook summary)|\|)/i;

/** Strip the marks that are direction, not speech, and count real words. */
function spokenWords(text) {
  return String(text || '')
    .replace(/`\[[^\]]*\]`/g, ' ')
    .replace(/\[pause\]/gi, ' ')
    .replace(/\*\*/g, '')
    .split(/\s+/)
    .filter((w) => /[A-Za-z0-9]/.test(w));
}

function estSeconds(wordCount, wpm) {
  return Math.round((wordCount / wpm) * 60 * 10) / 10;
}

/** Normalise for phrase matching: lowercase, collapse whitespace, drop bold marks. */
function normalise(text) {
  return String(text || '')
    .replace(/\*\*/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * parseScript — turn one "### SCRIPT" body into tagged chunks.
 *
 * A chunk is a blank-line-separated group of lines, exactly as the
 * teleprompter reads it. Marker lines (`[FACE]`, `[SCREEN: ...]`) and
 * [pause] carry no words but DO stay attached to the chunk that follows, so a
 * variant that keeps the chunk keeps its screen direction too.
 *
 * @param {string} body - the raw markdown between "### SCRIPT" and the next "###"
 * @param {object} meta - { video, title }
 */
function parseScript(body, meta = {}) {
  const lines = String(body || '').split(/\r?\n/);
  const chunks = [];
  const errors = [];

  // Default is CORE. An untagged script is a valid short — never silently
  // OPTIONAL, which would produce an empty core cut.
  let tag = 'CORE';
  let sawAnyTag = false;
  let pending = { lines: [], markers: [], tag };

  const flush = () => {
    if (!pending.lines.length && !pending.markers.length) return;
    const text = pending.lines.join('\n');
    const words = spokenWords(text);
    chunks.push({
      index: chunks.length,
      tag: pending.tag,
      markers: pending.markers.slice(),
      lines: pending.lines.slice(),
      text,
      wordCount: words.length,
    });
    pending = { lines: [], markers: [], tag };
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const tagMatch = line.match(TAG_LINE_RE);
    if (tagMatch) {
      // A tag boundary always closes the chunk in progress — a chunk cannot
      // be half CORE.
      flush();
      tag = tagMatch[1].toUpperCase();
      pending.tag = tag;
      sawAnyTag = true;
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (MARKER_LINE_RE.test(line)) { pending.markers.push(line.trim()); continue; }
    if (PAUSE_LINE_RE.test(line)) { pending.markers.push('[pause]'); continue; }
    // Editorial apparatus that lives inside the SCRIPT block but is never
    // read aloud. Counting it inflates the runtime estimate, which is the one
    // number this parser exists to get right.
    if (NOTE_LINE_RE.test(line)) { flush(); continue; }
    pending.lines.push(line.trim());
  }
  flush();

  const spoken = chunks.filter((c) => c.wordCount > 0);
  const core = spoken.filter((c) => c.tag === 'CORE');
  const optional = spoken.filter((c) => c.tag === 'OPTIONAL');

  if (!sawAnyTag) {
    errors.push(`${meta.title || 'script'}: no [CORE]/[OPTIONAL] tags found — every chunk defaulted to CORE, so both cuts would be identical`);
  }
  if (!core.length) {
    errors.push(`${meta.title || 'script'}: zero CORE chunks — the short cut would be empty`);
  }
  // Core must carry the hook and the CTA. The hook is the first spoken chunk;
  // the CTA is the last. This is the "a core-only cut must stand alone as a
  // coherent video" constraint, enforced instead of hoped for.
  if (spoken.length && core.length) {
    if (spoken[0].tag !== 'CORE') {
      errors.push(`${meta.title || 'script'}: the opening chunk is OPTIONAL — the core cut would have no hook`);
    }
    if (spoken[spoken.length - 1].tag !== 'CORE') {
      errors.push(`${meta.title || 'script'}: the closing chunk is OPTIONAL — the core cut would have no CTA`);
    }
  }

  return {
    video: meta.video || null,
    title: meta.title || null,
    chunks: spoken,
    core,
    optional,
    mustCarry: meta.mustCarry || [],
    errors,
  };
}

/**
 * selectVariant — the two target sentence-sets.
 * @param {object} script - a parseScript() result
 * @param {'core'|'full'} which
 */
function selectVariant(script, which) {
  const spec = VARIANTS[which];
  if (!spec) throw new Error(`unknown variant '${which}' (expected core|full)`);
  const chunks = script.chunks.filter((c) => spec.includes.includes(c.tag));
  const text = chunks.map((c) => c.text).join('\n\n');
  const words = spokenWords(text);
  return {
    ...spec,
    chunks,
    text,
    wordCount: words.length,
    estSecondsShortform: estSeconds(words.length, WPM_SHORTFORM),
    estSecondsMeasured: estSeconds(words.length, WPM_MEASURED),
  };
}

/**
 * paceBand — the delivery speeds at which BOTH cuts land in their windows.
 *
 * This is the whole reason for tagging before the shoot rather than trimming
 * after it. One recording produces both cuts, so both cuts are read at the
 * SAME words-per-minute. That makes the two length windows a single
 * simultaneous constraint on one number:
 *
 *   core_words / P * 60  must be within  [21, 34]
 *   full_words / P * 60  must be within  [40, 90]
 *
 * Solving for P gives a feasible pace band. An EMPTY band means no delivery
 * speed exists at which this script produces two compliant cuts — which is a
 * fact about the script, discoverable at the desk, and not something any
 * amount of editing afterwards can fix. That is exactly the wall the
 * 2026-09-25 42-second cut hit at edit time.
 *
 * @returns {{min:number|null, max:number|null, feasible:boolean, note:string}}
 */
function paceBand(script) {
  const core = selectVariant(script, 'core');
  const full = selectVariant(script, 'full');
  const [coreLo, coreHi] = VARIANTS.core.targetSeconds;
  const [fullLo, fullHi] = VARIANTS.full.targetSeconds;

  // core <= coreHi  =>  P >= coreWords*60/coreHi ; core >= coreLo => P <= coreWords*60/coreLo
  const min = Math.max(core.wordCount * 60 / coreHi, full.wordCount * 60 / fullHi);
  const max = Math.min(core.wordCount * 60 / coreLo, full.wordCount * 60 / fullLo);
  const feasible = min <= max;

  let note;
  if (feasible) {
    note = `deliver at ${Math.ceil(min)}-${Math.floor(max)} wpm and both cuts land in-window`;
  } else if (full.wordCount < core.wordCount * 1.35) {
    note = `no feasible pace — OPTIONAL adds only ${full.wordCount - core.wordCount} words (${Math.round(((full.wordCount / core.wordCount) - 1) * 100)}%). This script does not contain two distinct cuts; publish it as ONE video to all six surfaces rather than forcing a long cut that cannot reach ${fullLo}s.`;
  } else {
    note = `no feasible pace — core needs >=${Math.ceil(core.wordCount * 60 / coreHi)} wpm to fit ${coreHi}s, full needs <=${Math.floor(full.wordCount * 60 / fullLo)} wpm to reach ${fullLo}s. Move ~${Math.ceil((core.wordCount * 60 / coreHi - full.wordCount * 60 / fullLo) * coreHi / 60)} more core words to OPTIONAL.`;
  }
  return {
    min: Math.round(min * 10) / 10, max: Math.round(max * 10) / 10, feasible, note,
  };
}

/**
 * checkMustCarry — the accuracy gate.
 *
 * Every phrase the script declares under "### CORE MUST CARRY" has to survive
 * into the core-only text. This is what stops a trim from turning
 * "may provide Buyer with remedies" into "gives your buyer a right to
 * terminate", or "more than 10%" into "ten percent".
 */
function checkMustCarry(script) {
  const coreText = normalise(script.core.map((c) => c.text).join(' '));
  const missing = [];
  for (const phrase of script.mustCarry) {
    if (!coreText.includes(normalise(phrase))) missing.push(phrase);
  }
  return missing;
}

/**
 * parse — read a whole series markdown file.
 * Splits on "# VIDEO n — TITLE" headings, then takes each "### SCRIPT" body
 * and each "### CORE MUST CARRY" list.
 */
function parse(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const sections = [];
  let cur = null;

  for (const line of lines) {
    const h = line.match(VIDEO_HEADING_RE);
    if (h && /^#\s+(VIDEO|HOOK|CARD|CTA)/i.test(line)) {
      if (cur) sections.push(cur);
      cur = { video: h[1] ? Number(h[1]) : null, title: line.replace(/^#\s+/, '').trim(), lines: [] };
      continue;
    }
    if (cur) cur.lines.push(line);
  }
  if (cur) sections.push(cur);

  const scripts = [];
  const errors = [];

  for (const sec of sections) {
    const body = sec.lines.join('\n');
    // "### SCRIPT" .. next "###"
    // NOTE: JS has no \\Z anchor — an earlier version used one and it matched
    // a literal 'Z', truncating every script at its first capital Z.
    const scriptMatch = body.match(/^###[ \t]+SCRIPT[ \t]*\r?\n([\s\S]*?)(?=^###[ \t]|^---[ \t]*$|$(?![\s\S]))/m);
    if (!scriptMatch) continue;

    const carryMatch = body.match(/^###[ \t]+CORE MUST CARRY[ \t]*\r?\n([\s\S]*?)(?=^###[ \t]|^---[ \t]*$|$(?![\s\S]))/m);
    const mustCarry = carryMatch
      ? carryMatch[1]
        .split(/\r?\n/)
        .map((l) => l.match(/^\s*[-*]\s+(.*)$/))
        .filter(Boolean)
        .map((m) => m[1].replace(/^["“](.*)["”]$/, '$1').trim())
        .filter(Boolean)
      : [];

    const script = parseScript(scriptMatch[1], { video: sec.video, title: sec.title, mustCarry });
    const missing = checkMustCarry(script);
    for (const phrase of missing) {
      script.errors.push(`${sec.title}: CORE MUST CARRY phrase absent from the core-only cut: "${phrase}" — the short cut would state the rule without its qualifier`);
    }
    errors.push(...script.errors);
    scripts.push(script);
  }

  return { scripts, errors };
}

// ------------------------------------------------------------------ CLI ----
function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node scripts/video-engine/script-format.js <script.md> [--video N] [--json]');
    process.exit(1);
  }
  const wantVideo = process.argv.includes('--video')
    ? Number(process.argv[process.argv.indexOf('--video') + 1])
    : null;
  const asJson = process.argv.includes('--json');

  const { scripts, errors } = parse(fs.readFileSync(file, 'utf8'));
  const chosen = wantVideo ? scripts.filter((s) => s.video === wantVideo) : scripts;

  if (asJson) {
    const out = chosen.map((s) => ({
      video: s.video,
      title: s.title,
      core: selectVariant(s, 'core'),
      full: selectVariant(s, 'full'),
      paceBand: paceBand(s),
      errors: s.errors,
    }));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(errors.length ? 2 : 0);
  }

  for (const s of chosen) {
    const core = selectVariant(s, 'core');
    const full = selectVariant(s, 'full');
    console.log(`\n${s.title}`);
    console.log(`  chunks: ${s.chunks.length}  (CORE ${s.core.length} / OPTIONAL ${s.optional.length})`);
    console.log(`  core  : ${String(core.wordCount).padStart(4)} words  ${core.estSecondsShortform}s @200wpm  ${core.estSecondsMeasured}s @140wpm  -> ${core.platforms.join(', ')}`);
    console.log(`  full  : ${String(full.wordCount).padStart(4)} words  ${full.estSecondsShortform}s @200wpm  ${full.estSecondsMeasured}s @140wpm  -> ${full.platforms.join(', ')}`);
    const band = paceBand(s);
    console.log(`  pace  : ${band.feasible ? `OK  ${band.min}-${band.max} wpm` : 'INFEASIBLE'} — ${band.note}`);
    if (s.mustCarry.length) console.log(`  must-carry checked: ${s.mustCarry.length} phrase(s)`);
    for (const e of s.errors) console.log(`  FAIL ${e}`);
  }
  // SERIES-WIDE PACE. The recording block says "shoot all five in one
  // sitting" — one sitting is one delivery speed, so the feasible bands have
  // to INTERSECT, not merely each be non-empty on their own.
  if (chosen.length > 1) {
    const bands = chosen.map((s) => ({ title: s.title, band: paceBand(s) })).filter((b) => b.band.feasible);
    if (bands.length === chosen.length) {
      const lo = Math.max(...bands.map((b) => b.band.min));
      const hi = Math.min(...bands.map((b) => b.band.max));
      const loScript = bands.find((b) => b.band.min === lo);
      const hiScript = bands.find((b) => b.band.max === hi);
      console.log('');
      if (lo <= hi) {
        console.log(`SERIES PACE: ${Math.ceil(lo)}-${Math.floor(hi)} wpm works for all ${chosen.length} scripts.`);
      } else {
        console.log(`SERIES PACE: no single speed suits all ${chosen.length}. Floor ${lo.toFixed(1)} wpm (${loScript.title.split(' — ')[0]}) is above ceiling ${hi.toFixed(1)} wpm (${hiScript.title.split(' — ')[0]}) by ${(lo - hi).toFixed(1)} wpm.`);
        console.log('             Either move core words to OPTIONAL in the floor script, or shoot those two at different speeds.');
      }
    }
  }

  console.log('');
  if (errors.length) {
    console.error(`${errors.length} error(s) — a tagged script with errors must not go to camera.`);
    process.exit(2);
  }
  console.log('All scripts parse clean.');
}

module.exports = {
  parse, parseScript, selectVariant, checkMustCarry, paceBand, spokenWords, estSeconds,
  VARIANTS, WPM_SHORTFORM, WPM_MEASURED,
};
if (require.main === module) main();
