// Vercel Serverless Function: /api/cron-sage-autonomous-review
// Sage's autonomous review pass over pending_sage_review posts.
//
// For each row in sage_inbox with status='pending_sage_review':
//   1. Apply Sage's algorithm rules (brand fit, persona consistency, pillar alignment)
//   2. Approve → update sage_inbox.status='approved', social_posts.status='approved'
//   3. Reject soft (fixable) → kick to regenerator, mark status='regenerating'
//   4. Reject hard (off-strategy) → mark status='rejected', drop
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: every 30 min after cron-send-to-sage ("*/30 * * * *").

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const REVIEWER_MODEL = 'claude-haiku-4-5-20251001';
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

// Sage's review rules — simplified for speed (Haiku model)
async function sageReview(post) {
  const isGroupPost = !!post.post_body && !!post.first_comment_body !== undefined;

  const systemPrompt = isGroupPost
    ? `You are Sage, Head of Social Media at Dossie. You review Facebook group posts against brand strategy rules.

## Facebook Group Post Rules

1. **Brand Voice Fit**: Is the tone warm, casual, genuine, first-person? Never corporate.
2. **No Dossie in Main Body**: Post body must NEVER mention Dossie. Zero mentions.
3. **Dossie in First Comment**: If post has a first comment, it MUST contain the literal word "Dossie" and name ONE specific capability (deadline calc, morning brief, document tracking, etc).
4. **No Fabricated Specifics**: Zero invented details, timestamps, member numbers. Only verified claims.
5. **Hook Quality**: Opening must be punchy and agent-relatable. Real problem or genuine question.
6. **Pillar Alignment**: Does it touch one of: Cost, Control, Visibility, Speed?

## Verdict Scale

- **APPROVE** (score 8-10): Ship it now.
- **REGENERATE** (score 4-7): Fixable issue — re-run generation with feedback.
- **REJECT** (score 1-3): Off-strategy or hard blocker — drop it.

Return JSON: {"verdict": "approve|regenerate|reject", "score": N, "feedback": "reason"}`
    : `You are Sage, Head of Social Media at Dossie. You review draft social posts against brand strategy rules.

## Review Rules

1. **Brand Voice Fit**: Is the tone warm, capable, never corporate? Is it agent-focused (solving pain, not selling)?
2. **Persona Consistency**: If persona-tagged (Brenda/Patricia/Victor), is the voice authentic and consistent with past posts?
3. **No Fabricated Specifics**: Zero invented details, timestamps, member numbers, or facts. Only verified claims.
4. **Pillar Alignment**: Does it touch one of: Cost, Control, Visibility, Speed, or Coverage (new)?
5. **Dossie Mention Rule**: If the post is about Dossie features, it MUST mention Dossie in the first comment, not buried in the caption.
6. **Hook Quality**: Opening hook (first 1-2 sentences) must be punchy and agent-relatable.

## Verdict Scale

- **APPROVE** (score 8-10): Ship it now.
- **REGENERATE** (score 4-7): Fixable issue — re-run generation with feedback.
- **REJECT** (score 1-3): Off-strategy, wrong audience, or hard blocker — drop it.

Return JSON: {"verdict": "approve|regenerate|reject", "score": N, "feedback": "reason"}`;

  const userPrompt = isGroupPost
    ? `Review this Facebook group post:

Group: ${post.group_name || 'unknown'}
Category: ${post.category || 'general'}
Pillar: ${post.pillar || 'unspecified'}

POST BODY:
${post.post_body}

FIRST COMMENT:
${post.first_comment_body || '(no first comment)'}

Apply the rules above. Return JSON only.`
    : `Review this social media post:

Platform: ${post.platform}
Persona: ${post.persona || 'brand'}
Topic: ${post.topic || 'unspecified'}

Caption:
${post.content}

Hashtags: ${Array.isArray(post.hashtags) ? post.hashtags.join(' ') : '(none)'}

Media: ${post.media_url ? 'attached' : 'text only'}

Apply the rules above. Return JSON only.`;

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
    // Balanced-brace JSON extraction. The prior regex `/\{[^}]+\}/s` failed on
    // any response containing nested braces or newlines inside string values,
    // which Haiku returns for longer reviews — every long-form Facebook post
    // came back as "review call failed" because of this single line.
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
      verdict: String(parsed.verdict || '').toLowerCase(),
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

  // Load posts pending Sage review
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
  let regenerate = 0;
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

    // Run Sage's review
    const review = await sageReview(post);
    if (!review) {
      console.error('[cron-sage-autonomous-review] review call failed for', postId);
      errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'review call failed' });
      continue;
    }

    const verdict = review.verdict; // 'approve', 'regenerate', 'reject'
    const now = new Date().toISOString();

    if (verdict === 'approve') {
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
    } else if (verdict === 'regenerate') {
      // Soft reject: mark as regenerating, increment attempts counter
      const attempts = (inboxRow.regeneration_attempts || 0) + 1;
      await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'regenerating',
          sage_verdict: 'regenerate',
          sage_feedback: review.feedback,
          regeneration_attempts: attempts,
          sage_reviewed_at: now,
        }),
      });

      regenerate++;
      console.log('[cron-sage-autonomous-review] marked for regeneration:', postId, `(${postTable})`, '— attempt', attempts, '— feedback:', review.feedback);
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
          rejection_reason: 'Sage hard reject: ' + review.feedback,
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
    regenerate,
    rejected,
    errors: errors.length > 0 ? errors : undefined,
  });
});
