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

const FORMATS = [
  {
    id: 'ask_advice',
    label: 'Ask-for-advice / discovery question',
    risk: 'zero',
    requiresStory: false,
    scaffold: `Anyone here ever had a deal almost fall apart because of something buried in the option period? Not asking for tips, just want to know I'm not the only one who's had that stomach-drop moment. What happened?`,
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
    scaffold: `Unpopular opinion: waiving the option period to win a bid isn't brave, it's just moving the risk from the seller to you. I get why buyers do it in this market. I still think agents should push back on it harder than most of us do. Anyone actually had it blow up on a client?`,
  },
  {
    id: 'process_observation',
    label: 'Observation about the TREC process itself',
    risk: 'very_low',
    requiresStory: false,
    scaffold: `Something I see mixed up a lot: terminating during the option period and terminating for cause later under the contract are not the same thing. One just costs you the option fee. The other means pointing to a specific paragraph and proving you actually had the right to walk. Worth walking a buyer through the difference before they're staring at a deadline instead of after.`,
  },
  {
    id: 'tracking_question',
    label: 'Genuine question about deadline-tracking practices',
    risk: 'zero',
    requiresStory: false,
    scaffold: `Curious what everyone's actual system is for tracking the dates you can't afford to miss. Not the software name, the real workflow behind it. I'm always tightening mine up. What's actually working for you?`,
  },
];

const HOOK_TYPES = FORMATS.map((f) => f.id);

function getFormat(id) {
  return FORMATS.find((f) => f.id === id) || null;
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
 * The compound hook_type stored for an anecdote post, e.g.
 * "verified_anecdote:tc_went_dark" -- lets recency checks (both the
 * generator's per-group story cooldown and the existing hook-type dedupe
 * in scripts/_lib/group-post-dedup.js) tell WHICH story was used, not just
 * that the format was.
 */
function effectiveHookType(format, story) {
  return format.requiresStory && story ? `${format.id}:${story.id}` : format.id;
}

/** Strips any ":<storyId>" suffix back down to a plain format id. */
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
  const { VOICE_PROMPT_BLOCK, buildRecentOpenersBlock } = require('./heath-voice-guard');
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
${buildRecentOpenersBlock(recentOpeners)}
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
 */
function buildPrompt({ group, format, painLines, promoAllowed, recentOpeners, story }) {
  if (format.requiresStory) {
    if (!story) throw new Error(`buildPrompt: format "${format.id}" requires a verified story but none was provided`);
    return buildAnecdotePrompt({ group, story, painLines, recentOpeners });
  }

  const { buildRecentOpenersBlock } = require('./heath-voice-guard');
  const painBlock = (painLines && painLines.length)
    ? `\nREAL PAIN LANGUAGE FROM REALTORS ONLINE (fuel for authenticity — never quote verbatim, never mention Reddit):\n${painLines.map((p) => `- "${p}"`).join('\n')}\n`
    : '';

  return `You are writing a Facebook GROUP post for Heath Shepard, a licensed Texas REALTOR (Keller Williams, San Antonio / Hill Country). This is Heath's own personal group post, in his own voice — first person, direct, a little self-deprecating, dry rather than bubbly. This is NOT third-person marketing copy and NOT an enthusiastic AI-assistant voice.

GROUP: ${group.name}
FORMAT: ${format.label} (${format.id})
${promoAllowed ? '' : 'HARD RULE: this post must NEVER mention Dossie, any software, any app, any product, any link, "sign up", or anything that reads as self-promotion. Zero pitch. This is a working agent talking to peers, full stop.\n'}
HARD RULE: this format carries NO personal anecdote. Do not write "I had a client...", "a deal of mine...", "I once...", or any other claim of a specific personal experience/deal/client -- keep it to a general question, opinion, or observation about the process. If you find yourself inventing a specific story to make the post land, stop -- that is exactly what is banned here.
SCAFFOLD (rewrite this — do not copy verbatim, write fresh copy with the same shape and topic, but do not add any new personal-anecdote claim that isn't already in the scaffold):
---
${format.scaffold}
---
${painBlock}
RULES — NON-NEGOTIABLE:
1. First person, Heath's real voice: direct, genuine, a little self-deprecating, dry over bubbly. No corporate language, no hashtags, no enthusiasm-opener ("love this", "so smart", "that's wild").
2. Plain ASCII only. NEVER use an em-dash, and never use " - " (space-hyphen-space) as a sentence beat -- that reads written, not spoken. Use a period or a new short sentence instead.
3. 60-200 words. Contractions always ("that's", "didn't", "he's").
4. Ending in a question is optional -- vary it across the run (do not make every post end in "?").
5. Never mention Dossie, meetdossie.com, "the app", "the tool", or any link — this post pipeline never self-promotes, in ANY of the 5 target groups, today.
6. All facts must be plausible/accurate for a working Texas agent (option periods, TREC deadlines, earnest money, etc.) — do not invent a specific dollar figure or date that reads as a real, checkable claim; keep numbers illustrative ("a few thousand", "a couple days") unless the scaffold already used a specific one you're rewriting.
${buildRecentOpenersBlock(recentOpeners)}
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
  pickStory,
  effectiveHookType,
  baseHookType,
  buildPrompt,
  buildAnecdotePrompt,
};
