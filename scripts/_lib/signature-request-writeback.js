'use strict';

// scripts/_lib/signature-request-writeback.js
// =============================================================================
// C1 (docs/BACKLOG-ENGINEERING.md) — make CLI e-signature sends visible to the
// product.
//
// THE PROBLEM THIS SOLVES
// -----------------------
// Heath's real sends go through scripts/send-trec-amendment.js, which talks to
// DocuSeal directly. DocuSeal ended up holding 35 completed submissions while
// signature_requests held 33 rows, all status='sent', ZERO overlap — every
// tracked row a stale test send. api/esign-webhook.js keys strictly on
// docuseal_submission_id, so with no row there is nothing to match and it
// answers "submission not tracked" and drops the event. The verification /
// certificate / audit-trail leg was never broken. It was never fed.
//
// THE ONE RULE
// ------------
// send-trec-amendment.js sends legally binding documents to real clients. This
// module is BOOKKEEPING. It must never be able to prevent, delay, or corrupt a
// send. So:
//
//   * Nothing here throws. Every entry point returns {ok, ...} or {ok:false,
//     reason, detail} and callers ignore the result if they want to.
//   * It runs only AFTER the send has completed and been read back.
//   * It needs nothing from the operator.
//
// This mirrors api/esign-create.js insertSignatureRequest(), which learned the
// same lesson the hard way: a tracking-row failure once surfaced to the user as
// "Could not send document. Try again." while the envelope was already live,
// and retrying sent the client a SECOND envelope.
// =============================================================================

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

// Default owner for CLI sends. Resolved to a uuid via profiles — never hardcode
// the uuid, it differs between the real account and the demo/test account that
// owns all 33 legacy rows.
const DEFAULT_OWNER_EMAIL = 'heath.shepard@kw.com';

function loadEnv() {
  const f = path.join(REPO, '.env.local');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

function env() {
  loadEnv();
  return {
    url: (process.env.SUPABASE_URL || '').replace(/\/$/, ''),
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  };
}

async function supa(pathAndQuery, opts = {}) {
  const { url, key } = env();
  if (!url || !key) return { ok: false, status: 0, text: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing' };
  try {
    const res = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
      ...opts,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
        ...(opts.headers || {}),
      },
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
    return { ok: res.ok, status: res.status, text, data };
  } catch (err) {
    return { ok: false, status: 0, text: String((err && err.message) || err) };
  }
}

// Resolve the auth.users id that owns these tracking rows.
// Order: explicit argument → SIGNATURE_OWNER_USER_ID → profiles lookup on
// SIGNATURE_OWNER_EMAIL / heath.shepard@kw.com.
async function resolveOwnerUserId(explicit) {
  if (explicit) return { ok: true, userId: explicit, source: 'explicit' };
  loadEnv();
  if (process.env.SIGNATURE_OWNER_USER_ID) {
    return { ok: true, userId: process.env.SIGNATURE_OWNER_USER_ID, source: 'env' };
  }
  const email = process.env.SIGNATURE_OWNER_EMAIL || DEFAULT_OWNER_EMAIL;
  const r = await supa(`profiles?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
  const row = Array.isArray(r.data) ? r.data[0] : null;
  if (!r.ok || !row || !row.id) {
    return { ok: false, reason: 'owner_unresolved', detail: `no profiles row for ${email} (${r.status})` };
  }
  return { ok: true, userId: row.id, source: `profiles:${email}` };
}

// Normalise DocuSeal submitters into the signers jsonb shape the rest of the
// product already reads: api/esign-create.js writes it, api/esign-webhook.js
// updateSignerStatus() matches on .email, the dashboard renders .name/.status.
// Deviating here would break the webhook silently.
function normaliseSigners(submitters) {
  return (Array.isArray(submitters) ? submitters : []).map((s) => ({
    name: s.name || '',
    email: s.email || '',
    role: s.role || '',
    status: s.status || 'awaiting',
    signingUrl: s.slug ? `https://docuseal.com/s/${s.slug}` : (s.embed_src || null),
    uuid: s.uuid || null,
  }));
}

function isUnknownColumn(text) {
  return String(text || '').includes('PGRST204')
    || /could not find the .* column/i.test(text)
    || /column .* does not exist/i.test(text);
}

