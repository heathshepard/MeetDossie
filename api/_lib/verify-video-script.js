// api/_lib/verify-video-script.js
//
// Script-shape gate for talking-head video scripts (TREC series, founder-voice,
// any future series) — companion to `docs/SCRIPT-SPEC.md`. Modeled directly on
// api/_lib/verify-video-quality.js: same addRule()/rules/failedRules/detail
// shape, same "name every rule, explain the incident that produced it" comment
// style, same fail-closed posture (a check that cannot run — e.g. a missing
// section — fails, it does not skip).
//
// WHY THIS EXISTS — Heath has rejected scripts twice for silently dropping a
// required element:
//   1. A script dropped the stake AND the CTA that all four shipped videos at
//      the time had.
//   2. A script was "significantly shorter than the others" (an OPTIONAL-only
//      cut masquerading as a full script, no elaboration, no re-hook).
// Both were caught by Heath re-reading after the fact. This gate runs the same
// checks on the file BEFORE a human has to notice.
//
// THIS IS A CONTENT-SHAPE GATE, NOT A FACT GATE. It cannot verify a paragraph
// citation is correct — that is `MUST BE EXACT` / `MUST NOT SAY`, read against
// the real TREC PDF by a person (see docs/SCRIPTS-TREC-20-19-SERIES.md). What
// this file verifies mechanically: every structural element Heath has had to
// ask for by hand is actually present, in the right place, at the right time.

'use strict';

// ── Placement windows / thresholds — see docs/SCRIPT-SPEC.md §2 for the why ──

// The mid-video re-hook exists to fight completion-rate drop-off, which the
// research this repo already cites (docs/SCROLL-STOPPING-VIDEO-PLAYBOOK.md)
// puts in the back half of a short video, not the very end. 50-80% gives real
// room around the brief's "60-70%" without being so tight a one-word trim
// fails the gate for a reason that has nothing to do with the rule's intent.
const REHOOK_MIN_FRACTION = 0.5;
const REHOOK_MAX_FRACTION = 0.8;
// How many of the re-hook chunk's leading words may pass before "but" must
// appear — keeps it a re-hook (a pivot AT the top of the beat), not a "but"
// buried three sentences into unrelated elaboration.
const REHOOK_BUT_WORD_WINDOW = 8;

// The CTA must be one of the last two spoken chunks — allows a single closing
// [FACE] beat after it (the shipped series' own pattern: CTA chunk, then
// sometimes nothing, sometimes it IS the last chunk) without allowing a CTA
// buried mid-script.
const CTA_MAX_CHUNKS_FROM_END = 2;

// Comment-trigger keyword: spoken as a word, not an acronym string screamed
// letter by letter, and not so long it reads like a slogan instead of a word
// someone actually types in a comment box.
const KEYWORD_MIN_LEN = 2;
const KEYWORD_MAX_LEN = 12;
// Phrases that mean "this reads like an ad, not natural speech" per the
// brief's own instruction ("must be natural speech not an ad read").
const AD_READ_PHRASES = [/click the link/i, /link in bio/i, /swipe up/i, /tap the link/i];
// Generic words after "comment" that are not a real trigger keyword.
const GENERIC_KEYWORDS = new Set(['below', 'here', 'now', 'this', 'that', 'yes', 'no']);

// Stake sentence must name an actual cost — a dollar figure or one of these
// consequence words. A stake sentence with none of these is describing a rule,
// not a cost, which is exactly the gap Heath flagged when a script "dropped
// the stake."
const STAKE_KEYWORDS = [
  '$', 'terminat', 'forfeit', 'lose', 'lost', 'dead deal', "can't walk",
  'cannot walk', 'frozen', 'void', 'default', 'sue', 'lawsuit', 'liable',
];

const LIST_BULLET_RE = /^\s*(?:[-*•]|\d+[.)])\s+/m;
const ORDINAL_WORDS = ['first', 'second', 'third', 'fourth', 'fifth'];

// ── Parsing ───────────────────────────────────────────────────────────────

/**
 * Splits a markdown file into candidate script sections — one per `#`/`##`
 * heading that contains both a `### SCRIPT` subsection and a `Cover hook
 * text` field. Non-script sections (a recording-setup block, a runtime table)
 * are silently excluded, not failed — they were never scripts to grade.
 * @returns {Array<{title:string, text:string}>}
 */
