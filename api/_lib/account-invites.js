'use strict';

// api/_lib/account-invites.js
//
// WHY THIS EXISTS
//   Read docs/ACTIVATION-FORENSICS-2026-09-18.md first. Short version: every
//   Dossie account is created server-side with a random 48-character scratch
//   password that nobody -- not the customer, not Heath -- ever sees. The
//   customer's ONLY credential is a single Supabase recovery link, emailed
//   once, valid for one hour. Three paying customers never set a password at
//   all. They were never given a working way in.
//
//   A one-hour, one-shot link is a fine SECOND factor on a password reset the
//   user just asked for. It is an indefensible FIRST and ONLY credential on an
//   account somebody just paid for, because every ordinary thing that happens
//   to email -- read on a phone at dinner, quarantined by a brokerage filter,
//   opened Monday morning -- permanently bricks the account.
//
// THE FIX
//   Split the durable credential from the short-lived session grant.
//
//     1. We mint OUR OWN invite token, store only its SHA-256, and email a URL
//        that points at /api/invite?token=... That token is good for 30 days
//        and can be redeemed more than once.
//     2. Clicking it exchanges the durable token for a FRESH Supabase recovery
//        link, minted at click time, and redirects straight into it.
//
//   The one-hour window still exists -- GoTrue's expiry is not configurable
//   per-link -- but it now opens only at the instant the customer is sitting
//   in front of the page. There is no window to miss. And if the 30 days do
//   lapse, /api/invite redirects to the self-service reset page rather than
//   showing a dead end, so recovery still needs no human.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO
//   Nothing in here sends email on import, on a timer, or as a side effect of
//   creating an invite. `createInvite` writes a row and returns a URL.
//   `sendInviteEmail` is the only function that talks to Resend and it is only
//   ever called from an explicit request handler. See the module footer for
//   the full list of what would have to happen for a real customer to receive
//   anything.
//
// DEGRADATION
//   Every function tolerates `public.account_invites` not existing yet (the
//   migration in supabase/migrations/20260918_account_invites_and_lifecycle_log.sql
//   has NOT been applied). `createInvite` returns null instead of throwing, and
//   each caller falls back to today's behavior -- a direct one-hour link. That
//   means this code is safe to deploy before the migration runs: it degrades to
//   the status quo rather than breaking provisioning.
//
// Owner: 2026-09-18.

const crypto = require('crypto');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

const SITE_URL = (process.env.DOSSIE_SITE_URL || 'https://meetdossie.com').replace(/\/$/, '');
const SET_PASSWORD_REDIRECT = `${SITE_URL}/set-password.html`;

// 30 days. Long enough to survive a vacation, a quarantine queue and a
// forwarded-to-personal-address detour; short enough that a year-old email in
// a compromised mailbox is not a live key.
const DEFAULT_TTL_DAYS = 30;

const INVITE_TABLE = 'account_invites';
const LEDGER_TABLE = 'lifecycle_email_log';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_BLUSH_DEEP = '#D4A0A0';
const BRAND_MUTED = '#9CA8B4';

