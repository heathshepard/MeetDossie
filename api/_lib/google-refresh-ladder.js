'use strict';

// api/_lib/google-refresh-ladder.js
//
// THE SELF-HEAL LADDER for Google OAuth refresh tokens (Gmail + Calendar).
//
// Scope change, Heath, 2026-09-28 (mid-build correction to the original
// alert-only ask): "i dont want it to jsut message me. i want it to
// autofix if it fails." Alerting is the LAST resort. This module tries
// every automated recovery first and only reports a definitive dead end.
//
// THE REAL DEFECT THIS FIXES: user_integrations is unique on
// (user_id, oauth_provider), not on google_email -- a re-consent leaves
// MULTIPLE rows for the same address, some dead. Every caller up to today
// (scripts/kw-mail.py's ROW_PICK, api/gmail-refresh.js, scripts/
// preflight-check.js) picked ONLY the newest row (order=updated_at.desc&
// limit=1). If that one row's refresh_token is revoked, the whole
// integration reads as dead even when an older row still holds a live
// grant. Live example, 2026-09-28: 3 rows for heath.shepard@kw.com dated
// 9/12, 9/19, 9/26 -- walking only the newest missed 2 chances to recover
// (all 3 happen to be dead today too, per the live invalid_grant test run
// the same day, but the code must not assume that stays true).
//
// THE LADDER, per run:
//   1. Pull every user_integrations row for the account with a non-null
//      refresh_token, newest updated_at first.
//   2. For each row: attempt a real refresh. A TRANSIENT failure (network
//      error, timeout, HTTP 5xx/429, or a response with no parseable
//      `error`) gets bounded retries with backoff on that SAME row -- it's
//      not evidence the grant is bad. `invalid_grant` (Google's exact code
//      for a revoked/expired refresh token) is PERMANENT for that row --
//      no retry, move on to the next row immediately. Any other named
//      OAuth error that means the CLIENT credentials themselves are wrong
//      (invalid_client, unauthorized_client, unsupported_grant_type) stops
//      the whole ladder immediately -- no row can fix a bad client secret,
//      so trying the rest would just burn calls for the same non-token
//      reason. Any OTHER named 4xx error is treated like invalid_grant for
//      THIS row (permanent, move on) without being folded into the
//      all-revoked count's exact wording, since it isn't literally
//      invalid_grant -- see PERMANENT_OTHER handling below.
//   3. First row that refreshes successfully wins: persist its new
//      access_token/expires_at, and PRUNE every row this run confirmed
//      invalid_grant (refresh_token -> null) so they are never retried
//      again -- user_integrations' `refresh_token=not.is.null` filter is
//      what every reader already uses to mean "live candidate."
//   4. If every row tried is confirmed invalid_grant: prune all of them,
//      report `all_revoked`.
//   5. WHY invalid_grant CANNOT BE AUTO-FIXED FURTHER THAN THIS: a revoked
//      refresh token means Google itself has invalidated the grant --
//      recovering it requires a human completing Google's OAuth consent
//      screen (a real login + the explicit click only Google's own UI can
//      render). There is no server-side call that mints a new refresh
//      token without that. Deliberately NOT building: headless consent
//      automation, storing Heath's Google password, or a scripted
//      click-through of Google's consent page -- all three break
//      constantly and are themselves a security problem (this is a PUBLIC
//      repo). The one correct fix stays the alert's message: open
//      meetdossie.com/myjarvis and click Connect Google Calendar.
//
// Also fixes the ORIGINAL bug this whole check exists to catch: health can
// never be inferred from `expires_at`, a `scopes` string, or a non-null
// `refresh_token` -- all three looked fine on all three dead rows during
// the 2026-09-28 incident. The ladder only ever trusts a REAL refresh
// attempt's response.
//
// FOLLOW-UP DEFECT, found live 2026-09-29 (this ladder's OWN first real
// run): user_integrations rows are not all issued by the same Google Cloud
// OAuth client. The 2026-09-01 two-client split (api/google-oauth-callback.js
// CLIENT_BY_PROVIDER, now api/_lib/google-oauth-clients.js) means a
// 'google_calendar' row was issued by the INTERNAL client
// (GOOGLE_INTERNAL_CLIENT_ID/SECRET) while a 'google_gmail' row was issued
// by the CUSTOMER client (GOOGLE_CLIENT_ID/SECRET) -- Google's token
// endpoint correctly returns unauthorized_client if you present the wrong
// one. This file shipped one day after that split without accounting for
// it, tried heath.shepard@kw.com's newest row (google_calendar, INTERNAL)
// with the CUSTOMER pair, got unauthorized_client, and -- because a
// client_config verdict used to abort the ENTIRE ladder -- never even
// attempted the google_gmail rows, which would have refreshed fine.
// Fix: resolve client_id/client_secret PER ROW from its own oauth_provider
// (opts.clientsByProvider, keyed identically to
// api/_lib/google-oauth-clients.js's CLIENT_BY_PROVIDER; opts.clientId/
// opts.clientSecret remain the fallback "default client" for any provider
// not in that map, and the ONLY thing sole callers with a single client
// need to pass -- existing behavior for a single-provider caller is
// unchanged). A client_config verdict now only skips OTHER ROWS OF THE SAME
// PROVIDER (retrying them would fail identically) rather than the whole
// ladder -- a broken INTERNAL client must never block recovery of a
// perfectly fine CUSTOMER-client row for the same account.
//
// SECURITY: never returns refresh_token, access_token, or client_secret in
// any field -- only Google's categorical error code/description and row
// metadata (id, updated_at). This module's output can end up in a
// Telegram message, and this repo is public.
//
// Owner: Atlas, 2026-09-28 (per-provider client fix 2026-09-29).

