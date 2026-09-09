#!/usr/bin/env node
'use strict';

/**
 * Regression test for the verified-war-story library + fabrication guard
 * (api/_lib/verified-war-stories.json, api/_lib/verified-story-library.js,
 * api/_lib/fabrication-guard.js) and their wiring into
 * api/_lib/group-post5-formats.js + api/_lib/daily-group5-post-generator.js.
 *
 * INCIDENT, 2026-09-09: the daily group-post generator invented five
 * personal war stories -- a Hill Country foundation failure, a
 * daughter's-soccer-game amendment, a newer agent "on his team", a TREC
 * deadline one-pager that doesn't exist, and a false claim about
 * forwarding verification texts "a couple times a week" -- and nearly
 * posted them under Heath's real name and real estate license into Texas
 * REALTOR groups. See memory/heath-verified-war-stories.md.
 *
 * PINS DOWN:
 *   1. The library has exactly the two stories Heath confirmed, and the
 *      active-dispute one (Low Oak) is status='blocked', never eligible.
 *   2. The fabrication guard catches all FIVE known-fabricated examples.
 *   3. The fabrication guard does NOT false-positive on clean, real content
 *      (the five rewritten sample-day posts, verbatim).
 *   4. group-post5-formats.js no longer has a format that requires
 *      inventing an anecdote (resource_giveaway / teardown removed) and
 *      pickFormat() NEVER returns verified_anecdote when no eligible story
 *      is available -- across many random trials, not just one.
 *   5. The verified_anecdote prompt is built from the story's approved
 *      facts, not a "rewrite this scaffold with different specifics"
 *      instruction (the actual mechanism that invented the fabrications).
 *   6. Cross-group same-day story reuse is blocked: once tc_went_dark is
 *      used in one group, the SAME run's next group has zero eligible
 *      stories and must fall back to a non-anecdote format.
 *   7. End-to-end: generateCleanPost() BLOCKS and retries when Claude
 *      returns one of the five banned fabricated bodies, and returns null
 *      (skip) rather than inserting it, when both attempts fabricate.
 *
 * Run manually:
 *   node scripts/regression-verified-war-stories.js
 */

const assert = require('assert');
const path = require('path');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

const library = require(path.join(__dirname, '..', 'api', '_lib', 'verified-story-library.js'));
const { checkFabrication } = require(path.join(__dirname, '..', 'api', '_lib', 'fabrication-guard.js'));
const formats = require(path.join(__dirname, '..', 'api', '_lib', 'group-post5-formats.js'));
const gen = require(path.join(__dirname, '..', 'api', '_lib', 'daily-group5-post-generator.js'));

// The five real fabrications, written as they would have shipped (first
// person, in a group post) -- see memory/heath-verified-war-stories.md
// "Explicitly NOT true" section.
const BANNED_FABRICATIONS = [
  {
    label: 'Hill Country foundation failure',
    text: `Had a client waive the option period once and the house turned out to have a foundation issue nobody caught, out in the Hill Country. Learned fast how much that waiver actually costs when it goes wrong.`,
  },
  {
    label: "daughter's soccer game amendment",
    text: `Drafted a TREC amendment from my car in a parking lot at my daughter's soccer game once, phone propped on the dash between plays.`,
  },
  {
    label: 'newer agent "on his team"',
    text: `Had a newer agent on my team almost miss an option deadline early on. Scared both of us straight about how we track dates now.`,
  },
  {
    label: "TREC one-pager that doesn't exist",
    text: `Made myself a one-pager of every TREC deadline that has a dollar consequence if missed. Happy to drop it in the comments if people want it.`,
  },
  {
    label: 'false "forwards verification texts" claim',
    text: `Yeah I forward verification texts to my TC a couple times a week too, same as you. It just becomes habit after a while.`,
  },
];

// The five rewritten sample-day posts (see the report this test ships
// with) -- positive control. Only the TC-went-dark story is used as a
// personal anecdote; the other four carry no anecdote at all.
const CLEAN_SAMPLE_POSTS = [
  `Anyone here had a deal almost come apart over something buried in the option period? Not fishing for advice, just curious if I'm the only one who still gets a little nervous around day two or three, even after doing this a while. What happened, and did you catch it in time?`,
  `Had a TC go dark on me once, mid-transaction. No call, no email, nothing, right when I needed dates confirmed. Ended up handling the file myself until I could get someone else looped in. Made it painfully obvious how much of a transaction can ride on one person with no backup. Learned that lesson the hard way and don't set a file up that way anymore.`,
  `Curious what everyone's actual system is for tracking dates you can't afford to miss. Not the software name, the real workflow behind it. Calendar reminders, a paper checklist, texting yourself the night before. I've tightened mine up more than once after almost missing something and I'm always looking for a better way. What's actually working for you?`,
  `Something I see mixed up a lot: terminating during the option period and terminating for cause later in the contract are not the same animal. One just costs you the option fee. The other means you're pointing to a specific paragraph and proving you had the right to walk. Agents explain this to clients differently and it shows. Worth actually walking a buyer through the difference before they're staring at a deadline instead of after.`,
  `Unpopular opinion: waiving the option period to win a bid isn't brave, it's just moving risk from the seller onto the buyer. I get why it happens in this market. I still think more of us should push back on it with clients instead of just drafting it because they asked for it. Feels like something we've normalized instead of actually examined.`,
];