// ---------------------------------------------------------------------------
// Supabase REST helpers
// ---------------------------------------------------------------------------

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const err = new Error(`Supabase ${init.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

// PostgREST answers 404 (and PGRST205) for a table that does not exist. Treat
// that as "migration not applied yet", never as a hard failure -- provisioning
// must keep working on today's path until the migration lands.
function isMissingTable(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  const body = String(err.body || err.message || '');
  return /PGRST205|does not exist|Could not find the table/i.test(body);
}

// ---------------------------------------------------------------------------
// Token handling
// ---------------------------------------------------------------------------

// 32 bytes = 256 bits of entropy, base64url. Unguessable, and short enough to
// survive being wrapped by an email client without a line break in the middle.
function generateRawToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

function inviteUrl(rawToken) {
  return `${SITE_URL}/api/invite?token=${encodeURIComponent(rawToken)}`;
}

// ---------------------------------------------------------------------------
// GoTrue: mint a short-lived recovery link
// ---------------------------------------------------------------------------

// The admin generate_link endpoint RETURNS a link; it does not deliver one.
// Calling this sends no email. (Confirmed against the live project 2026-09-18
// with a throwaway @example.com address -- see scripts/verify-invite-flow.js.)
//
// The GoTrue HTTP body wants snake_case `redirect_to` at the top level.
// `options.redirectTo` is the JS SDK's shape, not the wire shape -- nesting it
// silently drops the redirect and strands the user on a blank page. That bug
// is already commented in api/stripe-webhook.js; this is the single copy now.
async function mintRecoveryLink(email) {
  if (!email) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'recovery',
        email,
        redirect_to: SET_PASSWORD_REDIRECT,
      }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      console.error('[account-invites] generate_link non-OK', res.status, text.slice(0, 300));
      return null;
    }
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { return null; }
    return (data && (data.action_link || (data.properties && data.properties.action_link))) || null;
  } catch (err) {
    console.error('[account-invites] generate_link threw:', err && err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Invite lifecycle
// ---------------------------------------------------------------------------

/**
 * Mint a durable invite. Writes a row; sends NOTHING.
 *
 * @returns {Promise<{token: string, url: string, inviteId: string, expiresAt: string}|null>}
 *          null means the invites table is not available -- the caller must
 *          fall back to a direct one-hour link rather than leaving the customer
 *          with no credential at all.
 */
async function createInvite({ userId, email, source, ttlDays }) {
  if (!userId || !email) return null;
  const raw = generateRawToken();
  const expiresAt = new Date(Date.now() + (Number(ttlDays) || DEFAULT_TTL_DAYS) * 86400000).toISOString();
  try {
    const rows = await rest(`/rest/v1/${INVITE_TABLE}`, {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        user_id: userId,
        email: String(email).toLowerCase(),
        token_hash: hashToken(raw),
        source: source || 'unknown',
        expires_at: expiresAt,
      }),
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (!row || !row.id) return null;
    // The raw token is returned to the caller and never persisted or logged.
    return { token: raw, url: inviteUrl(raw), inviteId: row.id, expiresAt };
  } catch (err) {
    if (isMissingTable(err)) {
      console.warn('[account-invites] account_invites table not present — caller should fall back to a direct recovery link');
      return null;
    }
    console.error('[account-invites] createInvite failed:', err && err.message);
    return null;
  }
}

/**
 * Look up an invite by raw token and decide whether it may be redeemed.
 * Read-only: does not mutate, does not send.
 *
 * @returns {Promise<{ok: boolean, reason?: string, invite?: object}>}
 *          reason is one of: 'no_token' | 'unknown' | 'expired' | 'completed'
 *          | 'unavailable'
 */
async function lookupInvite(rawToken) {
  if (!rawToken) return { ok: false, reason: 'no_token' };
  let rows;
  try {
    rows = await rest(
      `/rest/v1/${INVITE_TABLE}?token_hash=eq.${encodeURIComponent(hashToken(rawToken))}` +
      '&select=id,user_id,email,expires_at,consumed_at,completed_at,redeem_count&limit=1'
    );
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, reason: 'unavailable' };
    console.error('[account-invites] lookupInvite failed:', err && err.message);
    return { ok: false, reason: 'unavailable' };
  }
  const invite = Array.isArray(rows) ? rows[0] : null;
  // Deliberately identical shape for "no such token" and "wrong token" so the
  // endpoint cannot be used to confirm that an invite exists.
  if (!invite) return { ok: false, reason: 'unknown' };

  // completed_at means the customer already set a password. The token stops
  // being a credential at that point -- they sign in normally or reset.
  if (invite.completed_at) return { ok: false, reason: 'completed', invite };

  if (new Date(invite.expires_at).getTime() <= Date.now()) {
    return { ok: false, reason: 'expired', invite };
  }

  // NOTE: consumed_at is recorded but is NOT a bar to redemption. A customer
  // who clicks the link, gets interrupted, and comes back must still get in.
  // Single-use was a contributing cause of the original failure, not a
  // safeguard -- Terry Katz held exactly one 42-second session and then had
  // nothing left to click.
  return { ok: true, invite };
}

/**
 * Record a redemption. Mutates only our own invite row.
 */
async function markRedeemed(inviteId) {
  if (!inviteId) return;
  const now = new Date().toISOString();
  try {
    // consumed_at is set once (first redemption); last_redeemed_at every time.
    const rows = await rest(
      `/rest/v1/${INVITE_TABLE}?id=eq.${encodeURIComponent(inviteId)}&select=consumed_at,redeem_count&limit=1`
    );
    const prev = Array.isArray(rows) ? rows[0] : null;
    const patch = {
      last_redeemed_at: now,
      redeem_count: ((prev && prev.redeem_count) || 0) + 1,
    };
    if (!prev || !prev.consumed_at) patch.consumed_at = now;
    await rest(`/rest/v1/${INVITE_TABLE}?id=eq.${encodeURIComponent(inviteId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    // Never fail a redemption because bookkeeping failed -- getting the
    // customer in is the point.
    console.warn('[account-invites] markRedeemed failed (non-fatal):', err && err.message);
  }
}

/**
 * Retire every live invite for a user once they hold a real password.
 * Called by /api/activation-event (set-password success) so an old emailed
 * link stops being a live credential the moment it is no longer needed.
 */
async function completeInvitesForUser(userId) {
  if (!userId) return { ok: false, reason: 'no_user' };
  try {
    await rest(
      `/rest/v1/${INVITE_TABLE}?user_id=eq.${encodeURIComponent(userId)}&completed_at=is.null`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ completed_at: new Date().toISOString() }),
      }
    );
    return { ok: true };
  } catch (err) {
    if (isMissingTable(err)) return { ok: false, reason: 'unavailable' };
    console.warn('[account-invites] completeInvitesForUser failed:', err && err.message);
    return { ok: false, reason: 'error' };
  }
}

