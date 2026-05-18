// POST /api/mark-post-failed
// Marks a post as failed (for n8n workflow)
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { id: "uuid", error_message: "string" }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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

export default async function handler(req, res) {
  // Log to Supabase table BEFORE any auth check to catch all callers
  try {
    const authHeader = req.headers.authorization || req.headers.Authorization || '';
    const authPrefix = authHeader ? authHeader.substring(0, 20) + '...' : 'none';

    await supabaseFetch('/rest/v1/mark_post_failed_logs', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        post_id: req.body?.id || null,
        error_message: req.body?.error_message || null,
        user_agent: req.headers['user-agent'] || null,
        ip_address: req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || null,
        auth_header_prefix: authPrefix,
      }),
    });
  } catch (logError) {
    console.error('[MARK-FAILED] Failed to log to Supabase:', logError.message);
  }

  // Log all incoming requests before auth check
  console.log('[MARK-FAILED] Incoming request:', {
    timestamp: new Date().toISOString(),
    userAgent: req.headers['user-agent'],
    ip: req.headers['x-forwarded-for'],
    id: req.body?.id,
    error_message: req.body?.error_message,
    authHeader: req.headers.authorization?.substring(0, 20) + '...'
  });

  // Auth check
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { id, error_message } = req.body || {};

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing required field: id' });
  }

  // CRITICAL: Block any attempt to mark a post failed without a valid error message.
  // This prevents rogue processes (like the n8n workflow) from marking posts failed
  // with null/empty error_message before cron has a chance to publish them.
  if (!error_message || typeof error_message !== 'string' || error_message.trim() === '') {
    console.log('[MARK-FAILED] BLOCKED: Attempt to mark post failed with null/empty error_message');
    return res.status(400).json({
      ok: false,
      error: 'error_message is required and must be a non-empty string',
      blocked: true,
      reason: 'Preventing rogue process from marking posts failed without valid error'
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    // Safety net: if error_message contains "published successfully", mark as published instead
    const errorMsg = typeof error_message === 'string' ? error_message : JSON.stringify(error_message) || 'Unknown error';
    if (errorMsg.toLowerCase().includes('published successfully')) {
      const now = new Date().toISOString();
      const patchBody = {
        status: 'posted',
        posted_at: now,
        publishing_started_at: null,
        error_message: null,
      };

      const { ok: patchOk, data: patched } = await supabaseFetch(
        `/rest/v1/social_posts?id=eq.${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=representation' },
          body: JSON.stringify(patchBody),
        }
      );

      if (!patchOk) {
        return res.status(502).json({ ok: false, error: 'Failed to update post' });
      }

      const updated = Array.isArray(patched) && patched.length > 0 ? patched[0] : null;

      if (!updated) {
        return res.status(404).json({ ok: false, error: 'Post not found' });
      }

      return res.status(200).json({
        ok: true,
        redirected: true,
        reason: 'Error message contained "published successfully" - marked as posted instead',
        post: {
          id: updated.id,
          post_id: updated.post_id,
          status: updated.status,
          posted_at: updated.posted_at,
        },
      });
    }

    // Normal failure path
    const patchBody = {
      status: 'failed',
      publishing_started_at: null,
      error_message: errorMsg,
    };

    const { ok: patchOk, data: patched } = await supabaseFetch(
      `/rest/v1/social_posts?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify(patchBody),
      }
    );

    if (!patchOk) {
      return res.status(502).json({ ok: false, error: 'Failed to update post' });
    }

    const updated = Array.isArray(patched) && patched.length > 0 ? patched[0] : null;

    if (!updated) {
      return res.status(404).json({ ok: false, error: 'Post not found' });
    }

    return res.status(200).json({
      ok: true,
      post: {
        id: updated.id,
        post_id: updated.post_id,
        status: updated.status,
        error_message: updated.error_message,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
