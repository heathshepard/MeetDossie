'use strict';

// Vercel Serverless Function: GET /api/invite?token=...
//
// The front door for a server-provisioned account.
//
// WHY THIS ROUTE EXISTS
//   Until now the link in a new customer's welcome email WAS a Supabase
//   recovery link: one shot, one hour, generated at provisioning time. Whether
//   a paying customer could ever sign in came down to whether they happened to
//   open their email inside a 60-minute window they were never told about.
//   Three of eight paying customers lost that race and have never held a
//   session. See docs/ACTIVATION-FORENSICS-2026-09-18.md.
//
//   This route inverts the ordering. The emailed link is a durable token we
//   own (30 days, re-clickable). The one-hour Supabase link is minted HERE, at
//   the moment of the click, and immediately spent on a redirect. The
//   perishable thing is created only when someone is standing in front of it,
//   so there is no window left to miss.
//
// FLOW
//   1. Customer clicks the emailed URL.
//   2. We hash the token and look it up. Valid -> mint a fresh recovery link.
//   3. 302 to that link. GoTrue hands the browser session tokens in the URL
//      fragment; /set-password.html picks them up and shows the password form.
//   4. Expired/unknown/already-completed -> 302 to /forgot-password.html with a
//      `reason` the page explains in plain language, where they can get a new
//      link themselves. Never a dead end, never "email Heath".
//
// WHAT THIS ROUTE DOES NOT DO
//   It sends no email, ever. Redeeming an invite writes only to our own
//   account_invites row (redeem_count / last_redeemed_at / consumed_at). It
//   touches no profile, no subscription, and no other customer's data.
//
// Owner: 2026-09-18.

const invites = require('./_lib/account-invites');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');

const SITE_URL = invites.SITE_URL;

// Where a customer lands when the token will not work. Always a page that can
// get them back in without a human: /forgot-password.html emails a fresh link
// on demand. `reason` drives the explanatory banner there.
function recoveryUrl(reason) {
  return `${SITE_URL}/forgot-password.html?reason=${encodeURIComponent(reason)}`;
}

function redirect(res, location) {
  // 302, not 301: browsers cache 301s aggressively and a cached redirect on an
  // invite URL would be genuinely hard to explain to a customer on the phone.
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  // The token is in the query string; keep it out of any downstream Referer.
  res.setHeader('Referrer-Policy', 'no-referrer');
  return res.status(302).end();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  // Brute-forcing a 256-bit token is not a real threat, but an unauthenticated
  // route that calls GoTrue's admin API on every hit is worth a ceiling.
  try {
    await checkRateLimit(clientIpFromReq(req), 'invite-redeem', 30, 60 * 60 * 1000);
  } catch (err) {
    if (err instanceof RateLimitError) {
      if (err.retryAfterSeconds) res.setHeader('Retry-After', String(err.retryAfterSeconds));
      return redirect(res, recoveryUrl('rate_limited'));
    }
    // A rate-limiter outage must never lock a customer out of their account.
    console.warn('[invite] rate limit check failed (allowing):', err && err.message);
  }

  const token = typeof req.query?.token === 'string'
    ? req.query.token
    : (Array.isArray(req.query?.token) ? req.query.token[0] : '');

  if (!token) return redirect(res, recoveryUrl('missing_invite'));

  let lookup;
  try {
    lookup = await invites.lookupInvite(token);
  } catch (err) {
    console.error('[invite] lookupInvite threw:', err && err.message);
    return redirect(res, recoveryUrl('invite_error'));
  }

  if (!lookup.ok) {
    // Deliberately NOT distinguishing 'unknown' from 'expired' in the URL for
    // an unknown token -- that would confirm which tokens exist. Both land on
    // the same self-service page; only the wording differs for cases where we
    // already know the person.
    const reasonMap = {
      expired: 'invite_expired',
      completed: 'already_set',
      unavailable: 'invite_unavailable',
      unknown: 'invite_expired',
      no_token: 'missing_invite',
    };
    console.log('[invite] redeem refused:', lookup.reason);
    return redirect(res, recoveryUrl(reasonMap[lookup.reason] || 'invite_expired'));
  }

  const invite = lookup.invite;

  // Mint the short-lived credential NOW -- this is the whole point of the
  // route. generate_link returns a link; it does not deliver one, so nothing
  // is emailed here.
  const actionLink = await invites.mintRecoveryLink(invite.email);
  if (!actionLink) {
    console.error('[invite] could not mint recovery link for invite', invite.id);
    return redirect(res, recoveryUrl('invite_error'));
  }

  // Bookkeeping only, and never allowed to block the redirect.
  await invites.markRedeemed(invite.id);

  console.log('[invite] redeemed invite', invite.id, '-> set-password');
  return redirect(res, actionLink);
};
