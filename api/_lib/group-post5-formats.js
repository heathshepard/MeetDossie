'use strict';

// api/_lib/group-post5-formats.js
//
// The content formats for the daily 5-group-post pipeline. Rebuilt
// 2026-09-09 after the daily group-post generator invented five personal
// war stories (a Hill Country foundation failure, a daughter's-soccer-game
// amendment, a newer agent "on his team", a TREC one-pager that doesn't
// exist, and a false claim about forwarding verification texts) and nearly
// posted them under Heath's real name and real estate license. See
// memory/heath-verified-war-stories.md.
//
// HARD RULE going forward: only ONE format may carry a personal anecdote
// (`verified_anecdote`), and it may draw ONLY from
// api/_lib/verified-war-stories.json via api/_lib/verified-story-library.js
// -- never from free-form "rewrite this with different specific details"
// generation, which is exactly the mechanism that invented the five
// fabrications. The other four formats need no personal anecdote at all
// (a genuine question, a contrarian take, an observation about the TREC
// process itself, a second genuine question about practice habits) and are
// generated the same way as before: a scaffold Claude rewrites for tone,
// with a fabrication-guard pass after generation
// (api/_lib/fabrication-guard.js) as a second, independent check.
//
// Removed since the 2026-09-09 incident:
//   - `resource_giveaway` -- its scaffold claimed Heath had already made a
//     TREC deadline one-pager. That resource does not exist. Claiming
//     ownership of a resource that was never built is exactly the kind of
//     fabrication this file exists to stop, so the format is gone, not
//     just reworded.
//   - `teardown` -- its scaffold required inventing a specific personal
//     mistake ("missed a repair-amendment deadline early in my career...").
//     No verified story matches that shape. Replaced by
//     `process_observation` (a fact about the TREC process itself, no
//     personal narrative required) and `tracking_question` (a genuine
//     question about how OTHER agents track deadlines -- Heath doesn't
//     have to claim a specific mistake of his own to ask it).
//
// IMPORTANT: unlike docs/PIPELINE.md's third-person rule for Zernio persona
// content, these are Heath's OWN group posts in his OWN voice -- first
// person, warm, direct, ASCII only, no em-dashes (same call
// TC-DISCOVERY-CAMPAIGN.md already made for this class of content).
//
// Owner: Carter, 2026-09-09. Content-safety rebuild: Sage, 2026-09-09.

const { eligibleStories, getStory } = require('./verified-story-library');
const { POSITION_TAKING_FORMATS } = require('./practitioner-test-guard');

// Each non-anecdote format carries MULTIPLE scaffolds (distinct topics, not
// just distinct wording of the same topic). Root cause of the 2026-09-11
// "these all read like the same post" bug: every format had exactly ONE
// fixed scaffold that got "rewritten" every single time it was picked --
// so two different days landing on the same format (e.g. 'contrarian')
// were, structurally, always a paraphrase of the identical source
// paragraph about option-period waivers. Widening the pool and rotating
// scaffold id (tracked cross-group, not just per-group -- see
// scaffoldIdsRecentlyUsed() in api/_lib/daily-group5-post-generator.js) is
// the actual fix; the dedup layer in scripts/_lib/group-post-dedup.js is
// the safety net, not the primary defense.
const ASK_ADVICE_SCAFFOLDS = [
  {
    id: 'option_period_surprise',
    text: `Anyone here ever had a deal almost fall apart because of something buried in the option period? Not asking for tips, just want to know I'm not the only one who's had that stomach-drop moment. What happened?`,
  },
  {
    id: 'seller_repair_pushback',
    text: `Anyone else run into a seller who just flat refuses to take on ANY repairs after inspection, even the ones that'll almost certainly come back up with the next buyer? Not asking how to handle it, more curious how common that stance actually is right now versus a year or two ago. What's the standoff usually look like on your end?`,
  },
  {
    id: 'closing_delay_paperwork',
    text: `Had a closing slide because of a documentation gap nobody caught until the very end, something like a well or septic record, an HOA doc, a survey issue. Curious how often that's happening to other people lately versus it just being bad luck on my file. What's the paperwork gap that's bitten you most?`,
  },
];

