// Vercel Serverless Function: /api/google-oauth-callback
// =========================================================================
// Handle the redirect back from Google after user consent.
//
// GET /api/google-oauth-callback?code=<>&state=<>
//   OR ?error=access_denied&state=<>
//
// Shared across every Google OAuth provider we run (google_calendar,
// google_gmail, google_youtube, ...) — the specific provider comes from
// oauth_states.provider, written by whichever *-oauth-init endpoint started
// the flow. One callback, N providers, but — as of the 2026-09-01 client
// split (SV-ENG-OAUTH-SPLIT) — TWO Google Cloud OAuth clients behind it:
//   - 'google_gmail'    -> CUSTOMER client (GOOGLE_CLIENT_ID), read-only,
//                          started by api/google-oauth-init.js
//   - 'google_youtube'  -> CUSTOMER client (GOOGLE_CLIENT_ID), unchanged,
//                          started by api/youtube-oauth-init.js
//   - 'google_calendar' -> INTERNAL client (GOOGLE_INTERNAL_CLIENT_ID),
//                          calendar + gmail send/compose, started by
//                          api/google-internal-oauth-init.js, gated to Heath
//   - anything else     -> falls back to the CUSTOMER client (safe default;
//                          matches pre-split behavior for any state row this
//                          callback doesn't recognize)
// Do not hardcode a provider name into the exchange logic beyond this map;
// read stateRow.provider and look up CLIENT_BY_PROVIDER.
//
// Behavior:
//   1. Look up state token in public.oauth_states (must exist, unconsumed,
//      not expired). Resolve to user_id + provider.
//   2. Mark state consumed.
//   3. Exchange code for access + refresh tokens, using the client_id /
//      client_secret / redirect_uri that ISSUED the authorization (i.e. the
//      one matching stateRow.provider) — Google rejects a token exchange
//      whose client_id doesn't match the one used to start the flow.
//   4. Upsert into public.user_integrations
//      (user_id, oauth_provider=<stateRow.provider>, access_token, refresh_token,
//       scopes, expires_at, google_email).
//   5. 302 redirect to <redirect_after>?connected=<stateRow.provider>
//      (or ?error=<code> on failure).
//
// This endpoint is public (no bearer token — that's the whole point of the
// callback), but authenticity is proven via the opaque state token.
//
// Owner: Atlas (SV-JARVIS-CAL-1, 2026-07-06; generalized for youtube
// 2026-08-25; two-client split Carter 2026-09-01).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;
const GOOGLE_INTERNAL_CLIENT_ID = process.env.GOOGLE_INTERNAL_CLIENT_ID;
const GOOGLE_INTERNAL_CLIENT_SECRET = process.env.GOOGLE_INTERNAL_CLIENT_SECRET;
const GOOGLE_INTERNAL_OAUTH_REDIRECT_URI = process.env.GOOGLE_INTERNAL_OAUTH_REDIRECT_URI;

const CUSTOMER_CLIENT = {
  clientId: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  redirectUri: GOOGLE_OAUTH_REDIRECT_URI,
};
const INTERNAL_CLIENT = {
  clientId: GOOGLE_INTERNAL_CLIENT_ID,
  clientSecret: GOOGLE_INTERNAL_CLIENT_SECRET,
  redirectUri: GOOGLE_INTERNAL_OAUTH_REDIRECT_URI,
};

const CLIENT_BY_PROVIDER = {
  google_calendar: INTERNAL_CLIENT,
  google_gmail: CUSTOMER_CLIENT,
  google_youtube: CUSTOMER_CLIENT,
};

function clientForProvider(provider) {
  return CLIENT_BY_PROVIDER[provider] || CUSTOMER_CLIENT;
}