/**
 * The most recent live invite for an email, if any. Used by the resend path so
 * a customer spamming "resend" does not accumulate dozens of live tokens.
 */
async function findLiveInviteByEmail(email) {
  if (!email) return null;
  try {
    const rows = await rest(
      `/rest/v1/${INVITE_TABLE}?email=eq.${encodeURIComponent(String(email).toLowerCase())}` +
      '&completed_at=is.null' +
      `&expires_at=gt.${encodeURIComponent(new Date().toISOString())}` +
      '&select=id,user_id,email,created_at,expires_at,email_sent_at' +
      '&order=created_at.desc&limit=1'
    );
    return Array.isArray(rows) ? (rows[0] || null) : null;
  } catch (err) {
    if (isMissingTable(err)) return null;
    console.warn('[account-invites] findLiveInviteByEmail failed:', err && err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function firstNameOf(fullName) {
  return (String(fullName || '').trim().split(/\s+/)[0]) || 'there';
}

/**
 * The invite email body.
 *
 * Copy change that matters: the old template said "This link expires in 1 hour.
 * If it's expired, contact us at heath@meetdossie.com and we'll send a new
 * one." That sentence is the failure written down -- it tells a paying customer
 * their way in is perishable and that recovery requires a human. The new copy
 * states a 30-day window and names the self-service route.
 */
function inviteEmailHtml({ actionUrl, fullName, expiresAt }) {
  const name = firstNameOf(fullName);
  const days = expiresAt
    ? Math.max(1, Math.round((new Date(expiresAt).getTime() - Date.now()) / 86400000))
    : DEFAULT_TTL_DAYS;
  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 48px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-size: 12px; letter-spacing: 2px; color: #A48531; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 36px; line-height: 1.15; margin: 0 0 16px; color: ${BRAND_NAVY};">${name}, you're in.</h1>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">Your Dossie account is ready. Pick a password and you can start dropping contracts in right away.</p>
  <a href="${actionUrl}" style="display: inline-block; padding: 16px 32px; background: ${BRAND_BLUSH_DEEP}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px;">Set Your Password</a>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 28px 0 0;">Once you're in: open any deal you're working &mdash; even a closed one &mdash; and drop the contract in. She reads it, pulls every TREC deadline with the paragraph it came from, and lays your file out in order.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 18px 0 0;">Reply to this email any time. I read every one.</p>
  <p style="font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 18px 0 4px;">Heath</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.6; margin: 0;">heath@meetdossie.com<br>Licensed Texas REALTOR | Founder, Dossie</p>
  <p style="margin-top: 32px; font-size: 13px; color: ${BRAND_MUTED}; line-height: 1.6;">This link stays good for ${days} days, and you can use it more than once. If it ever stops working, go to <a href="${SITE_URL}/forgot-password.html" style="color: ${BRAND_BLUSH_DEEP};">meetdossie.com/forgot-password</a> and we'll send a fresh one straight away &mdash; no need to wait on anybody.</p>
</div>`;
}

/**
 * The ONLY function in this module that contacts Resend.
 *
 * @returns {Promise<{ok: boolean, id?: string, error?: string}>}
 */
async function sendInviteEmail({ to, fullName, actionUrl, expiresAt, subject }) {
  if (!RESEND_API_KEY) {
    console.error('[account-invites] RESEND_API_KEY not set — cannot email', to);
    return { ok: false, error: 'resend_not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Dossie <dossie@meetdossie.com>',
        to: [to],
        subject: subject || "You're in — set your Dossie password",
        html: inviteEmailHtml({ actionUrl, fullName, expiresAt }),
        bcc: ['heath@meetdossie.com'],
      }),
    });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!res.ok) {
      console.error('[account-invites] Resend failed', res.status, text.slice(0, 300));
      return { ok: false, error: `resend_${res.status}` };
    }
    return { ok: true, id: body && body.id };
  } catch (err) {
    console.error('[account-invites] Resend threw:', err && err.message);
    return { ok: false, error: 'resend_threw' };
  }
}

async function markInviteEmailed(inviteId, resendMessageId) {
  if (!inviteId) return;
  try {
    await rest(`/rest/v1/${INVITE_TABLE}?id=eq.${encodeURIComponent(inviteId)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        email_sent_at: new Date().toISOString(),
        resend_message_id: resendMessageId || null,
      }),
    });
  } catch (err) {
    console.warn('[account-invites] markInviteEmailed failed (non-fatal):', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle ledger
// ---------------------------------------------------------------------------

/**
 * Append to lifecycle_email_log. Call this ONLY after Resend has accepted a
 * message -- a row here is the project's definition of "genuinely sent", and
 * writing one speculatively would reintroduce exactly the ambiguity that made
 * the activation_email_*_sent_at columns worthless.
 *
 * A 23505 conflict on the (user_id, sequence, step) unique index is NOT an
 * error — it is the index doing its job and telling us the step was already
 * recorded. Note that `Prefer: resolution=ignore-duplicates` does not suppress
 * it here: PostgREST only applies that when an `on_conflict` target is named,
 * and this constraint is a PARTIAL unique index (WHERE user_id IS NOT NULL),
 * which cannot be used as an ON CONFLICT target at all. So we catch the
 * conflict explicitly and report success. Logging it as a failure would train
 * whoever reads these logs to ignore them.
 */
function isDuplicateRow(err) {
  const body = String((err && (err.body || err.message)) || '');
  return (err && err.status === 409) || body.includes('23505');
}

async function logLifecycleEmail({ userId, email, sequence, step, resendMessageId, source, metadata }) {
  try {
    await rest(`/rest/v1/${LEDGER_TABLE}`, {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        user_id: userId || null,
        email: String(email || '').toLowerCase(),
        sequence,
        step,
        resend_message_id: resendMessageId || null,
        source: source || 'unknown',
        metadata: metadata || {},
      }),
    });
    return { ok: true, recorded: true };
  } catch (err) {
    if (isDuplicateRow(err)) return { ok: true, recorded: false, reason: 'already_logged' };
    if (isMissingTable(err)) return { ok: false, reason: 'unavailable' };
    console.warn('[account-invites] logLifecycleEmail failed (non-fatal):', err && err.message);
    return { ok: false, reason: 'error' };
  }
}

