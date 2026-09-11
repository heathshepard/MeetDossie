'use strict';

// api/_lib/post-scorer.js
//
// Brokerage-post scoring rubric -- SEPARATE from the software rubric that
// lives inline in api/cron-send-for-approval.js (and its mirror in
// api/telegram-webhook.js's regeneratePost()).
//
// WHY THIS FILE EXISTS: the software rubric scores Hook / Platform Fit /
// CTA, built for Dossie SaaS content where a real CTA means "sign up."
// Heath's own listing marketing (social_posts.target_owner='heath-realtor')
// has no signup CTA -- it never can -- so grading it on that scale
// auto-rejected three of Heath's already-approved listing posts at 2/10 CTA
// on 2026-09-11 before he ever saw them in Telegram. This module is the
// fix: a dimension set that actually predicts real-estate reach, selected
// by post.target_owner, with compliance (brokerage name, TREC §535.155) as
// a hard gate instead of a score.
//
// The software rubric is intentionally left untouched wherever it already
// lives -- this file only adds the brokerage path.
//
// Owner: Carter, 2026-09-11.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const SCORER_MODEL = 'claude-haiku-4-5-20251001';

function clamp1to10(n) {
  return Math.min(10, Math.max(1, parseInt(n, 10) || 0));
}

function isVideoUrl(url) {
  return /\.(mp4|mov|webm)(\?|$)/i.test(String(url || ''));
}

// True when this post belongs to Heath's own real-estate marketing
// (Tier-1 owned channels) rather than Dossie SaaS content. Reliable
// selector confirmed against scripts/listing-marketing-generator.js,
// which sets target_owner='heath-realtor' on every row it inserts.
function isBrokeragePost(post) {
  return String((post && post.target_owner) || '') === 'heath-realtor';
}

// ─── Compliance gate (hard block, NOT a score) ────────────────────────────
// TREC §535.155 requires the broker's name on advertising. A listing post
// missing it must never go out under Heath's license -- this is checked
// deterministically (no LLM) so it can never be talked out of blocking.
const BROKERAGE_NAME_PATTERN = /Keller Williams/i;

function checkBrokerageCompliance(content) {
  const body = String(content || '');
  if (!BROKERAGE_NAME_PATTERN.test(body)) {
    return { allowed: false, reason: 'missing_brokerage_name' };
  }
  return { allowed: true, reason: null };
}

// ─── Media dimension (deterministic — not an LLM judgment call) ──────────
// Video vastly out-reaches static on FB/IG right now; text-only is
// near-unpostable for a listing and literally unpostable on Instagram.
function scoreMediaDimension(post) {
  const url = String((post && post.media_url) || '');
  if (!url) return 0;
  return isVideoUrl(url) ? 10 : 5;
}

// ─── Brokerage rubric ──────────────────────────────────────────────────
// Hook, Local signal, Media, Reply invite, Specifics — equal-weight
// composite (Media scored deterministically above, the rest via Haiku).
async function scoreBrokeragePost(post) {
  if (!ANTHROPIC_API_KEY) return null;
  const caption = String((post && post.content) || '');
  const platform = String((post && post.platform) || '');
  const prompt = `Score this Texas real-estate LISTING social media post on four dimensions (1-10 each). This is a licensed REALTOR's own listing marketing, NOT a software product -- do not expect or reward a signup-style call to action.

- hook: Does the first ~125 characters give a real reason to stop scrolling (a specific fact, number, or detail) rather than just a category label like "Just Listed" or "Price Drop"?
- local_signal: Is the neighborhood or city named early and clearly? This is how buyers self-identify and how the post gets found locally.
- reply_invite: Does the post genuinely invite a comment, question, or DM (e.g. "message me and I'll let you know the day it's ready") rather than only a generic "save this / share this"? A real invitation to engage should score noticeably higher than a generic save/share-only ask, because comments drive reach more than saves.
- specifics: Does it carry the concrete facts a buyer actually filters on -- price, beds/baths, square footage, acreage, HOA, school district, or financing eligibility (VA/FHA)? Vague copy should score low here.

Post (platform: ${platform}):
${caption}

Return JSON only: {"hook": N, "local_signal": N, "reply_invite": N, "specifics": N}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: SCORER_MODEL,
        max_tokens: 120,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    const match = text.match(/\{[^}]+\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const hook = clamp1to10(parsed.hook);
    const local_signal = clamp1to10(parsed.local_signal);
    const reply_invite = clamp1to10(parsed.reply_invite);
    const specifics = clamp1to10(parsed.specifics);
    if (!hook || !local_signal || !reply_invite || !specifics) return null;
    const media = scoreMediaDimension(post);
    const composite = Math.round(((hook + local_signal + media + reply_invite + specifics) / 5) * 10) / 10;
    return { hook, local_signal, media, reply_invite, specifics, composite };
  } catch (err) {
    console.warn('[post-scorer] scoreBrokeragePost failed:', err && err.message);
    return null;
  }
}

function formatBrokerageScoreLine(score) {
  if (!score) return '';
  return `Score: ${score.composite}/10 (Hook: ${score.hook} | Local: ${score.local_signal} | Media: ${score.media} | Reply: ${score.reply_invite} | Specifics: ${score.specifics})\n\n`;
}

// Below this composite, the approval card gets a "⚠️ LOW SCORE" banner.
// UNLIKE the software rubric, this NEVER auto-rejects -- Heath reviews
// every brokerage post himself; only checkBrokerageCompliance() blocks.
const BROKERAGE_WARN_THRESHOLD = 7.4;

// Printed on the approval card in place of PLATFORM_RULES_SUMMARY so Heath
// can sanity-check against the right playbook for this content type.
const BROKERAGE_RULES_SUMMARY =
  'Hook<125 chars (fact, not a category label), name the neighborhood/city early, video>image>text (text-only is unpostable on IG), invite a real reply not just save/share, carry price/beds/baths/sqft/HOA/school/financing, 3-5 hashtags, brokerage name required (TREC S535.155)';

module.exports = {
  isBrokeragePost,
  checkBrokerageCompliance,
  BROKERAGE_NAME_PATTERN,
  scoreMediaDimension,
  scoreBrokeragePost,
  formatBrokerageScoreLine,
  BROKERAGE_WARN_THRESHOLD,
  BROKERAGE_RULES_SUMMARY,
};