export const config = { api: { bodyParser: false }, maxDuration: 15 };

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function sbPatch(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`sbPatch ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
}

async function sbUpsert(path, body, onConflict) {
  const url = `${SUPABASE_URL}/rest/v1/${path}?on_conflict=${onConflict}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`sbUpsert ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
}

function bounceUrl(redirectAfter, params) {
  // Redirect back to the app. Same-origin paths ONLY (must start with a single
  // "/" and not "//" — the latter is a protocol-relative URL that could
  // redirect off-site). This prevents open-redirect abuse of ?redirect_after.
  let base = '/myjarvis';
  if (
    redirectAfter &&
    typeof redirectAfter === 'string' &&
    redirectAfter.startsWith('/') &&
    !redirectAfter.startsWith('//')
  ) {
    base = redirectAfter;
  }
  const qp = new URLSearchParams(params).toString();
  return base + (base.includes('?') ? '&' : '?') + qp;
}

async function exchangeCodeForTokens(code, client) {
  const params = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: client.redirectUri,
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`token_exchange ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

async function fetchGoogleAccountEmail(accessToken) {
  try {
    const r = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    return data.email || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_OAUTH_REDIRECT_URI) {
    return res.status(503).json({ ok: false, error: 'google_oauth_not_configured' });
  }

  const { code, state, error: userError } = req.query;

  if (userError) {
    // User denied consent or Google returned an error.
    res.setHeader('Location', bounceUrl('/myjarvis', { connected: 'error', reason: userError }));
    return res.status(302).end();
  }

  if (!code || !state) {
    res.setHeader('Location', bounceUrl('/myjarvis', { connected: 'error', reason: 'missing_params' }));
    return res.status(302).end();
  }

  // 1. Look up state.
  let stateRow;
  try {
    const rows = await sbGet(
      `oauth_states?select=state,user_id,provider,redirect_after,expires_at,consumed_at`
      + `&state=eq.${encodeURIComponent(state)}&limit=1`
    );
    stateRow = rows && rows[0];
  } catch (err) {
    console.error('[oauth-callback] state lookup failed:', err.message);
  }

  if (!stateRow) {
    res.setHeader('Location', bounceUrl('/myjarvis', { connected: 'error', reason: 'invalid_state' }));
    return res.status(302).end();
  }
  if (stateRow.consumed_at) {
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'state_reused' }));
    return res.status(302).end();
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'state_expired' }));
    return res.status(302).end();
  }

  // 2. Mark consumed (best-effort).
  try {
    await sbPatch(
      `oauth_states?state=eq.${encodeURIComponent(state)}`,
      { consumed_at: new Date().toISOString() }
    );
  } catch (err) {
    console.warn('[oauth-callback] state consume warning:', err.message);
  }

  // 3. Exchange code for tokens, using the client that issued this
  // provider's authorization (see CLIENT_BY_PROVIDER above).
  const client = clientForProvider(stateRow.provider);
  if (!client.clientId || !client.clientSecret || !client.redirectUri) {
    console.error(`[oauth-callback] client not configured for provider=${stateRow.provider}`);
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'oauth_client_not_configured' }));
    return res.status(302).end();
  }
  let tokenResp;
  try {
    tokenResp = await exchangeCodeForTokens(code, client);
  } catch (err) {
    console.error('[oauth-callback] token exchange failed:', err.message);
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'token_exchange_failed' }));
    return res.status(302).end();
  }

  const accessToken = tokenResp.access_token;
  const refreshToken = tokenResp.refresh_token;
  const scopes = tokenResp.scope || '';
  const expiresIn = tokenResp.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  if (!refreshToken) {
    // Google only returns refresh_token on first consent or when prompt=consent.
    // If missing, the account previously consented; caller must revoke &
    // re-authorize. Bounce with a clear reason.
    console.warn('[oauth-callback] no refresh_token in response (already consented?)');
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'no_refresh_token' }));
    return res.status(302).end();
  }

  // 4. Fetch Google account email (nice-to-have).
  const googleEmail = await fetchGoogleAccountEmail(accessToken);

  // 5. Upsert into user_integrations, under whichever provider this flow was
  // started for (stateRow.provider — e.g. 'google_calendar', 'google_youtube').
  const provider = stateRow.provider || 'google_calendar';
  try {
    await sbUpsert('user_integrations', {
      user_id: stateRow.user_id,
      oauth_provider: provider,
      access_token: accessToken,
      refresh_token: refreshToken,
      scopes,
      expires_at: expiresAt,
      google_email: googleEmail,
      updated_at: new Date().toISOString(),
    }, 'user_id,oauth_provider');
  } catch (err) {
    console.error('[oauth-callback] user_integrations upsert failed:', err.message);
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'db_write_failed' }));
    return res.status(302).end();
  }

  // 6. Success. Bounce back to the app.
  res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: provider }));
  return res.status(302).end();
}
