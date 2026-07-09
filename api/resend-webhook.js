/**
 * Resend Webhook Listener
 * Receives Resend email events (delivered, opened, clicked, bounced, complained)
 * Verifies Resend webhook signature header for security
 * Inserts events into email_events table for cold-email metrics tracking.
 *
 * 2026-07-09 ATLAS LOOP G — Dossie Sign bounce-recovery
 * On hard bounce / complaint, additionally:
 *   - Look up the signer in signature_requests by recipient email
 *   - Log to email_failures with retry_count + envelope_id + submission_id
 *   - Attempt a single fallback resend via /api/esign-resend (if signer found)
 *   - Telegram-alert Heath after 3 failures on the same envelope+recipient combo
 *
 * Environment:
 *   RESEND_WEBHOOK_SECRET — Resend webhook signing secret (from Resend dashboard)
 *   SUPABASE_URL          — Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role JWT for database writes
 *   RESEND_API_KEY        — used to fire the fallback resend
 *   TELEGRAM_BOT_TOKEN    — Claudy bot (personal alerts)
 *   TELEGRAM_CHAT_ID      — Heath's chat id (7874782923)
 */

const crypto = require('crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BOUNCE_ALERT_THRESHOLD = 3; // Telegram alert after Nth failure per envelope+email

// Verify Resend webhook signature.
//
// Resend uses Svix under the hood. Headers sent:
//   svix-id:        <unique event id>
//   svix-timestamp: <unix timestamp>
//   svix-signature: v1,<base64(HMAC)>  (space-separated list; may contain multiple 'v1,...' entries)
//
// Signed content: "<svix-id>.<svix-timestamp>.<raw-body>"
// HMAC: SHA-256 with the secret. The stored secret is base64-encoded and
// prefixed with "whsec_"; decode the base64 portion for the HMAC key.
//
// Docs: https://docs.svix.com/receiving/verifying-payloads/how-manual
//
// 2026-07-09 LOOP G — Older on-the-wire scheme (x-resend-signature: t=,v1=)
// kept as a fallback for legacy/test callers.
function verifyResendSignature(rawBody, headers) {
  if (!RESEND_WEBHOOK_SECRET) {
    console.error('[resend-webhook] RESEND_WEBHOOK_SECRET not configured — rejecting webhook');
    return false;
  }

  // Prefer Svix headers (real Resend production traffic).
  const svixId = headers['svix-id'];
  const svixTs = headers['svix-timestamp'];
  const svixSig = headers['svix-signature'];
  if (svixId && svixTs && svixSig) {
    try {
      // Optional 5-min replay-window guard
      const tsNum = Number(svixTs);
      if (!Number.isFinite(tsNum)) {
        console.error('[resend-webhook] svix-timestamp not numeric');
        return false;
      }
      const nowSec = Math.floor(Date.now() / 1000);
      if (Math.abs(nowSec - tsNum) > 300) {
        console.error('[resend-webhook] svix-timestamp outside 5-min replay window');
        return false;
      }

      // Decode secret: strip "whsec_" prefix, then base64-decode to raw bytes.
      const secretStr = String(RESEND_WEBHOOK_SECRET);
      const secretB64 = secretStr.startsWith('whsec_') ? secretStr.slice(6) : secretStr;
      let secretBytes;
      try {
        secretBytes = Buffer.from(secretB64, 'base64');
      } catch {
        secretBytes = Buffer.from(secretB64);
      }

      const signedContent = svixId + '.' + svixTs + '.' + rawBody;
      const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

      // svix-signature can contain multiple entries: "v1,sig1 v1,sig2"
      const entries = String(svixSig).split(' ');
      for (const entry of entries) {
        const [scheme, sig] = entry.split(',');
        if (scheme !== 'v1' || !sig) continue;
        // Constant-time-ish compare
        if (sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          return true;
        }
      }
      console.error('[resend-webhook] Svix signature mismatch');
      return false;
    } catch (err) {
      console.error('[resend-webhook] Svix verify threw:', err && err.message);
      return false;
    }
  }

  // Legacy fallback: x-resend-signature: t=<ts>,v1=<hex-hmac>
  const legacy = headers['x-resend-signature'];
  if (!legacy) {
    console.error('[resend-webhook] No signature header found (svix or x-resend)');
    return false;
  }
  try {
    const parts = String(legacy).split(',').reduce((acc, part) => {
      const [key, value] = part.split('=');
      acc[key] = value;
      return acc;
    }, {});
    const timestamp = parts.t;
    const hmac = parts.v1;
    if (!timestamp || !hmac) {
      console.error('[resend-webhook] legacy signature format invalid');
      return false;
    }
    const signedContent = timestamp + '.' + rawBody;
    const computed = crypto.createHmac('sha256', RESEND_WEBHOOK_SECRET).update(signedContent).digest('hex');
    if (computed !== hmac) {
      console.error('[resend-webhook] legacy signature mismatch');
      return false;
    }
    return true;
  } catch (err) {
    console.error('[resend-webhook] legacy verify threw:', err && err.message);
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

// ---------------------------------------------------------------------------
// LOOP G — Dossie Sign bounce-recovery helpers
// ---------------------------------------------------------------------------

// Find the signature_request that contains this recipient in its signers JSONB.
// Uses Postgres JSONB @> containment; scoped to last 30 days to keep the scan cheap.
async function findSignatureRequestByRecipient(recipientEmail) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !recipientEmail) return null;
  try {
    // signers is jsonb array of {name, email, role, ...}. Use PostgREST cs
    // (contains) with a URL-encoded JSON array. We search recent (<= 60 days)
    // envelopes only to keep the scan cheap.
    const containsPayload = encodeURIComponent(JSON.stringify([{ email: recipientEmail.toLowerCase() }]));
    const sinceIso = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();
    const q =
      'signature_requests' +
      '?select=id,user_id,transaction_id,document_id,docuseal_submission_id,signers,created_at' +
      '&signers=cs.' + containsPayload +
      '&created_at=gte.' + encodeURIComponent(sinceIso) +
      '&order=created_at.desc&limit=5';
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn('[resend-webhook] signature_requests lookup failed:', res.status, text.slice(0, 200));
      return null;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      // Fallback: some envelopes may store the email with different casing. Try case-insensitive iterate.
      return null;
    }
    return rows[0]; // most recent match
  } catch (err) {
    console.warn('[resend-webhook] signature_requests lookup threw:', err && err.message);
    return null;
  }
}