const MAX_ATTEMPTS_PER_ROW = 3;
const BASE_BACKOFF_MS = 300;

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Google's OAuth token errors that mean "the client credentials themselves
// are wrong" -- retrying a DIFFERENT row cannot fix any of these, only a
// Vercel env-var fix can. Deliberately excludes invalid_grant, which is
// row-specific.
const CLIENT_CONFIG_ERRORS = new Set(['invalid_client', 'unauthorized_client', 'unsupported_grant_type']);

async function fetchRows(fetchImpl, supabaseUrl, serviceKey, account) {
  const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/user_integrations`
    + `?select=id,refresh_token,google_email,updated_at,oauth_provider`
    + `&google_email=eq.${encodeURIComponent(account)}`
    + `&refresh_token=not.is.null&order=updated_at.desc`;
  const res = await fetchImpl(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function attemptGoogleRefresh(fetchImpl, refreshToken, clientId, clientSecret) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Classifies one HTTP attempt against Google's token endpoint.
 * @returns {{verdict: 'success'|'invalid_grant'|'client_config'|'permanent_other'|'transient', errorCode?: string, errorDetail?: string, accessToken?: string, expiresIn?: number, scope?: string}}
 */
function classifyTokenResponse(res) {
  if (res.ok && res.data && res.data.access_token) {
    return { verdict: 'success', accessToken: res.data.access_token, expiresIn: res.data.expires_in, scope: res.data.scope };
  }
  const code = res.data && res.data.error;
  const detail = (res.data && res.data.error_description) || '';
  if (code === 'invalid_grant') return { verdict: 'invalid_grant', errorCode: code, errorDetail: detail };
  if (code && CLIENT_CONFIG_ERRORS.has(code)) return { verdict: 'client_config', errorCode: code, errorDetail: detail };
  // A named OAuth error on a 4xx that isn't invalid_grant and isn't a
  // client-config error (e.g. invalid_request with a malformed refresh_token
  // value) -- permanent for this row, but kept distinct from invalid_grant
  // so "all_revoked" only ever means literally that.
  if (code && res.status >= 400 && res.status < 500) return { verdict: 'permanent_other', errorCode: code, errorDetail: detail };
  // No parseable OAuth error body (network hiccup upstream, 5xx, 429, or a
  // non-JSON response) -- genuinely transient, worth a retry.
  return { verdict: 'transient', errorCode: code || `http_${res.status}`, errorDetail: detail };
}

// Resolves which client_id/client_secret to use for a given row's
// oauth_provider. `clientsByProvider` is optional (keyed like
// api/_lib/google-oauth-clients.js's CLIENT_BY_PROVIDER) -- any provider not
// present in it, or when the map itself isn't supplied, falls back to the
// single default client (opts.clientId/opts.clientSecret), preserving the
// original single-client behavior for any caller that only has one.
function resolveClient(row, defaultClient, clientsByProvider) {
  if (clientsByProvider && row.oauth_provider && clientsByProvider[row.oauth_provider]) {
    return clientsByProvider[row.oauth_provider];
  }
  return defaultClient;
}

async function attemptRowWithRetries(fetchImpl, sleepImpl, row, client) {
  // Missing client_id/client_secret for THIS row's provider is a config
  // problem, not a network one -- never spend a Google call finding that
  // out.
  if (!client || !client.clientId || !client.clientSecret) {
    return { verdict: 'client_config', errorCode: 'missing_client_config', errorDetail: 'no client_id/client_secret configured for this row\'s oauth_provider', tries: 0 };
  }
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_ROW; attempt++) {
    let classified;
    try {
      const res = await attemptGoogleRefresh(fetchImpl, row.refresh_token, client.clientId, client.clientSecret);
      classified = classifyTokenResponse(res);
    } catch (err) {
      classified = { verdict: 'transient', errorCode: 'network_error', errorDetail: String((err && err.message) || err).slice(0, 200) };
    }
    last = classified;
    if (classified.verdict !== 'transient') return { ...classified, tries: attempt };
    if (attempt < MAX_ATTEMPTS_PER_ROW) await sleepImpl(BASE_BACKOFF_MS * attempt);
  }
  return { ...last, tries: MAX_ATTEMPTS_PER_ROW };
}

async function persistWinner(fetchImpl, supabaseUrl, serviceKey, rowId, accessToken, expiresIn) {
  const expiresAt = new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString();
  const res = await fetchImpl(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/user_integrations?id=eq.${encodeURIComponent(rowId)}`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt, updated_at: new Date().toISOString() }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`persist http_${res.status} ${text.slice(0, 160)}`);
  }
  return { expiresAt };
}

