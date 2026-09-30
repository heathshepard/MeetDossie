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
// Owner: Atlas, 2026-09-28.

const { refreshWithLadder } = require('./google-refresh-ladder.js');
// Per-row client resolution (Atlas, 2026-09-29) -- see
// api/_lib/google-oauth-clients.js header for the unauthorized_client
// incident this closes. heath.shepard@kw.com carries rows minted by BOTH
// the customer and internal Google clients under one email.
const { resolveGoogleClient } = require('./google-oauth-clients.js');

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
 * @param {object} [opts.env] - injectable env override for tests
 */
async function checkGoogleTokenHealth(opts = {}) {
  const env = opts.env || {};
  // Tests inject a single explicit clientId/clientSecret pair (flat legacy
  // mode -- every fixture row is oauth_provider='google_gmail'). Real
  // production calls pass no env override at all, so they get the shared
  // per-row resolver -- required because heath.shepard@kw.com's rows span
  // TWO different Google clients (see google-oauth-clients.js).
  const hasLegacyOverride = ('clientId' in env) || ('clientSecret' in env);
  const clientOpts = hasLegacyOverride
    ? { clientId: env.clientId, clientSecret: env.clientSecret }
    : { resolveClient: resolveGoogleClient };

  const result = await refreshWithLadder({
    account: GOOGLE_ACCOUNT,
    fetchImpl: opts.fetchImpl,
    sleepImpl: opts.sleepImpl,
    supabaseUrl: 'supabaseUrl' in env ? env.supabaseUrl : process.env.SUPABASE_URL,
    serviceKey: 'serviceKey' in env ? env.serviceKey : process.env.SUPABASE_SERVICE_ROLE_KEY,
    ...clientOpts,
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

    case 'client_config_error':
      return [{
        key: 'google_token_client_config_error',
        message: `Google rejected the client credentials themselves (${result.errorCode}${result.errorDetail ? `: ${result.errorDetail}` : ''}) -- `
          + `this is a GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET problem in Vercel, not a revoked grant. `
          + `No stored credential could even attempt a refresh. Fix the env vars, not consent.`,
      }];

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
