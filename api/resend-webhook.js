/**
 * Resend Webhook Listener
 * Receives Resend email events (delivered, opened, clicked, bounced, complained)
 * Verifies Resend webhook signature header for security
 * Inserts events into email_events table for cold-email metrics tracking
 *
 * Environment:
 *   RESEND_WEBHOOK_SECRET — Resend webhook signing secret (from Resend dashboard)
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT for database writes
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

// Verify Resend webhook signature header
// Resend includes an 'x-resend-signature' header with format: 't=<timestamp>,v1=<hmac>'
function verifyResendSignature(rawBody, signature) {
  if (!RESEND_WEBHOOK_SECRET) {
    console.warn('[resend-webhook] RESEND_WEBHOOK_SECRET not configured — skipping verification');
    return true; // Fail open if not configured
  }

  if (!signature) {
    console.error('[resend-webhook] No x-resend-signature header found');
    return false;
  }

  try {
    // Parse signature header: 't=<timestamp>,v1=<hmac>'
    const parts = signature.split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      acc[key] = value;
      return acc;
    }, {});

    const timestamp = parts.t;
    const hmac = parts.v1;

    if (!timestamp || !hmac) {
      console.error('[resend-webhook] Invalid signature format');
      return false;
    }

    // Construct signed content: "<timestamp>.<raw_body>"
    const signedContent = `${timestamp}.${rawBody}`;

    // Compute HMAC-SHA256 with the webhook secret
    const computed = crypto
      .createHmac('sha256', RESEND_WEBHOOK_SECRET)
      .update(signedContent)
      .digest('hex');

    // Compare with provided HMAC
    const isValid = computed === hmac;
    if (!isValid) {
      console.error('[resend-webhook] Signature mismatch');
    }
    return isValid;
  } catch (err) {
    console.error('[resend-webhook] Signature verification threw:', err && err.message);
    return false;
  }
}

// Insert or update event in email_events table
async function insertEmailEvent(event) {
  const {
    resend_email_id,
    recipient_email,
    event_type,
    event_ts,
    url_clicked,
    campaign_id,
    batch_id,
  } = event;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[resend-webhook] Supabase not configured — skipping event insert');
    return;
  }

  try {
    const body = {
      resend_email_id,
      recipient_email: recipient_email ? String(recipient_email).toLowerCase() : null,
      event_type,
      event_ts,
      url_clicked,
      campaign_id,
      batch_id,
    };

    const res = await fetch(`${SUPABASE_URL}/rest/v1/email_events`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[resend-webhook] Insert failed:', res.status, text.slice(0, 300));
      return false;
    }

    console.log('[resend-webhook] Event inserted: type=', event_type, 'email=', recipient_email);
    return true;
  } catch (err) {
    console.error('[resend-webhook] Insert threw:', err && err.message);
    return false;
  }
}

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-resend-signature');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[resend-webhook] Failed to read body:', err && err.message);
    return res.status(400).json({ ok: false, error: 'Failed to read request body' });
  }

  // Verify signature
  const signature = req.headers['x-resend-signature'];
  if (!verifyResendSignature(rawBody, signature)) {
    console.error('[resend-webhook] Signature verification failed');
    return res.status(401).json({ ok: false, error: 'Signature verification failed' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error('[resend-webhook] JSON parse failed:', err && err.message);
    return res.status(400).json({ ok: false, error: 'Invalid JSON' });
  }

  // Resend webhook format: { type: 'email.sent' | 'email.delivered' | ... , data: {...} }
  const eventType = payload.type || '';
  const data = payload.data || {};

  console.log('[resend-webhook] Received event:', eventType);

  // Map Resend event types to our event_type column
  let eventTypeToStore = null;
  let recipientEmail = null;
  let urlClicked = null;
  let eventTimestamp = null;
  let campaignId = null;
  let batchId = null;

  switch (eventType) {
    case 'email.sent':
      eventTypeToStore = 'sent';
      recipientEmail = data.to;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    case 'email.delivered':
      eventTypeToStore = 'delivered';
      recipientEmail = data.to;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    case 'email.opened':
      eventTypeToStore = 'opened';
      recipientEmail = data.to;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    case 'email.clicked':
      eventTypeToStore = 'clicked';
      recipientEmail = data.to;
      urlClicked = data.click?.link || null;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    case 'email.bounced':
      eventTypeToStore = 'bounced';
      recipientEmail = data.to;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    case 'email.complained':
      eventTypeToStore = 'complained';
      recipientEmail = data.to;
      eventTimestamp = data.created_at || new Date().toISOString();
      break;

    default:
      console.log('[resend-webhook] Unknown event type, ignoring:', eventType);
      return res.status(200).json({ ok: true, received: eventType, note: 'unknown event type' });
  }

  if (!eventTypeToStore || !recipientEmail) {
    console.warn('[resend-webhook] Missing required fields for event. type=', eventType, 'email=', recipientEmail);
    return res.status(200).json({ ok: true, received: eventType, note: 'skipped (missing fields)' });
  }

  // Extract campaign/batch IDs from metadata if available
  if (data.metadata) {
    campaignId = data.metadata.campaign_id || null;
    batchId = data.metadata.batch_id || null;
  }

  // Always use resend_email_id from the webhook payload (Resend's unique message ID)
  const resendEmailId = data.id || null;

  // Insert the event
  const inserted = await insertEmailEvent({
    resend_email_id: resendEmailId,
    recipient_email: recipientEmail,
    event_type: eventTypeToStore,
    event_ts: eventTimestamp,
    url_clicked: urlClicked,
    campaign_id: campaignId,
    batch_id: batchId,
  });

  if (inserted) {
    return res.status(200).json({ ok: true, received: eventType });
  } else {
    // Still return 200 — Resend will retry on 5xx anyway. We've logged the failure.
    return res.status(200).json({ ok: true, received: eventType, warning: 'insert failed (logged)' });
  }
};
