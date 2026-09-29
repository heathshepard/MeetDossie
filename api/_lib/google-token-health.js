'use strict';

// api/_lib/google-token-health.js
//
// Consumed by api/_lib/silence-alarm.js's runAllChecks() -- same daily
// heartbeat cron, same alert_state dedup, same Telegram path as every other
// silent-failure detector (see api/cron-silence-alarm.js). No new
// standalone Vercel cron needed.
//
// THE INCIDENT THIS CLOSES (2026-09-28): the Google refresh token for
// heath.shepard@kw.com died 3 times, 7 days apart (Google's Testing-mode
// refresh-token expiry), and nothing alerted -- Heath found out by asking.
// scripts/preflight-check.js's checkGmailSend() infers health from
// `scopes` + `expires_at`, which looked fine on all three dead rows. The
// ONLY thing that actually proves a refresh token still works is
// attempting the refresh -- so that's the only thing this file trusts.
//
// SCOPE CHANGE mid-build (Heath, direct quote): "i dont want it to jsut
// message me. i want it to autofix if it fails." This module is now a
// thin wrapper: the actual recovery ladder (try every stored credential,
// retry transient failures, persist a working token, prune confirmed-dead
// rows) lives in api/_lib/google-refresh-ladder.js and runs FIRST. This
// file only turns a ladder outcome that could NOT self-heal into an alert
// condition -- alerting is the last resort, not the deliverable.
//
// SECURITY: never put refresh_token, access_token, or client_secret in any
// returned field -- this repo is public and these conditions can end up in
// a Telegram message. Only Google's categorical error code/description and
// row metadata (id, updated_at) are safe to surface.
//
// FOLLOW-UP, 2026-09-29: heath.shepard@kw.com has user_integrations rows
// under TWO different Google Cloud OAuth clients (the 2026-09-01
// CUSTOMER/INTERNAL split -- api/_lib/google-oauth-clients.js). This file
// used to pass a single client_id/client_secret pair for every row
// regardless of which client actually issued it, which produced exactly
// the "unauthorized_client" false alarm this comment is now next to (the
// newest row was 'google_calendar'/INTERNAL, refreshed with the CUSTOMER
// pair). Now builds a clientsByProvider map via google-oauth-clients.js and
// lets api/_lib/google-refresh-ladder.js resolve the right pair per row.
//
// Owner: Atlas, 2026-09-28 (per-provider client fix 2026-09-29).

const { refreshWithLadder } = require('./google-refresh-ladder.js');
const { buildClients } = require('./google-oauth-clients.js');

// Single-tenant today -- mirrors scripts/preflight-check.js's KW_ACCOUNT and
// scripts/kw-mail.py's ACCOUNT.
const GOOGLE_ACCOUNT = 'heath.shepard@kw.com';

const THE_FIX = 'Open meetdossie.com/myjarvis and click Connect Google Calendar to re-consent.';

/**
 * Runs the self-heal ladder and returns condition object(s) in the exact
 * shape api/_lib/silence-alarm.js's other check*() functions use -- []
 * when healthy (including self-healed this run), or [{ key, message, ... }]
 * describing exactly one failure state the ladder could not fix on its own.
 *
 * Every distinct failure gets its own `key` so alert_state's per-key
 * cooldown (api/_lib/silence-alarm.js shouldFire/markFired) can never let
 * one failure type's cooldown suppress a DIFFERENT, newer failure type --
 * e.g. going from "all revoked" to "can't even reach Supabase" still
 * alerts immediately, it doesn't inherit invalid_grant's cooldown.
 *
 * @param {object} [opts]
 * @param {Function} [opts.fetchImpl] - injectable for tests; defaults to global fetch
 * @param {Function} [opts.sleepImpl] - injectable for tests; defaults to real setTimeout
 * @param {object} [opts.env] - injectable env override for tests. Recognizes
 *   clientId/clientSecret (CUSTOMER client -- also the fallback default) and
 *   internalClientId/internalClientSecret (INTERNAL client, google_calendar
 *   rows only); any key omitted falls back to the matching real env var.
 */
