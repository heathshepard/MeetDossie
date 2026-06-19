// Vercel Serverless Function: /api/cron-send-outbound-emails
//
// Polls public.outbound_email_queue every minute and dispatches pending rows
// through Resend. This is the worker half of Cole's autonomous outbound
// email infrastructure (Cole / agents enqueue rows; this cron sends them).
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 1 minute ("* * * * *")
//
// Behaviour:
//   1. Stuck-row recovery: any row stuck in 'sending' for >5 min flips back
//      to 'pending' so a crashed cron run doesn't strand it.
//   2. Claim up to MAX_PER_RUN (=20) pending rows by flipping each to
//      'sending' with a conditional update (status=eq.pending). If the
//      conditional update affects 0 rows, a parallel run already grabbed
//      it — skip.
//   3. For each claimed row, send via Resend.
//   4. Resend success → status='sent', sent_at=now(), resend_message_id=...
//      Resend 4xx (bad email, blocked, etc.) → status='failed', no retry.
//      Resend 5xx / network → status='pending' (will retry next minute) but
//      increment attempts; after attempts >= 5, flip to 'failed' to stop
//      retry storms.
//   5. Row body_html is preferred; if absent we render body_text with
//      escapeHtml + <br> for newlines (same pattern as admin-send-email.js).
//
// Idempotency: the conditional UPDATE ... WHERE status='pending' is the
// lock. Postgres guarantees only one cron run flips a given row to
// 'sending'. No risk of double-send across overlapping runs.
//
// Cost guardrails: MAX_PER_RUN=20 per minute = 1200/hour ceiling, well
// under Resend's free-tier quota and far under the Creator plan we'd
// upgrade to if volume warranted it.

const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 5;
const STUCK_SENDING_MINUTES = 5;

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

function supabaseHeaders(extra = {}) {
  return {
    'apikey': SUPABASE_SERVICE_ROLE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

// Recover any rows stuck in 'sending' for >5 min (crashed prior cron run).
async function recoverStuckSending() {
  const cutoff = new Date(Date.now() - STUCK_SENDING_MINUTES * 60 * 1000).toISOString();
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?status=eq.sending&locked_at=lt.${encodeURIComponent(cutoff)}`;
  try {
    const r = await fetch(url, {
      method: 'PATCH',
      headers: supabaseHeaders({ 'Prefer': 'return=representation' }),
      body: JSON.stringify({ status: 'pending', locked_at: null }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.warn('[outbound-email] recoverStuckSending failed', r.status, text);
      return 0;
    }
    const rows = await r.json().catch(() => []);
    return Array.isArray(rows) ? rows.length : 0;
  } catch (e) {
    console.warn('[outbound-email] recoverStuckSending crashed', e && e.message);
    return 0;
  }
}

// Fetch the next batch of pending rows ordered FIFO.
async function fetchPending() {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?status=eq.pending&order=created_at.asc&limit=${MAX_PER_RUN}`;
  const r = await fetch(url, { headers: supabaseHeaders() });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`fetchPending failed: ${r.status} ${text.slice(0, 200)}`);
  }
  return r.json();
}

// Conditional claim: flip to 'sending' only if still 'pending'. Returns the
// updated row if we got the lock, otherwise null.
async function claimRow(id) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?id=eq.${id}&status=eq.pending`;
  const r = await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Prefer': 'return=representation' }),
    body: JSON.stringify({
      status: 'sending',
      locked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    console.warn('[outbound-email] claimRow failed', id, r.status, text);
    return null;
  }
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
}

async function markSent(id, resendId) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?id=eq.${id}`;
  await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      status: 'sent',
      sent_at: new Date().toISOString(),
      resend_message_id: resendId || null,
      error_text: null,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function markFailed(id, errorText, attempts) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?id=eq.${id}`;
  await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      status: 'failed',
      error_text: String(errorText || '').slice(0, 1000),
      attempts: (attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    }),
  });
}

async function returnToPending(id, errorText, attempts) {
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?id=eq.${id}`;
  await fetch(url, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Prefer': 'return=minimal' }),
    body: JSON.stringify({
      status: 'pending',
      locked_at: null,
      error_text: String(errorText || '').slice(0, 1000),
      attempts: (attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    }),
  });
}

// Send through Resend. Returns { ok, id?, status, errorText? }.
// status === 4xx -> permanent failure (bad address etc.); 5xx/network -> transient.
async function sendViaResend(row) {
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
    // BCC Heath so he always has a copy of what Cole sent. Mirrors
    // admin-send-email.js. Easy to remove later if it gets noisy.
    bcc: ['heath@meetdossie.com'],
  };

  // Attachment support via metadata.attachments_b64:
  // [{ filename: 'foo.png', content_b64: '...', content_type: 'image/png' }]
  // Resend expects { filename, content (base64 string) } per their API.
  // Keeps the schema flat; no migration needed.
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
    console.warn('[outbound-email] attachments parse failed', e && e.message);
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
  // 4xx → permanent (bad email, validation, blocked). 5xx → transient retry.
  const transient = r.status >= 500;
  const msg = (data && (data.message || data.error)) || `resend_${r.status}`;
  return { ok: false, status: r.status, transient, errorText: String(msg).slice(0, 500) };
}

async function handler(req, res) {
  // Auth: Vercel cron hits us with Authorization: Bearer <CRON_SECRET>.
  // Also accept GET (cron) and POST (manual curl).
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }
  if (!RESEND_API_KEY) {
    return res.status(500).json({ ok: false, error: 'resend_not_configured' });
  }

  const startedAt = Date.now();
  const result = {
    recovered: 0,
    candidates: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    retrying: 0,
    skipped_invalid: 0,
  };

  try {
    result.recovered = await recoverStuckSending();

    const pending = await fetchPending();
    result.candidates = Array.isArray(pending) ? pending.length : 0;

    for (const row of pending || []) {
      // Reject obviously-bad rows up front; don't burn Resend quota.
      if (!isValidEmail(row.to_email) || !row.subject || !row.body_text) {
        await markFailed(row.id, 'invalid_row: missing to_email/subject/body_text', row.attempts);
        result.skipped_invalid += 1;
        continue;
      }

      const claimed = await claimRow(row.id);
      if (!claimed) continue; // race lost
      result.claimed += 1;

      const send = await sendViaResend(claimed);
      if (send.ok) {
        await markSent(claimed.id, send.id);
        result.sent += 1;
        continue;
      }

      // Permanent failure → mark failed, stop.
      if (!send.transient) {
        await markFailed(claimed.id, send.errorText, claimed.attempts);
        result.failed += 1;
        continue;
      }

      // Transient: retry up to MAX_ATTEMPTS, then give up.
      const nextAttempts = (claimed.attempts || 0) + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await markFailed(claimed.id, `gave_up_after_${nextAttempts}: ${send.errorText}`, claimed.attempts);
        result.failed += 1;
      } else {
        await returnToPending(claimed.id, send.errorText, claimed.attempts);
        result.retrying += 1;
      }
    }

    const duration_ms = Date.now() - startedAt;
    // Fail-soft telemetry — same pattern as the other crons.
    recordCronRun('cron-send-outbound-emails', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = (err && err.message) ? err.message.slice(0, 500) : 'crash';
    recordCronRun('cron-send-outbound-emails', 'error', { duration_ms, error: msg, ...result }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms, ...result });
  }
}

module.exports = handler;
module.exports.default = handler;
