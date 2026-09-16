'use strict';

// scripts/_lib/auto-reply-content-gates.js
//
// Content gates a DRAFTED reply must clear before it is allowed onto the
// veto-timeout auto-post path (see supabase/migrations/20260916_auto_reply_veto.sql
// for the full contract). A gate failure NEVER blocks the reply outright —
// it just routes the row to the pre-existing manual Approve/Edit/Skip flow
// (api/cron-tc-reply-approval.js), same as an escalated risk classification.
//
// Five gates, all fail-closed (a check we can't confidently pass = fail):
//   1. no pricing figures
//   2. no war story outside the verified allowlist (heath-verified-war-stories.md)
//   3. no Dossie capability claim not in docs/DOSSIE-VERIFIED-CAPABILITIES.md
//   4. no AI-tell opener (reuses api/_lib/heath-voice-guard.js — Rule 1: scan
//      before build, don't reinvent the existing voice check)
//   5. length in Heath's normal range
//
// Owner: Carter, 2026-09-16

const voiceGuard = require('../../api/_lib/heath-voice-guard.js');

// ── Gate 1: pricing figures ──────────────────────────────────────────────────
const PRICING_FIGURE_RE = /\$\s?\d|\b\d+\s?(?:\/|per)\s?(?:mo|month|yr|year)\b|\bfree trial\b/i;

// ── Gate 2: war stories ──────────────────────────────────────────────────────
// The two REAL, Heath-confirmed stories (memory/heath-verified-war-stories.md).
// A first-person anecdote is only safe if it fingerprints as one of these.
const VERIFIED_STORY_FINGERPRINTS = [
  /\btc went dark\b|\bcoordinator.*(?:went dark|unreachable|disappeared|stopped responding)\b/i,
  /\bearnest money\b.*(?:3 days|three days)|\boption period\b.*(?:terminate|missed|deadline)/i,
];
// The five documented FABRICATIONS a prior generator invented and nearly
// posted (memory/heath-verified-war-stories.md, "Explicitly NOT true").
// Any match is an automatic gate failure regardless of fingerprint logic
// below — these are known-bad, not just unrecognized.
const KNOWN_FABRICATED_STORY_PHRASES = [
  /hill country/i,
  /foundation issue/i,
  /soccer game/i,
  /parking lot/i,
  /one-?pager/i,
  /couple times a week/i,
];
// Markers that this draft is telling a first-person anecdote at all — most
// short peer replies won't hit any of these, which is the common case.
const FIRST_PERSON_STORY_MARKERS = [
  /\bi once\b/i,
  /\bi had a\b/i,
  /\bi remember when\b/i,
  /\bmy client\b.*(?:missed|lost|foundation|deadline|dark)/i,
  /\ba client of mine\b/i,
  /\bone of my (?:clients|deals|files)\b/i,
  /\bhad a (?:client|deal|file) (?:who|that)\b/i,
];

function checkWarStoryGate(text) {
  for (const re of KNOWN_FABRICATED_STORY_PHRASES) {
    if (re.test(text)) return { ok: false, code: 'unverified_war_story', detail: `matches known fabrication pattern ${re}` };
  }
  const tellsAStory = FIRST_PERSON_STORY_MARKERS.some((re) => re.test(text));
  if (!tellsAStory) return { ok: true };
  const matchesVerified = VERIFIED_STORY_FINGERPRINTS.some((re) => re.test(text));
  if (!matchesVerified) {
    return { ok: false, code: 'unverified_war_story', detail: 'first-person anecdote does not fingerprint as a verified story' };
  }
  return { ok: true };
}

