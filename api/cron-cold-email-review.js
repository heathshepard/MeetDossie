'use strict';

// Vercel Serverless Function: /api/cron-cold-email-review
//
// Human-approval gate for cold email (Carter, 2026-08-16), built after the
// 2026-08-13 incident: 49 real cold emails fired via a direct, validly
// Bearer-authenticated hit to /api/cron-send-outbound-emails while its own
// Vercel schedule was parked. A parked schedule is not a real gate -- an
// authenticated manual trigger bypasses it entirely. This cron closes that
// path for real: cron-cold-email-daily-batch.js and cron-cold-email-followup.js
// now tag every row they insert with metadata.requires_approval=true and
// metadata.approval_status='pending_approval'. Both cron-send-outbound-emails.js
// and jarvis-approve.js refuse to send any row still sitting at
// approval_status != 'approved', regardless of how either endpoint is hit.
// This cron is the only thing that flips a batch to 'approved' (via Heath's
// Telegram tap, handled in telegram-webhook.js's coldemail_approve_/
// coldemail_reject_ callback branch).
//
// Mirrors api/cron-content-pipeline-review.js's pattern (single item ->
// Telegram card -> Approve/Reject buttons -> telegram-webhook.js callback),
// but batches at the metadata.batch level instead of per-row, since a cold
// email batch is 10-25 rows Heath needs to spot-check as one unit, not
// review one at a time.
//
// Auth:     Authorization: Bearer ${CRON_SECRET} (or Vercel's own cron header)
// Schedule: vercel.json -- runs every 15 min, well inside the 1hr window
//           between cron-cold-email-daily-batch (14:00 UTC) queuing a batch
//           and its send_after gate (15:00 UTC) opening.
//
// Idempotency: once a batch's card has been sent, every row in that batch is
// stamped metadata.batch_card_sent_at so a later run of this cron does not
// resend the card. Heath's tap is what actually changes approval_status.

require('./_lib/telegram-gate').install('cron-cold-email-review');

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SAMPLE_COUNT = 3;
const MAX_ROWS_SCANNED = 500; // covers several days of un-reviewed batches

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

async function tgSend(text, replyMarkup) {
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const respText = await res.text();
  let data = null;
  try { data = respText ? JSON.parse(respText) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, data, raw: respText };
}

function inlineKeyboard(batchId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `coldemail_approve_${batchId}` },
      { text: '❌ Reject', callback_data: `coldemail_reject_${batchId}` },
    ]],
  };
}

function truncate(s, n) {
  const str = String(s || '');
  return str.length > n ? str.slice(0, n) + '...' : str;
}

function formatSample(row, idx) {
  const meta = row.metadata || {};
  return [
    `--- Sample ${idx + 1} ---`,
    `To: ${row.to_email}`,
    `Subject: ${row.subject}`,
    truncate(row.body_text, 500),
  ].join('\n');
}

function formatMessage(batchId, rows) {
  const meta0 = rows[0].metadata || {};
  const campaign = meta0.campaign || '(no campaign tag)';
  const touch = meta0.touch != null ? meta0.touch : '?';
  const samples = rows.slice(0, SAMPLE_COUNT).map(formatSample).join('\n\n');

  return [
    `COLD EMAIL BATCH -- REVIEW REQUIRED`,
    '',
    `Batch: ${batchId}`,
    `Campaign: ${campaign} (touch ${touch})`,
    `Recipients: ${rows.length}`,
    '',
    samples,
    '',
    rows.length > SAMPLE_COUNT ? `(+ ${rows.length - SAMPLE_COUNT} more not shown)` : '',
    '',
    'Approve = every email in this batch becomes sendable (cron-send-outbound-emails will actually send once metadata.send_after passes).',
    'Reject = every email in this batch is discarded, none will send, this topic/lead-set is not retried.',
  ].filter(Boolean).join('\n');
}

module.exports = withTelemetry('cron-cold-email-review', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[cron-cold-email-review] Telegram env not configured — skipping run.');
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }

  const { data: rows, ok: loadOk } = await sb(
    `outbound_email_queue?metadata->>approval_status=eq.pending_approval&order=created_at.asc&limit=${MAX_ROWS_SCANNED}`,
  );
  if (!loadOk) {
    return res.status(502).json({ ok: false, error: 'failed to load outbound_email_queue' });
  }
  const items = Array.isArray(rows) ? rows : [];

  // Group by metadata.batch. Rows without a batch tag are ignored — this
  // gate only applies to cold-email crons, which always set one.
  const byBatch = new Map();
  for (const row of items) {
    const batchId = row && row.metadata && row.metadata.batch;
    if (!batchId) continue;
    // Already reviewed (card sent, awaiting Heath's tap) — skip re-sending.
    if (row.metadata.batch_card_sent_at) continue;
    if (!byBatch.has(batchId)) byBatch.set(batchId, []);
    byBatch.get(batchId).push(row);
  }

  let sent = 0;
  const errors = [];
  for (const [batchId, batchRows] of byBatch.entries()) {
    const text = formatMessage(batchId, batchRows);
    const result = await tgSend(text, inlineKeyboard(batchId));
    if (!result.ok) {
      console.error('[cron-cold-email-review] send failed for batch', batchId, result.raw?.slice(0, 200));
      errors.push({ batch: batchId, error: result.raw?.slice(0, 200) });
      continue;
    }
    const messageId = result.data?.result?.message_id || null;
    const now = new Date().toISOString();

    // Stamp every row in the batch so we never re-send this card. PostgREST
    // PATCH replaces the whole metadata value, so this has to be a per-row
    // merge, not a single bulk update.
    let stampFailures = 0;
    for (const row of batchRows) {
      const patch = await sb(`outbound_email_queue?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          metadata: { ...row.metadata, batch_card_sent_at: now, telegram_message_id: messageId },
        }),
      });
      if (!patch.ok) stampFailures += 1;
    }
    if (stampFailures > 0) {
      errors.push({ batch: batchId, error: `${stampFailures} row(s) failed to stamp batch_card_sent_at` });
    } else {
      sent += 1;
    }
  }

  console.log('[cron-cold-email-review] done — batches reviewed', sent, 'of', byBatch.size, 'errors:', errors.length);
  return res.status(200).json({ ok: true, batches_sent: sent, batches_found: byBatch.size, errors });
});