async function main() {
  // ── 1. Library structure: exactly 2 stories, correct eligibility ──────────
  const all = library.loadLibrary();
  assert.strictEqual(all.length, 2, 'library has exactly the two stories Heath confirmed on 2026-09-09');
  const tcStory = library.getStory('tc_went_dark');
  assert.ok(tcStory, 'tc_went_dark story exists');
  assert.strictEqual(tcStory.status, 'eligible', 'tc_went_dark is eligible (resolved, safe, non-litigious)');

  const lowOak = library.getStory('low_oak_earnest_money');
  assert.ok(lowOak, 'low_oak_earnest_money story exists in the library (structurally ready, not deleted)');
  assert.strictEqual(lowOak.status, 'blocked', 'low_oak_earnest_money is BLOCKED -- active, unresolved dispute, must never auto-publish');
  assert.ok(/active/i.test(lowOak.blocked_reason) && /dispute/i.test(lowOak.blocked_reason), 'blocked_reason documents why (active dispute)');

  const eligible = library.eligibleStories({});
  assert.strictEqual(eligible.length, 1, 'exactly one story is eligible today');
  assert.strictEqual(eligible[0].id, 'tc_went_dark', 'the eligible story is tc_went_dark, never the blocked Low Oak file');

  const excluded = library.eligibleStories({ excludeIds: ['tc_went_dark'] });
  assert.strictEqual(excluded.length, 0, 'excluding the one eligible story (e.g. already used today) leaves zero -- Low Oak never fills the gap');

  // ── 2. Fabrication guard catches all FIVE known-fabricated examples ───────
  for (const { label, text } of BANNED_FABRICATIONS) {
    const check = checkFabrication(text, { formatId: null });
    assert.strictEqual(check.ok, false, `banned fabrication must be caught: "${label}"`);
    assert.ok(check.violations.length > 0, `violations list is non-empty for "${label}"`);
  }
  // Spot-check the specific pattern each one trips, so this isn't just
  // "something matched" -- the RIGHT thing matched.
  assert.ok(checkFabrication(BANNED_FABRICATIONS[0].text).violations.some((v) => v.startsWith('named_client')), 'Hill Country story flagged as an uncredentialed client claim');
  assert.ok(checkFabrication(BANNED_FABRICATIONS[1].text).violations.some((v) => v.startsWith('family_member')), 'soccer-game story flagged for naming a family member');
  assert.ok(checkFabrication(BANNED_FABRICATIONS[2].text).violations.some((v) => v.startsWith('my_team')), '"newer agent on my team" flagged as a team claim');
  assert.ok(checkFabrication(BANNED_FABRICATIONS[3].text).violations.some((v) => v.startsWith('resource_offer')), 'the nonexistent one-pager flagged as an unverified resource offer');
  assert.ok(checkFabrication(BANNED_FABRICATIONS[4].text).violations.some((v) => v.startsWith('unverified_practice_claim')), 'the false "couple times a week" claim flagged');

  // ── 3. No false positives on real, clean content ──────────────────────────
  for (const text of CLEAN_SAMPLE_POSTS) {
    const check = checkFabrication(text, { formatId: 'verified_anecdote' });
    assert.strictEqual(check.ok, true, `clean sample post must pass the guard: "${text.slice(0, 60)}..." (violations: ${check.violations.join(', ')})`);
  }
  // The TC story specifically must ALSO pass under the non-anecdote formats
  // (belt+suspenders -- it shouldn't trip named_client etc even without the
  // allowance) since it makes no client claim at all.
  assert.strictEqual(checkFabrication(CLEAN_SAMPLE_POSTS[1], { formatId: 'ask_advice' }).ok, true, 'TC story trips nothing even without the verified_anecdote allowance (it never claims a client)');

  // ── 4. Formats: no format requires inventing an anecdote; verified_anecdote
  //    is the only anecdote-carrying format and is gated on story availability ─
  const formatIds = formats.FORMATS.map((f) => f.id);
  assert.ok(!formatIds.includes('resource_giveaway'), 'resource_giveaway format removed -- it claimed a resource that does not exist');
  assert.ok(!formatIds.includes('teardown'), 'teardown format removed -- it required inventing a specific unverified mistake');
  assert.ok(formatIds.includes('verified_anecdote'), 'verified_anecdote format exists');
  const anecdoteFormat = formats.getFormat('verified_anecdote');
  assert.strictEqual(anecdoteFormat.requiresStory, true, 'verified_anecdote is flagged as requiring a story');
  const otherFormats = formats.FORMATS.filter((f) => f.id !== 'verified_anecdote');
  assert.ok(otherFormats.every((f) => !f.requiresStory), 'no OTHER format requires a story (none of them may carry a personal anecdote)');
  assert.strictEqual(formats.FORMATS.length, 5, 'exactly 5 formats total');

  // pickFormat NEVER returns verified_anecdote with zero eligible stories --
  // across many trials, since it's randomized.
  for (let i = 0; i < 200; i++) {
    const picked = formats.pickFormat(null, [], []);
    assert.notStrictEqual(picked.id, 'verified_anecdote', 'pickFormat must never select verified_anecdote when eligibleStoryIds is empty (trial ' + i + ')');
  }
  // With a story available, it's a normal candidate (not guaranteed every
  // trial since it competes with 4 others, but must show up eventually).
  let sawAnecdote = false;
  for (let i = 0; i < 200; i++) {
    const picked = formats.pickFormat(null, [], ['tc_went_dark']);
    if (picked.id === 'verified_anecdote') { sawAnecdote = true; break; }
  }
  assert.ok(sawAnecdote, 'verified_anecdote IS a normal candidate once a story is eligible');

  // pickFormat also never violates the story gate even at its loosest
  // fallback stage (usedThisRun covers everything, lastHookType excludes
  // the rest) -- it should still return SOME format, never throw/crash,
  // and never verified_anecdote with no story.
  const allFormatIds = formats.FORMATS.map((f) => f.id);
  const jammed = formats.pickFormat('ask_advice', allFormatIds, []);
  assert.ok(jammed && jammed.id !== 'verified_anecdote', 'even when every format is "already used" and lastHookType is set, a jammed pickFormat still refuses to hand back verified_anecdote without a story');

  // ── 5. The anecdote prompt is fact-bounded, not a free rewrite ────────────
  const anecdotePrompt = formats.buildAnecdotePrompt({
    group: { name: 'Texas Real Estate Agents' },
    story: tcStory,
    painLines: [],
    recentOpeners: [],
  });
  assert.ok(anecdotePrompt.includes('do not invent a single new fact'), 'anecdote prompt explicitly forbids inventing new facts');
  assert.ok(anecdotePrompt.includes(tcStory.approved_narrative), 'anecdote prompt includes the pre-approved narrative as the anchor');
  for (const fact of tcStory.safe_to_say) {
    assert.ok(anecdotePrompt.includes(fact), `anecdote prompt lists allowed fact: "${fact.slice(0, 40)}..."`);
  }
  assert.ok(!/rewrite this — do not copy verbatim, write fresh copy with different specific details/i.test(anecdotePrompt), 'anecdote prompt does NOT use the free-rewrite instruction that invented the five fabrications');
  // buildPrompt() must throw rather than silently produce an unbounded
  // prompt if a story-requiring format is ever called without one.
  assert.throws(() => formats.buildPrompt({ group: { name: 'x' }, format: anecdoteFormat, painLines: [], promoAllowed: false, recentOpeners: [], story: null }),
    /requires a verified story/, 'buildPrompt refuses to generate an anecdote prompt with no story provided');

  // The Low Oak story must be structurally usable by buildAnecdotePrompt
  // (so it's ready the day it's cleared) but is NEVER reachable through the
  // normal pickFormat/eligibleStories path today.
  const lowOakPrompt = formats.buildAnecdotePrompt({ group: { name: 'x' }, story: lowOak, painLines: [], recentOpeners: [] });
  assert.ok(lowOakPrompt.includes('Never characterize fault'), 'if Low Oak were ever manually invoked, its never_say list (never characterize fault, no dollar figure, etc) still flows into the prompt');

  // ── 6. Cross-group same-day story reuse blocked ────────────────────────────
  let calls = 0;
  const anecdoteThenAnything = async (prompt) => {
    calls++;
    if (/VERIFIED STORY/.test(prompt)) return { post_body: tcStory.approved_narrative };
    return { post_body: `Fresh non-anecdote content number ${calls}, no personal claims, just a genuine question about market conditions in Texas this week for other agents to weigh in on.` };
  };
  const group1 = { key: 'tx_re_agents', name: 'Texas Real Estate Agents' };
  const group2 = { key: 'kw_re_group', name: 'Keller Williams Real Estate Group' };
  const first = await gen.generateCleanPost({ generate: anecdoteThenAnything, group: group1, recentPosts: [], painLines: [], log: () => {}, usedFormatsThisRun: [], usedStoriesThisRun: [] });
  assert.ok(first, 'first group produces a clean post');
  const usedStoriesThisRun = first.story ? [first.story.id] : [];
  if (first.story) {
    // Only assert the cross-group block in the branch where the RNG
    // actually picked verified_anecdote for group 1 -- otherwise there's
    // nothing to exclude and the test would be vacuous. Force it directly
    // instead of relying on random luck.
  }
  // Force group 1 onto verified_anecdote deterministically to make the
  // cross-group exclusion assertion meaningful (rather than depending on
  // pickFormat's RNG happening to land there).
  const forcedFirst = await gen.generateCleanPost({
    generate: anecdoteThenAnything, group: group1, recentPosts: [], painLines: [], log: () => {},
    usedFormatsThisRun: formats.FORMATS.filter((f) => f.id !== 'verified_anecdote').map((f) => f.id), // force every other format "used"
    usedStoriesThisRun: [],
  });
  assert.ok(forcedFirst, 'group 1 produces a clean post when forced onto verified_anecdote');
  assert.strictEqual(forcedFirst.format.id, 'verified_anecdote', 'group 1 was actually forced onto verified_anecdote for this assertion');
  assert.strictEqual(forcedFirst.story.id, 'tc_went_dark', 'group 1 used the one eligible story');
  assert.strictEqual(forcedFirst.hookType, 'verified_anecdote:tc_went_dark', 'stored hook_type encodes which story was used');

  const second = await gen.generateCleanPost({
    generate: anecdoteThenAnything, group: group2, recentPosts: [], painLines: [], log: () => {},
    usedFormatsThisRun: [], // format itself isn't excluded
    usedStoriesThisRun: [forcedFirst.story.id], // but the STORY was used elsewhere today
  });
  assert.ok(second, 'group 2 still produces a clean post (falls back, does not just fail)');
  assert.notStrictEqual(second.format.id, 'verified_anecdote', 'group 2 falls back to a non-anecdote format -- the one eligible story was already used today, so it never repeats the same story in two groups the same day');

  // ── 7. End-to-end: a fabricating Claude response is blocked and retried,
  //    then skipped (never inserted) if it keeps fabricating ────────────────
  let fabCalls = 0;
  const alwaysFabricates = async () => {
    fabCalls++;
    return { post_body: BANNED_FABRICATIONS[0].text }; // Hill Country foundation story, every time
  };
  const blockedResult = await gen.generateCleanPost({ generate: alwaysFabricates, group: group1, recentPosts: [], painLines: [], log: () => {}, usedFormatsThisRun: [], usedStoriesThisRun: [] });
  assert.strictEqual(blockedResult, null, 'a persistently fabricating generator produces NO clean post -- generateCleanPost returns null (skip), never a fabricated row');
  assert.strictEqual(fabCalls, 2, 'exactly one retry attempted before giving up (2 calls total), never an unbounded loop and never "post it anyway"');

  let fixCalls = 0;
  const fabricatesThenFixes = async () => {
    fixCalls++;
    if (fixCalls === 1) return { post_body: BANNED_FABRICATIONS[2].text }; // "on my team" fabrication
    return { post_body: `Curious what everyone's actual system is for tracking dates you can't afford to miss. Not the software name, the real workflow. I'm always tightening mine up. What's actually working for you?` };
  };
  const recoveredResult = await gen.generateCleanPost({ generate: fabricatesThenFixes, group: group1, recentPosts: [], painLines: [], log: () => {}, usedFormatsThisRun: [], usedStoriesThisRun: [] });
  assert.ok(recoveredResult, 'a generator that fabricates once then self-corrects on retry produces a clean post on attempt 2');
  assert.strictEqual(checkFabrication(recoveredResult.post_body).ok, true, 'the FINAL post that made it through is clean');

  console.log('PASS: verified-story library (2 stories, Low Oak correctly BLOCKED as an active dispute), fabrication guard (catches all 5 real fabrications, zero false positives on the 5 clean sample posts), format rebuild (no anecdote-inventing formats remain, verified_anecdote hard-gated on story availability across 200 randomized trials), fact-bounded anecdote prompt, cross-group same-day story-reuse block, and end-to-end fabrication blocking in generateCleanPost (skip-not-invent contract verified)');
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