// Fallback email for a signer. Currently:
//   - If the signer email matches a Dossie auth.users row, no fallback (self)
//   - No alternate-contact column exists yet — return null.
// The agent still gets Telegram-alerted after 3 failures so they can call the signer.
// TODO(loop-G-v2): add transactions.signer_alt_email column so we can auto-resend.
async function resolveFallbackEmail(recipientEmail, signatureRequest) {
  // Placeholder for future logic. Kept as a function so the shape is stable.
  return null;
}

// Count how many prior failures we've logged for the same envelope+email.
async function countPriorFailures(envelopeId, recipientEmail) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return 0;
  try {
    const q = `email_failures?select=id&envelope_id=eq.${encodeURIComponent(envelopeId || '')}&original_email=eq.${encodeURIComponent(recipientEmail.toLowerCase())}`;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${q}`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) return 0;
    const rows = await res.json();
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

// Insert a new email_failures row.
async function insertEmailFailure(row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/email_failures`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[resend-webhook] email_failures insert failed:', res.status, text.slice(0, 300));
      return null;
    }
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  } catch (err) {
    console.error('[resend-webhook] email_failures insert threw:', err && err.message);
    return null;
  }
}

// Attempt to send a fallback email via Resend. Returns true if sent.
async function sendFallbackEmail({ fallbackEmail, signerName, envelopeId, signingUrl, documentName }) {
  if (!RESEND_API_KEY || !fallbackEmail) return false;
  try {
    const subject = `Fallback: Please sign ${documentName || 'a document'}`;
    const html = `
      <p>Hi ${signerName || 'there'},</p>
      <p>Your agent sent you a document to sign, but our first delivery didn't reach the original address. Please review and sign here:</p>
      <p><a href="${signingUrl || 'https://docuseal.com'}">Open signing page</a></p>
      <p>If this doesn't look familiar, ignore this email — no action is taken until you click the signing link.</p>
    `;
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Dossie <sign@meetdossie.com>',
        to: [fallbackEmail],
        subject,
        html,
        headers: { 'X-Dossie-Fallback-Envelope': String(envelopeId || '') },
      }),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      console.error('[resend-webhook] fallback resend failed:', r.status, text.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[resend-webhook] fallback resend threw:', err && err.message);
    return false;
  }
}

// Fire a Telegram alert to Heath (Claudy bot, personal chat).
async function alertHeathTelegram({ envelopeId, recipientEmail, failureCount, submissionId }) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[resend-webhook] Telegram alert skipped — bot token or chat id missing.');
    return false;
  }
  try {
    const text = [
      'e-sign email failed ' + failureCount + 'x.',
      'Envelope: ' + (envelopeId || '(unknown)'),
      'Original: ' + recipientEmail,
      submissionId ? 'Submission: ' + submissionId : null,
      'Action: reach out to the signer directly.',
    ].filter(Boolean).join('\n');

    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[resend-webhook] Telegram alert failed:', r.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (err) {
    console.error('[resend-webhook] Telegram alert threw:', err && err.message);
    return false;
  }
}

