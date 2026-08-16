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
const { isSuppressed, clearCache } = require('./_lib/check-suppression.js');
const { sendOutboundEmailRow, isValidEmail } = require('./_lib/outbound-email-send.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MAX_PER_RUN = 20;
const MAX_ATTEMPTS = 5;
const STUCK_SENDING_MINUTES = 5;

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
//
// Scheduled sends: if metadata.send_after is present and in the future, we
// skip that row until the timestamp passes. This lets Pierce/Sage/etc queue
// rows now that fire on a specific date (e.g. cold-email batch queued Wed
// night for Thursday 7am CDT send). We fetch a wider window than MAX_PER_RUN
// and filter in JS because PostgREST jsonb-timestamp comparisons are
// brittle across timezones.
async function fetchPending() {
  const overFetch = MAX_PER_RUN * 3;
  const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?status=eq.pending&order=created_at.asc&limit=${overFetch}`;
  const r = await fetch(url, { headers: supabaseHeaders() });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`fetchPending failed: ${r.status} ${text.slice(0, 200)}`);
  }
  const rows = await r.json();
  if (!Array.isArray(rows)) return [];
  const nowMs = Date.now();
  const ready = [];
  for (const row of rows) {
    const sendAfter = row && row.metadata && row.metadata.send_after;
    if (sendAfter) {
      const t = Date.parse(sendAfter);
      if (Number.isFinite(t) && t > nowMs) {
        // Not yet — leave for a later cron pass.
        continue;
      }
    }
    // Human-approval gate (Carter, 2026-08-16, post 8/13 incident). Rows
    // tagged requires_approval=true (cold-email daily-batch + followup) are
    // structurally un-sendable until a Telegram Approve tap flips
    // metadata.approval_status to 'approved'. This check lives INSIDE the
    // sender itself — not in whether the generator cron's own schedule ran
    // — so a direct authenticated Bearer hit to this endpoint (the exact
    // 8/13 mechanism) still can't send an unapproved row. Rows that never
    // set requires_approval (legacy/manual queue-outbound-email.js sends,
    // one-off agent sends) are unaffected and keep working as before.
    if (row && row.metadata && row.metadata.requires_approval === true &&
        row.metadata.approval_status !== 'approved') {
      continue;
    }

    ready.push(row);
    if (ready.length >= MAX_PER_RUN) break;
  }
  return ready;
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

// Send through Resend. sendOutboundEmailRow lives in ./_lib/outbound-email-send.js
// — shared with /api/jarvis-approve so a single Heath-tap "Approve" send uses
// the exact same Resend/suppression path as this batch cron (2026-08-13).

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
    clearCache(); // Fresh cache per cron invocation

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

      // Check CAN-SPAM suppression list before sending
      const suppressed = await isSuppressed(row.to_email, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      if (suppressed) {
        await markFailed(row.id, 'suppressed_send_blocked: recipient on suppression list', row.attempts);
        result.skipped_invalid += 1;
        continue;
      }

      const claimed = await claimRow(row.id);
      if (!claimed) continue; // race lost
      result.claimed += 1;

      const send = await sendOutboundEmailRow(claimed);
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