function parseScriptSections(fileText) {
  const lines = String(fileText || '').split('\n');
  const headingIdx = [];
  lines.forEach((line, i) => {
    if (/^#{1,2}\s+\S/.test(line)) headingIdx.push(i);
  });
  headingIdx.push(lines.length);

  const sections = [];
  for (let i = 0; i < headingIdx.length - 1; i++) {
    const start = headingIdx[i];
    const end = headingIdx[i + 1];
    const text = lines.slice(start, end).join('\n');
    if (/###\s+SCRIPT\b/i.test(text) && /\*\*Cover hook text:\*\*/.test(text)) {
      sections.push({ title: lines[start].replace(/^#+\s*/, '').trim(), text });
    }
  }
  return sections;
}

/**
 * Splits a script section's body into ordered chunks (paragraphs separated by
 * a blank line), classifying each as a tag (its entire trimmed content is
 * `` `[NAME]` `` or `` `[NAME: ...]` ``, e.g. `[CORE]`, `[SCREEN: page 6]`) or
 * spoken (everything else — the text Heath actually reads).
 * @returns {Array<{type:'tag'|'spoken', tagName:string|null, raw:string, words:string[]}>}
 */
// A markdown paragraph that is apparatus, not speech — the word-count/runtime
// footer that immediately follows every script per the series' own convention
// (docs/SCRIPTS-TREC-20-19-SERIES.md). It sits INSIDE the captured body (the
// next real heading is ### CORE MUST CARRY, further down), so without this
// the parser read the footer itself as spoken text and inflated both the
// word count and the [REHOOK]/[CTA] placement fractions. Same apparatus list
// scripts/video-engine/script-format.js's NOTE_LINE_RE already excludes.
const SCRIPT_FOOTER_NOTE_RE = /^\*\*(?:Word count|CORE only|CORE \+ OPTIONAL|Runtime)\b/i;

function splitScriptBody(bodyText) {
  const scriptHeadingMatch = bodyText.match(/###\s+SCRIPT\b[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s+\S|$)/i);
  const body = scriptHeadingMatch ? scriptHeadingMatch[1] : '';
  let paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const footerIdx = paragraphs.findIndex((p) => SCRIPT_FOOTER_NOTE_RE.test(p));
  if (footerIdx !== -1) paragraphs = paragraphs.slice(0, footerIdx);

  return paragraphs.map((raw) => {
    const tagMatch = raw.match(/^`\[([^\]]+)\]`$/);
    if (tagMatch) {
      return { type: 'tag', tagName: tagMatch[1].trim(), raw, words: [] };
    }
    const spokenText = raw.replace(/\*\*/g, '').trim();
    const words = spokenText.split(/\s+/).filter(Boolean);
    return { type: 'spoken', tagName: null, raw: spokenText, words };
  });
}

function extractField(sectionText, fieldName) {
  // Non-greedy up to the next blank line (paragraph end) or EOF — a field's
  // value is a markdown paragraph, which may itself be line-wrapped for
  // readability. A single-line `.+` capture (the original version of this
  // function) silently truncated any wrapped Stake/Cover-hook-text sentence
  // at its first newline, which meant a keyword living past that newline
  // (e.g. "...and you could **lose** your only paper trail") was invisible
  // to stake_present even though the sentence plainly states a real cost.
  const re = new RegExp(`\\*\\*${fieldName}:\\*\\*\\s*([\\s\\S]+?)(?=\\n\\s*\\n|$)`, 'i');
  const m = sectionText.match(re);
  return m ? m[1].replace(/\s+/g, ' ').trim() : null;
}

// ── Individual rule checks — each takes the parsed section, returns {pass, note} ──

function checkCoverHookText(sectionText) {
  const raw = extractField(sectionText, 'Cover hook text');
  if (!raw) return { pass: false, note: 'no `**Cover hook text:**` field found — frame-1 has nothing to render' };
  const m = raw.match(/`([^`]+)`/);
  const text = m ? m[1].trim() : raw.replace(/`/g, '').trim();
  if (!text) return { pass: false, note: 'Cover hook text field is empty' };
  return { pass: true, note: text };
}

function checkNoFadeDirection(chunks) {
  const spoken = chunks.filter((c) => c.type === 'spoken');
  const firstTwo = spoken.slice(0, 2).map((c) => c.raw).join(' ');
  if (/\bfade\b/i.test(firstTwo)) {
    return { pass: false, note: 'a fade direction in the opening lines emptied frame 0 once already — no fade on the cold open' };
  }
  return { pass: true, note: '' };
}

function checkStakePresent(sectionText) {
  const raw = extractField(sectionText, 'Stake');
  if (!raw) return { pass: false, note: 'no `**Stake:**` field found — a script must state what this costs an agent' };
  const lower = raw.toLowerCase();
  const hit = STAKE_KEYWORDS.find((kw) => lower.includes(kw.toLowerCase()));
  if (!hit) {
    return { pass: false, note: `Stake field present but names no dollar figure or dead-deal consequence: "${raw}"` };
  }
  return { pass: true, note: raw };
}

function totalSpokenWordCount(chunks) {
  return chunks.reduce((n, c) => n + (c.type === 'spoken' ? c.words.length : 0), 0);
}

/** Cumulative spoken-word count of every chunk strictly before index `idx`. */
function spokenWordsBefore(chunks, idx) {
  let n = 0;
  for (let i = 0; i < idx; i++) if (chunks[i].type === 'spoken') n += chunks[i].words.length;
  return n;
}

function nextSpokenChunk(chunks, fromIdx) {
  for (let i = fromIdx + 1; i < chunks.length; i++) if (chunks[i].type === 'spoken') return { chunk: chunks[i], index: i };
  return null;
}

function checkRehookPlacement(chunks) {
  const idx = chunks.findIndex((c) => c.type === 'tag' && c.tagName === 'REHOOK');
  if (idx === -1) return { pass: false, note: 'no `[REHOOK]` tag — nothing marks a mid-video re-hook' };

  const total = totalSpokenWordCount(chunks);
  if (total === 0) return { pass: false, note: 'script has no spoken words to compute placement against' };
  const fraction = spokenWordsBefore(chunks, idx) / total;
  if (fraction < REHOOK_MIN_FRACTION || fraction > REHOOK_MAX_FRACTION) {
    return {
      pass: false,
      note: `[REHOOK] sits at ${(fraction * 100).toFixed(0)}% through the script — must land between ${REHOOK_MIN_FRACTION * 100}% and ${REHOOK_MAX_FRACTION * 100}%`,
    };
  }

  const next = nextSpokenChunk(chunks, idx);
  if (!next) return { pass: false, note: '[REHOOK] tag has no spoken chunk after it' };
  const leadingWords = next.chunk.words.slice(0, REHOOK_BUT_WORD_WINDOW).join(' ');
  if (!/\bbut\b/i.test(leadingWords)) {
    return {
      pass: false,
      note: `re-hook chunk does not open with "but" (checked first ${REHOOK_BUT_WORD_WINDOW} words): "${leadingWords}"`,
    };
  }
  return { pass: true, note: `[REHOOK] at ${(fraction * 100).toFixed(0)}%` };
}

function checkCtaPlacement(chunks) {
  const ctaIdx = chunks.findIndex((c) => c.type === 'tag' && c.tagName === 'CTA');
  if (ctaIdx === -1) return { pass: false, note: 'no `[CTA]` tag — no marked call-to-action' };

  const spokenIdxs = chunks.map((c, i) => (c.type === 'spoken' ? i : -1)).filter((i) => i !== -1);
  const next = nextSpokenChunk(chunks, ctaIdx);
  if (!next) return { pass: false, note: '[CTA] tag has no spoken chunk after it' };
  const posFromEnd = spokenIdxs.length - 1 - spokenIdxs.indexOf(next.index);
  if (posFromEnd >= CTA_MAX_CHUNKS_FROM_END) {
    return { pass: false, note: `CTA chunk is not near the end (${posFromEnd} spoken chunks follow it, max allowed ${CTA_MAX_CHUNKS_FROM_END - 1})` };
  }
  return { pass: true, note: next.chunk.raw };
}

function checkKeywordTrigger(chunks) {
  const keywordIdx = chunks.findIndex((c) => c.type === 'tag' && c.tagName === 'KEYWORD');
  if (keywordIdx === -1) return { pass: false, note: 'no `[KEYWORD]` tag — no marked comment-trigger sentence' };

  const ctaIdx = chunks.findIndex((c) => c.type === 'tag' && c.tagName === 'CTA');
  if (ctaIdx !== -1 && keywordIdx < ctaIdx) {
    return { pass: false, note: '[KEYWORD] tag appears before [CTA] — the trigger must land at or after the call-to-action' };
  }

  const tail = chunks.slice(keywordIdx).filter((c) => c.type === 'spoken').map((c) => c.raw).join(' ');
  if (!tail) return { pass: false, note: '[KEYWORD] tag has no spoken text after it' };

  const adReadHit = AD_READ_PHRASES.find((re) => re.test(tail));
  if (adReadHit) return { pass: false, note: `keyword sentence reads like an ad, not natural speech: matched ${adReadHit}` };

  const m = tail.match(/\bcomment\s+([A-Za-z][A-Za-z]{1,11})\b/i);
  if (!m) return { pass: false, note: `no natural "comment <WORD>" trigger found after [KEYWORD]: "${tail}"` };
  const word = m[1];
  if (word.length < KEYWORD_MIN_LEN || word.length > KEYWORD_MAX_LEN) {
    return { pass: false, note: `trigger word "${word}" is outside ${KEYWORD_MIN_LEN}-${KEYWORD_MAX_LEN} characters` };
  }
  if (GENERIC_KEYWORDS.has(word.toLowerCase())) {
    return { pass: false, note: `trigger word "${word}" is generic, not a real keyword (e.g. "comment below" isn't a trigger)` };
  }
  return { pass: true, note: `comment ${word.toUpperCase()}` };
}

function checkNoSpokenLists(chunks) {
  const offenders = [];
  for (const c of chunks) {
    if (c.type !== 'spoken') continue;
    if (LIST_BULLET_RE.test(c.raw)) {
      offenders.push(`bulleted/numbered line: "${c.raw.split('\n')[0]}"`);
      continue;
    }
    const lower = c.raw.toLowerCase();
    const ordinalHits = ORDINAL_WORDS.filter((w) => new RegExp(`\\b${w}\\b`).test(lower));
    if (ordinalHits.length >= 2) {
      offenders.push(`spoken as an enumerated list (${ordinalHits.join(', ')}): "${c.raw}"`);
    }
  }
  if (offenders.length) return { pass: false, note: offenders.join(' | ') };
  return { pass: true, note: '' };
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Validates one script section against every rule in docs/SCRIPT-SPEC.md.
 * @param {string} sectionText - the full text of one script's section
 *   (heading through the next heading), as returned by parseScriptSections().
 * @returns {{pass:boolean, rules:object, failedRules:string[], detail:object}}
 */
function validateScript(sectionText) {
  const rules = {};
  const addRule = (name, { pass, note = '' }) => { rules[name] = { pass: !!pass, blocking: true, note }; };

  const chunks = splitScriptBody(sectionText);

  addRule('cover_hook_text_present', checkCoverHookText(sectionText));
  addRule('frame1_no_fade_direction', checkNoFadeDirection(chunks));
  addRule('stake_present', checkStakePresent(sectionText));
  addRule('rehook_present_and_placed', checkRehookPlacement(chunks));
  addRule('cta_present_near_end', checkCtaPlacement(chunks));
  addRule('keyword_trigger_natural', checkKeywordTrigger(chunks));
  addRule('no_spoken_lists', checkNoSpokenLists(chunks));

  const failedRules = Object.entries(rules).filter(([, r]) => r.blocking && !r.pass).map(([name]) => name);
  return {
    pass: failedRules.length === 0,
    rules,
    failedRules,
    detail: {
      spoken_word_count: totalSpokenWordCount(chunks),
      chunk_count: chunks.length,
    },
  };
}

/**
 * Convenience wrapper: validates every script section found in a full
 * markdown file. Fails closed if the file contains zero recognizable script
 * sections — a file that was supposed to hold a script but doesn't parse as
 * one is a defect, not a pass.
 * @returns {{pass:boolean, sections:Array<{title:string, result:object}>}}
 */
function validateScriptFile(fileText) {
  const sections = parseScriptSections(fileText);
  if (!sections.length) {
    return {
      pass: false,
      sections: [{ title: '(no script sections found)', result: { pass: false, rules: {}, failedRules: ['no_script_sections_found'], detail: {} } }],
    };
  }
  const graded = sections.map((s) => ({ title: s.title, result: validateScript(s.text) }));
  return { pass: graded.every((s) => s.result.pass), sections: graded };
}

module.exports = {
  validateScript,
  validateScriptFile,
  parseScriptSections,
  splitScriptBody,
  extractField,
  REHOOK_MIN_FRACTION,
  REHOOK_MAX_FRACTION,
  REHOOK_BUT_WORD_WINDOW,
  CTA_MAX_CHUNKS_FROM_END,
  KEYWORD_MIN_LEN,
  KEYWORD_MAX_LEN,
  STAKE_KEYWORDS,
};