const CONTRARIAN_SCAFFOLDS = [
  {
    id: 'option_period_waiver',
    text: `Waiving the option period isn't automatically brave, and it isn't automatically reckless either. For a typical retail buyer it's still a bad idea, you're giving up your one clean way out before you know what's actually wrong with the house. For a cash investor planning a full gut anyway, or a contractor who can price that risk himself, it can genuinely make sense. Most buyers waiving it in this market are neither of those. I just don't think we walk clients through which one they actually are before they sign off on it.`,
  },
  {
    id: 'escalation_clause_oversold',
    text: `Escalation clauses get pitched like a guaranteed win and they aren't. They make sense when you already know the ceiling you're comfortable with and you're disciplined enough to stop there. They backfire when a buyer uses one to avoid deciding their real number and ends up escalated past what they'd have offered outright. For a buyer with a firm budget and real nerve, it can genuinely win the house clean. For a buyer who's just anxious about losing, it just delays the moment they overpay. Worth being honest with a client about which one they are before you write it in.`,
  },
  {
    id: 'pre_approval_vs_pre_qual',
    text: `"Always require a pre-approval, never accept a pre-qual" gets repeated like gospel and it's not that simple. In a slow market with one offer on the table, a solid pre-qual from a known local lender is usually fine, you've got time to firm it up before option period ends. In a multiple-offer situation, though, a pre-qual next to someone else's full pre-approval is basically asking your seller to bet on the weaker paper. Same document, completely different amount of risk depending on how many other offers are in the room.`,
  },
];

const PROCESS_OBSERVATION_SCAFFOLDS = [
  {
    id: 'option_vs_provision_termination',
    text: `Something I see mixed up a lot: terminating during the option period and terminating under a specific contract provision later on are not the same animal. During the option period you can walk for any reason and it costs you the option fee, nothing else has to be proven. Later on, whether it's the financing addendum or a repair dispute, you need an actual contractual basis, not just a change of mind. Worth walking a buyer through that difference before they're staring at a deadline instead of after.`,
  },
  {
    id: 'earnest_money_vs_option_fee',
    text: `Earnest money and the option fee get treated as basically the same thing and they're not. The option fee buys the unrestricted right to walk during the option period, full stop, and it's usually non-refundable no matter why you leave. Earnest money is a good-faith deposit toward the purchase that's refundable in a lot more scenarios later in the contract, financing falling through, an unmet contingency, whatever the contract actually allows. Clients hear "deposit" for both and assume they work the same way. They really don't, and the difference matters most exactly when someone's trying to figure out what they get back.`,
  },
  {
    id: 'buyer_rep_agreement_scope',
    text: `A buyer's representation agreement isn't just paperwork you get signed and forget about, the SCOPE of it actually matters. Some agents write a broad geographic and price range on autopilot without really thinking about whether it matches what the buyer's actually looking at. Then three months later the buyer's interested in something slightly outside that box and nobody remembers to amend it. Worth actually reading your own scope language against what the client's really shopping for instead of treating it as a formality to get past.`,
  },
];

const TRACKING_QUESTION_SCAFFOLDS = [
  {
    id: 'deadline_tracking_system',
    text: `Curious what everyone's actual system is for tracking the dates you can't afford to miss. Not the software name, the real workflow behind it. I'm always tightening mine up. What's actually working for you?`,
  },
  {
    id: 'disclosure_review_habit',
    text: `Genuine question, how thoroughly do you actually read a seller's disclosure notice before you write an offer for a buyer versus after it's already executed and you're in option period? I go back and forth on whether reading it cover to cover upfront saves more headaches than it costs in time. What's your actual habit here, not the textbook answer?`,
  },
  {
    id: 'multiple_offer_communication',
    text: `Question for the group on multiple-offer situations specifically, what's your actual practice for communicating with the other agents once you know there's competition? Some agents give a deadline and a highest-and-best call, some just let it play out silently and take whatever lands. Curious what you've found actually gets the best result for your client without burning a relationship with the other side.`,
  },
];

const FORMATS = [
  {
    id: 'ask_advice',
    label: 'Ask-for-advice / discovery question',
    risk: 'zero',
    requiresStory: false,
    scaffolds: ASK_ADVICE_SCAFFOLDS,
  },
  {
    id: 'verified_anecdote',
    label: 'Verified personal story (library only)',
    risk: 'low_medium',
    requiresStory: true,
    // No scaffold here on purpose -- buildPrompt() builds this format's
    // prompt entirely from the chosen verified-story-library entry, never
    // from a freely-rewritable scaffold. See buildAnecdotePrompt() below.
  },
  {
    id: 'contrarian',
    label: 'Contrarian take',
    risk: 'medium',
    requiresStory: false,
    scaffolds: CONTRARIAN_SCAFFOLDS,
  },
  {
    id: 'process_observation',
    label: 'Observation about the TREC process itself',
    risk: 'very_low',
    requiresStory: false,
    scaffolds: PROCESS_OBSERVATION_SCAFFOLDS,
  },
  {
    id: 'tracking_question',
    label: 'Genuine question about deadline-tracking practices',
    risk: 'zero',
    requiresStory: false,
    scaffolds: TRACKING_QUESTION_SCAFFOLDS,
  },
];

