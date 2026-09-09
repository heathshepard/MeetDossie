'use strict';

// api/_lib/fabrication-guard.js
//
// Catches invented personal/factual specifics in generated group-post copy
// that aren't traceable to the verified-story library
// (api/_lib/verified-war-stories.json). Built 2026-09-09 after the daily
// group-post generator invented five personal war stories -- a Hill
// Country foundation failure, a daughter's-soccer-game amendment, a newer
// agent "on his team", a TREC deadline one-pager that doesn't exist, and a
// false claim about forwarding verification texts "a couple times a
// week" -- and nearly posted them under Heath's real name and real estate
// license into Texas REALTOR groups. See memory/heath-verified-war-stories.md.
//
// This is a keyword/pattern scanner, not a semantic fact-checker -- it
// cannot verify TRUTH, only flag the SHAPE of a fabricated claim (a
// specific dollar figure, a named family member, an offer of a resource
// that doesn't exist, etc). A hit should always BLOCK the post and force a
// retry/fallback -- this guard has no "warn only" mode on purpose. The
// failure mode this exists to force is "skip the post", never "post it
// anyway and hope."
//
// Owner: Sage, 2026-09-09.

const PATTERNS = [
  {
    id: 'dollar_amount',
    re: /\$\s?\d[\d,]*(\.\d+)?/,
    desc: 'a specific dollar figure',
  },
  {
    id: 'family_member',
    re: /\b(my |his |her )(daughter|son|wife|husband|kids?|mom|dad|mother|father)\b/i,
    desc: 'a named family member',
  },
  {
    id: 'my_team',
    re: /\b(my team|on my team|a newer agent (on|in) (my|his|her) team|someone on my team)\b/i,
    desc: '"my team" / a colleague claim',
  },
  {
    id: 'resource_offer',
    re: /\b(one[- ]?pager|drop (it|the link) in the comments|dm me for( the)? link|i (made|put together) (myself )?a (checklist|guide|one-pager|pdf))\b/i,
    desc: 'an offer of a resource that may not actually exist',
  },
  {
    id: 'specific_property',
    re: /\b\d{1,5}\s+[A-Za-z]+\s+(st|street|ave|avenue|dr|drive|rd|road|ln|lane|blvd|way|ct|court|cir|circle)\b/i,
    desc: 'a specific street address',
  },
  {
    id: 'named_client',
    re: /\b(a client of mine|one of my clients|my client\b|had a client\b|a client who\b|a client that\b)/i,
    desc: 'a claim about a specific client not traceable to the verified-story library',
    allowFor: ['verified_anecdote'],
  },
  {
    id: 'unverified_practice_claim',
    re: /\bforward(ing|ed)?\s+verification texts?\b.{0,40}\b(couple|few|two|three)\s+times a week\b/i,
    desc: "a claim about mirroring someone else's routine that isn't a verified fact about Heath's own practice",
  },
  {
    id: 'travel_location',
    re: /\b(while I was in [A-Z]\w+|from a hotel (lobby|room)|parking lot at)\b/i,
    desc: 'an invented location/travel detail not confirmed anywhere',
  },
];

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string|null} [opts.formatId]  the format id being generated for --
 *   some patterns (e.g. named_client) are only permitted for formats whose
 *   whole point is a verified client-involving anecdote.
 * @returns {{ ok: boolean, violations: string[] }}
 */
function checkFabrication(text, { formatId = null } = {}) {
  const t = String(text || '');
  const violations = [];
  for (const p of PATTERNS) {
    if (!p.re.test(t)) continue;
    if (p.allowFor && p.allowFor.includes(formatId)) continue;
    violations.push(`${p.id}:${p.desc}`);
  }
  return { ok: violations.length === 0, violations };
}

module.exports = { PATTERNS, checkFabrication };