// Nulls refresh_token on every confirmed-dead row so user_integrations'
// `refresh_token=not.is.null` filter (used by kw-mail.py, this ladder, and
// every other reader) never picks them again. Deliberately does NOT touch
// updated_at -- that column stays the true record of when the row was last
// actually consented, not when it was pruned.
async function pruneDeadRows(fetchImpl, supabaseUrl, serviceKey, ids) {
  if (!ids || ids.length === 0) return;
  const list = ids.map((id) => `"${id}"`).join(',');
  const res = await fetchImpl(
    `${supabaseUrl.replace(/\/$/, '')}/rest/v1/user_integrations?id=in.(${list})`,
    {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ refresh_token: null }),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`prune http_${res.status} ${text.slice(0, 160)}`);
  }
}

/**
 * Runs the full self-heal ladder for one Google account.
 *
 * @param {object} opts
 * @param {string} opts.account - google_email to look up
 * @param {string} opts.supabaseUrl
 * @param {string} opts.serviceKey
 * @param {string} opts.clientId - default/fallback client_id, used for any
 *   row whose oauth_provider isn't in opts.clientsByProvider
 * @param {string} opts.clientSecret - default/fallback client_secret
 * @param {Object<string, {clientId: string, clientSecret: string}>} [opts.clientsByProvider] -
 *   per-oauth_provider client override (see api/_lib/google-oauth-clients.js
 *   CLIENT_BY_PROVIDER). Optional -- a caller with only one Google Cloud
 *   client for every row it manages can omit this entirely.
 * @param {Function} [opts.fetchImpl] - injectable for tests; defaults to global fetch
 * @param {Function} [opts.sleepImpl] - injectable for tests; defaults to real setTimeout
 * @returns {Promise<object>} outcome: 'healthy' | 'healthy_persist_failed' |
 *   'misconfigured' | 'query_failed' | 'no_rows' | 'client_config_error' |
 *   'all_revoked' | 'inconclusive', plus attempts[] (no credential material)
 */
