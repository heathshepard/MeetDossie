'use strict';

// api/_lib/google-oauth-clients.js
// =========================================================================
// ONE place that maps a `user_integrations.oauth_provider` value to the
// Google Cloud OAuth client that issued (and must be used to refresh) its
// tokens.
//
// THE BUG THIS FIXES (found 2026-09-29): the 2026-09-01 SV-ENG-OAUTH-SPLIT
// split one combined Google client into two —
//   - CUSTOMER  (GOOGLE_CLIENT_ID/SECRET)          -> provider google_gmail,
//     google_youtube. Every paying customer's "Connect Gmail" consent.
//   - INTERNAL  (GOOGLE_INTERNAL_CLIENT_ID/SECRET) -> provider
//     google_calendar. Heath's own tooling only (calendar.readonly +
//     gmail.send/compose/readonly) — see api/google-internal-oauth-init.js.
// api/google-oauth-callback.js already encodes this mapping correctly (it's
// the ONLY thing minting tokens, so it has to). But every CONSUMER that
// later refreshes a stored token — api/jarvis-calendar.js,
// api/cron-relevance-watcher.js, api/gmail-refresh.js (and therefore
// scripts/kw-mail.py's OAuth fallback), api/_lib/google-refresh-ladder.js,
// api/_lib/gmail-oauth.js — kept reading the flat GOOGLE_CLIENT_ID/SECRET
// module constants, i.e. always the CUSTOMER client, regardless of which
// client actually minted the row it was refreshing.
//
// Heath's own heath.shepard@kw.com account re-consented 2026-09-28 through
// the INTERNAL flow (oauth_provider='google_calendar'), so every one of
// those consumers started sending that row's refresh_token to the CUSTOMER
// client. Google's real response to "right refresh_token, wrong client" is
// `unauthorized_client` (a client_config-class error, see
// google-refresh-ladder.js CLIENT_CONFIG_ERRORS) — not `invalid_grant` —
// which read exactly like a dead Vercel env var and sent every prior
// investigation down the "is GOOGLE_CLIENT_ID stale" path. It wasn't: the
// customer client is fine (confirmed 2026-09-29 by refreshing it with a
// bogus token and getting `invalid_grant`, proving Google accepted the
// client itself). The wrong CLIENT was just being paired with the token.
//
// Import resolveGoogleClient() everywhere a stored token gets refreshed.
// Never re-read GOOGLE_INTERNAL_CLIENT_ID/SECRET directly outside this file
// and google-oauth-callback.js (which owns minting) — that sprinkling is
// exactly how this broke the first time.
//
// Owner: Atlas, 2026-09-29 (fix/google-client-repoint-0929).

const CUSTOMER_CLIENT_LABEL = 'customer';
const INTERNAL_CLIENT_LABEL = 'internal';

function readCustomerClient() {
  return {
    label: CUSTOMER_CLIENT_LABEL,
    clientId: process.env.GOOGLE_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || null,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || null,
    missingEnvNames: [
      ...(process.env.GOOGLE_CLIENT_ID ? [] : ['GOOGLE_CLIENT_ID']),
      ...(process.env.GOOGLE_CLIENT_SECRET ? [] : ['GOOGLE_CLIENT_SECRET']),
    ],
  };
}

function readInternalClient() {
  return {
    label: INTERNAL_CLIENT_LABEL,
    clientId: process.env.GOOGLE_INTERNAL_CLIENT_ID || null,
    clientSecret: process.env.GOOGLE_INTERNAL_CLIENT_SECRET || null,
    redirectUri: process.env.GOOGLE_INTERNAL_OAUTH_REDIRECT_URI || null,
    missingEnvNames: [
      ...(process.env.GOOGLE_INTERNAL_CLIENT_ID ? [] : ['GOOGLE_INTERNAL_CLIENT_ID']),
      ...(process.env.GOOGLE_INTERNAL_CLIENT_SECRET ? [] : ['GOOGLE_INTERNAL_CLIENT_SECRET']),
    ],
  };
}

// Same provider -> client mapping api/google-oauth-callback.js uses to mint
// tokens in the first place. Keep these two in sync; this file is the one
// to change if a new provider/client is ever added.
const PROVIDER_TO_READER = {
  google_calendar: readInternalClient,
  google_gmail: readCustomerClient,
  google_youtube: readCustomerClient,
};

/**
 * Resolves which Google OAuth client (customer or internal) owns a given
 * user_integrations.oauth_provider value, reading live from process.env so
 * callers never cache a stale pair across a cold start.
 *
 * @param {string} provider - e.g. 'google_calendar', 'google_gmail'
 * @returns {{label: string, clientId: string|null, clientSecret: string|null,
 *            redirectUri: string|null, missingEnvNames: string[]}}
 *   missingEnvNames is non-empty when the client this provider needs isn't
 *   fully configured in this environment — callers must treat that as a
 *   config error for rows of that provider, not attempt the refresh.
 *   Unknown providers fall back to the customer client (matches
 *   google-oauth-callback.js's documented fallback for any oauth_states row
 *   it doesn't recognize).
 */
function resolveGoogleClient(provider) {
  const reader = PROVIDER_TO_READER[provider] || readCustomerClient;
  return reader();
}

module.exports = { resolveGoogleClient, CUSTOMER_CLIENT_LABEL, INTERNAL_CLIENT_LABEL };
