'use strict';

// api/_lib/heath-voice-guard.js
//
// Shared voice-compliance guard for every drafted Facebook comment/reply/
// post in Heath's name. Built from his 2026-09-09 feedback, verbatim:
// "the voice that we use in these groups sound a little AI... doesn't sound
// really like me too much... it just sounds like too enthusiastic. And
// happy. It sounds a little robotic."
//
// The tell: three drafted comments in a row ran the identical two-beat
// shape — enthusiasm opener, then a question:
//   "Haha love the confidence, James - if you had to pick the one thing..."
//   "A couple times a week just to forward verification texts is wild, Ben..."
//   "Holly, that's a great tip about writing both emails into the contract..."
// A person doesn't compliment-then-interrogate every single time. Full
// profile: memory/heath-group-comment-voice.md.
//
// Used by:
//   - api/cron-tc-reply-approval.js       (DRAFT_PROMPT / GUEST_DRAFT_PROMPT)
//   - api/cron-comment-opp-approval.js    (SCORE_PROMPT)
//   - api/_lib/group-post5-formats.js     (buildPrompt, daily5 group posts)
//
// Owner: Carter, 2026-09-09

// Specific idioms Heath named + their close variants. Substring match,
// case-insensitive — these are distinctive enough phrases that a false
// positive on legitimate later-sentence usage is unlikely, and a missed
// catch here just means Heath edits it himself in Telegram.
const BANNED_PHRASES = [
  'haha love',
  'love that',
  'love the',
  'love this',
  'love your',
  "that's a great tip",
  'thats a great tip',
  'great tip',
  "that's wild",
  'thats wild',
  'so smart',
  'i love this',
  'love it',
];

// The prompt fragment every drafting prompt in Heath's name should include
// verbatim (word it into the surrounding prompt, don't paraphrase away the
// specifics — the specifics are what caught the actual failure).
const VOICE_PROMPT_BLOCK = `VOICE — this is Heath's real voice, not an AI assistant's. Read carefully, this is the #1 thing that gets a draft rejected:
- BANNED: opening with a compliment or enthusiasm before you respond — "haha love that", "that's a great tip", "that's wild", "so smart", "I love this", or any close variant. Never compliment the person before you actually respond to them.
- Do NOT end every reply with a question. Often just answer, agree, or share his own experience and STOP — no question tacked on the end for the sake of having one.
- Do NOT restate what they just said back to them before replying ("So you're saying X..." / "Sounds like Y...").
- Plain ASCII only. NEVER use an em-dash, and never use " - " (space-hyphen-space) as a sentence beat — that reads written, not spoken. Use a period, "and", or a new short sentence instead.
- SHORT — often 1-2 sentences, fragments are fine. Contractions always ("that's", "didn't", "he's"). Lowercase openers are fine.
- He's a working agent talking to other working agents, not a founder running discovery on them. Prefer sharing his own experience or opinion over asking a question every time.
- Dry over bubbly, direct, low-hedge. "yeah, same" plus one specific detail beats an enthusiastic paragraph.`;

function checkVoiceCompliance(text) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const violations = [];
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) violations.push(`banned_phrase:"${phrase}"`);
  }
  if (/—/.test(t)) violations.push('em_dash'); // real em-dash character
  if (/\s-\s/.test(t)) violations.push('dash_beat'); // " - " used as a written sentence beat
  return { ok: violations.length === 0, violations };
}

/**
 * The "opener shape" used for cross-draft variety checks — first ~6 words
 * up to the first comma, normalized. This is what Heath actually caught:
 * not one bad draft, but three drafts that all opened the same way.
 */
