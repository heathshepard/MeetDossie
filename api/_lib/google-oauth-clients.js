'use strict';

// api/_lib/google-oauth-clients.js
//
// SINGLE SOURCE OF TRUTH for which Google Cloud OAuth client (CUSTOMER vs
// INTERNAL) owns which oauth_provider. Extracted 2026-09-29 from
// api/google-oauth-callback.js's inline CLIENT_BY_PROVIDER map after that
// exact split caused a live incident: api/_lib/google-refresh-ladder.js
// (built 2026-09-28, one day after the 2026-09-01 two-client split landed)
// didn't know about this map and refreshed EVERY user_integrations row for
// an account with the single CUSTOMER client_id/secret -- including
// 'google_calendar' rows that were only ever issued under the INTERNAL
// client. Google's token endpoint correctly rejected those with
// unauthorized_client, and because that verdict used to abort the whole
// ladder immediately, it also blocked recovery of the 'google_gmail' rows
// that WOULD have refreshed fine under the CUSTOMER client. Found live
// 2026-09-29: alert_state's google_token_client_config_error fired ~19h
// after this file's own alarm shipped, on exactly this cross-wiring.
//
// The provider->client mapping itself is UNCHANGED from what
// google-oauth-callback.js has run since the 2026-09-01 split -- this file
// only stops that map from being duplicated (and silently drifting) at
// every new call site. google-oauth-callback.js, google-refresh-ladder.js
// (via api/_lib/google-token-health.js and api/gmail-refresh.js) all read
// from here now.
//
// Owner: Atlas, 2026-09-29.

function buildClients(env = process.env) {
  const CUSTOMER_CLIENT = {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
  };
  const INTERNAL_CLIENT = {
    clientId: env.GOOGLE_INTERNAL_CLIENT_ID,
    clientSecret: env.GOOGLE_INTERNAL_CLIENT_SECRET,
    redirectUri: env.GOOGLE_INTERNAL_OAUTH_REDIRECT_URI,
  };
  // google_calendar -> INTERNAL (calendar.readonly + gmail.readonly/send/
  // compose, gated to heath.shepard@kw.com, started by
  // api/google-internal-oauth-init.js).
  // google_gmail / google_youtube -> CUSTOMER (read-only scopes, any user).
  // Anything unrecognized falls back to CUSTOMER -- matches pre-split
  // behavior for any state row / integrations row this doesn't recognize.
  const CLIENT_BY_PROVIDER = {
    google_calendar: INTERNAL_CLIENT,
    google_gmail: CUSTOMER_CLIENT,
    google_youtube: CUSTOMER_CLIENT,
  };
  return { CUSTOMER_CLIENT, INTERNAL_CLIENT, CLIENT_BY_PROVIDER };
}

function clientForProvider(provider, env = process.env) {
  const { CLIENT_BY_PROVIDER, CUSTOMER_CLIENT } = buildClients(env);
  return CLIENT_BY_PROVIDER[provider] || CUSTOMER_CLIENT;
}

module.exports = { buildClients, clientForProvider };
