'use strict';

// api/cron-comment-monitor.js
// =============================================================================
// Comment engagement automation.
// Fires every 15 min. Scrapes recent comments on Dossie's TikTok/IG/FB posts
// (Zernio surfaces them via GET /posts/{id}/comments — see zernio API docs).
// For every fresh comment we haven't handled:
//   - Insert an audit row into social_comment_replies (draft, is_spam=false).
//   - Enqueue a 'comment_reply_gen' task to the Claude Code CLI worker so
//     the reply text is drafted on Heath's Max plan (free at the margin).
//   - The worker updates the row with reply_text + reply_status='draft' or
//     'skipped_spam' if it detects obvious spam.
//   - A separate lightweight publisher (existing cron-publish-approved knows
//     nothing about comments — a small future publisher will post the drafts).
//
// Constraint: only fetch posts posted in the last 4 hours (algo lift window).
//
// Schedule: "*/15 * * * *".
// Owner: Atlas 2026-07-08.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;

const ZERNIO_BASE = 'https://zernio.com/api/v1';
const RECENT_HOURS = 4;
const MAX_POSTS_PER_TICK = 15;
const MAX_COMMENTS_PER_POST = 20;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function zernioFetch(path) {
  try {
    const res = await fetch(`${ZERNIO_BASE}${path}`, {
      headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` },
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

async function enqueueClaudeCodeTask(host, body) {
  const res = await fetch(`${host}/api/claude-code-enqueue`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!ZERNIO_API_KEY) {
    return res.status(503).json({ ok: false, error: 'zernio_env_missing' });
  }

  const sinceIso = new Date(Date.now() - RECENT_HOURS * 3600 * 1000).toISOString();

  // Load recently posted Dossie posts (only ones with a zernio_post_id).
  const postsR = await sb(
    `social_posts?select=id,platform,persona,hook,content,zernio_post_id,posted_at&status=eq.posted&posted_at=gte.${sinceIso}&zernio_post_id=not.is.null&order=posted_at.desc&limit=${MAX_POSTS_PER_TICK}`
  );
  if (!postsR.ok) {
    return res.status(500).json({ ok: false, error: `posts_query_failed:${postsR.status}` });
  }
  const posts = Array.isArray(postsR.data) ? postsR.data : [];

  if (posts.length === 0) {
    return res.status(200).json({ ok: true, posts_scanned: 0, comments_new: 0 });
  }

  const host = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  let commentsScanned = 0;
  let commentsNew = 0;
  let commentsEnqueued = 0;
  const errors = [];

  for (const post of posts) {
    const zRes = await zernioFetch(`/posts/${post.zernio_post_id}/comments?limit=${MAX_COMMENTS_PER_POST}`);
    if (!zRes.ok) {
      // Non-fatal — some platforms don't expose comments to Zernio yet.
      errors.push({ post_id: post.id, zernio_status: zRes.status, err: zRes.error });
      continue;
    }
    // Zernio comment shape varies by platform; try common shapes.
    const rawList = Array.isArray(zRes.data?.comments)
      ? zRes.data.comments
      : Array.isArray(zRes.data?.data)
        ? zRes.data.data
        : Array.isArray(zRes.data)
          ? zRes.data
          : [];
    commentsScanned += rawList.length;

    for (const c of rawList) {
      const externalId = String(c.id || c.comment_id || c.external_id || '');
      const commentText = String(c.text || c.body || c.content || '').trim();
      const handle = String(c.author || c.username || c.handle || c.user?.username || '');
      if (!externalId || !commentText) continue;

      // Skip if already tracked.
      const existR = await sb(
        `social_comment_replies?select=id&platform=eq.${encodeURIComponent(post.platform)}&comment_external_id=eq.${encodeURIComponent(externalId)}&limit=1`
      );
      if (existR.ok && Array.isArray(existR.data) && existR.data.length > 0) continue;

      // Insert audit row.
      const ins = await sb('social_comment_replies', {
        method: 'POST',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          social_post_id: post.id,
          platform: post.platform,
          external_post_id: post.zernio_post_id,
          comment_external_id: externalId,
          commenter_handle: handle,
          original_comment: commentText.slice(0, 2000),
          reply_status: 'draft',
        }),
      });
      if (!ins.ok || !Array.isArray(ins.data) || !ins.data[0]) {
        errors.push({ post_id: post.id, external: externalId, err: 'insert_failed', status: ins.status });
        continue;
      }
      commentsNew++;

      // Enqueue draft.
      const enq = await enqueueClaudeCodeTask(host, {
        task_type: 'comment_reply_gen',
        agent_name: 'sage',
        priority: 4,
        title: `Comment reply ${post.platform} ${externalId}`,
        description: 'Draft a warm 1-2 sentence reply to an inbound comment; skip if spam.',
        idempotency_key: `comment_reply_gen:${post.platform}:${externalId}`,
        payload: {
          reply_row_id: ins.data[0].id,
          platform: post.platform,
          post_persona: post.persona,
          post_hook: post.hook,
          post_content: post.content,
          commenter_handle: handle,
          original_comment: commentText,
        },
      });
      if (enq.ok) commentsEnqueued++;
    }
  }

  return res.status(200).json({
    ok: true,
    posts_scanned: posts.length,
    comments_scanned: commentsScanned,
    comments_new: commentsNew,
    comments_enqueued: commentsEnqueued,
    error_count: errors.length,
    errors: errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-comment-monitor', handler);
