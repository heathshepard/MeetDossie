'use strict';

// api/_lib/caption-structure-gate.js
//
// THE DEFECT THIS CLOSES (Heath, 2026-09-29, on a caption that had gone live
// an hour earlier): "Paragraph 7.I: if the Seller's Water Disclosure never
// goes out..." — opens with a paragraph number (the weakest possible first
// three words; only ~125 chars show before "more" on Instagram, so the
// citation ate the hook), buries the actual stake at the end, and used `--`
// instead of a real em dash. Same post also promised "Comment WATER and
// I'll DM you the one-pager" with zero DM wiring behind it — see
// checkDmFieldsForCaption() below.
//
// Two independent gates, both meant to be called from the ONE place that
// writes video_library rows (scripts/video-engine/queue-variant.js) so a bad
// caption is refused at registration time rather than caught after it is
// already live.
//
// Owner: Sage, 2026-09-29.

// Matches an opening like "Paragraph 7.I:", "Para. 7:", "¶7.I", "20-19",
// "7.I:" at the very START of the caption — the weakest possible hook.
// Anchored to the first line only; a citation anywhere else is fine and
// expected (that's the credibility, just not in first position).
const OPENING_PARAGRAPH_RE = /^\s*(paragraph|para\.?|¶)\s*\d/i;
const OPENING_FORM_NUMBER_RE = /^\s*\d{1,2}[-.]\d{1,2}\b/; // "20-19", "7.I" etc. at position 0
const OPENING_BARE_PARA_LABEL_RE = /^\s*\d+[A-Za-z]?(\.\d+)?\s*[:.—-]/; // "7.I:" / "12.B -" at position 0

// Literal ASCII double-hyphen standing in for an em dash. A real em dash is
// U+2014 (—); this only flags the "--" typo, never a legitimate double
// hyphen inside a URL or hashtag (which this pattern won't match anyway
// since it requires the dash to sit between word characters/spaces).
const DOUBLE_HYPHEN_RE = /\s--\s|\w--\w|--(?=\s|$)/;

/**
 * @param {string} caption
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkCaptionStructure(caption) {
  const violations = [];
  const text = String(caption || '').trim();
  const firstLine = text.split('\n')[0] || '';

  if (OPENING_PARAGRAPH_RE.test(firstLine) || OPENING_FORM_NUMBER_RE.test(firstLine) || OPENING_BARE_PARA_LABEL_RE.test(firstLine)) {
    violations.push(
      `caption opens with a paragraph/form number ("${firstLine.slice(0, 40)}") — lead with the stake in plain language, keep the citation for the second line`,
    );
  }

  if (DOUBLE_HYPHEN_RE.test(text)) {
    violations.push('caption uses "--" (double hyphen) instead of a real em dash (—)');
  }

  return { ok: violations.length === 0, violations };
}

// "Comment WATER", "comment DISCLOSE and I'll DM you...", etc. Captures the
// keyword so it can be checked against dm_keyword for a mismatch, not just
// presence/absence.
const COMMENT_CTA_RE = /\bcomment\s+([A-Za-z][A-Za-z0-9]{1,29})\b/i;

/**
 * @param {string} caption
 * @returns {string|null} the keyword as written in the caption, or null if
 *   the caption carries no "Comment X" CTA.
 */
function extractCommentCtaKeyword(caption) {
  const m = COMMENT_CTA_RE.exec(String(caption || ''));
  return m ? m[1] : null;
}

/**
 * THE GATE. A caption promising "Comment X and I'll DM you..." must not be
 * queueable without the three fields that make that promise true — this is
 * what makes the unfulfilled-DM-promise class of bug structurally impossible
 * instead of something to remember to check.
 *
 * @param {object} o
 * @param {string} o.caption
 * @param {string|null|undefined} o.dm_keyword
 * @param {string|null|undefined} o.dm_asset_url
 * @param {string|null|undefined} o.dm_message
 * @returns {{ ok: boolean, violations: string[], ctaKeyword: string|null }}
 */
function checkDmFieldsForCaption({ caption, dm_keyword, dm_asset_url, dm_message } = {}) {
  const ctaKeyword = extractCommentCtaKeyword(caption);
  if (!ctaKeyword) return { ok: true, violations: [], ctaKeyword: null };

  const violations = [];
  if (!dm_keyword || !String(dm_keyword).trim()) {
    violations.push(`caption promises "Comment ${ctaKeyword}" but dm_keyword is not set`);
  } else if (String(dm_keyword).trim().toUpperCase() !== ctaKeyword.toUpperCase()) {
    violations.push(`dm_keyword ("${dm_keyword}") does not match the CTA word in the caption ("${ctaKeyword}")`);
  }
  if (!dm_asset_url || !String(dm_asset_url).trim()) {
    violations.push('caption promises a DM but dm_asset_url is not set');
  }
  if (!dm_message || !String(dm_message).trim()) {
    violations.push('caption promises a DM but dm_message is not set');
  }

  return { ok: violations.length === 0, violations, ctaKeyword };
}

module.exports = {
  checkCaptionStructure,
  extractCommentCtaKeyword,
  checkDmFieldsForCaption,
};
