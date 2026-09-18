'use strict';

// scripts/_lib/auto-reply-risk-classifier.js
//
// MODEL-BASED risk classifier for the auto-reply-with-veto feature (Heath's
// explicit approval, 2026-09-16 — see
// supabase/migrations/20260916_auto_reply_veto.sql for the full contract).
//
// REWRITTEN 2026-09-16 (3rd pass) after the regex-only version failed a
// THIRD adversarial QA round in a row on the same failure class: named
// third parties and comparative/implied language keep taking new shapes
// ("Miguel and I were just talking about TC stuff", "dana loved the
// checklist feature" — lowercase name, unlisted verb; "way cheaper than
// what I pay now" — pricing with no $ sign and no listed keyword) that no
// fixed pattern list generalizes to, because the categories this
// classifier judges are SEMANTIC, not lexical. Cole's directive, verbatim:
// "stop patching regexes — the approach is wrong, not the patterns...
// Regex will keep losing this game because the categories are semantic."
//
// ARCHITECTURE NOW:
//   1. A SMALL, deterministic PRE-FILTER (PRE_FILTER_PATTERNS below) that
//      can ONLY force an escalation — an explicit $ figure or an explicit
//      "demo"/"trial" ask. It can NEVER certify something eligible; it
//      exists purely to catch the two highest-confidence, cheapest-to-
//      detect signals before spending an API call.
//   2. A Claude Haiku 4.5 call (classifyWithModel) that judges everything
//      else against a tight rubric: the same escalate categories as
//      before, PLUS "a named third party appears at all" (any name, any
//      phrasing, either word order) and "any implied or comparative
//      pricing" (not just a literal $ figure).
//   3. eligible=true requires BOTH the model's eligible=true AND
//      confidence="high". Medium/low confidence escalates regardless of
//      what the model thought was eligible — ties directly to the spec:
//      "Require high confidence AND eligible to auto-send; anything else
//      escalates."
//   4. FAIL-CLOSED on every failure mode: missing API key, network error,
//      timeout, non-200 status, no JSON in the response, JSON that fails
//      schema validation — every one of these returns the same shape as a
//      real escalate verdict (eligible:false), tagged with a distinct
//      category/source so a bad call is diagnosable separately from a
//      real "the model said no."
//
// Model choice: Claude Haiku 4.5 (`claude-haiku-4-5`). This is a short,
// single-turn classification call (a few sentences of input, a one-line
// JSON verdict out) — exactly the "classification... high-volume or
// latency-sensitive" workload the current model-selection guidance says
// does NOT need a bigger/slower model. At current published rates
// ($1.00 / $5.00 per MTok in/out) a call this size (~250 input + ~60
// output tokens) costs well under $0.001 — at a few comments a day this
// pipeline runs, monthly cost is cents, not dollars.
//
// Used by:
//   - api/cron-tc-reply-approval.js (decides veto-path vs manual-approval-path)
//   - scripts/regression-auto-reply-classifier.js (unit coverage, incl.
//     Quinn's reported misses across all three QA rounds + fail-closed paths)
//
// Owner: Carter, 2026-09-16

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLASSIFY_MODEL = 'claude-haiku-4-5';
const CLASSIFY_TIMEOUT_MS = 8000;
const CLASSIFY_MAX_TOKENS = 200;

// ── Hard pre-filter — ESCALATE-ONLY, never certifies eligible ──────────────
// Deliberately tiny. Everything that used to live in a big keyword list
// (competitors, contact requests, legal terms, complaint words, named
// third parties, indirect pricing...) is now the model's job. These two
// stay as a pattern match because they're unambiguous, free, and catch the
// highest-frequency cases before spending an API call at all.
const PRE_FILTER_PATTERNS = [
  { category: 'pricing', re: /\$\s?\d/ },
  { category: 'demo_request', re: /\b(?:demo|trial)\b/i },
];

function preFilter(combinedText) {
  for (const { category, re } of PRE_FILTER_PATTERNS) {
    if (re.test(combinedText)) return { category, pattern: re.toString() };
  }
  return null;
}

// ── The rubric ────────────────────────────────────────────────────────────
const KNOWN_CATEGORIES = new Set([
  'auto_eligible',
  'pricing',
  'demo_request',
  'complaint',
  'legal_compliance',
  'specific_client',
  'contact_request',
  'competitor_mention',
  'low_confidence',
]);