function openerShape(text) {
  const t = String(text || '').trim();
  const upToComma = t.split(',')[0];
  const words = upToComma.split(/\s+/).slice(0, 6).join(' ');
  return words.toLowerCase().replace(/[^\w\s']/g, '').trim();
}

/** Word-overlap similarity between two opener shapes, 0-1. */
function openerSimilarity(a, b) {
  const wa = new Set(String(a || '').split(/\s+/).filter(Boolean));
  const wb = new Set(String(b || '').split(/\s+/).filter(Boolean));
  if (wa.size === 0 || wb.size === 0) return 0;
  let hit = 0;
  for (const w of wa) if (wb.has(w)) hit++;
  return hit / Math.max(wa.size, wb.size);
}

const OPENER_SIMILARITY_THRESHOLD = 0.5;

function openerTooSimilar(a, b) {
  return openerSimilarity(a, b) >= OPENER_SIMILARITY_THRESHOLD;
}

/**
 * Build the "do not reuse this shape" prompt fragment from a list of
 * recently drafted texts (same spirit as the 30-day group-post-body
 * dedupe — applied here to OPENING SHAPE across a rolling recent window,
 * not the whole body).
 */
function buildRecentOpenersBlock(recentTexts) {
  const openers = (Array.isArray(recentTexts) ? recentTexts : [])
    .map(openerShape)
    .filter(Boolean);
  if (!openers.length) return '';
  return `\nDo NOT open with any of these recent shapes (vary the structure, not just the words):\n${openers.map((o) => `- "${o}..."`).join('\n')}\n`;
}

/**
 * Build the "do not reuse this IDEA" prompt fragment -- the full-body
 * counterpart to buildRecentOpenersBlock() above. Added 2026-09-11 after
 * two group posts one day apart, in different groups, turned out to be the
 * same core claim in synonym-swapped wording ("Waiving the option period
 * gets talked about like a character flag..." vs "...like a personality
 * trait..."). Opener-shape checking alone missed it because the two posts
 * didn't open the same way -- the whole body was the same argument
 * restated. This shows the model full recent bodies (capped + truncated,
 * not just the first 6 words) and tells it explicitly not to reuse the
 * ARGUMENT, not just the phrasing.
 * @param {string[]} recentBodies  full post_body strings, most-recent-first
 * @param {number} [limit]  max number of bodies to include (keep the
 *   prompt from growing unbounded as the pipeline accumulates history)
 */
function buildRecentIdeasBlock(recentBodies, limit = 12) {
  const bodies = (Array.isArray(recentBodies) ? recentBodies : [])
    .filter(Boolean)
    .slice(0, limit);
  if (!bodies.length) return '';
  const snippets = bodies.map((b) => String(b).trim().replace(/\s+/g, ' ').slice(0, 220));
  return `\nDO NOT REUSE ANY OF THESE IDEAS OR ARGUMENTS, even reworded (these already posted to other groups in the last 30 days -- members overlap across groups, a reworded repeat reads as a bot):\n${snippets.map((s) => `- "${s}${s.length >= 220 ? '...' : ''}"`).join('\n')}\n`;
}

/**
 * Batch-level check across a set of drafts generated in the same run — the
 * actual failure mode Heath named was three drafts with the SAME shape,
 * not any single draft being wrong in isolation.
 * @param {string[]} drafts
 * @returns {{ perDraftViolations: Array, allEndInQuestion: boolean, anyOpenerCollision: boolean }}
 */
function batchVoiceCheck(drafts) {
  const list = Array.isArray(drafts) ? drafts.filter(Boolean) : [];
  const perDraftViolations = list
    .map((d, i) => ({ index: i, ...checkVoiceCompliance(d) }))
    .filter((r) => !r.ok);

  const endsInQuestion = list.map((d) => /\?\s*$/.test(String(d).trim()));
  const allEndInQuestion = list.length > 1 && endsInQuestion.every(Boolean);

  let anyOpenerCollision = false;
  const shapes = list.map(openerShape);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      if (openerTooSimilar(shapes[i], shapes[j])) { anyOpenerCollision = true; break; }
    }
    if (anyOpenerCollision) break;
  }

  return { perDraftViolations, allEndInQuestion, anyOpenerCollision };
}

module.exports = {
  BANNED_PHRASES,
  VOICE_PROMPT_BLOCK,
  OPENER_SIMILARITY_THRESHOLD,
  checkVoiceCompliance,
  openerShape,
  openerSimilarity,
  openerTooSimilar,
  buildRecentOpenersBlock,
  buildRecentIdeasBlock,
  batchVoiceCheck,
};
