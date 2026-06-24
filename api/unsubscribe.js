// api/unsubscribe.js
// POST /api/unsubscribe
// CAN-SPAM compliant unsubscribe handler.
// Accepts: { email, reason? }
// Inserts into email_suppression_list, attempts Instantly.ai API, returns 200 { ok: true, unsubscribed_at }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY; // Optional; if absent, skip Instantly sync

async function insertSuppressionRecord(email, reason, ip) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/email_suppression_list`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email: email.toLowerCase(),
      source: 'cold_email',
      reason: reason || null,
      unsubscribed_at: new Date().toISOString(),
      ip: ip || null,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} ${text}`);
  }

  return await res.json();
}

async function syncInstantlyAI(email) {
  if (!INSTANTLY_API_KEY) {
    // Instantly integration not configured; skip silently
    return null;
  }

  try {
    const res = await fetch('https://api.instantly.ai/api/v1/block-list/add', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INSTANTLY_API_KEY}`,
      },
      body: JSON.stringify({
        email: email.toLowerCase(),
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error(`Instantly.ai blocklist sync failed: ${res.status} ${text}`);
      // Don't fail the user's unsubscribe just because Instantly failed; log and continue
      return null;
    }

    return await res.json();
  } catch (err) {
    console.error(`Instantly.ai sync error: ${err.message}`);
    return null;
  }
}

export default async function handler(req, res) {
  // Only POST allowed
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate inputs
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Service not configured' });
  }

  const { email, reason } = req.body || {};

  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'email is required' });
  }

  const trimmedEmail = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(trimmedEmail)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (reason && typeof reason !== 'string') {
    return res.status(400).json({ error: 'reason must be a string' });
  }

  const clientIp = req.headers['x-forwarded-for']
    ? req.headers['x-forwarded-for'].split(',')[0].trim()
    : req.socket?.remoteAddress || null;

  try {
    // Insert into email_suppression_list
    const record = await insertSuppressionRecord(trimmedEmail, reason || null, clientIp);

    // Fire-and-forget: sync with Instantly.ai (don't block on failure)
    syncInstantlyAI(trimmedEmail).catch((err) => {
      console.error(`Background Instantly sync failed: ${err.message}`);
    });

    return res.status(200).json({
      ok: true,
      unsubscribed_at: record[0]?.unsubscribed_at || new Date().toISOString(),
    });
  } catch (err) {
    console.error(`Unsubscribe handler error: ${err.message}`);

    // Check if it's a duplicate key error (email already in suppression list)
    if (err.message.includes('duplicate') || err.message.includes('23505')) {
      return res.status(200).json({
        ok: true,
        message: 'Email was already unsubscribed',
        unsubscribed_at: new Date().toISOString(),
      });
    }

    return res.status(500).json({ error: 'Failed to process unsubscribe' });
  }
}