const CLASSIFY_PROMPT = (commentText, replyDraft) => `You are a risk classifier for an automated Facebook comment-reply system. Heath is a real, licensed Texas real estate agent. His name and license are attached to every reply this system might post. You decide whether a DRAFTED reply is safe to auto-post with zero human review, or must be escalated to Heath for a manual decision.

Default to ESCALATE. Only call something eligible when you are genuinely confident it is harmless small talk.

ESCALATE (eligible=false) whenever the COMMENT or the DRAFT touches any of these — judge the MEANING, not just specific words:
- pricing: any price, cost, discount, refund, billing question, OR any comparative/implied money reference at all (e.g. "cheaper than what I pay now", "worth it", "afford", "pay for itself") — even with no dollar sign and no word like "cost".
- demo_request: any request to see, try, access, or be walked through the product or how it works, in any phrasing.
- complaint: negative sentiment, doubt, skepticism, or backhanded criticism — including a "thanks" that also carries doubt ("thanks, I guess, not sure it works though").
- legal_compliance: anything touching TREC, legal exposure, liability, contract breach, earnest money forfeiture, or similar — even if it never says "legal" or "TREC".
- specific_client: a NAMED THIRD PARTY appears AT ALL, in any phrasing, any verb, any capitalization, any word order — "Miguel and I were talking about this", "dana loved the checklist feature", "my buddy Ray asked", "told Sarah about it". Treat any personal name reference as disqualifying regardless of how casual or friendly it sounds. This is the single most important rule: an auto-reply must never land in front of, or reference, someone Heath hasn't met.
- contact_request: asking Heath to DM, message, call, text, or otherwise reach out directly.
- competitor_mention: naming any competing product, tool, or platform (TC software, transaction-management tools, etc.).
- low_confidence: anything else you are not fully sure is harmless — including long or rambling comments, unclear intent, or a question/statement that doesn't cleanly resemble ordinary small talk between two working agents.

ELIGIBLE (eligible=true, and ONLY with confidence="high") is reserved for: a clean thanks, a clean agreement, a neutral question about the other agent's own general practice (not Heath's, not a third party's), or a plain factual answer about how TC/transaction work goes — with NONE of the above present anywhere in the comment or the draft.

COMMENT:
"""
${String(commentText || '').slice(0, 900)}
"""

DRAFTED REPLY (also check this for leaked pricing, capability claims, or anything else that would make posting it risky):
"""
${String(replyDraft || '').slice(0, 900)}
"""

Return ONLY this JSON shape, nothing else:
{"eligible": boolean, "category": "auto_eligible|pricing|demo_request|complaint|legal_compliance|specific_client|contact_request|competitor_mention|low_confidence", "confidence": "high|medium|low", "reason": "one short sentence"}`;

/**
 * Real API call. Injectable via deps for tests — never hits the network in
 * a regression run.
 * @returns {Promise<{eligible, category, confidence, reason, source, raw?}>}
 *   ALWAYS a fully-formed, fail-closed-safe result. Never throws.
 */
async function classifyWithModel(commentText, replyDraft) {
  if (!ANTHROPIC_API_KEY) {
    return { eligible: false, category: 'low_confidence', confidence: 'low', reason: 'ANTHROPIC_API_KEY not configured', source: 'model_error' };
  }

  let res;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLASSIFY_TIMEOUT_MS);
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: CLASSIFY_MODEL,
          max_tokens: CLASSIFY_MAX_TOKENS,
          temperature: 0,
          messages: [{ role: 'user', content: CLASSIFY_PROMPT(commentText, replyDraft) }],
        }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const isTimeout = err && (err.name === 'AbortError' || /abort/i.test(String(err.message)));
    return {
      eligible: false, category: 'low_confidence', confidence: 'low',
      reason: isTimeout ? 'classification call timed out' : `classification call failed: ${String(err.message || err).slice(0, 150)}`,
      source: 'model_error',
    };
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return {
      eligible: false, category: 'low_confidence', confidence: 'low',
      reason: `classification API returned ${res.status}: ${errText.slice(0, 150)}`,
      source: 'model_error',
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (err) {
    return { eligible: false, category: 'low_confidence', confidence: 'low', reason: 'classification response was not valid JSON envelope', source: 'model_error' };
  }

  const text = ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { eligible: false, category: 'low_confidence', confidence: 'low', reason: 'no JSON found in classification response', source: 'model_error', raw: text.slice(0, 200) };
  }

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch (err) {
    return { eligible: false, category: 'low_confidence', confidence: 'low', reason: 'classification JSON failed to parse', source: 'model_error', raw: match[0].slice(0, 200) };
  }

  // Schema validation — a malformed field is treated exactly like a
  // network failure: fail closed, never guess at what was meant.
  const eligibleOk = typeof parsed.eligible === 'boolean';
  const categoryOk = typeof parsed.category === 'string' && KNOWN_CATEGORIES.has(parsed.category);
  const confidenceOk = parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low';
  if (!eligibleOk || !categoryOk || !confidenceOk) {
    return {
      eligible: false, category: 'low_confidence', confidence: 'low',
      reason: 'classification response failed schema validation',
      source: 'model_error', raw: match[0].slice(0, 200),
    };
  }

  return {
    eligible: parsed.eligible,
    category: parsed.category,
    confidence: parsed.confidence,
    reason: String(parsed.reason || '').slice(0, 300),
    source: 'model',
  };
}