/**
 * Which lifecycle steps this set of users has a LEDGER row for.
 * @returns {Promise<Map<string, Set<string>>>} user_id -> Set('activation:email_1', ...)
 *          An empty map is returned when the ledger table does not exist, and
 *          callers must treat "no ledger data" as "unknown", never as
 *          "definitely not sent" -- guessing the latter is how you mail five
 *          people who have been silent for four months.
 */
async function fetchLedgerSteps(userIds) {
  const out = new Map();
  if (!Array.isArray(userIds) || userIds.length === 0) return out;
  try {
    const rows = await rest(
      `/rest/v1/${LEDGER_TABLE}?select=user_id,sequence,step&user_id=in.(${userIds.join(',')})&limit=2000`
    );
    for (const r of (Array.isArray(rows) ? rows : [])) {
      if (!out.has(r.user_id)) out.set(r.user_id, new Set());
      out.get(r.user_id).add(`${r.sequence}:${r.step}`);
    }
  } catch (err) {
    if (!isMissingTable(err)) {
      console.warn('[account-invites] fetchLedgerSteps failed:', err && err.message);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// WHAT WOULD HAVE TO HAPPEN FOR A REAL CUSTOMER TO RECEIVE EMAIL FROM HERE
//
//   sendInviteEmail() is the only outbound call in this file. It has exactly
//   three callers, and every one of them needs an inbound HTTP request that
//   someone deliberately makes:
//
//     1. api/stripe-webhook.js / api/signup.js / api/complete-onboarding.js
//        -- a NEW person pays or redeems an invite code. This is the intended
//        path and it only fires for someone who just signed up.
//     2. api/invite-resend.js, self-service -- the customer themselves types
//        their own address into the reset form.
//     3. api/invite-resend.js, admin mode -- Heath calls it with CRON_SECRET
//        AND passes deliver=email. The default is deliver=none, which returns
//        the link for him to paste into a personal note and sends nothing.
//
//   No cron calls it. No import triggers it. Nothing in this branch has been
//   run against a real address.
// ---------------------------------------------------------------------------

module.exports = {
  createInvite,
  lookupInvite,
  markRedeemed,
  markInviteEmailed,
  completeInvitesForUser,
  findLiveInviteByEmail,
  mintRecoveryLink,
  sendInviteEmail,
  inviteEmailHtml,
  logLifecycleEmail,
  fetchLedgerSteps,
  inviteUrl,
  hashToken,
  generateRawToken,
  isMissingTable,
  DEFAULT_TTL_DAYS,
  SET_PASSWORD_REDIRECT,
  SITE_URL,
};