// -----------------------------------------------------------------------------
// recordSend — insert the tracking row for a submission that was just sent.
//
// Returns {ok:true, id, skipped?} or {ok:false, reason, detail}. NEVER throws.
//
// FAIL-SAFE ON suppress_notifications
// -----------------------------------
// If that column is missing (migration not yet applied), we DO NOT fall back to
// inserting the row without it. An unflagged row makes api/esign-webhook.js
// email every signer a "Your signed contract" message on completion — real
// clients, on a live transaction, who were never told to expect mail from
// Dossie and who DocuSeal has already emailed. Losing a bookkeeping row is
// recoverable (scripts/backfill-docuseal-completions.js reconciles it later).
// An unrequested email to a client is not. So we abort loudly instead.
// -----------------------------------------------------------------------------
async function recordSend({
  submissionId,
  templateId = null,
  submitters = [],
  documentName = null,
  status = 'sent',
  sentPdfPath = null,
  userId = null,
  transactionId = null,
  message = null,
}) {
  if (!submissionId) return { ok: false, reason: 'no_submission_id' };

  const { url, key } = env();
  if (!url || !key) {
    return { ok: false, reason: 'supabase_env_missing', detail: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in .env.local' };
  }

  // Idempotence — re-running a send script against an existing submission must
  // not create a duplicate row the webhook would then pick at random (it does
  // ?limit=1 on docuseal_submission_id).
  const existing = await supa(
    `signature_requests?docuseal_submission_id=eq.${encodeURIComponent(submissionId)}&select=id&limit=1`
  );
  if (existing.ok && Array.isArray(existing.data) && existing.data.length > 0) {
    return { ok: true, id: existing.data[0].id, skipped: 'already_tracked' };
  }

  const owner = await resolveOwnerUserId(userId);
  if (!owner.ok) return owner;

  // sha256 of exactly the bytes we handed DocuSeal. This is what makes a later
  // "is the signed PDF the document we sent?" question answerable at all.
  let sentHashes = null;
  if (sentPdfPath) {
    try {
      const crypto = require('crypto');
      const buf = fs.readFileSync(sentPdfPath);
      sentHashes = { [path.basename(sentPdfPath)]: crypto.createHash('sha256').update(buf).digest('hex') };
    } catch (err) {
      console.warn(`[writeback] could not hash sent PDF (non-fatal): ${err && err.message}`);
    }
  }

  const row = {
    user_id: owner.userId,
    transaction_id: transactionId || null,
    docuseal_submission_id: String(submissionId),
    docuseal_template_id: templateId ? String(templateId) : null,
    status,
    signers: normaliseSigners(submitters),
    message: message || documentName || null,
    ...(sentHashes ? { sent_pdf_sha256: sentHashes } : {}),
    suppress_notifications: true,
  };

  const res = await supa('signature_requests', { method: 'POST', body: JSON.stringify(row) });
  if (res.ok) {
    const inserted = Array.isArray(res.data) ? res.data[0] : res.data;
    return { ok: true, id: inserted && inserted.id, userId: owner.userId };
  }

  if (isUnknownColumn(res.text)) {
    if (/suppress_notifications/i.test(res.text)) {
      return {
        ok: false,
        reason: 'suppress_notifications_column_missing',
        detail: 'Refusing to insert an unflagged tracking row — it would make the webhook email '
          + 'real signers on completion. Apply supabase/migrations/'
          + '20260917000000_signature_requests_suppress_notifications.sql, then backfill with '
          + 'scripts/backfill-docuseal-completions.js.',
      };
    }
    // A different optional column is missing (0026 audit columns). Those are
    // safe to drop — they carry no notification behavior.
    const stripped = { ...row };
    for (const col of ['docuseal_template_id', 'sent_pdf_sha256']) delete stripped[col];
    const retry = await supa('signature_requests', { method: 'POST', body: JSON.stringify(stripped) });
    if (retry.ok) {
      const inserted = Array.isArray(retry.data) ? retry.data[0] : retry.data;
      return { ok: true, id: inserted && inserted.id, userId: owner.userId, warning: 'audit columns missing (run api/_migrations/0026)' };
    }
    return { ok: false, reason: 'insert_failed', detail: `${retry.status} ${String(retry.text).slice(0, 200)}` };
  }

  // FK violation on transaction_id — record it unlinked rather than not at all.
  if ((String(res.text).includes('23503') || /foreign key/i.test(res.text)) && row.transaction_id) {
    const retry = await supa('signature_requests', {
      method: 'POST',
      body: JSON.stringify({ ...row, transaction_id: null }),
    });
    if (retry.ok) {
      const inserted = Array.isArray(retry.data) ? retry.data[0] : retry.data;
      return { ok: true, id: inserted && inserted.id, userId: owner.userId, warning: 'transaction link dropped (FK violation)' };
    }
  }

  return { ok: false, reason: 'insert_failed', detail: `${res.status} ${String(res.text).slice(0, 200)}` };
}

module.exports = { recordSend, resolveOwnerUserId, normaliseSigners, supa, loadEnv, isUnknownColumn };
