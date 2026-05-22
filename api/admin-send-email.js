// Vercel Serverless Function: /api/admin-send-email
//
// Trusted-caller endpoint for sending an arbitrary email "from Heath" via
// Resend. Use cases: customer outreach, Hadley/Cole orchestration, scheduled
// routines that need to email a recipient who isn't Heath.
//
// POST /api/admin-send-email
// Headers:
//   Authorization: Bearer ${CRON_SECRET}
//   Content-Type: application/json
// Body:
//   { "to": "...", "subject": "...", "body": "plain text with \\n line breaks", "replyTo"?: "..." }
//
// Sends as "Heath at Dossie <heath@meetdossie.com>" by default. The body is
// HTML-escaped, then newlines become <br>. Mirrors api/send-email.js but
// without the user-JWT requirement — CRON_SECRET is enough because this is
// only callable by trusted internal automation.

const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderHtml(bodyText) {
  const escaped = escapeHtml(bodyText).replace(/\n/g, '<br>');
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px 20px;color:#1C2B3A;line-height:1.7;">${escaped}</div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'resend_not_configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ ok: false, error: 'body_required' });
  }

  const { to, subject, body: text, replyTo } = body;
  if (!isValidEmail(to)) {
    return res.status(400).json({ ok: false, error: 'to_invalid' });
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return res.status(400).json({ ok: false, error: 'subject_required' });
  }
  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ ok: false, error: 'body_required' });
  }

  const payload = {
    from: 'Heath at Dossie <heath@meetdossie.com>',
    to: [String(to).trim()],
    subject: String(subject).trim(),
    html: renderHtml(text),
    reply_to: isValidEmail(replyTo) ? String(replyTo).trim() : 'heath@meetdossie.com',
  };

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(502).json({ ok: false, error: 'resend_failed', status: r.status, data });
    }
    return res.status(200).json({ ok: true, id: data?.id, to: payload.to[0] });
  } catch (err) {
    return res.status(502).json({ ok: false, error: 'fetch_failed', message: String(err && err.message) });
  }
}
