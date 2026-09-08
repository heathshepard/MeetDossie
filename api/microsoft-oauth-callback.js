// Vercel Serverless Function: /api/microsoft-oauth-callback
// =========================================================================
// Handle the redirect back from Microsoft after user consent. Mirrors
// api/google-oauth-callback.js's structure, but is single-provider
// (microsoft_graph only) rather than generic across multiple Google
// products — Azure/Entra requires its OWN registered redirect_uri, so this
// can't share google-oauth-callback.js's one-callback-many-providers design;
// there is exactly one Microsoft app registration and one redirect_uri here.
//
// GET /api/microsoft-oauth-callback?code=<>&state=<>
//   OR ?error=access_denied&state=<>
//
// Behavior:
//   1. Look up state token in public.oauth_states (must exist, unconsumed,
//      not expired, provider='microsoft_graph').
//   2. Mark state consumed.
//   3. Exchange code for access + refresh tokens
//      (login.microsoftonline.com/common/oauth2/v2.0/token).
//   4. Fetch the connected account's email via Graph /me.
//   5. Upsert into public.user_integrations
//      (user_id, oauth_provider='microsoft_graph', access_token,
//       refresh_token, scopes, expires_at, microsoft_email).
//   6. 302 redirect to <redirect_after>?connected=microsoft_graph
//      (or ?error=<code> on failure).
//
// Public endpoint (no bearer token) — authenticity comes from the opaque
// state token, same as the Google callback.
//
// Owner: Carter, 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;
const MICROSOFT_OAUTH_REDIRECT_URI = process.env.MICROSOFT_OAUTH_REDIRECT_URI;

const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const SCOPES = ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Mail.Read'];

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
  // Same-origin paths ONLY — see google-oauth-callback.js for the
  // open-redirect rationale; identical guard here.
  let base = '/app';
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

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: MICROSOFT_OAUTH_REDIRECT_URI,
    scope: SCOPES.join(' '),
  });
  const r = await fetch(TOKEN_ENDPOINT, {
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

async function fetchMicrosoftAccountEmail(accessToken) {
  try {
    const r = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const data = await r.json();
    // Personal/consumer Microsoft accounts and some tenants leave `mail`
    // null; userPrincipalName is the reliable fallback (it IS the sign-in
    // email for work/school accounts).
    return data.mail || data.userPrincipalName || null;
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
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_CLIENT_SECRET || !MICROSOFT_OAUTH_REDIRECT_URI) {
    return res.status(503).json({ ok: false, error: 'microsoft_oauth_not_configured' });
  }

  const { code, state, error: userError } = req.query;

  if (userError) {
    res.setHeader('Location', bounceUrl('/app', { connected: 'error', reason: userError }));
    return res.status(302).end();
  }

  if (!code || !state) {
    res.setHeader('Location', bounceUrl('/app', { connected: 'error', reason: 'missing_params' }));
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
    console.error('[microsoft-oauth-callback] state lookup failed:', err.message);
  }

  if (!stateRow) {
    res.setHeader('Location', bounceUrl('/app', { connected: 'error', reason: 'invalid_state' }));
    return res.status(302).end();
  }
  if (stateRow.provider !== 'microsoft_graph') {
    // Wrong callback for this state (e.g. redirect_uri misconfigured in
    // Azure to point at this endpoint for a different flow) — reject rather
    // than silently writing to the wrong provider's columns.
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'provider_mismatch' }));
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
    console.warn('[microsoft-oauth-callback] state consume warning:', err.message);
  }

  // 3. Exchange code for tokens.
  let tokenResp;
  try {
    tokenResp = await exchangeCodeForTokens(code);
  } catch (err) {
    console.error('[microsoft-oauth-callback] token exchange failed:', err.message);
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'token_exchange_failed' }));
    return res.status(302).end();
  }

  const accessToken = tokenResp.access_token;
  const refreshToken = tokenResp.refresh_token;
  const scopes = tokenResp.scope || '';
  const expiresIn = tokenResp.expires_in || 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  if (!refreshToken) {
    // offline_access was requested, so this should always be present on
    // first consent — if it's missing, treat it the same as Google's
    // no_refresh_token case: bounce and ask the user to reconnect.
    console.warn('[microsoft-oauth-callback] no refresh_token in response');
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'no_refresh_token' }));
    return res.status(302).end();
  }

  // 4. Fetch the connected account's email (nice-to-have, but also what
  // api/_lib/microsoft-oauth.js and the addon-status endpoint key off of).
  const microsoftEmail = await fetchMicrosoftAccountEmail(accessToken);

  // 5. Upsert into user_integrations.
  try {
    await sbUpsert('user_integrations', {
      user_id: stateRow.user_id,
      oauth_provider: 'microsoft_graph',
      access_token: accessToken,
      refresh_token: refreshToken,
      scopes,
      expires_at: expiresAt,
      microsoft_email: microsoftEmail,
      updated_at: new Date().toISOString(),
    }, 'user_id,oauth_provider');
  } catch (err) {
    console.error('[microsoft-oauth-callback] user_integrations upsert failed:', err.message);
    res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'error', reason: 'db_write_failed' }));
    return res.status(302).end();
  }

  // 6. Success. Bounce back to the app.
  res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'microsoft_graph' }));
  return res.status(302).end();
}
