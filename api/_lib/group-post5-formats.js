'use strict';

// api/_lib/group-post5-formats.js
//
// The 5 content formats from docs/GROUP-ENGAGEMENT-PLAN.md #2 (Sage,
// 2026-09-09), ranked by comment-volume-vs-risk. Formats #6 (celebrate
// someone else's win) and #7 (poll-style) are excluded — #6 is a comment,
// not an originated post, and #7 is explicitly cut from rotation per the
// plan ("underperforms in FB groups... keep in the back pocket").
//
// IMPORTANT: unlike docs/PIPELINE.md's third-person rule for Zernio persona
// content, these are Heath's OWN group posts in his OWN voice — first
// person, warm, direct, ASCII only, no em-dashes (same call
// TC-DISCOVERY-CAMPAIGN.md already made for this class of content).
//
// Owner: Carter, 2026-09-09

const FORMATS = [
  {
    id: 'ask_advice',
    label: 'Ask-for-advice / discovery question',
    risk: 'zero',
    usesPain: true,
    scaffold: `Anyone here ever had a deal almost fall apart because of something buried in the option period? Not asking for tips, just want to know I'm not the only one who's had that stomach-drop moment. What happened?`,
  },
  {
    id: 'founder_story',
    label: 'Founder pain story',
    risk: 'low_medium',
    usesPain: true,
    scaffold: `Had a TC quit on me at 4:30am while I was in Italy, mid-option-period on three deals. Talked a client through a TREC amendment from a hotel lobby on bad wifi. That's the morning I decided paperwork couldn't depend on one person's schedule anymore. Anyone else had the "this can't happen again" moment with a transaction?`,
  },
  {
    id: 'contrarian',
    label: 'Contrarian take',
    risk: 'medium',
    usesPain: false,
    scaffold: `Unpopular opinion: waiving the option period to win a bid isn't brave, it's just moving the risk from the seller to you. I get why buyers do it in this market. I still think agents should push back on it harder than most of us do. Anyone actually had it blow up on a client?`,
  },
  {
    id: 'teardown',
    label: 'Teardown / what I got wrong',
    risk: 'very_low',
    usesPain: true,
    scaffold: `Missed a repair-amendment deadline early in my career because I was tracking dates in my head instead of writing them anywhere. Cost my seller leverage in a negotiation that should've gone our way. Wasn't a system failure - I didn't have a system. What's the mistake that actually changed how you track deadlines?`,
  },
  {
    id: 'resource_giveaway',
    label: 'Resource/checklist give-away',
    risk: 'low_medium',
    usesPain: false,
    scaffold: `Made myself a one-pager of every TREC deadline that has a hard dollar consequence if missed (option fee, earnest money, financing addendum). Happy to drop it in the comments if people want it - just say the word so I'm not spamming a link nobody asked for.`,
  },
];

const HOOK_TYPES = FORMATS.map((f) => f.id);

function getFormat(id) {
  return FORMATS.find((f) => f.id === id) || null;
}

/**
 * Pick the next format for a group, avoiding whatever was used last in that
 * SAME group (matches api/_lib/group-post-generator.js's pickTemplate
 * pattern for the legacy campaign).
 * @param {string|null} lastHookType
 * @returns {object} a FORMATS entry
 */
function pickFormat(lastHookType) {
  const candidates = FORMATS.length > 1
    ? FORMATS.filter((f) => f.id !== lastHookType)
    : FORMATS;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

const DRAFT_MODEL = 'claude-sonnet-5';

/**
 * Build the Claude prompt for one post. `painLines` are real
 * reddit_pain_language snippets (may be empty) used as authentic-language
 * fuel, never quoted verbatim into the post.
 */
function buildPrompt({ group, format, painLines, promoAllowed }) {
  const painBlock = (painLines && painLines.length)
    ? `\nREAL PAIN LANGUAGE FROM REALTORS ONLINE (fuel for authenticity — never quote verbatim, never mention Reddit):\n${painLines.map((p) => `- "${p}"`).join('\n')}\n`
    : '';

  return `You are writing a Facebook GROUP post for Heath Shepard, a licensed Texas REALTOR (Keller Williams, San Antonio / Hill Country). This is Heath's own personal group post, in his own voice — first person, warm, direct, a little self-deprecating. This is NOT third-person marketing copy.

GROUP: ${group.name}
FORMAT: ${format.label} (${format.id})
${promoAllowed ? '' : 'HARD RULE: this post must NEVER mention Dossie, any software, any app, any product, any link, "sign up", or anything that reads as self-promotion. Zero pitch. This is a working agent talking to peers, full stop.\n'}
SCAFFOLD (rewrite this — do not copy verbatim, write fresh copy with different specific details but the same emotional truth and structure):
---
${format.scaffold}
---
${painBlock}
RULES — NON-NEGOTIABLE:
1. First person, Heath's real voice: warm, casual, genuine, a little self-deprecating. No corporate language, no hashtags.
2. Plain ASCII only — no em-dashes, no curly quotes, no special Unicode. Use plain hyphens (-) and straight quotes only.
3. 100-300 words.
4. End with a genuine, specific open question that invites real comments (except the resource-giveaway format, which can end with the "just say the word" line instead).
5. Never mention Dossie, meetdossie.com, "the app", "the tool", or any link — this post pipeline never self-promotes, in ANY of the 5 target groups, today.
6. All facts must be plausible/accurate for a working Texas agent (option periods, TREC deadlines, earnest money, etc.) — do not invent a specific dollar figure or date that reads as a real, checkable claim; keep numbers illustrative ("a few thousand", "a couple days") unless the scaffold already used a specific one you're rewriting.

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
  buildPrompt,
};