const HOOK_TYPES = FORMATS.map((f) => f.id);

function getFormat(id) {
  return FORMATS.find((f) => f.id === id) || null;
}

/**
 * Pick a scaffold variant for a format, avoiding any scaffold id already
 * used (cross-group, within the dedupe window -- see
 * scaffoldIdsRecentlyUsed() in api/_lib/daily-group5-post-generator.js).
 * Falls back to "any scaffold for this format" only if every variant has
 * been used recently -- never returns nothing, since a slightly-stale
 * topic beats silently skipping the group.
 * @param {object} format  a FORMATS entry with a `scaffolds` array
 * @param {string[]} [excludeScaffoldIds]
 * @returns {{id: string, text: string}}
 */
function pickScaffold(format, excludeScaffoldIds = []) {
  const pool = Array.isArray(format.scaffolds) ? format.scaffolds : [];
  const fresh = pool.filter((s) => !excludeScaffoldIds.includes(s.id));
  const candidates = fresh.length ? fresh : pool;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick the next format for a group, avoiding:
 *   (a) whatever was used last in that SAME group,
 *   (b) any format already used ELSEWHERE in the SAME day's run, and
 *   (c) `verified_anecdote` whenever there is no eligible, unused verified
 *       story available -- THIS is the hard gate that replaces "invent a
 *       narrative": if no library story fits, the anecdote format is never
 *       a candidate, full stop, at every fallback stage below. Falling
 *       back to a non-anecdote format is a normal, expected outcome, not
 *       an error.
 *
 * @param {string|null} lastHookType  format id used last in this group
 *   (already stripped of any ":<storyId>" suffix by the caller)
 * @param {string[]} [usedThisRun]  format ids already used elsewhere in this run
 * @param {string[]} [eligibleStoryIds]  verified story ids currently usable
 *   (not blocked, not used elsewhere today, not used too recently in this
 *   group) -- empty array means "no anecdote today, in any group"
 * @returns {object} a FORMATS entry
 */
function pickFormat(lastHookType, usedThisRun = [], eligibleStoryIds = []) {
  const hasStory = Array.isArray(eligibleStoryIds) && eligibleStoryIds.length > 0;
  const storyGate = (f) => !f.requiresStory || hasStory;

  let candidates = FORMATS.filter((f) => storyGate(f) && f.id !== lastHookType && !usedThisRun.includes(f.id));
  if (candidates.length === 0) candidates = FORMATS.filter((f) => storyGate(f) && !usedThisRun.includes(f.id));
  if (candidates.length === 0) candidates = FORMATS.filter((f) => storyGate(f) && f.id !== lastHookType);
  if (candidates.length === 0) candidates = FORMATS.filter(storyGate);
  // storyGate is NEVER dropped, even as a last resort -- there are always
  // at least 4 non-anecdote formats, so this can't empty the pool.
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/**
 * Pick which eligible story to use for a `verified_anecdote` post. Simple
 * "first eligible" today (the library only ever has a small number of
 * entries) -- if the library grows, this is the one place to add smarter
 * per-group matching later.
 * @param {string[]} eligibleStoryIds
 * @returns {object|null} a verified-war-stories.json entry
 */
function pickStory(eligibleStoryIds) {
  if (!Array.isArray(eligibleStoryIds) || !eligibleStoryIds.length) return null;
  return getStory(eligibleStoryIds[0]);
}

const DRAFT_MODEL = 'claude-sonnet-5';

/**
 * The compound hook_type stored for a post, e.g. "verified_anecdote:tc_went_dark"
 * or "contrarian:option_period_waiver" -- lets recency checks (both the
 * generator's per-group cooldown and the cross-group hook-type dedupe in
 * scripts/_lib/group-post-dedup.js) tell WHICH story/scaffold was used, not
 * just that the format was. Added for non-anecdote formats 2026-09-11: the
 * bare format id was too coarse to catch "same scaffold, different day"
 * reuse -- see scaffoldIdsRecentlyUsed() in
 * api/_lib/daily-group5-post-generator.js.
 */
function effectiveHookType(format, story, scaffold) {
  if (format.requiresStory && story) return `${format.id}:${story.id}`;
  if (scaffold && scaffold.id) return `${format.id}:${scaffold.id}`;
  return format.id;
}

/** Strips any ":<storyId>" or ":<scaffoldId>" suffix back down to a plain format id. */
function baseHookType(hookType) {
  return typeof hookType === 'string' ? hookType.split(':')[0] : hookType;
}

/**
 * Build the prompt for a `verified_anecdote` post. Deliberately NOT a
 * "rewrite this scaffold with different specific details" prompt -- that
 * phrasing is what invented the five fabrications on 2026-09-09. Instead
 * the model is handed the story's approved narrative plus an explicit
 * allow-list of facts and a deny-list of what it must never add, and told
 * it may only adjust wording/tone, never facts.
 */
function buildAnecdotePrompt({ group, story, painLines, recentOpeners }) {
  const { VOICE_PROMPT_BLOCK, buildRecentOpenersBlock, buildRecentIdeasBlock } = require('./heath-voice-guard');
  const painBlock = (painLines && painLines.length)
    ? `\nREAL PAIN LANGUAGE FROM REALTORS ONLINE (fuel for authenticity elsewhere in the post, e.g. the closing line -- never use it to add a fact to the story itself, never mention Reddit):\n${painLines.map((p) => `- "${p}"`).join('\n')}\n`
    : '';

  return `You are writing a Facebook GROUP post for Heath Shepard, a licensed Texas REALTOR (Keller Williams, San Antonio / Hill Country). This is Heath's own personal group post, in his own voice.

GROUP: ${group.name}
FORMAT: Verified personal story (this is a REAL thing that happened to Heath -- not a story to invent or embellish)

VERIFIED STORY: ${story.title}

APPROVED NARRATIVE (your starting point -- you may reword for natural flow, but every fact below is the ceiling of what you may say, not a floor to build on):
---
${story.approved_narrative}
---

FACTS YOU ARE ALLOWED TO STATE (nothing else):
${story.safe_to_say.map((s) => `- ${s}`).join('\n')}

YOU MUST NEVER ADD OR IMPLY ANY OF THE FOLLOWING -- this is the hard rule that matters most:
${story.never_say.map((s) => `- ${s}`).join('\n')}

HARD RULE: do not invent a single new fact. No name, no date, no dollar figure, no city, no property, no family member, no colleague, no number of deals, no travel detail, nothing beyond the FACTS list above. If you feel the post needs more texture, add texture to the FEELING or the LESSON, never to the facts of what happened.
${painBlock}
${VOICE_PROMPT_BLOCK}
RULES:
1. Plain ASCII only. NEVER use an em-dash, and never use " - " (space-hyphen-space) as a sentence beat.
2. 60-180 words. Contractions always.
3. Ending in a question is optional here -- do not force one if the story reads better as a flat statement (vary this across the run; do not make every post in this run end in "?").
4. Never mention Dossie, meetdossie.com, "the app", "the tool", or any link.
${buildRecentOpenersBlock(recentOpeners)}${buildRecentIdeasBlock(recentOpeners)}
Return STRICT JSON only. No markdown, no commentary.
{
  "post_body": "<the post, plain text, newlines allowed>"
}`;
}

/**
 * Build the Claude prompt for one post. `painLines` are real
 * reddit_pain_language snippets (may be empty) used as authentic-language
 * fuel, never quoted verbatim into the post.
 *
 * `story` is REQUIRED when format.requiresStory is true, and this function
 * routes to buildAnecdotePrompt() in that case -- the free-form
 * "rewrite this scaffold with different specifics" path below is never
 * used for an anecdote format.
 *
 * `scaffold` is REQUIRED for every other format -- the specific
 * {id, text} variant picked by pickScaffold(), not the format's whole
 * scaffolds array. Passing the wrong one is a caller bug, not a silent
 * fallback, since silently defaulting to "some scaffold" is exactly the
 * "everything reads like the same post" failure mode this was built to fix.
 */
function buildPrompt({ group, format, painLines, promoAllowed, recentOpeners, story, scaffold }) {
  if (format.requiresStory) {
    if (!story) throw new Error(`buildPrompt: format "${format.id}" requires a verified story but none was provided`);
    return buildAnecdotePrompt({ group, story, painLines, recentOpeners });
  }
  if (!scaffold || !scaffold.text) {
    throw new Error(`buildPrompt: format "${format.id}" requires a scaffold variant (from pickScaffold()) but none was provided`);
  }

  const { buildRecentOpenersBlock, buildRecentIdeasBlock } = require('./heath-voice-guard');
  const painBlock = (painLines && painLines.length)
    ? `\nREAL PAIN LANGUAGE FROM REALTORS ONLINE (fuel for authenticity — never quote verbatim, never mention Reddit):\n${painLines.map((p) => `- "${p}"`).join('\n')}\n`
    : '';

  return `You are writing a Facebook GROUP post for Heath Shepard, a licensed Texas REALTOR (Keller Williams, San Antonio / Hill Country). This is Heath's own personal group post, in his own voice — first person, direct, a little self-deprecating, dry rather than bubbly. This is NOT third-person marketing copy and NOT an enthusiastic AI-assistant voice.

GROUP: ${group.name}
FORMAT: ${format.label} (${format.id})
${promoAllowed ? '' : 'HARD RULE: this post must NEVER mention Dossie, any software, any app, any product, any link, "sign up", or anything that reads as self-promotion. Zero pitch. This is a working agent talking to peers, full stop.\n'}
HARD RULE: this format carries NO personal anecdote. Do not write "I had a client...", "a deal of mine...", "I once...", or any other claim of a specific personal experience/deal/client -- keep it to a general question, opinion, or observation about the process. If you find yourself inventing a specific story to make the post land, stop -- that is exactly what is banned here.
${POSITION_TAKING_FORMATS.includes(format.id) ? `HARD RULE (practitioner test, memory/heath-marketing-must-pass-practitioner-test.md): this post is worthless to Heath if it reads as a flat absolute a 20-year agent would dismiss. If you're taking any evaluative position (something is a bad idea, risky, not worth it, etc.), you MUST also name the legitimate exception -- who or what situation it does NOT apply to (e.g. waiving the option period is bad for a typical retail buyer, but can make sense for a cash investor planning a gut renovation or a contractor who can price the risk himself). If you genuinely cannot name a real exception, do not take a flat position at all -- write the post as a neutral observation or question instead. A position with no stated exception will be rejected.
` : ''}SCAFFOLD (rewrite this — do not copy verbatim, write fresh copy with the same shape and topic, but do not add any new personal-anecdote claim that isn't already in the scaffold):
---
${scaffold.text}
---
${painBlock}
RULES — NON-NEGOTIABLE:
1. First person, Heath's real voice: direct, genuine, a little self-deprecating, dry over bubbly. No corporate language, no hashtags, no enthusiasm-opener ("love this", "so smart", "that's wild").
2. Plain ASCII only. NEVER use an em-dash, and never use " - " (space-hyphen-space) as a sentence beat -- that reads written, not spoken. Use a period or a new short sentence instead.
3. 60-200 words. Contractions always ("that's", "didn't", "he's").
4. Ending in a question is optional -- vary it across the run (do not make every post end in "?").
5. Never mention Dossie, meetdossie.com, "the app", "the tool", or any link — this post pipeline never self-promotes, in ANY of the 5 target groups, today.
6. All facts must be plausible/accurate for a working Texas agent (option periods, TREC deadlines, earnest money, etc.) — do not invent a specific dollar figure or date that reads as a real, checkable claim; keep numbers illustrative ("a few thousand", "a couple days") unless the scaffold already used a specific one you're rewriting.
7. Do not reuse the SAME opening line/hook shape or the SAME core claim as any post listed below under "recent posts" -- those are real posts already published to other groups in the last 30 days. A different scaffold topic still has to read like a genuinely different post, not the same idea in new words.
${buildRecentOpenersBlock(recentOpeners)}${buildRecentIdeasBlock(recentOpeners)}
Return STRICT JSON only. No markdown, no commentary.
{
  "post_body": "<the rewritten post, plain text, newlines allowed>"
}`;
}

module.exports = {
  FORMATS,
  HOOK_TYPES,
  DRAFT_MODEL,
  getFormat,
  pickFormat,
  pickScaffold,
  pickStory,
  effectiveHookType,
  baseHookType,
  buildPrompt,
  buildAnecdotePrompt,
};
