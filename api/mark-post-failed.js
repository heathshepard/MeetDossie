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
