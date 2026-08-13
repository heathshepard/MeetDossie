// api/_lib/outbound-email-send.js
//
// Shared single-row sender for public.outbound_email_queue. Extracted from
// cron-send-outbound-emails.js (2026-08-13) so /api/jarvis-approve can send
// a single Heath-approved row through the exact same Resend + suppression
// path as the batch cron, instead of duplicating (and inevitably drifting
// from) that logic.
//
// Usage:
//   const { sendOutboundEmailRow, isValidEmail } = require('./outbound-email-send.js');
//   const result = await sendOutboundEmailRow(row);
//   // { ok: true, id, status } on success
//   // { ok: false, status, transient, errorText } on failure

const { isSuppressed } = require('./check-suppression.js');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const isValidEmail = (e) =>
  typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

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

// Sends one outbound_email_queue row via Resend. Does NOT touch the DB row —
// callers own claim/lock + status transitions so this stays usable from both
// the batch cron (claims a page at a time) and a single manual approve tap.
async function sendOutboundEmailRow(row) {
  if (!RESEND_API_KEY) {
    return { ok: false, status: 0, transient: false, errorText: 'resend_not_configured' };
  }
  if (!isValidEmail(row.to_email) || !row.subject || (!row.body_text && !row.body_html)) {
    return { ok: false, status: 0, transient: false, errorText: 'invalid_row: missing to_email/subject/body' };
  }

  const suppressed = await isSuppressed(row.to_email, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (suppressed) {
    return { ok: false, status: 0, transient: false, errorText: 'suppressed_send_blocked: recipient on suppression list' };
  }

  const payload = {
    from: row.from_email
      ? `Heath at Dossie <${row.from_email}>`
      : 'Heath at Dossie <heath@meetdossie.com>',
    to: [String(row.to_email).trim()],
    subject: String(row.subject).trim(),
    html: row.body_html && row.body_html.trim().length > 0
      ? row.body_html
      : renderHtml(row.body_text || ''),
    reply_to: isValidEmail(row.reply_to)
      ? String(row.reply_to).trim()
      : (row.from_email || 'heath@meetdossie.com'),
  };

  // Same BCC rule as the batch cron: strip on marketing batches, keep on
  // everything else so Heath has an archive copy.
  const queuedBy = row && row.metadata && row.metadata.queued_by;
  const isMarketingBatch = queuedBy === 'cron-cold-email-daily-batch' || queuedBy === 'cron-cold-email-followup';
  if (!isMarketingBatch) {
    payload.bcc = ['heath@meetdossie.com'];
  }

  try {
    const attachments = row && row.metadata && Array.isArray(row.metadata.attachments_b64)
      ? row.metadata.attachments_b64
      : null;
    if (attachments && attachments.length > 0) {
      const cleaned = [];
      for (const a of attachments) {
        if (!a || typeof a !== 'object') continue;
        if (typeof a.filename !== 'string' || !a.filename.trim()) continue;
        if (typeof a.content_b64 !== 'string' || !a.content_b64.trim()) continue;
        cleaned.push({
          filename: a.filename.trim(),
          content: a.content_b64.trim(),
          ...(a.content_type ? { content_type: String(a.content_type) } : {}),
        });
      }
      if (cleaned.length > 0) payload.attachments = cleaned;
    }
  } catch (e) {
    console.warn('[outbound-email-send] attachments parse failed', e && e.message);
  }

  let r;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    return { ok: false, status: 0, transient: true, errorText: `fetch_failed: ${err && err.message}` };
  }

  const data = await r.json().catch(() => ({}));
  if (r.ok) {
    return { ok: true, id: data && data.id, status: r.status };
  }
  const transient = r.status >= 500;
  const msg = (data && (data.message || data.error)) || `resend_${r.status}`;
  return { ok: false, status: r.status, transient, errorText: String(msg).slice(0, 500) };
}

module.exports = { sendOutboundEmailRow, isValidEmail, renderHtml, escapeHtml };
