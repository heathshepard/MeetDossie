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

// Verified facts — these are LOCKED in CLAUDE.md and persistent memory.
// Anything in this block must NEVER be flagged as fabricated.
const VERIFIED_FACTS = `
## VERIFIED FACTS — DO NOT FLAG THESE AS FABRICATED

These are locked, sourced from CLAUDE.md / persistent memory / live product:

1. **Founding pricing: $29/month, locked while subscription stays active, 50 spots total.** This is in CLAUDE.md Section 5. It is current. Posts using "$29/month founding pricing" or "locked while your subscription stays active" are accurate.
2. **Founder pain story is REAL.** Heath was on a trip when his TC quit mid-deal. Active escrows, ~7-8 hour time difference, no clean handoff. He had paid ~$400/file for TC services and still woke at 4:30am running mental checklists. Dossie was built out of that experience. Any post citing the TC-quit, 4:30am wake-up, or ~$400/file is verified — NOT fabricated.
3. **TC cost reference: $300-400/file** is the documented going rate. Posts in that range are verified.
4. **Texas TREC deadlines** (option period from executed date, earnest money typically within 3 days of execution to title company, title commitment window, financing contingency) are all real TREC rules — not fabricated. The verifier already pre-validated TREC facts before this review runs.
5. **Shipped Dossie features** that posts can claim:
   - Contract scan + auto-deadline calc with paragraph citations
   - Pipeline view with per-deal deadline badges
   - Morning brief (voice, Luna narration)
   - Email draft queue (review-and-send, not auto-send)
   - Closing milestone cards
   - Talk-to-Dossie voice conversation
6. **Valid persona tags**: 'brenda', 'patricia', 'victor' (agent personas), AND 'dossie' (brand voice). 'dossie' is a legitimate persona — DO NOT reject for "persona mismatch" just because the value is 'dossie'.
7. **All posts in this queue have ALREADY passed the deterministic content verifier** (verifier_result.verdict='approve' means TREC facts, shipped features, and pricing were validated against ground truth). Your job is brand fit and voice — NOT re-checking facts.

If your only objection is one of the above 7 items, the correct decision is APPROVE.
`.trim();

async function coleReview(post) {
  const isGroupPost = !!post.post_body && post.first_comment_body !== undefined;

  const systemPrompt = isGroupPost
    ? `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You're reviewing this Facebook group post for brand fit and editorial polish before it ships to social media.

Your role: warm but rigorous. You know Dossie inside-out, you trust verified facts (they've already been checked by a deterministic verifier), and you default to APPROVE when the voice is warm and the strategy is sound.

${VERIFIED_FACTS}

## Facebook Group Post Rules (THESE ARE GROUP-POST-SPECIFIC)

1. **Brand Voice Fit**: Tone is warm, casual, genuine, first-person. Never corporate. Reads like an agent talking to other agents in a private group.
2. **No Dossie in Main Body**: Post body must NEVER mention Dossie. Zero mentions of the product in the main post.
3. **Dossie in First Comment**: If post has a first comment, it MUST contain the literal word "Dossie" and name ONE specific shipped capability.
4. **No Fabricated Specifics**: Per the VERIFIED FACTS block above — anything listed there is real. Only flag genuinely invented details (made-up customer names, made-up MRR numbers, invented features).
5. **Hook Quality**: Opening must be punchy and agent-relatable.
6. **Pillar Alignment**: Touches one of Cost, Control, Visibility, Speed, Coverage.

## Your Decision Framework (BIAS TOWARD APPROVE)

- **APPROVE** (score 7-10): Brand fit acceptable. Ship it. This should be your default — the deterministic verifier already passed these posts on facts. Your job is voice, not fact-checking.
- **SEND_BACK** (score 4-6): ONE specific fixable issue (e.g., voice drifts corporate, weak hook, body mentions Dossie). Name the single fix for Sage to regenerate.
- **REJECT** (score 1-3): Hard violation — wrong audience, harmful claim, off-strategy brand violation. Use sparingly.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise reason if not approve"}`
    : `You are Cole, Chief of Staff at Shepard Ventures (which owns Dossie). You review draft social posts for brand voice, editorial fit, and strategy alignment.

Your role: warm but rigorous editor. You know Dossie's voice, you trust verified facts (already fact-checked upstream), and you default to APPROVE when facts are clean and brand voice is strong.

${VERIFIED_FACTS}

## Review Rules (MAIN SOCIAL POSTS — Facebook page, Twitter, LinkedIn, Instagram)

1. **Brand Voice Fit**: Warm, capable, agent-focused. Never corporate buzzwords. Solving pain, not pure selling.
2. **Persona Consistency**: 'dossie' is brand-voice persona and IS VALID. 'brenda'/'patricia'/'victor' are agent personas. Tone should match the tagged persona.
3. **No Fabricated Specifics**: See VERIFIED FACTS block. Only flag genuinely invented numbers (made-up customer counts, fake testimonials, invented features). Pricing ($29/mo), founder story, TREC rules, and shipped features are all verified.
4. **Pillar Alignment**: Touches Cost, Control, Visibility, Speed, or Coverage.
5. **Hook Quality**: First 1-2 sentences are punchy and agent-relatable.
6. **Dossie Mention** (MAIN POSTS — NOT GROUP POSTS): Main social posts (Facebook page, Twitter, LinkedIn, Instagram) ARE ALLOWED and EXPECTED to mention Dossie in the caption. The "Dossie in first comment only" rule is FACEBOOK-GROUP-SPECIFIC and does not apply here. Captions that name Dossie and a specific capability are correct.

## Your Decision Framework (BIAS TOWARD APPROVE — verifier already validated facts)

- **APPROVE** (score 7-10): Brand fit acceptable. Ship it. This should be your default. The deterministic verifier already passed these posts on facts.
- **SEND_BACK** (score 4-6): ONE specific fixable issue (e.g., hook too weak, tone drifts corporate mid-post). Name the single fix.
- **REJECT** (score 1-3): Hard violation — invented customer testimonial, unshipped feature claim, harmful content, completely off-audience. Use sparingly.

Return JSON ONLY: {"decision": "approve|send_back|reject", "score": N, "feedback": "concise reason if not approve"}`;

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
    const text = data?.content?.[0]?.text || '';
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
