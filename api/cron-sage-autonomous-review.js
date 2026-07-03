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

## Decision Framework — DEFAULT TO APPROVE

Send back ONLY for these four conditions (per locked spec):
(a) Obvious factual fabrication BEYOND the VERIFIED FACTS whitelist (e.g., invented customer name like "Sarah from Plano", fake MRR figure, unshipped feature, made-up testimonial).
(b) Wrong persona for the platform's audience (rare).
(c) PII or sensitive data exposure.
(d) FB-group rule violation (DOES NOT APPLY HERE — this is a main social post, Dossie mention in caption is FINE).

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
- **SEND_BACK** (score 4-6): ONE specific fixable issue from (a)-(c). ≤25 words.
- **REJECT** (score 1-3): Hard violation — invented testimonial, harmful content, completely off-audience. Rare.

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
    const review = await coleReview(post);
    if (!review) {
      console.error('[cron-sage-autonomous-review] review call failed for', postId);
      errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'review call failed' });
      continue;
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