// ── Gate 3: unverified Dossie capability claims ─────────────────────────────
// Straight from docs/DOSSIE-VERIFIED-CAPABILITIES.md, "For the
// conversation-video format specifically" — the exact list of things a
// scripted answer must never say or imply. This pipeline's own prompts
// forbid mentioning Dossie at all, so this gate is defense-in-depth for
// any future reply pipeline that does discuss the product.
const FORBIDDEN_CAPABILITY_CLAIMS = [
  { re: /\bgets? (?:it |the (?:contract|document) )?signed\b/i, detail: 'claims a document actually gets signed (only generates + sends for signature)' },
  { re: /\bsign(?:s|ed)? and (?:it'?s )?done\b/i, detail: 'implies signature completion' },
  { re: /\bpulls? comps\b|\bmls data\b|\bpulls? mls\b/i, detail: 'no MLS/comps access exists' },
  { re: /\btexts?\s+(?:your|the|a)\s+client\b|\bmonitors?\s+(?:your|the)?\s*(?:sms|texts?)\b/i, detail: 'no SMS capability exists' },
  { re: /\bemails?\s+(?:your|the)\s+client\s+automatically\b|\bauto-?sends?\s+(?:the|an)?\s*email\b/i, detail: 'drafts only, member sends' },
  { re: /\bsubmits?\s+.*(?:to\s+)?(?:brokerage|kw command|skyslope|dotloop)\b/i, detail: 'no brokerage-portal upload exists' },
  { re: /\byour gmail is connected\b|\bgmail'?s? connected\b/i, detail: 'no member has ever completed the Gmail connect flow' },
  { re: /\bremembers? your (?:usual )?terms\b|\bper-agent (?:contract )?defaults\b/i, detail: 'contract-term defaults are not saved per agent, only identity fields' },
];

function checkCapabilityGate(text) {
  for (const { re, detail } of FORBIDDEN_CAPABILITY_CLAIMS) {
    if (re.test(text)) return { ok: false, code: 'unverified_capability_claim', detail };
  }
  return { ok: true };
}

// ── Gate 5: length ────────────────────────────────────────────────────────────
// heath-group-comment-voice.md: "Short. Often one or two sentences,
// sometimes a fragment." Generous ceiling so a legitimately longer factual
// answer isn't blocked on length alone, but a rambling multi-paragraph
// draft is not "Heath's normal range" for a group comment reply.
const MIN_LEN = 3;
const MAX_LEN = 420;
const MAX_SENTENCES = 4;

function checkLengthGate(text) {
  const len = text.trim().length;
  if (len < MIN_LEN) return { ok: false, code: 'length_out_of_range', detail: `too short (${len} chars)` };
  if (len > MAX_LEN) return { ok: false, code: 'length_out_of_range', detail: `too long (${len} chars > ${MAX_LEN})` };
  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  if (sentences.length > MAX_SENTENCES) {
    return { ok: false, code: 'length_out_of_range', detail: `${sentences.length} sentences > ${MAX_SENTENCES}` };
  }
  return { ok: true };
}

/**
 * checkContentGates(draftText)
 * @param {string} draftText
 * @returns {{ pass: boolean, failures: Array<{code: string, detail: string}> }}
 */
function checkContentGates(draftText) {
  const text = String(draftText || '');
  const failures = [];

  if (PRICING_FIGURE_RE.test(text)) {
    failures.push({ code: 'pricing_figure', detail: 'draft contains a price/cost figure' });
  }

  const storyCheck = checkWarStoryGate(text);
  if (!storyCheck.ok) failures.push({ code: storyCheck.code, detail: storyCheck.detail });

  const capabilityCheck = checkCapabilityGate(text);
  if (!capabilityCheck.ok) failures.push({ code: capabilityCheck.code, detail: capabilityCheck.detail });

  const voiceCheck = voiceGuard.checkVoiceCompliance(text);
  if (!voiceCheck.ok) {
    failures.push({ code: 'voice_violation', detail: voiceCheck.violations.join(', ') });
  }

  const lengthCheck = checkLengthGate(text);
  if (!lengthCheck.ok) failures.push({ code: lengthCheck.code, detail: lengthCheck.detail });

  return { pass: failures.length === 0, failures };
}

module.exports = {
  PRICING_FIGURE_RE,
  VERIFIED_STORY_FINGERPRINTS,
  KNOWN_FABRICATED_STORY_PHRASES,
  FORBIDDEN_CAPABILITY_CLAIMS,
  MIN_LEN,
  MAX_LEN,
  MAX_SENTENCES,
  checkContentGates,
};
