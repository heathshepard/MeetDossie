'use strict';

// Vercel Serverless Function: POST /api/invite-resend
//
// Getting a new way in, without needing a human.
//
// WHY
//   docs/ACTIVATION-FORENSICS-2026-09-18.md: the old set-password email told
//   customers "If it's expired, contact us at heath@meetdossie.com and we'll
//   send a new one." That sentence made a human the single point of recovery
//   for the only credential the account had. Nobody wrote in; three people just
//   never got in. Recovery has to work at 9pm on a Sunday with Heath asleep.
//
// TWO MODES
//
//   SELF-SERVICE (no auth) -- the customer types their own email. If an account
//   exists we mint a fresh durable invite and email it. The response is
//   byte-identical whether or not the address is registered, so this cannot be
//   used to enumerate customers. Rate limited hard.
//
//   ADMIN (Authorization: Bearer $CRON_SECRET) -- for Heath. The DEFAULT is
//   `deliver=none`: it mints the invite and RETURNS THE URL to the caller,
//   sending nothing. That exists because for the five customers who have been
//   silent for four months, a personal note from Heath with a working link in
//   it is very likely the right move, and an automated template is very likely
//   the wrong one. `deliver=email` is the opt-in that actually mails.
//
// SAFETY POSTURE
//   Nothing here runs on a schedule. No cron references this file. It sends
//   only in response to an inbound HTTP request that a person deliberately
//   makes: the customer typing their address, or Heath passing CRON_SECRET AND
//   deliver=email. As of this commit it has never been called with a real
//   customer's address.
//
//   It never modifies a customer's password, profile, or subscription. The only
//   writes are new rows in account_invites and lifecycle_email_log.
//
// Owner: 2026-09-18.

const invites = require('./_lib/account-invites');
const { applyCorsHeaders } = require('./_middleware/cors');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Identical for every self-service outcome -- registered, unregistered,
// throttled-per-address. Account enumeration is the one thing an unauthorized
// caller could otherwise get out of this endpoint.
const GENERIC_RESPONSE = {
  ok: true,
  message: "If that email has a Dossie account, a fresh set-password link is on its way. It stays good for 30 days.",
};

// A per-address cooldown on top of the per-IP limit. Without it, one person
// clicking "resend" five times would put five live tokens in their inbox and
// make the newest one hard to identify.
const RESEND_COOLDOWN_MS = 10 * 60 * 1000;

async function findAuthUser(email) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
    return users.find((u) => String(u.email || '').toLowerCase() === email) || null;
  } catch (err) {
    console.warn('[invite-resend] findAuthUser failed:', err && err.message);
    return null;
  }
}

