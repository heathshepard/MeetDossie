// Vercel Serverless Function: /api/cron-sage-autonomous-review
// Cole's autonomous review pass over pending_sage_review posts.
//
// For each row in sage_inbox with status='pending_sage_review':
//   1. Apply Cole's editorial judgment (brand fit, voice consistency, strategy alignment)
//   2. Approve → update sage_inbox.status='approved', social_posts.status='approved'
//   3. Send Back (fixable) → mark status='regenerating', write feedback to social_posts.review_feedback, increment regeneration_attempts
//   4. Reject (hard) → mark status='rejected', drop
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: every 30 min after cron-send-to-sage ("*/30 * * * *").

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { buildVerifiedFactsBlock, POLICY_SURFACE_MATRIX } = require('./_lib/sage-verified-facts.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const REVIEWER_MODEL = 'claude-sonnet-4-20250514';
const MAX_PER_RUN = 12;

// -------------------------------------------------------------------------
// DEMOTED-RULE DETECTOR (2026-07-07 sage recalibration)
//
// The model kept stacking send_back / reject verdicts on rules that the
// prompt explicitly demotes: (a) Dossie mentioned in main-body of a
// non-group post, (b) persona='dossie' flagged as mismatch, (c) verified
// facts (pricing, TC quit in Italy, 4:30am, $400/file) flagged as
// "fabricated". This sanitizer runs AFTER the LLM verdict. If the model
// sent back a post but every objection matches a demoted keyword pattern,
// the sanitizer flips the verdict to APPROVE.
//
// This is intentionally a whitelist of DEMOTED reasons, not a blacklist of
// approve reasons. If the model finds a real fabrication (invented
// customer, fake MRR, unshipped feature), those phrases won't match and
// the send_back stands.
// -------------------------------------------------------------------------
// Two-part matcher (see scripts/sage-reviewer-sanitizer-selftest.js):
// (1) Simple keyword hits — chunk mentions demoted terminology.
// (2) Combo hits — chunk contains both a verified-fact keyword AND an
//     unverification word (in either order, any distance apart).
const DEMOTED_KEYWORD_PATTERNS = [
  // Dossie-in-body objections on main social (not group)
  /dossie\s+mention(ion)?\s+rule/i,
  /dossie\s+(should\s+)?(be\s+)?(in|moved\s+to)\s+(the\s+)?first\s+comment/i,
  /(reserve|save|move)\s+.*dossie.*for\s+first\s+comment/i,
  /dossie\s+in\s+(the\s+)?(main\s+)?(body|caption|post)/i,
  /product\s+details?\s+(buried|in\s+caption).*first\s+comment/i,
  /mentions?\s+dossie\s+throughout/i,
  /dossie\s+isn'?t\s+mentioned\s+until/i,
  /bury(?:ing|ies|ied)?\s+dossie/i,
  /dossie\s+(is\s+)?(mentioned\s+)?buried/i,
  /dossie\s+mention.*first\s+comment/i,
  /caption\s+.*(first\s+comment|save.*first)/i,
  /first\s+comment\s+per\s+rules/i,
  /should\s+save\s+product\s+details/i,

  // Persona=dossie flagged as mismatch
  /persona\s+mismatch/i,
  /tagged\s+(as\s+)?['"]?dossie['"]?\s+but\s+should\s+be/i,
  /'?dossie'?\s+is\s+not\s+a\s+valid\s+persona/i,
  /dossie\s+doesn'?t\s+post\s+in\s+first-?person/i,
  /use\s+brenda\/?patricia\/?victor/i,
  /(reframe|rewrite|use)\s+(as\s+)?agent\s+persona/i,
  /should\s+be\s+agent[- ]?focused\s+voice/i,
  /dossie\s+persona\s+(should|but\s+reads)/i,

  // Hashtag-count objections
  /hashtag\s+count/i,
  /too\s+many\s+hashtags/i,
  /(more|less)\s+than\s+\d+\s+hashtags/i,

  // Copy-nit / vibe / self-contradicting objections
  /clunky\s+phrasing/i,
  /could\s+read\s+better/i,
  /consider\s+rephrasing/i,
  /on\s+second\s+thought/i,
  /actually\s+fine/i,
  /minor\s+(copy\s+)?nit/i,
  /reads?\s+(like\s+)?(a\s+)?(corporate|sales\s*[- ]?y|salesy|marketing|product\s+pitch|sales\s+pitch)/i,
  /too\s+corporate/i,
  /voice\s+is\s+off/i,
  /tone\s+(drift|is\s+off)/i,
  /reads?\s+more\s+like\s+a?\s*sales\s+pitch/i,
  /voice\s+too\s+salesy/i,
  /salesy\/?corporate/i,
];

// Combo matcher: a chunk is DEMOTED if it contains any verified-fact
// keyword AND any unverification word.
const VERIFIED_FACT_KEYWORDS = [
  /\$29(?![\d])/i,           // $29 not followed by more digits
  /\$400(?![\d])/i,          // $400/file
  /founding\s+pricing/i,
  /founding\s+member\s+pricing/i,
  /founding\s+price/i,
  /italy/i,
  /4:?30\s*(am|a\.m\.)/i,
  /4:?30\s*in\s+the\s+morning/i,
  /heath\s+built\s+dossie/i,
  /heath.*tc\s+quit/i,
  /tc\s+quit.*heath/i,
  /locked\s+while\s+(your\s+)?subscription/i,
];
const UNVERIFICATION_KEYWORDS = [
  /unverified/i,
  /fabricat/i,
  /invented/i,
  /needs\s+verification/i,
  /not\s+confirmed/i,
  /no\s+evidence/i,
  /lacks\s+verification/i,
  /is\s+a\s+(specific\s+)?claim/i,
  /is\s+a\s+specific\s+detail/i,
  /invented\s+narrative/i,
  /specific\s+claim.*verification/i,
];

function isDemotedChunk(chunk) {
  if (DEMOTED_KEYWORD_PATTERNS.some((rx) => rx.test(chunk))) return true;
  const hasFact = VERIFIED_FACT_KEYWORDS.some((rx) => rx.test(chunk));
  const hasUnverif = UNVERIFICATION_KEYWORDS.some((rx) => rx.test(chunk));
  if (hasFact && hasUnverif) return true;
  return false;
}

// Real hard-block phrases that ALWAYS justify a send_back (never demote)
const HARD_BLOCK_PATTERNS = [
  /invented\s+customer(?:\s+name)?/i,
  /fake\s+testimonial/i,
  /fabricated\s+testimonial/i,
  /made-?up\s+testimonial/i,
  /unshipped\s+feature/i,
  /unreleased\s+feature/i,
  /pii/i,
  /personal\s+information/i,
  /phone\s+number/i,
  /email\s+address\s+exposed/i,
  /home\s+address/i,
  /harmful/i,
  /discriminatory/i,
  /misleading\s+medical/i,
];

// Split the feedback into candidate objections and score them.
// Returns { totalObjections, demotedCount, hardBlockCount }
function scoreFeedback(feedback) {
  if (!feedback || typeof feedback !== 'string') {
    return { totalObjections: 0, demotedCount: 0, hardBlockCount: 0 };
  }

  // Split into sentence-ish chunks + numbered lists so we can count objections.
  const chunks = feedback
    .split(/(?:\n+|\(\d+\)|(?:^|\s)\d+[\.\)]\s+|;\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4);

  const list = chunks.length > 0 ? chunks : [feedback];

  // Drop the intro-only chunks like "Multiple hard blockers:" which are
  // NOT an objection but a heading
  const substantive = list.filter((c) => {
    const t = c.trim();
    if (/^(multiple\s+)?(hard\s+)?(critical\s+)?(blockers?|issues?|violations?|failures?)[\s:.-]*$/i.test(t)) return false;
    if (t.length < 15) return false;
    return true;
  });
  const scored = substantive.length > 0 ? substantive : list;

  let hardBlockCount = 0;
  let demotedCount = 0;

  for (const chunk of scored) {
    if (HARD_BLOCK_PATTERNS.some((rx) => rx.test(chunk))) {
      hardBlockCount++;
      continue;
    }
    if (isDemotedChunk(chunk)) {
      demotedCount++;
    }
  }

  return {
    totalObjections: scored.length,
    demotedCount,
    hardBlockCount,
  };
}

// Sanitize the LLM verdict. If the model sent back but every objection is
// a demoted rule and NO hard-block phrases are present, override to approve.
function sanitizeReview(review, isGroupPost) {
  if (!review) return review;
  const decision = String(review.decision || '').toLowerCase();

  // Group posts are governed by the strict "no Dossie in body" rule which
  // is NOT demoted — do not sanitize group posts. Only sanitize main
  // social posts.
  if (isGroupPost) return review;

  if (decision !== 'send_back' && decision !== 'reject') return review;

  const { totalObjections, demotedCount, hardBlockCount } = scoreFeedback(review.feedback);

  // If there's a real hard-block phrase, keep the verdict.
  if (hardBlockCount > 0) return review;

  // Threshold: if at least 2 demoted matches AND >= 50% of objections
  // are demoted (and none are hard-block), the review is spurious.
  // Verified by scripts/sage-reviewer-sanitizer-selftest.js against the
  // last 30 days of production rejects.
  if (demotedCount >= 2 && totalObjections > 0 && demotedCount / totalObjections >= 0.5) {
    return {
      decision: 'approve',
      score: Math.max(review.score || 5, 7),
      feedback: `[sanitized: ${demotedCount}/${totalObjections} objections were demoted rules; auto-approved. Original feedback dropped: ${(review.feedback || '').slice(0, 160)}]`,
      _sanitized: true,
      _originalDecision: decision,
    };
  }

  return review;
}


async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// Cole's autonomous review — warm-but-rigorous editor with verified facts.
//
// PARAMOUNT (2026-06-20, cole_review): Cole brings human judgment to post approval,
// catching brand voice issues and editorial fit that deterministic rules miss.
// Cole is warm but rigorous, trusts verified facts (already fact-checked upstream),
// and defaults to APPROVE when facts are clean and voice matches Dossie's personality.
// All posts reaching Cole have already passed deterministic fact-checking. Her job is
// editorial fit and brand voice alignment, NOT re-checking facts.
//
// 2026-06-22 sage_4: VERIFIED_FACTS extracted to api/_lib/sage-verified-facts.js
// and expanded with VERIFIED_PAIN_POINTS whitelist + POLICY_SURFACE_MATRIX so Cole
// doesn't cross-apply FB-group rules to FB-page/Twitter/LinkedIn/Instagram posts.

const VERIFIED_FACTS = buildVerifiedFactsBlock();

async function coleReview(post) {
  const isGroupPost = !!post.post_body && post.first_comment_body !== undefined;

  const systemPrompt = isGroupPost
    ? `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You're reviewing this Facebook group post for brand fit and editorial polish before it ships.

Your role: warm but rigorous. You DEFAULT TO APPROVE. The deterministic verifier already passed these posts on facts. Your job is brand voice — NOT re-checking facts.

${VERIFIED_FACTS}

${POLICY_SURFACE_MATRIX}

## Facebook GROUP Post Rules (THIS POST IS A GROUP POST)

1. **No Dossie in Main Body** (HARD-BLOCK): Post body must NEVER mention Dossie. This rule applies ONLY to FB group posts.
2. **Dossie in First Comment** (HARD-BLOCK): If post has a first comment, it MUST contain the literal word "Dossie" and name ONE specific shipped capability.
3. **Brand Voice Fit**: Tone is warm, casual, genuine, first-person. Like an agent talking to other agents.
4. **Hook Quality**: Opening must be punchy and agent-relatable.
5. **Pillar Alignment**: Touches one of Cost, Control, Visibility, Speed, Coverage.

## Decision Framework — DEFAULT TO APPROVE

Send back ONLY for these four conditions (per locked spec):
(a) Obvious factual fabrication BEYOND the VERIFIED FACTS whitelist (e.g., invented customer name like "Sarah from Plano", fake MRR figure, unshipped feature).
(b) Wrong persona for the platform's audience (rare — most personas work).
(c) PII or sensitive data exposure.
(d) FB-group main-body Dossie mention (this IS a hard-block for GROUP posts).

Feedback must be SPECIFIC and ACTIONABLE. Example: "Rewrite hook — your TC story uses $500/file but verified is $400/file." NOT vague: "tone is off."

- **APPROVE** (score 7-10): Default. Ship it.
- **SEND_BACK** (score 4-6): ONE specific fixable issue from (a)-(d). Name the exact fix.
- **REJECT** (score 1-3): Hard violation — harmful content, off-audience entirely. Rare.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise specific reason if not approve"}`
    : `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You review main social posts (Facebook page, Twitter, LinkedIn, Instagram) for brand voice and editorial fit.

Your role: warm but rigorous editor. You DEFAULT TO APPROVE. The deterministic verifier already passed these posts on facts. Your job is brand voice — NOT re-checking facts.

${VERIFIED_FACTS}

${POLICY_SURFACE_MATRIX}

## Review Rules (MAIN SOCIAL POSTS — Facebook PAGE, Twitter, LinkedIn, Instagram)

1. **Dossie Mention IS EXPECTED**: This is the brand's own social presence. Dossie naming in the caption is correct. NEVER send back for "Dossie should be in first comment" — that rule is FB-group-only. If you see "Dossie's pipeline view" or "Dossie reads your contract" in the caption, that is RIGHT.
2. **All 4 Personas Are Valid**: 'brenda', 'patricia', 'victor', 'dossie' — all 4 are documented valid personas. NEVER reject for "persona mismatch" just because tag is 'dossie'. Dossie IS a brand-voice persona.
3. **Brand Voice**: Warm, capable, agent-focused. Solving pain, not pure selling.
4. **Hook Quality**: First 1-2 sentences are punchy and agent-relatable.
5. **Pillar Alignment**: Touches Cost, Control, Visibility, Speed, or Coverage.

## HARD RULE — READ THIS BEFORE ANSWERING

If your ONLY objections come from the DEMOTED list below, verdict is APPROVE.
Do not send_back. Do not reject. APPROVE.

You have been repeatedly over-rejecting posts that are actually fine. The Dossie mention rule is FB-GROUP-ONLY. It does not apply to Facebook PAGE, Twitter, LinkedIn, or Instagram. On main social posts, Dossie mention in the caption IS CORRECT and EXPECTED.

## THE ONLY REASONS TO SEND_BACK ARE:

(a) An INVENTED customer name (e.g., "Sarah from Plano called me") not in VERIFIED CUSTOMERS.
(b) An INVENTED testimonial or direct quote attributed to a specific person we do not have on record.
(c) A specific fake MRR number, deal count, or metric that contradicts VERIFIED FACTS (current MRR is $377 as of 2026-07-07).
(d) A feature described as shipped that isn't in VERIFIED FEATURES (e.g., "Dossie signs contracts for you" — not shipped).
(e) PII or sensitive data (phone number, home address, private email).
(f) The post is a Facebook GROUP post AND mentions Dossie in the main body (NOT applicable — this is a MAIN social post).

If NONE of (a)-(f) applies, verdict is APPROVE.

## Decision Framework — DEFAULT TO APPROVE (kept for backward compat)

DEMOTED to warning (auto-approve, do not send back):
- "Dossie mentioned in main body" objections on Facebook PAGE / Twitter / LinkedIn / Instagram → AUTO-APPROVE.
- "Persona is dossie not brenda/patricia/victor" → AUTO-APPROVE (dossie is valid).
- "$29/month / $400 per file / TC quit in Italy / 4:30am" → AUTO-APPROVE (verified).
- **Hashtag COUNT alone is NEVER a send-back trigger.** Twitter 2-3 ideal but up to 5 fine. LinkedIn 3-5 normal. Instagram 8-10 normal. Group rule violation = the only hashtag-related send-back.
- Minor copy nits (clunky phrasing, "could read better", "consider rephrasing") → AUTO-APPROVE. Only send back for outright errors.
- Self-contradicting reasoning ("on second thought, actually fine") → AUTO-APPROVE. If you find yourself reversing your own send_back rationale, the answer is APPROVE.

DECIDE THE VERDICT FIRST. Then write feedback only if verdict is send_back or reject. Do not reason aloud in the feedback field — feedback must state the ONE exact fix, ≤25 words.

Feedback examples:
GOOD: "Rewrite hook — claim 'I closed 50 deals last month' is unverified. Use 'high-volume agents do 50+ deals/year' instead."
BAD: "Hashtag count exceeds rules but LinkedIn allows more so this is actually fine, however on second thought..." ← reverse to APPROVE.

- **APPROVE** (score 7-10): Default. Ship it. Empty feedback OK.
- **SEND_BACK** (score 4-6): ONE specific fixable issue from (a)-(e) above. ≤20 words.
- **REJECT** (score 1-3): Hard violation — invented testimonial, harmful, completely off-audience. Extremely rare.

## MANDATORY SELF-CHECK BEFORE EMITTING JSON

Before you output your verdict, mentally run this checklist:

1. Does my feedback contain "Dossie mention rule", "first comment", "buried Dossie", "reserve for first comment", or similar? → FLIP TO APPROVE.
2. Does my feedback say persona 'dossie' is a mismatch or invalid? → FLIP TO APPROVE.
3. Does my feedback say $29 / $400 / Italy / 4:30am / founding pricing is unverified or fabricated? → FLIP TO APPROVE (all verified).
4. Does my feedback say the hashtag count is too high? → FLIP TO APPROVE.
5. Does my feedback say the post reads salesy / corporate / like marketing (without a specific rule violation)? → FLIP TO APPROVE.
6. Am I stacking "multiple violations" where each individual one is in the DEMOTED list? → FLIP TO APPROVE.
7. Is my only concrete objection something specifically in (a)-(e) above? If not → FLIP TO APPROVE.

If ANY self-check fires, the verdict is APPROVE and feedback should be empty or a positive note.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise specific reason if not approve"}`;

  const verifierContext = post.verifier_result && typeof post.verifier_result === 'object'
    ? `\nUpstream verifier verdict: ${post.verifier_result.verdict || 'unknown'} — ${post.verifier_result.summary || ''}`
    : '';

  const userPrompt = isGroupPost
    ? `Review this Facebook group post:

Group: ${post.group_name || 'unknown'}
Category: ${post.category || 'general'}
Pillar: ${post.pillar || 'unspecified'}${verifierContext}

POST BODY:
${post.post_body}

FIRST COMMENT:
${post.first_comment_body || '(no first comment)'}

Apply the rules above. Bias toward APPROVE if facts are clean and voice is warm. Return JSON only.`
    : `Review this social media post:

Platform: ${post.platform}
Persona: ${post.persona || 'brand'}
Topic: ${post.topic || 'unspecified'}${verifierContext}

Caption:
${post.content}

Hashtags: ${Array.isArray(post.hashtags) ? post.hashtags.join(' ') : '(none)'}

Media: ${post.media_url ? 'attached' : 'text only'}

Apply the rules above. Bias toward APPROVE if facts are clean and voice is warm. Return JSON only.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: REVIEWER_MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      console.warn('[cron-sage-autonomous-review] API call failed:', res.status);
      return null;
    }

    const data = await res.json();
    // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
    const text = ((data?.content || [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim());
    // Balanced-brace JSON extraction for Sonnet's longer-form responses
    const start = text.indexOf('{');
    if (start === -1) {
      console.warn('[cron-sage-autonomous-review] no JSON object in response:', text.slice(0, 200));
      return null;
    }
    let depth = 0;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) {
      console.warn('[cron-sage-autonomous-review] unbalanced JSON in response:', text.slice(0, 200));
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      console.warn('[cron-sage-autonomous-review] JSON parse failed:', e.message);
      return null;
    }
    return {
      decision: String(parsed.decision || '').toLowerCase(),
      score: parseInt(parsed.score, 10) || 5,
      feedback: String(parsed.feedback || ''),
    };
  } catch (err) {
    console.warn('[cron-sage-autonomous-review] review failed:', err && err.message);
    return null;
  }
}

module.exports = withTelemetry('cron-sage-autonomous-review', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Load posts pending review
  const { data: pendingRows, ok: loadOk } = await supabaseFetch(
    `/rest/v1/sage_inbox?status=eq.pending_sage_review&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load sage_inbox' });
  }

  const rows = Array.isArray(pendingRows) ? pendingRows : [];
  console.log('[cron-sage-autonomous-review] reviewing', rows.length, 'posts');

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, reviewed: 0 });
  }

  let approved = 0;
  let sendBack = 0;
  let rejected = 0;
  const errors = [];

  for (const inboxRow of rows) {
    const postId = inboxRow.post_id;
    if (!postId) continue;

    // Load the actual post — try social_posts first, then group_posts
    const { data: postData, ok: postLoadOk } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`
    );

    let post;
    let postTable = 'social_posts';

    if (postLoadOk && Array.isArray(postData) && postData.length > 0) {
      post = postData[0];
    } else {
      // Try group_posts
      const { data: groupData, ok: groupLoadOk } = await supabaseFetch(
        `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}`
      );
      if (groupLoadOk && Array.isArray(groupData) && groupData.length > 0) {
        post = groupData[0];
        postTable = 'group_posts';
      } else {
        console.error('[cron-sage-autonomous-review] post not found in either table:', postId);
        errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'post not found' });
        continue;
      }
    }

    // Run Cole's review
    const rawReview = await coleReview(post);
    if (!rawReview) {
      console.error('[cron-sage-autonomous-review] review call failed for', postId);
      errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'review call failed' });
      continue;
    }

    // 2026-07-07 recalibration: sanitize the LLM verdict against demoted-rule
    // objections. If model sent back a post but every objection is a demoted
    // rule, override to approve.
    const isGroupPost = !!post.post_body && post.first_comment_body !== undefined;
    const review = sanitizeReview(rawReview, isGroupPost);
    if (review._sanitized) {
      console.log(
        '[cron-sage-autonomous-review] sanitizer overrode',
        rawReview.decision, '→ approve for', postId,
        '— demoted objections only'
      );
    }

    const decision = review.decision; // 'approve', 'send_back', 'reject'
    const now = new Date().toISOString();

    if (decision === 'approve') {
      // Approve: update sage_inbox and the relevant post table
      await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'approved',
          sage_verdict: 'approve',
          sage_feedback: review.feedback,
          sage_reviewed_at: now,
        }),
      });

      await supabaseFetch(`/rest/v1/${postTable}?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'approved',
          sage_reviewed_at: now,
        }),
      });

      approved++;
      console.log('[cron-sage-autonomous-review] approved:', postId, `(${postTable})`, '— score:', review.score);
    } else if (decision === 'send_back') {
      // Soft reject: mark as regenerating, write feedback to social_posts, increment attempts
      const attempts = (inboxRow.regeneration_attempts || 0) + 1;
      
      await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'regenerating',
          sage_verdict: 'send_back',
          sage_feedback: review.feedback,
          regeneration_attempts: attempts,
          sage_reviewed_at: now,
        }),
      });

      // Write feedback to social_posts.review_feedback for Sage's regeneration loop
      await supabaseFetch(`/rest/v1/${postTable}?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          review_feedback: review.feedback,
        }),
      });

      sendBack++;
      console.log('[cron-sage-autonomous-review] sent back for regeneration:', postId, `(${postTable})`, '— attempt', attempts, '— feedback:', review.feedback);
    } else {
      // Hard reject: drop it
      await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          sage_verdict: 'reject',
          sage_feedback: review.feedback,
          sage_reviewed_at: now,
        }),
      });

      await supabaseFetch(`/rest/v1/${postTable}?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          rejection_reason: 'Cole hard reject: ' + review.feedback,
        }),
      });

      rejected++;
      console.log('[cron-sage-autonomous-review] rejected:', postId, `(${postTable})`, '— reason:', review.feedback);
    }
  }

  return res.status(200).json({
    ok: true,
    reviewed: rows.length,
    approved,
    sendBack,
    rejected,
    errors: errors.length > 0 ? errors : undefined,
  });
});