/**
 * classifyCommentRisk(commentText, replyDraft, deps)
 *
 * @param {string} commentText  the inbound FB comment
 * @param {string} replyDraft   Heath's drafted reply to it
 * @param {object} [deps]       { classify } — injectable model-call fn for tests
 * @returns {Promise<{
 *   eligible: boolean,
 *   category: string,
 *   confidence: 'high'|'medium'|'low',
 *   reason: string,
 *   source: 'pre_filter'|'model'|'model_error'
 * }>}
 */
async function classifyCommentRisk(commentText, replyDraft, deps = {}) {
  const { classify = classifyWithModel } = deps;
  const comment = String(commentText || '');
  const draft = String(replyDraft || '');
  const combined = `${comment}\n${draft}`;

  // 1. Hard pre-filter — cheap, deterministic, ESCALATE-ONLY.
  const hit = preFilter(combined);
  if (hit) {
    return {
      eligible: false,
      category: hit.category,
      confidence: 'high',
      reason: `pre-filter matched ${hit.pattern}`,
      source: 'pre_filter',
    };
  }

  if (!draft.trim()) {
    return { eligible: false, category: 'low_confidence', confidence: 'low', reason: 'empty draft', source: 'pre_filter' };
  }

  // 2. Model judgment for everything semantic.
  const verdict = await classify(comment, draft);

  // 3. Confidence gate — the model's own eligible=true is necessary but
  // NOT sufficient. Anything short of "high" confidence escalates.
  const eligible = verdict.eligible === true && verdict.confidence === 'high';

  return {
    eligible,
    category: verdict.category,
    confidence: verdict.confidence,
    reason: verdict.reason,
    source: verdict.source || 'model',
  };
}

// ── "No reply needed" verdict — pure reactions, not a classifier failure ──
//
// Investigated 2026-09-17 (Sage): 5 comments were reported stuck in
// tc_discovery_responses, reappearing in api/cron-tc-reply-approval.js's
// `errors` array on every run. Root cause was NOT the risk classifier above
// (classifyCommentRisk already fails closed correctly, verified against
// live rows + the regression suite — 50/50 passing, no malformed-JSON case
// found live). The actual bug was one level up, in the DRAFT call
// (callDraftModel / draftReply in api/cron-tc-reply-approval.js): a very
// short, low-content comment ("nice", "Beautiful!", a lone emoji) correctly
// produces a WELL-FORMED, validly-parsed JSON draft response of
// `{"hostile": false, "reply": ""}` — the model is telling us there's
// nothing worth saying — but the caller treated any empty, non-hostile
// reply as an exception (`throw new Error('empty draft for non-hostile
// comment')`), thrown BEFORE any DB write. The row never advanced past
// reply_status='new' and re-failed identically on every subsequent tick.
//
// Per memory/fb-engagement-thread-close-policy.md: a pure reaction closes
// immediately, it never gets a manufactured follow-up. `isNoReplyNeeded`
// makes that a first-class, auditable verdict (category 'no_reply_needed')
// instead of an uncaught exception, so the caller can route it straight to
// reply_status='skipped' — no Telegram send, no retry loop, no escalation
// (this is the SAFE, intentional-close case, not a failure).
//
// This is deliberately NOT a model call of its own — the draft model
// already gave us the signal for free (an empty, non-hostile reply), so
// classifying "should we even reply" a second time would just add another
// JSON-shaped failure surface for no benefit. A comment that's short but
// GENUINE ("Yes I'm a TC.", "Inside the US") already comes back from the
// draft model with real reply text and is unaffected — confirmed against
// live tc_discovery_responses rows, both drafted and posted successfully.
//
// Malformed/empty draft-model OUTPUT (no JSON found, JSON.parse throws,
// network/timeout error) is a DIFFERENT case and must NOT be treated as
// "no reply needed" — that stays a thrown error in the caller, which now
// routes to reply_status='flagged' (escalate to Heath) instead of leaving
// the row silently stuck at 'new' forever. Fail-closed to escalation,
// never to auto-send, exactly as classifyCommentRisk already does above.
const NO_REPLY_NEEDED_CATEGORY = 'no_reply_needed';

/**
 * isNoReplyNeeded(draftResult)
 *
 * @param {{hostile: boolean, reply: string}} draftResult  the parsed
 *   {hostile, reply} shape returned by the draft-model call (callDraftModel
 *   in api/cron-tc-reply-approval.js).
 * @returns {boolean} true only when the model deliberately, validly
 *   returned an empty, NON-hostile reply — i.e. "nothing worth saying
 *   here". Never true for a hostile verdict (that already routes to
 *   'flagged' separately) and never true for malformed/missing output
 *   (draftResult itself won't exist — the caller throws before this is
 *   ever reached).
 */
function isNoReplyNeeded(draftResult) {
  return !!draftResult
    && draftResult.hostile !== true
    && !String(draftResult.reply || '').trim();
}

module.exports = {
  CLASSIFY_MODEL,
  PRE_FILTER_PATTERNS,
  KNOWN_CATEGORIES,
  CLASSIFY_PROMPT,
  classifyWithModel,
  classifyCommentRisk,
  NO_REPLY_NEEDED_CATEGORY,
  isNoReplyNeeded,
};
