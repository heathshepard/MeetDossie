// api/_lib/cold-email-batch-approval.js
//
// Shared logic for the cold-email BATCH approve/reject lifecycle. Extracted
// 2026-08-26 (Atlas) from telegram-webhook.js's coldemail_approve_/
// coldemail_reject_ callback branch so /api/jarvis-approve (the new in-Jarvis
// approval surface) and the Telegram callback both act on the exact same
// code path instead of drifting.
//
// WHY THIS EXISTS: Heath's Telegram approval card for cold-email batches
// depends on cron-cold-email-review.js successfully pushing a message to
// Telegram. On 2026-08-26 that push was silently suppressed by the
// telegram-gate kill switch (TELEGRAM_CRON_NOTIFICATIONS gate, see
// api/_lib/telegram-gate.js) — the gate returns a fake "ok" response so the
// cron proceeds as if the card sent, stamps metadata.batch_card_sent_at, and
// the batch becomes invisible: 25 real queued emails, no card ever reached
// Heath's phone, and the old jarvis-pending-approvals.js rendering told him
// to "check Telegram" for something that was never actually sent there.
// Fix: cold-email batch approval is now a first-class action inside Jarvis
// itself (kind: 'cold_email_batch' in jarvis-approve.js) that reads directly
// from outbound_email_queue — it does not depend on the Telegram card having
// sent at all. Telegram approval still works exactly as before for anyone
// who prefers tapping a phone button.
//
// Both callers pass a batchId (metadata.batch on outbound_email_queue rows).
'use strict';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

/**
 * Load every still-pending row for a batch.
 * @returns {Promise<Array>} rows (empty if batch already actioned or unknown)
 */
async function loadPendingBatchRows(batchId) {
  const { data } = await sb(
    `outbound_email_queue?metadata->>batch=eq.${encodeURIComponent(batchId)}&metadata->>approval_status=eq.pending_approval&select=id,to_email,subject,body_text,metadata`,
  );
  return Array.isArray(data) ? data : [];
}

/**
 * Approve every row in a cold-email batch — flips metadata.approval_status
 * to 'approved' on each row. Sending itself still happens later via
 * cron-send-outbound-emails once metadata.send_after passes; this only
 * clears the human-approval gate.
 * @param {string} batchId
 * @returns {Promise<{ok:boolean, count:number, failures:number, rows:Array}>}
 */
async function approveColdEmailBatch(batchId) {
  const rows = await loadPendingBatchRows(batchId);
  if (rows.length === 0) return { ok: false, count: 0, failures: 0, rows: [], reason: 'not_found_or_already_actioned' };

  const now = new Date().toISOString();
  let failures = 0;
  for (const row of rows) {
    const patch = await sb(`outbound_email_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: { ...row.metadata, approval_status: 'approved', approved_at: now } }),
    });
    if (!patch.ok) failures += 1;
  }
  return { ok: true, count: rows.length, failures, rows };
}

/**
 * Reject every row in a cold-email batch — flips metadata.approval_status to
 * 'rejected' and status to 'skipped' so cron-send-outbound-emails never
 * picks it up.
 * @param {string} batchId
 * @param {string} [reasonText]
 * @returns {Promise<{ok:boolean, count:number, failures:number, rows:Array}>}
 */
async function rejectColdEmailBatch(batchId, reasonText) {
  const rows = await loadPendingBatchRows(batchId);
  if (rows.length === 0) return { ok: false, count: 0, failures: 0, rows: [], reason: 'not_found_or_already_actioned' };

  const now = new Date().toISOString();
  let failures = 0;
  for (const row of rows) {
    const patch = await sb(`outbound_email_queue?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        metadata: { ...row.metadata, approval_status: 'rejected', rejected_at: now },
        status: 'skipped',
        error_text: reasonText || 'heath_rejected_batch_review',
      }),
    });
    if (!patch.ok) failures += 1;
  }
  return { ok: true, count: rows.length, failures, rows };
}

module.exports = { loadPendingBatchRows, approveColdEmailBatch, rejectColdEmailBatch };