async function profileName(userId) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=full_name&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) return '';
    const rows = await res.json().catch(() => []);
    return (Array.isArray(rows) && rows[0] && rows[0].full_name) || '';
  } catch {
    return '';
  }
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCorsHeaders(req, res, { methods: 'POST, OPTIONS', headers: 'Content-Type, Authorization' });
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Not configured.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const authHeader = (req.headers.authorization || req.headers.Authorization || '');
  const isAdmin = !!CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  // `deliver` only means anything in admin mode. Self-service always delivers
  // by email -- that IS the request the customer is making.
  //
  // The default is 'none' on purpose: an admin call that forgets the parameter
  // must not mail a customer. Opting IN to sending is a deliberate keystroke.
  const deliver = isAdmin
    ? String(body.deliver || req.query?.deliver || 'none').toLowerCase()
    : 'email';

  if (isAdmin && !['none', 'email'].includes(deliver)) {
    return res.status(400).json({ ok: false, error: "deliver must be 'none' (default, returns the link) or 'email'." });
  }

  const email = String(body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    // Admin gets a real error; self-service gets the generic body so a
    // malformed address is not distinguishable from an unknown one.
    return isAdmin
      ? res.status(400).json({ ok: false, error: 'A valid email is required.' })
      : res.status(200).json(GENERIC_RESPONSE);
  }

  if (!isAdmin) {
    try {
      // 5 per IP per hour. Generous for a confused customer, useless as a
      // mail cannon.
      await checkRateLimit(clientIpFromReq(req), 'invite-resend', 5, 60 * 60 * 1000);
    } catch (err) {
      if (err instanceof RateLimitError) {
        if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
        // Still the generic body: a 429 that only appears for real addresses
        // would leak membership.
        return res.status(200).json(GENERIC_RESPONSE);
      }
      console.warn('[invite-resend] rate limit check failed (allowing):', err && err.message);
    }
  }

  const user = await findAuthUser(email);
  if (!user) {
    console.log('[invite-resend] no account for supplied address; returning generic response');
    return isAdmin
      ? res.status(404).json({ ok: false, error: 'No auth user with that email.' })
      : res.status(200).json(GENERIC_RESPONSE);
  }

  // ---------------------------------------------------------------------
  // A durable invite is the right tool for exactly one situation: an account
  // that was provisioned for somebody who has never managed to get into it.
  // For a customer who already has a working password and simply forgot it, a
  // 30-day bearer token in an inbox is worse security than the standard
  // short-lived reset — and they don't need it, because they are sitting at
  // the page right now having just asked for the link. The original defect was
  // never "one-hour links"; it was an UNREQUESTED one-hour link being the only
  // credential an account ever had.
  //
  // So: never activated -> durable invite. Already activated -> ordinary
  // one-hour reset. Heath's admin mode can still force either.
  const neverActivated = !user.last_sign_in_at;
  if (!isAdmin && !neverActivated) {
    const actionLink = await invites.mintRecoveryLink(email);
    if (actionLink) {
      const sent = await invites.sendInviteEmail({
        to: email,
        fullName: await profileName(user.id),
        actionUrl: actionLink,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
        subject: 'Reset your Dossie password',
      });
      if (!sent.ok) console.error('[invite-resend] reset email failed for an activated account:', sent.error);
    } else {
      console.error('[invite-resend] could not mint a reset link for an activated account');
    }
    return res.status(200).json(GENERIC_RESPONSE);
  }

  // Per-address cooldown (self-service only -- Heath is not the abuse case).
  if (!isAdmin) {
    const live = await invites.findLiveInviteByEmail(email);
    if (live && live.email_sent_at && (Date.now() - new Date(live.email_sent_at).getTime()) < RESEND_COOLDOWN_MS) {
      console.log('[invite-resend] within cooldown for this address; not sending again');
      return res.status(200).json(GENERIC_RESPONSE);
    }
  }

  const invite = await invites.createInvite({
    userId: user.id,
    email,
    source: isAdmin ? 'admin_resend' : 'self_service',
  });

  if (!invite) {
    // account_invites is unavailable (migration not applied). Rather than fail,
    // fall back to today's mechanism so a customer asking for help still gets
    // something -- a one-hour link is bad, but it beats silence.
    const actionLink = await invites.mintRecoveryLink(email);
    if (!actionLink) {
      return isAdmin
        ? res.status(500).json({ ok: false, error: 'Could not mint a link (invites table unavailable and generate_link failed).' })
        : res.status(200).json(GENERIC_RESPONSE);
    }
    if (isAdmin && deliver === 'none') {
      return res.status(200).json({
        ok: true,
        mode: 'admin',
        delivered: false,
        durable: false,
        warning: 'account_invites table not found — this is a ONE-HOUR link. Apply supabase/migrations/20260918_account_invites_and_lifecycle_log.sql for durable invites.',
        url: actionLink,
      });
    }
    const fallbackSend = await invites.sendInviteEmail({
      to: email,
      fullName: await profileName(user.id),
      actionUrl: actionLink,
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    });
    return isAdmin
      ? res.status(fallbackSend.ok ? 200 : 500).json({ ok: fallbackSend.ok, mode: 'admin', delivered: fallbackSend.ok, durable: false })
      : res.status(200).json(GENERIC_RESPONSE);
  }

  // ---- Admin, deliver=none: hand Heath the link. Send nothing. ----
  if (isAdmin && deliver === 'none') {
    console.log('[invite-resend] admin minted invite (no delivery) for user', user.id);
    return res.status(200).json({
      ok: true,
      mode: 'admin',
      delivered: false,
      durable: true,
      expires_at: invite.expiresAt,
      url: invite.url,
      note: 'Nothing was emailed. Paste this into a personal note, or call again with deliver=email to have Dossie send the standard template.',
    });
  }

  // ---- Actually send ----
  const fullName = await profileName(user.id);
  const sent = await invites.sendInviteEmail({
    to: email,
    fullName,
    actionUrl: invite.url,
    expiresAt: invite.expiresAt,
    subject: 'Your Dossie sign-in link',
  });

  if (sent.ok) {
    await invites.markInviteEmailed(invite.inviteId, sent.id);
    await invites.logLifecycleEmail({
      userId: user.id,
      email,
      sequence: 'invite',
      step: isAdmin ? 'invite_resend_admin' : 'invite_resend',
      resendMessageId: sent.id,
      source: 'api/invite-resend',
      metadata: { invite_id: invite.inviteId },
    });
  } else {
    console.error('[invite-resend] send failed for user', user.id, sent.error);
  }

  return isAdmin
    ? res.status(sent.ok ? 200 : 500).json({
        ok: sent.ok,
        mode: 'admin',
        delivered: sent.ok,
        durable: true,
        expires_at: invite.expiresAt,
        resend_message_id: sent.id || null,
      })
    : res.status(200).json(GENERIC_RESPONSE);
};
