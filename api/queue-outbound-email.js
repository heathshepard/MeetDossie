// Vercel Serverless Function: /api/queue-outbound-email
//
// Cole-facing helper: INSERT a row into public.outbound_email_queue from a
// caller that has CRON_SECRET but does NOT have the Supabase service-role
// key on disk. Cron-send-outbound-emails will pick it up within ~60s.
//
// Auth:    Authorization: Bearer ${CRON_SECRET}
// Method:  POST
// Body:    {
//            "to":         "recipient@example.com",        // required
//            "subject":    "Subject line",                  // required
//            "body_text":  "Plain text body with \\n newlines", // required
//            "body_html":  "<p>Optional HTML.</p>",         // optional
//            "reply_to":   "heath@meetdossie.com",          // optional
//            "from_email": "heath@meetdossie.com",          // optional, defaults to heath@meetdossie.com
//            "metadata":   { "ticket": "abc", "agent": "cole" } // optional, jsonb audit
//          }
// Returns: { ok: true, id: "<uuid>", queued_at: "<iso>" }
//
// Notes:
//   - We deliberately do NOT send the email here. We only enqueue. The cron
//     does the actual send so we get retries, idempotency, and rate limits
//     for free.
//   - Caller does not need the Supabase service-role key. Only CRON_SECRET.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const isValidEmail = (e) =>
  typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'body_required' });
  }

  const {
    to,
    subject,
    body_text,
    body_html,
    reply_to,
    from_email,
    metadata,
  } = body;

  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'to_invalid' });
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ ok: false, error: 'subject_required' });
  }
  if (typeof body_text !== 'string' || !body_text.trim()) {
    return res.status(400).json({ ok: false, error: 'body_text_required' });
  }
  if (reply_to != null && !isValidEmail(reply_to)) {
    return res.status(400).json({ ok: false, error: 'reply_to_invalid' });
  }
  if (from_email != null && !isValidEmail(from_email)) {
    return res.status(400).json({ ok: false, error: 'from_email_invalid' });
  }

  const row = {
    to_email: String(to).trim(),
    subject: String(subject).trim(),
    body_text: String(body_text),
    status: 'pending',
  };
  if (body_html && typeof body_html === 'string') row.body_html = body_html;
  if (reply_to) row.reply_to = String(reply_to).trim();
  if (from_email) row.from_email = String(from_email).trim();
  if (metadata && typeof metadata === 'object') row.metadata = metadata;

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/outbound_email_queue`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      return res.status(502).json({
        ok: false,
        error: 'supabase_insert_failed',
        status: r.status,
        detail: text.slice(0, 500),
      });
    }
    const rows = await r.json().catch(() => []);
    const created = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
    return res.status(200).json({
      ok: true,
      id: created && created.id,
      queued_at: created && created.created_at,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: 'fetch_failed',
      message: String(err && err.message),
    });
  }
}

module.exports = handler;
module.exports.default = handler;