// Master bounce-handling entrypoint. Called for email.bounced and email.complained.
// Non-blocking: any failure here is logged but the webhook still returns 200.
async function handleBounceForEsign({ payload, recipientEmail, resendEmailId, eventType }) {
  try {
    // Look up the signature request that contains this recipient
    const sr = await findSignatureRequestByRecipient(recipientEmail);
    if (!sr) {
      console.log('[resend-webhook] bounce for non-esign recipient (or older than 60d), skipping esign fallback:', recipientEmail);
      return { esignHandled: false };
    }

    // Classify bounce
    const data = payload.data || {};
    let bounceType = 'soft';
    if (eventType === 'email.complained') bounceType = 'complaint';
    else if (data.bounce && (data.bounce.type === 'hard' || /perm|permanent|hard/i.test(String(data.bounce.type || data.bounce.subType || '')))) bounceType = 'hard';
    else if (data.type === 'hard') bounceType = 'hard';
    const bounceReason = (data.bounce && (data.bounce.message || data.bounce.reason)) || data.reason || null;

    // Count prior failures for this envelope+email
    const priorCount = await countPriorFailures(sr.docuseal_submission_id, recipientEmail);
    const newFailureCount = priorCount + 1;

    // Attempt fallback resend for hard bounces only.
    let fallbackEmail = null;
    let fallbackSent = false;
    if (bounceType === 'hard') {
      fallbackEmail = await resolveFallbackEmail(recipientEmail, sr);
      if (fallbackEmail && fallbackEmail !== recipientEmail) {
        const signer = Array.isArray(sr.signers)
          ? sr.signers.find((s) => (s.email || '').toLowerCase() === recipientEmail.toLowerCase())
          : null;
        fallbackSent = await sendFallbackEmail({
          fallbackEmail,
          signerName: signer ? signer.name : null,
          envelopeId: sr.docuseal_submission_id,
          signingUrl: signer ? signer.signingUrl : null,
          documentName: 'your document',
        });
      }
    }

    // Log
    const inserted = await insertEmailFailure({
      resend_message_id: resendEmailId,
      original_email: recipientEmail.toLowerCase(),
      fallback_email: fallbackEmail,
      envelope_id: sr.docuseal_submission_id,
      submission_id: sr.docuseal_submission_id,
      signature_request_id: sr.id,
      bounce_type: bounceType,
      bounce_reason: bounceReason,
      retry_count: fallbackSent ? 1 : 0,
      retried_at: fallbackSent ? new Date().toISOString() : null,
      resolved: false,
      raw_webhook: payload,
    });

    // Alert on threshold
    if (newFailureCount >= BOUNCE_ALERT_THRESHOLD) {
      await alertHeathTelegram({
        envelopeId: sr.docuseal_submission_id,
        recipientEmail,
        failureCount: newFailureCount,
        submissionId: sr.docuseal_submission_id,
      });
    }

    console.log(
      '[resend-webhook] esign bounce handled envelope=' + sr.docuseal_submission_id +
      ' recipient=' + recipientEmail +
      ' type=' + bounceType +
      ' priorCount=' + priorCount +
      ' fallbackSent=' + fallbackSent +
      ' failureRowId=' + (inserted && inserted.id)
    );

    return { esignHandled: true, failureRowId: inserted && inserted.id, failureCount: newFailureCount, fallbackSent };
  } catch (err) {
    console.error('[resend-webhook] handleBounceForEsign threw:', err && err.message);
    return { esignHandled: false, error: err && err.message };
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
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-resend-signature, svix-id, svix-timestamp, svix-signature',
  );

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

  // Verify webhook is configured first
  if (!RESEND_WEBHOOK_SECRET) {
    console.error('[resend-webhook] Webhook not configured (RESEND_WEBHOOK_SECRET missing)');
    return res.status(503).json({ ok: false, error: 'Webhook not configured' });
  }

  // Verify signature (Svix headers preferred; x-resend-signature legacy fallback).
  if (!verifyResendSignature(rawBody, req.headers)) {
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

    case 'email.delivery_delayed':
      // Resend flag for a soft-defer (mailbox full, greylist, etc.). We log it
      // as a 'delayed' event type. Loop G will not fire fallback/alert for these
      // — only hard bounces + complaints escalate.
      eventTypeToStore = 'delayed';
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

  // 2026-07-09 LOOP G — Dossie Sign bounce-recovery.
  // On bounce/complaint, additionally check if the recipient is an esign signer
  // and log to email_failures + attempt fallback + alert Heath if threshold hit.
  let esignResult = null;
  if (eventType === 'email.bounced' || eventType === 'email.complained') {
    esignResult = await handleBounceForEsign({
      payload,
      recipientEmail,
      resendEmailId,
      eventType,
    });
  }

  if (inserted) {
    return res.status(200).json({ ok: true, received: eventType, esign: esignResult });
  } else {
    // Still return 200 — Resend will retry on 5xx anyway. We've logged the failure.
    return res.status(200).json({ ok: true, received: eventType, warning: 'insert failed (logged)', esign: esignResult });
  }
};
