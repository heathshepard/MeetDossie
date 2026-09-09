'use strict';

// scripts/_lib/junk-text-guard.js
//
// Facebook's virtualized/lazy-loading feed occasionally hands back scraped
// "post" or "comment" text that is really repeated nav/chrome noise (an
// image-placeholder label repeated once per lazy-loading photo, a run of
// button labels like "Like Reply Share" concatenated by innerText, etc.)
// rather than real human-written content.
//
// REAL INCIDENT (2026-09-09): scripts/fb-comment-hunt-daily.js scraped
// "Facebook" repeated 20+ times as the entire "post" for a candidate
// attributed to Christina Morgan in "Transaction Coordinators and Virtual
// Assistants for Real Estate". It scored 62 (>= MIN_SCORE 55) in
// api/cron-comment-opp-approval.js and a full reply was drafted and sent to
// Heath for approval. Scoring never catches this class of junk — an LLM
// asked "is this worth a comment" will happily rationalize a coherent-looking
// reply to noise. This guard rejects it BEFORE scoring/drafting ever runs.
//
// Used by:
//   - scripts/fb-comment-hunt-daily.js   (prefilterPost, before insert)
//   - scripts/fb-comment-opportunity-scanner.js (before insertOpportunity)
//   - scripts/harvest-tc-discovery-responses.js (before upsertComments)
//
// Owner: Carter, 2026-09-09

const CHROME_WORDS = new Set([
  'facebook', 'like', 'likes', 'reply', 'replies', 'comment', 'comments',
  'share', 'shares', 'see', 'more', 'top', 'most', 'relevant', 'write',
  'a', 'public', 'send', 'follow', 'following', 'edited', 'author',
  'all', 'view',
]);

const CHROME_PHRASES = [
  /\bsee more\b/i,
  /\btop comments?\b/i,
  /\bwrite a (public )?comment\b/i,
  /\bmost relevant\b/i,
  /\ball comments\b/i,
];

function toWords(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * @param {string} text
 * @returns {{junk: boolean, reason?: string}}
 */
function isJunkText(text) {
  const raw = String(text || '').trim();
  if (!raw) return { junk: true, reason: 'empty' };

  const w = toWords(raw);
  if (w.length === 0) return { junk: true, reason: 'no_words' };

  // 1. A single token repeated back-to-back over threshold — the Christina
  //    Morgan shape exactly ("Facebook Facebook Facebook...").
  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < w.length; i++) {
    if (w[i] === w[i - 1]) {
      run++;
      maxRun = Math.max(maxRun, run);
    } else {
      run = 1;
    }
  }
  if (maxRun >= 5) return { junk: true, reason: `repeated_token_run:${maxRun}` };

  // 2. One word dominates the whole blob (only meaningful with enough tokens
  //    that a short genuine "congrats congrats congrats!" doesn't trip it).
  if (w.length >= 8) {
    const counts = new Map();
    for (const t of w) counts.set(t, (counts.get(t) || 0) + 1);
    let top = 0;
    for (const c of counts.values()) top = Math.max(top, c);
    const ratio = top / w.length;
    if (ratio > 0.5) return { junk: true, reason: `dominant_token:${ratio.toFixed(2)}` };
  }

  // 3. Mostly Facebook UI chrome vocabulary.
  if (w.length >= 4) {
    const chromeCount = w.filter((t) => CHROME_WORDS.has(t)).length;
    const ratio = chromeCount / w.length;
    if (ratio > 0.6) return { junk: true, reason: `mostly_chrome_words:${ratio.toFixed(2)}` };
  }
  if (raw.length < 150) {
    const phraseHits = CHROME_PHRASES.filter((re) => re.test(raw)).length;
    if (phraseHits >= 2) return { junk: true, reason: 'chrome_phrase_cluster' };
  }

  // 4. No real sentence structure: long blob, almost no unique tokens (an
  //    alternating 2-3 token repeat rather than one straight repeated run).
  if (w.length >= 10) {
    const unique = new Set(w).size;
    const ratio = unique / w.length;
    if (ratio < 0.15) return { junk: true, reason: `low_unique_ratio:${ratio.toFixed(2)}` };
  }

  return { junk: false };
}

module.exports = { isJunkText, CHROME_WORDS, CHROME_PHRASES };
