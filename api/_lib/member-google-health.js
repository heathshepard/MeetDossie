'use strict';

// api/_lib/member-google-health.js
// =========================================================================
// Per-member Google (Gmail) connection health. Reuses
// api/_lib/google-refresh-ladder.js's refreshWithLadder() EXACTLY as
// api/_lib/google-token-health.js does for Heath's own account — the only
// difference is `account` (the google_email to check) is looked up per
// member from their own user_integrations row instead of being the
// hardcoded GOOGLE_ACCOUNT constant. No parallel refresh/self-heal system.
//
// resolveGoogleClient (api/_lib/google-oauth-clients.js) picks the right
// client per row's oauth_provider automatically — every member-facing row
// here is 'google_gmail' (the CUSTOMER client), never 'google_calendar'
// (Heath-only INTERNAL client), but routing through the shared resolver
// keeps this file correct even if that ever changes.
//
// Owner: Carter, 2026-10-01 (member integrations build).

const { refreshWithLadder } = require('./google-refresh-ladder');
const { resolveGoogleClient } = require('./google-oauth-clients');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function loadGoogleEmailForUser(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/user_integrations`
    + `?select=google_email&user_id=eq.${encodeURIComponent(userId)}`
    + `&oauth_provider=eq.google_gmail&google_email=not.is.null&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!r.ok) return null;
  const rows = await r.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) ? rows[0].google_email : null;
}

/**
 * @param {string} userId
 * @returns {Promise<{status: 'never_connected'|'connected'|'expired'|'error', detail?: string, accountEmail?: string}>}
 */
async function checkMemberGoogleHealth(userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { status: 'error', detail: 'Supabase not configured.' };
  }
  let account;
  try {
    account = await loadGoogleEmailForUser(userId);
  } catch (err) {
    return { status: 'error', detail: `Could not read stored Google tokens: ${String(err && err.message || err).slice(0, 160)}` };
  }
  if (!account) {
    return { status: 'never_connected', detail: 'No Google account connected.' };
  }

  const result = await refreshWithLadder({
    account,
    supabaseUrl: SUPABASE_URL,
    serviceKey: SUPABASE_SERVICE_ROLE_KEY,
    resolveClient: resolveGoogleClient,
  });

  switch (result.outcome) {
    case 'healthy':
    case 'healthy_persist_failed':
      return { status: 'connected', accountEmail: account };
    case 'all_revoked':
      return { status: 'expired', detail: 'Google access was revoked. Reconnect in Settings.', accountEmail: account };
    case 'no_rows':
      return { status: 'never_connected', detail: 'No Google account connected.' };
    case 'client_config_error':
      return { status: 'error', detail: `Google OAuth client misconfigured (${result.errorCode || 'unknown'}).`, accountEmail: account };
    case 'misconfigured':
      return { status: 'error', detail: `Missing env var(s): ${(result.missingEnv || []).join(', ')}`, accountEmail: account };
    case 'query_failed':
      return { status: 'error', detail: 'Could not reach Supabase to check Google health.', accountEmail: account };
    case 'inconclusive':
      return { status: 'error', detail: 'Google health check was inconclusive — try again shortly.', accountEmail: account };
    default:
      return { status: 'error', detail: `Unrecognized ladder outcome: ${result.outcome}`, accountEmail: account };
  }
}

module.exports = { checkMemberGoogleHealth, loadGoogleEmailForUser };
