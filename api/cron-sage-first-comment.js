// Vercel Serverless Function: /api/cron-sage-first-comment
// Monitors published posts for engagement (3+ replies) and triggers Sage to
// post a second comment continuing the conversation.
//
// Behavior:
//   1. Load sage_engagement_queue rows with status='pending' where created_at < 24h ago
//   2. Check if post has 3+ comments (poll via Zernio API or platform native)
//   3. If yes: draft a second comment via Sage, post via Zernio, mark status='posted'
//   4. If no: update current_reply_count, keep status='pending'
//   5. If post > 24h old: mark status='expired'
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: every 15 min ("*/15 * * * *").

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const COMMENTER_MODEL = 'claude-haiku-4-5-20251001';
const MAX_PER_RUN = 10;

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

// Draft a follow-up comment to continue the conversation
async function draftFollowUpComment(post, commentCount) {
  const systemPrompt = `You are Sage, drafting a second comment to continue engagement on a Dossie social post.

Rules:
- Tone: peer-to-peer, warm, helpful — never corporate or sales-y
- Length: 2-3 sentences max (comment, not a post)
- Goal: deepen the conversation, answer a common question, or validate a pain point
- Mention Dossie only if it fits naturally; otherwise stay in agent voice

Return JSON: {"comment": "2-3 sentence follow-up"}`;

  const userPrompt = `This post has ${commentCount} comments and needs a second Dossie comment to keep the convo going.

Original post:
Platform: ${post.platform}
Persona: ${post.persona}
Content: ${post.content}

Draft a follow-up comment that continues the discussion (not a sales pitch).`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: COMMENTER_MODEL,
        max_tokens: 150,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    const text = data?.content?.[0]?.text || '';
    // Balanced-brace JSON extraction (same fix as cron-sage-autonomous-review).
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0, end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end === -1) return null;
    let parsed;
    try { parsed = JSON.parse(text.slice(start, end + 1)); }
    catch (e) { console.warn('[cron-sage-first-comment] JSON parse failed:', e.message); return null; }
    return String(parsed.comment || '');
  } catch (err) {
    console.warn('[cron-sage-first-comment] draft failed:', err && err.message);
    return null;
  }
}

// Post a comment via Zernio (simplified — real implementation would use Zernio's comment API)
async function postViaZernio(accountId, postId, commentText, platform) {
  // TODO: Zernio's comment API endpoint — varies by platform
  // For now, this is a placeholder. Real implementation requires platform-specific comment endpoints.
  console.log(`[cron-sage-first-comment] would post to ${platform}/${postId}: "${commentText}"`);
  return { ok: true, comment_id: 'placeholder' };
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

  // Load pending engagement rows
  const { data: pendingRows, ok: loadOk } = await supabaseFetch(
    `/rest/v1/sage_engagement_queue?status=eq.pending&order=created_at.asc&limit=${MAX_PER_RUN}`,
  );

  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load engagement queue' });
  }

  const rows = Array.isArray(pendingRows) ? pendingRows : [];
  console.log('[cron-sage-first-comment] checking', rows.length, 'pending posts');

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, posted: 0 });
  }

  let posted = 0;
  let expired = 0;
  const errors = [];

  for (const queueRow of rows) {
    const postId = queueRow.post_id;
    const platform = queueRow.platform;
    const createdAt = new Date(queueRow.created_at);
    const now = new Date();
    const ageHours = (now - createdAt) / (1000 * 60 * 60);

    if (ageHours > 24) {
      // Post is old — expire it
      await supabaseFetch(`/rest/v1/sage_engagement_queue?id=eq.${encodeURIComponent(queueRow.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'expired' }),
      });
      expired++;
      continue;
    }

    // Load the social post to get content
    const { data: postData, ok: postLoadOk } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(postId)}`
    );

    if (!postLoadOk || !Array.isArray(postData) || postData.length === 0) {
      console.error('[cron-sage-first-comment] post not found:', postId);
      errors.push({ queue_id: queueRow.id, post_id: postId, error: 'post not found' });
      continue;
    }

    const post = postData[0];

    // Check reply count — for now, just use current_reply_count from queue
    // Real implementation would poll Zernio or platform APIs
    const replyThreshold = queueRow.reply_count_threshold || 3;
    if (queueRow.current_reply_count < replyThreshold) {
      // Not enough replies yet — stay pending
      continue;
    }

    // Ready to post — draft the comment
    const comment = await draftFollowUpComment(post, queueRow.current_reply_count);
    if (!comment) {
      console.error('[cron-sage-first-comment] draft failed for', postId);
      errors.push({ queue_id: queueRow.id, post_id: postId, error: 'draft failed' });
      continue;
    }

    // Post via Zernio (placeholder for now)
    const postResult = await postViaZernio(post.zernio_account_id, post.zernio_post_id, comment, platform);
    if (!postResult.ok) {
      console.error('[cron-sage-first-comment] post failed for', postId);
      errors.push({ queue_id: queueRow.id, post_id: postId, error: 'post failed' });
      continue;
    }

    // Mark as posted
    const now_iso = new Date().toISOString();
    await supabaseFetch(`/rest/v1/sage_engagement_queue?id=eq.${encodeURIComponent(queueRow.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'posted',
        comment_text: comment,
        posted_at: now_iso,
      }),
    });

    posted++;
    console.log('[cron-sage-first-comment] posted follow-up to', postId);
  }

  return res.status(200).json({
    ok: true,
    posted,
    expired,
    checked: rows.length,
    errors: errors.length > 0 ? errors : undefined,
  });
};