async function refreshWithLadder(opts = {}) {
  const fetchImpl = opts.fetchImpl || global.fetch;
  const sleepImpl = opts.sleepImpl || defaultSleep;
  const { account, supabaseUrl, serviceKey, clientId, clientSecret, clientsByProvider } = opts;
  const defaultClient = { clientId, clientSecret };

  const missingEnv = [];
  if (!supabaseUrl) missingEnv.push('SUPABASE_URL');
  if (!serviceKey) missingEnv.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!clientId) missingEnv.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missingEnv.push('GOOGLE_CLIENT_SECRET');
  if (missingEnv.length > 0) return { outcome: 'misconfigured', missingEnv, attempts: [] };

  let rowsRes;
  try {
    rowsRes = await fetchRows(fetchImpl, supabaseUrl, serviceKey, account);
  } catch (err) {
    return { outcome: 'query_failed', error: String((err && err.message) || err).slice(0, 200), attempts: [] };
  }
  if (!rowsRes.ok) return { outcome: 'query_failed', error: `http_${rowsRes.status}`, attempts: [] };
  const rows = Array.isArray(rowsRes.data) ? rowsRes.data : [];
  if (rows.length === 0) return { outcome: 'no_rows', attempts: [] };

  const attempts = [];
  const confirmedDeadIds = [];
  // Providers whose client credentials are confirmed broken THIS run --
  // retrying another row under the SAME provider can't change that outcome,
  // but a DIFFERENT provider's rows must still get a real attempt (that's
  // the exact 2026-09-29 bug: one provider's bad client must never block
  // another provider's good one for the same account).
  const brokenProviders = new Set();
  let winner = null;

  for (const row of rows) {
    const providerKey = row.oauth_provider || '__default__';
    const client = resolveClient(row, defaultClient, clientsByProvider);
    const result = brokenProviders.has(providerKey)
      ? { verdict: 'client_config', errorCode: 'client_config', errorDetail: 'skipped -- this provider\'s client already confirmed broken this run', tries: 0 }
      : await attemptRowWithRetries(fetchImpl, sleepImpl, row, client);
    attempts.push({
      rowId: row.id,
      updatedAt: row.updated_at,
      provider: row.oauth_provider || null,
      verdict: result.verdict,
      errorCode: result.errorCode,
      errorDetail: result.errorDetail,
      tries: result.tries,
    });
    if (result.verdict === 'success') {
      winner = { row, ...result };
      break;
    }
    if (result.verdict === 'client_config') { brokenProviders.add(providerKey); continue; } // only THIS provider is a dead end
    if (result.verdict === 'invalid_grant') confirmedDeadIds.push(row.id);
    // 'permanent_other' and retry-exhausted 'transient': move to next row.
  }

  let persistError = null;
  if (winner) {
    try {
      await persistWinner(fetchImpl, supabaseUrl, serviceKey, winner.row.id, winner.accessToken, winner.expiresIn);
    } catch (err) {
      persistError = String((err && err.message) || err).slice(0, 200);
    }
  }

  // Pruning a row this run individually confirmed invalid_grant is always
  // safe, independent of the overall ladder outcome -- do it once, here,
  // regardless of which branch below fires. Best-effort: a failed prune
  // must never turn a successful recovery (or any other outcome) into a
  // reported failure -- the row just gets re-classified and re-pruned next
  // run.
  let prunedIds = [];
  if (confirmedDeadIds.length > 0) {
    try {
      await pruneDeadRows(fetchImpl, supabaseUrl, serviceKey, confirmedDeadIds);
      prunedIds = confirmedDeadIds;
    } catch { /* best-effort */ }
  }

  if (winner) {
    if (persistError) {
      return { outcome: 'healthy_persist_failed', attempts, winningRowId: winner.row.id, persistError, prunedIds };
    }
    return { outcome: 'healthy', attempts, winningRowId: winner.row.id, prunedIds };
  }

  const allInvalidGrant = attempts.length === rows.length && attempts.every((a) => a.verdict === 'invalid_grant');
  if (allInvalidGrant) {
    return { outcome: 'all_revoked', attempts, totalRows: rows.length, prunedIds };
  }

  // Every row failed on CLIENT credentials -- not necessarily the same
  // provider's credentials (an account can have rows under both the
  // CUSTOMER and INTERNAL client). Report one entry per distinct provider
  // hit so the alert names the actual broken client(s), not just "google"
  // generically. Top-level errorCode/errorDetail mirror the FIRST provider
  // hit, for callers (api/gmail-refresh.js) that only care about one.
  const allClientConfig = attempts.length === rows.length && attempts.every((a) => a.verdict === 'client_config');
  if (allClientConfig) {
    const seen = new Set();
    const byProvider = [];
    for (const a of attempts) {
      const key = a.provider || '__default__';
      if (seen.has(key)) continue;
      seen.add(key);
      byProvider.push({ provider: a.provider, errorCode: a.errorCode, errorDetail: a.errorDetail });
    }
    return {
      outcome: 'client_config_error',
      attempts,
      errorCode: byProvider[0].errorCode,
      errorDetail: byProvider[0].errorDetail,
      byProvider,
      prunedIds,
    };
  }

  return { outcome: 'inconclusive', attempts, totalRows: rows.length, prunedIds };
}

module.exports = {
  refreshWithLadder,
  classifyTokenResponse,
  MAX_ATTEMPTS_PER_ROW,
  BASE_BACKOFF_MS,
};
