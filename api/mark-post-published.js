// POST /api/mark-post-published
// Marks a post as published (for n8n workflow)
// Auth: Authorization: Bearer ${CRON_SECRET}
// Body: { id: "uuid", zernio_post_id: "string" }

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
  // Auth check
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { id, zernio_post_id } = req.body || {};

  if (!id) {
    return res.status(400).json({ ok: false, error: 'Missing required field: id' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const now = new Date().toISOString();
    // UNVERIFIED-SURVIVAL FLAG (Atlas 2026-09-25): this endpoint marks a row
    // 'posted' on the n8n caller's say-so alone — unlike
    // api/cron-publish-approved.js's own Zernio call, it never confirms
    // delivery itself. Before this fix it also unconditionally cleared
    // error_message to null, so a row published here with no zernio_post_id
    // looked byte-for-byte identical to a normal, verified post — no
    // zernio_post_id, no zernio_verified_at, no error_message. That is
    // exactly the signature found on 6 real rows 2026-09-25 whose posted_at
    // landed 4-5 DAYS before their own scheduled_for; this endpoint is the
    // only write path in the codebase that can produce it, since it is the
    // only one that doesn't check scheduled_for at all. Mirroring the
    // "unverified survival" pattern cron-publish-approved.js already uses
    // (search that file for FIX #3, 2026-06-11) rather than inventing a new
    // one — same meaning, same place a human would look for it.
    const unverified = !zernio_post_id;
    const patchBody = {
      status: 'posted',
      posted_at: now,
      publishing_started_at: null,
      error_message: unverified
        ? 'Marked posted via /api/mark-post-published with no zernio_post_id — unverified survival'
        : null,
    };

    if (zernio_post_id) {
      patchBody.zernio_post_id = zernio_post_id;
    }

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
        posted_at: updated.posted_at,
      },
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
}