async function checkGoogleTokenHealth(opts = {}) {
  const env = opts.env || {};
  const customerClientId = 'clientId' in env ? env.clientId : process.env.GOOGLE_CLIENT_ID;
  const customerClientSecret = 'clientSecret' in env ? env.clientSecret : process.env.GOOGLE_CLIENT_SECRET;

  // Same CUSTOMER/INTERNAL split google-oauth-callback.js exchanges tokens
  // with -- built from the SAME resolved (test-overridable) values, not raw
  // process.env, so injecting env.clientId/clientSecret in a test actually
  // takes effect for the 'google_gmail'/'google_youtube' rows that map to
  // the CUSTOMER client below.
  const { CLIENT_BY_PROVIDER } = buildClients({
    GOOGLE_CLIENT_ID: customerClientId,
    GOOGLE_CLIENT_SECRET: customerClientSecret,
    GOOGLE_INTERNAL_CLIENT_ID: 'internalClientId' in env ? env.internalClientId : process.env.GOOGLE_INTERNAL_CLIENT_ID,
    GOOGLE_INTERNAL_CLIENT_SECRET: 'internalClientSecret' in env ? env.internalClientSecret : process.env.GOOGLE_INTERNAL_CLIENT_SECRET,
  });
  const clientsByProvider = {
    google_calendar: CLIENT_BY_PROVIDER.google_calendar,
    google_gmail: CLIENT_BY_PROVIDER.google_gmail,
    google_youtube: CLIENT_BY_PROVIDER.google_youtube,
  };

  const result = await refreshWithLadder({
    account: GOOGLE_ACCOUNT,
    fetchImpl: opts.fetchImpl,
    sleepImpl: opts.sleepImpl,
    supabaseUrl: 'supabaseUrl' in env ? env.supabaseUrl : process.env.SUPABASE_URL,
    serviceKey: 'serviceKey' in env ? env.serviceKey : process.env.SUPABASE_SERVICE_ROLE_KEY,
    clientId: customerClientId,
    clientSecret: customerClientSecret,
    clientsByProvider,
  });

  switch (result.outcome) {
    case 'healthy':
      // Either it was already fine, or the ladder just fixed it by walking
      // to an older row and/or pruning dead ones. Self-heal succeeded --
      // nothing for Heath to do, so nothing to say.
      return [];

    case 'healthy_persist_failed':
      return [{
        key: 'google_token_persist_failed',
        message: `Google token refresh for ${GOOGLE_ACCOUNT} succeeded (row ${result.winningRowId}) but writing the new token back to Supabase failed: ${result.persistError}. `
          + `The current access token works for now but the fix won't stick -- check Supabase connectivity / user_integrations write access.`,
      }];

    case 'misconfigured':
      return [{
        key: 'google_token_check_misconfigured',
        message: `Google token self-heal cannot run -- missing env var(s): ${result.missingEnv.join(', ')}. `
          + `The check itself is broken, not necessarily the token. Fix the Vercel env config.`,
      }];

    case 'query_failed':
      return [{
        key: 'google_token_check_query_failed',
        message: `Google token self-heal could not read user_integrations from Supabase (${result.error}). `
          + `Cannot verify or repair Gmail/Calendar access this run.`,
      }];

    case 'no_rows':
      return [{
        key: 'google_token_missing_row',
        message: `No user_integrations row with a refresh token exists for ${GOOGLE_ACCOUNT}. `
          + `Gmail/Calendar has never been connected, or every grant has already been pruned as dead. ${THE_FIX}`,
      }];

    case 'client_config_error': {
      // byProvider names exactly which Google Cloud client(s) are broken --
      // 'google_calendar' means GOOGLE_INTERNAL_CLIENT_ID/SECRET, everything
      // else means GOOGLE_CLIENT_ID/SECRET (see api/_lib/google-oauth-clients.js).
      const parts = (result.byProvider || [{ provider: null, errorCode: result.errorCode, errorDetail: result.errorDetail }])
        .map((p) => {
          const envVars = p.provider === 'google_calendar'
            ? 'GOOGLE_INTERNAL_CLIENT_ID/GOOGLE_INTERNAL_CLIENT_SECRET'
            : 'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET';
          return `${p.provider || 'default'} client (${envVars}): ${p.errorCode}${p.errorDetail ? ` -- ${p.errorDetail}` : ''}`;
        });
      return [{
        key: 'google_token_client_config_error',
        message: `Google rejected the client credentials themselves for every stored credential, not a revoked grant. `
          + `${parts.join('; ')}. Fix the Vercel env var(s) named above, not consent.`,
      }];
    }

    case 'all_revoked': {
      const dates = (result.attempts || []).map((a) => a.updatedAt).filter(Boolean).join(', ');
      return [{
        key: 'google_token_refresh_failed',
        reason: 'invalid_grant',
        message: `Google refresh token for ${GOOGLE_ACCOUNT} is dead. Automated recovery tried ${result.totalRows} stored credential(s)`
          + `${dates ? ` (updated ${dates})` : ''}, all revoked (invalid_grant) -- pruned so they won't be retried again. `
          + `A revoked grant can only be restored by Google's own consent screen, which needs a human. ${THE_FIX}`,
      }];
    }

    case 'inconclusive':
      return [{
        key: 'google_token_check_inconclusive',
        message: `Google token self-heal tried ${result.totalRows} stored credential(s) and none succeeded, but the failures weren't `
          + `cleanly "revoked" either (transient/config errors mixed in) -- not calling this a dead integration yet. Will retry automatically next run.`,
      }];

    default:
      return [{
        key: 'google_token_check_unknown_outcome',
        message: `Google token self-heal returned an unrecognized outcome "${result.outcome}" -- the check itself needs a look.`,
      }];
  }
}

module.exports = { checkGoogleTokenHealth, GOOGLE_ACCOUNT };
