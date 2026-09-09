'use strict';

// scripts/_lib/group-post-content-gate.js
//
// Per-group content gating for the daily 5-group-post pipeline. This is the
// HARD, code-level rule Heath's brief asked for — keyed off group config,
// never a prompt suggestion the model can ignore.
//
// Per docs/GROUP-ENGAGEMENT-PLAN.md #4: dfw_network_collab has a VERIFIED
// "no promotions or spam" rule (group_registry row cb59a780.../a9608d97...,
// "DFW REALTORS") — that group NEVER gets anything product-adjacent, full
// stop, no config flip possible without deleting this override. The other 4
// groups are unverified (never rules-recon'd), so Sage's explicit
// recommendation is value-only across all five until each gets a real
// recon pass — same code path, just a different (currently identical)
// default, and each is flippable independently once a group is recon'd.
//
// Read by api/_lib/daily-group5-post-generator.js AFTER generation, as a
// real content check (regex/keyword scan on the actual text) — never just a
// prompt instruction the model could drift from.
//
// Owner: Carter, 2026-09-09

// value_only        -- post body (and any first_comment) must never mention
//                       the product, a link, a signup CTA, or pricing.
// hard_no_promo      -- same enforcement as value_only, but this override
//                       can never be flipped by a config change alone (see
//                       ALWAYS_NO_PROMO below) — dfw_network_collab only.
const GROUP_POLICY = Object.freeze({
  dfw_network_collab: 'hard_no_promo',
  tc_admins: 'value_only',
  tc_vas: 'value_only',
  kw_re_group: 'value_only',
  tx_re_agents: 'value_only',
});

// Groups where NOTHING can ever flip GROUP_POLICY to allow promo content,
// even by editing the map above by mistake — DFW's rule is VERIFIED
// (group_registry.promo_policy), not just unconfirmed-so-default-safe like
// the other four. This is the literal "never" from the brief.
const ALWAYS_NO_PROMO = new Set(['dfw_network_collab']);

// Anything that reads as product-adjacent or self-promotional. Deliberately
// broad — a false-positive block just means a human looks at it again; a
// false negative means a banned post lands in the one group with a verified
// rule against it.
const BANNED_TERMS = [
  'dossie',
  'meetdossie',
  'meet dossie',
  'sign up',
  'signup',
  'sign-up',
  'link in bio',
  'dm me for the link',
  'dm me for a link',
  'founding member',
  'free trial',
  '/founding',
  '.com/signup',
  'transaction coordinator app',
  'ai transaction coordinator',
  'the app i built',
  'the tool i built',
  'the software i built',
];

function normalize(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * @param {string} groupKey  key from scripts/comment-hunt-groups.json
 * @param {string} postBody
 * @param {string|null} [firstCommentBody]
 * @returns {{ allowed: boolean, reason?: string, policy: string }}
 */
function checkGroupContentGate(groupKey, postBody, firstCommentBody) {
  const policy = GROUP_POLICY[groupKey] || 'value_only'; // fail safe: unknown group = strictest
  const combined = normalize(`${postBody || ''} ${firstCommentBody || ''}`);

  const hit = BANNED_TERMS.find((term) => combined.includes(term));
  if (hit) {
    return {
      allowed: false,
      policy,
      reason: `banned_term:"${hit}"${ALWAYS_NO_PROMO.has(groupKey) ? ' (hard_no_promo group — never allowed)' : ' (value-only pending group-rules recon)'}`,
    };
  }

  // A bare URL is a promo signal even without a banned phrase.
  if (/https?:\/\//.test(combined)) {
    return { allowed: false, policy, reason: 'contains_url' };
  }

  return { allowed: true, policy };
}

module.exports = {
  GROUP_POLICY,
  ALWAYS_NO_PROMO,
  BANNED_TERMS,
  checkGroupContentGate,
};
