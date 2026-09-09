#!/usr/bin/env node
'use strict';

/**
 * Regression test for the Heath-voice guard (api/_lib/heath-voice-guard.js)
 * wired into every drafted group comment/reply/post:
 *   - api/cron-tc-reply-approval.js       (DRAFT_PROMPT / GUEST_DRAFT_PROMPT)
 *   - api/cron-comment-opp-approval.js    (SCORE_PROMPT)
 *   - api/_lib/group-post5-formats.js     (buildPrompt, daily5 group posts)
 *
 * Heath's feedback, 2026-09-09, verbatim: "the voice that we use in these
 * groups sound a little AI... doesn't sound really like me too much...
 * it just sounds like too enthusiastic. And happy. It sounds a little
 * robotic." The tell: three real drafts in a row ran the identical
 * "enthusiasm opener, then a question" shape:
 *   - "Haha love the confidence, James - if you had to pick the one thing
 *      clients bring up most from that 'everything,' what would it be?"
 *   - "A couple times a week just to forward verification texts is wild,
 *      Ben - does she ever miss one if you're slow to forward it, or has
 *      that system held up so far?"
 *   - "Holly, that's a great tip about writing both emails into the
 *      contract so there's no excuse not to copy - how often do you still
 *      find yourself having to send that..."
 *
 * PINS DOWN:
 *   1. Each of those THREE REAL DRAFTS individually fails the guard (proves
 *      the guard actually catches the reported bug, not a strawman).
 *   2. Banned openers/phrases are rejected wherever they appear.
 *   3. Em-dash and the " - " beat substitute are both rejected.
 *   4. A batch of drafts must NOT all end in "?" (structural variety, not
 *      just per-draft compliance).
 *   5. Opener-shape collision detection catches two differently-worded
 *      drafts that open the same way (the actual failure mode, not just
 *      verbatim repeats).
 *   6. A clean, Heath-voiced sample passes.
 *   7. All three drafting prompts (TC reply, guest reply, comment-opp,
 *      group-post5) actually include the shared voice block + recent-
 *      openers block — wired in, not just built and unused.
 *   8. scoreAndDraft / draftReply retry once on a violation (prompt-level
 *      self-correction loop exists).
 *
 * Run manually:
 *   node scripts/regression-heath-voice-guard.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-not-real';
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
process.env.TELEGRAM_MARKETING_BOT_TOKEN = 'test-token-not-real';
process.env.TELEGRAM_CHAT_ID = '1';

const guard = require(path.join(__dirname, '..', 'api', '_lib', 'heath-voice-guard.js'));

// The exact three real drafts Heath flagged, verbatim.
const REAL_BAD_DRAFTS = [
  `Haha love the confidence, James - if you had to pick the one thing clients bring up most from that 'everything,' what would it be?`,
  `A couple times a week just to forward verification texts is wild, Ben - does she ever miss one if you're slow to forward it, or has that system held up so far?`,
  `Holly, that's a great tip about writing both emails into the contract so there's no excuse not to copy - how often do you still find yourself having to send that...`,
];

// A believable "fixed" version of each, in the requested register: short,
// dry, contractions, no compliment-opener, not every one ends in "?".
const SAMPLE_GOOD_DRAFTS = [
  `yeah that's the one that gets people. usually it's the closing cost breakdown, not the price itself.`,
  `mine's held up so far but I always confirm by phone too, not just text.`,
  `I still end up sending that reminder more than I'd like. put it in the contract and people still forget.`,
];

async function main() {
  // ── 1. The THREE REAL DRAFTS all fail the guard ───────────────────────────
  for (const draft of REAL_BAD_DRAFTS) {
    const check = guard.checkVoiceCompliance(draft);
    assert.strictEqual(check.ok, false, `real flagged draft must fail the guard: "${draft.slice(0, 50)}..."`);
    assert.ok(check.violations.length > 0, 'violations list is non-empty');
  }
  // Specifically: each catches the phrase Heath actually saw.
  assert.ok(guard.checkVoiceCompliance(REAL_BAD_DRAFTS[0]).violations.some((v) => v.includes('love the')), 'catches "love the" opener');
  assert.ok(guard.checkVoiceCompliance(REAL_BAD_DRAFTS[2]).violations.some((v) => v.includes('great tip')), 'catches "great tip"');

  // ── 2. Banned phrases anywhere in the text, not just as an opener ─────────
  assert.strictEqual(guard.checkVoiceCompliance('anyway, so smart of them honestly').ok, false, 'so smart is banned mid-sentence too');
  assert.strictEqual(guard.checkVoiceCompliance('yeah I love this approach').ok, false, '"love this" is banned');
  assert.strictEqual(guard.checkVoiceCompliance('that is not related at all').ok, true, 'unrelated text with no banned phrase passes');

  // ── 3. Em-dash and " - " beat substitute both rejected ─────────────────────
  assert.strictEqual(guard.checkVoiceCompliance('good point — I had that happen once too').ok, false, 'real em-dash character rejected');
  assert.strictEqual(guard.checkVoiceCompliance('good point - I had that happen once too').ok, false, '" - " used as a written beat rejected');
  assert.strictEqual(guard.checkVoiceCompliance('good point, I had that happen once too').ok, true, 'a comma in the same spot is fine');
  assert.strictEqual(guard.checkVoiceCompliance('long-term tenants are usually easier').ok, true, 'a real hyphenated compound word (no spaces) is NOT flagged');

  // ── 4. Batch structural check: not every draft may end in "?" ─────────────
  // (Heath's own 3rd example was truncated with "..." mid-question in his
  // quote, so it doesn't end in a literal "?" — construct the batch check
  // against the actual reported shape: 2 of 3 real drafts are pure
  // enthusiasm-then-question, which is the pattern under test here.)
  const badBatch = guard.batchVoiceCheck(REAL_BAD_DRAFTS);
  assert.ok(badBatch.perDraftViolations.length === 3, 'all 3 real drafts individually flagged in the batch check too');

  const allQuestionsBatch = guard.batchVoiceCheck([REAL_BAD_DRAFTS[0], REAL_BAD_DRAFTS[1], 'and does the same thing happen with the reply-to-reply flow?']);
  assert.strictEqual(allQuestionsBatch.allEndInQuestion, true, 'a batch where every draft ends in "?" is correctly flagged as all-questions');

  const goodBatch = guard.batchVoiceCheck(SAMPLE_GOOD_DRAFTS);
  assert.strictEqual(goodBatch.allEndInQuestion, false, 'the fixed sample batch is NOT all-questions');
  assert.strictEqual(goodBatch.perDraftViolations.length, 0, 'the fixed sample batch has zero voice violations');

  // ── 5. Opener-shape collision detection (not just verbatim dup) ───────────
  const shapeA = guard.openerShape(`Haha love the confidence, James`);
  const shapeB = guard.openerShape(`Haha love the confidence, honestly`);
  assert.ok(guard.openerTooSimilar(shapeA, shapeB), 'two differently-worded openers with the same shape are flagged as too similar');
  const shapeC = guard.openerShape(`yeah that happens to me too sometimes`);
  assert.ok(!guard.openerTooSimilar(shapeA, shapeC), 'genuinely different openers are not flagged');

  const recentBlock = guard.buildRecentOpenersBlock(REAL_BAD_DRAFTS);
  assert.ok(/do not open with any of these recent shapes/i.test(recentBlock), 'recent-openers block instructs the model not to reuse recent shapes');
  assert.ok(recentBlock.length > 0, 'recent-openers block is non-empty given real recent drafts');
  assert.strictEqual(guard.buildRecentOpenersBlock([]), '', 'empty recent list produces an empty block (no dangling instruction)');

  // ── 6. A clean, Heath-voiced sample passes cleanly ─────────────────────────
  for (const draft of SAMPLE_GOOD_DRAFTS) {
    const check = guard.checkVoiceCompliance(draft);
    assert.strictEqual(check.ok, true, `fixed sample draft should pass: "${draft}"`);
  }

  // ── 7. Wired into all three drafting prompts, not just built and unused ───
  const tcSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-tc-reply-approval.js'), 'utf8');
  assert.ok(tcSrc.includes("require('./_lib/heath-voice-guard')"), 'cron-tc-reply-approval.js imports the voice guard');
  assert.ok(tcSrc.includes('voiceGuard.VOICE_PROMPT_BLOCK'), 'DRAFT_PROMPT/GUEST_DRAFT_PROMPT include the voice block');
  assert.ok(tcSrc.includes('voiceGuard.buildRecentOpenersBlock'), 'prompts include the recent-openers block');
  assert.ok(tcSrc.includes('voiceGuard.checkVoiceCompliance'), 'draftReply runs a post-generation voice check');
  assert.ok(!/Thank them for the SPECIFIC thing they said — reference their actual words\/details, never a generic "thanks for sharing"\.\n- Ask exactly ONE follow-up question/.test(tcSrc),
    'the old "thank them then ask exactly one question" hard rule is gone, not just supplemented');

  const oppSrc = fs.readFileSync(path.join(__dirname, '..', 'api', 'cron-comment-opp-approval.js'), 'utf8');
  assert.ok(oppSrc.includes("require('./_lib/heath-voice-guard')"), 'cron-comment-opp-approval.js imports the voice guard');
  assert.ok(oppSrc.includes('voiceGuard.VOICE_PROMPT_BLOCK'), 'SCORE_PROMPT includes the voice block');
  assert.ok(oppSrc.includes('voiceGuard.buildRecentOpenersBlock'), 'SCORE_PROMPT includes the recent-openers block');
  assert.ok(oppSrc.includes('voiceGuard.checkVoiceCompliance'), 'scoreAndDraft runs a post-generation voice check');
  // Still must not regress the pre-existing hard rules the other regression pins.
  assert.ok(/NEVER mention Dossie/i.test(oppSrc), 'draft prompt still forbids mentioning Dossie');
  assert.ok(/never a generic/i.test(oppSrc), 'draft prompt still forbids filler comments');

  const groupFormatsSrc = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'group-post5-formats.js'), 'utf8');
  assert.ok(groupFormatsSrc.includes("require('./heath-voice-guard')"), 'group-post5-formats.js imports buildRecentOpenersBlock from the voice guard');
  assert.ok(groupFormatsSrc.includes('enthusiasm-opener'), 'group post prompt bans enthusiasm openers too');
  assert.ok(/space-hyphen-space/.test(groupFormatsSrc), 'group post prompt bans the " - " beat substitute');

  const genSrc = fs.readFileSync(path.join(__dirname, '..', 'api', '_lib', 'daily-group5-post-generator.js'), 'utf8');
  assert.ok(genSrc.includes('heathVoiceGuard.checkVoiceCompliance'), 'daily-group5-post-generator.js runs a post-generation voice check, same as the content gate and dedupe');
  assert.ok(genSrc.includes('runOpeners'), 'generator tracks openers across the whole run for cross-group variety, not just within one group');

  // ── 8. Retry-once-on-violation loop actually exists in both cron files ────
  assert.ok(tcSrc.includes('YOUR PREVIOUS DRAFT VIOLATED THE VOICE RULES'), 'tc-reply-approval retries once with explicit feedback on a violation');
  assert.ok(oppSrc.includes('YOUR PREVIOUS DRAFT VIOLATED THE VOICE RULES'), 'comment-opp-approval retries once with explicit feedback on a violation');

  // ── Integration: scoreAndDraft / draftReply actually self-correct ─────────
  const cron = require(path.join(__dirname, '..', 'api', 'cron-comment-opp-approval.js'));
  let calls = 0;
  const badThenGood = async (promptText) => {
    calls++;
    if (calls === 1) return { score: 80, reasons: 'x', comment: `Haha love that - what's your take on it?` };
    return { score: 80, reasons: 'x', comment: 'yeah that tracks with what I have seen too.' };
  };
  // scoreAndDraft calls callScoreModel internally (not injectable directly),
  // so this integration check goes through the real function shape: verify
  // the retry actually replaces a violating comment by calling the module's
  // internal retry contract via a controlled monkeypatch of global fetch.
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  global.fetch = async (url, init) => {
    fetchCalls++;
    const body = JSON.parse(init.body);
    const prompt = body.messages[0].content;
    const violatesRetryFeedback = /YOUR PREVIOUS DRAFT VIOLATED/.test(prompt);
    const responseComment = violatesRetryFeedback
      ? 'yeah that tracks with what I have seen too.'
      : `Haha love that - what's your take on it?`;
    const payload = { content: [{ type: 'text', text: JSON.stringify({ score: 80, reasons: 'x', comment: responseComment }) }] };
    return { ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload };
  };
  try {
    const result = await cron.scoreAndDraft({ group_name: 'G', author_name: 'A', post_text: 'x' }, []);
    assert.strictEqual(fetchCalls, 2, 'scoreAndDraft called the model exactly twice: initial + one retry');
    assert.strictEqual(guard.checkVoiceCompliance(result.comment).ok, true, 'the FINAL comment after retry passes the voice guard');
  } finally {
    global.fetch = originalFetch;
  }

  console.log('PASS: Heath voice guard (bans real reported phrases, em-dash + dash-beat, batch all-question check, opener-shape collision, wired into TC-reply/comment-opp/group-post5 prompts, retry-on-violation loop verified end to end)');
  console.log('\n--- SAMPLE: before (real flagged drafts) ---');
  for (const d of REAL_BAD_DRAFTS) console.log(`  - ${d}`);
  console.log('--- SAMPLE: after (passes the guard) ---');
  for (const d of SAMPLE_GOOD_DRAFTS) console.log(`  - ${d}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error('FAIL:', err.message, '\n', err.stack); process.exit(1); });
