// Vercel Serverless Function: /api/cron-sage-regenerate
// Re-generate content for posts marked status='regenerating' in sage_inbox.
//
// Behavior:
//   1. Load sage_inbox rows where status='regenerating' and regeneration_attempts < 3
//   2. Load the original post from social_posts
//   3. Call Claude Sonnet with the original generation prompt + Sage's feedback
//   4. Update post.content + hashtags with regenerated copy
//   5. Mark sage_inbox.status back to 'pending_sage_review' to re-run the review
//   6. If attempts >= 3, hard-reject (status='rejected')
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: every 30 min, after cron-sage-autonomous-review ("*/30 * * * *").

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const GENERATOR_MODEL = 'claude-sonnet-4-6';
const MAX_PER_RUN = 6; // conservative: regeneration is slower than initial generation

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

async function regenerateContent(post, feedback) {
  // Re-generate the post with Sage's feedback incorporated.
  // This is a simplified version — full prompt would come from cron-generate-posts.
  const systemPrompt = `You are Dossie's content generator. You create social media posts for Texas real estate agents.

Regenerate this post with the following feedback in mind:
${feedback}

Match the original tone, persona, and platform. Return JSON only: {"content": "revised caption", "hashtags": ["tag1", "tag2"]}`;

  const userPrompt = `Original post for ${post.platform}:

Persona: ${post.persona}
Topic: ${post.topic}
Original: ${post.content}

Please regenerate with the feedback considered.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: GENERATOR_MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) {
      console.warn('[cron-sage-regenerate] API failed:', res.status);
      return null;
    }

    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    const match = text.match(/\{[^}]+\}/s);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    return {
      content: String(parsed.content || ''),
      hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags : [],
    };
  } catch (err) {
    console.warn('[cron-sage-regenerate] regeneration failed:', err && err.message);
    return null;
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Load posts marked for regeneration
  const { data: regeneratingRows, ok: loadOk } = await supabaseFetch(
    `/rest/v1/sage_inbox?status=eq.regenerating&regeneration_attempts=lt.3&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load regenerating rows' });
  }

  const rows = Array.isArray(regeneratingRows) ? regeneratingRows : [];
  console.log('[cron-sage-regenerate] regenerating', rows.length, 'posts');

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, regenerated: 0 });
  }

  let regenerated = 0;
  let maxedOut = 0;
  const errors = [];

  for (const inboxRow of rows) {
    const postId = inboxRow.post_id;
    const attempts = inboxRow.regeneration_attempts || 0;

    if (attempts >= 3) {
      // Hard-reject after 3 attempts
      await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          sage_feedback: `Rejected after ${attempts} regeneration attempts`,
        }),
      });

      await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'rejected',
          rejection_reason: `Failed to fix after ${attempts} regeneration attempts`,
        }),
      });

      maxedOut++;
      console.log('[cron-sage-regenerate] maxed out after', attempts, 'attempts:', postId);
      continue;
    }

    // Load the original post
    const { data: postData, ok: postLoadOk } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`
    );

    if (!postLoadOk || !Array.isArray(postData) || postData.length === 0) {
      console.error('[cron-sage-regenerate] post not found:', postId);
      errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'post not found' });
      continue;
    }

    const post = postData[0];

    // Regenerate with feedback
    const newContent = await regenerateContent(post, inboxRow.sage_feedback || '');
    if (!newContent) {
      console.error('[cron-sage-regenerate] regeneration failed for', postId);
      errors.push({ inbox_id: inboxRow.id, post_id: postId, error: 'regeneration API failed' });
      continue;
    }

    // Update post with new content
    await supabaseFetch(`/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        content: newContent.content,
        hashtags: newContent.hashtags,
        regeneration_count: (post.regeneration_count || 0) + 1,
      }),
    });

    // Mark sage_inbox back to pending_sage_review
    const now = new Date().toISOString();
    await supabaseFetch(`/rest/v1/sage_inbox?id=eq.${encodeURIComponent(inboxRow.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'pending_sage_review',
        regenerated_content: newContent.content,
        updated_at: now,
      }),
    });

    regenerated++;
    console.log('[cron-sage-regenerate] regenerated:', postId, '— attempt', attempts + 1);
  }

  return res.status(200).json({
    ok: true,
    regenerated,
    maxedOut,
    total: rows.length,
    errors: errors.length > 0 ? errors : undefined,
  });
};
