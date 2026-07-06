// Vercel Serverless Function: /api/google-oauth-callback
// =========================================================================
// Handle the redirect back from Google after user consent.
//
// GET /api/google-oauth-callback?code=<>&state=<>
//   OR ?error=access_denied&state=<>
//
// Behavior:
//   1. Look up state token in public.oauth_states (must exist, unconsumed,
//      not expired). Resolve to user_id.
//   2. Mark state consumed.
//   3. Exchange code for access + refresh tokens.
//   4. Upsert into public.user_integrations
//      (user_id, oauth_provider='google_calendar', access_token, refresh_token,
//       scopes, expires_at, google_email).
//   5. 302 redirect to <redirect_after>?connected=google_calendar
//      (or ?error=<code> on failure).
//
// This endpoint is public (no bearer token — that's the whole point of the
// callback), but authenticity is proven via the opaque state token.
//
// Owner: Atlas (SV-JARVIS-CAL-1, 2026-07-06).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

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

async function exchangeCodeForTokens(code) {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
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

  // 3. Exchange code for tokens.
  let tokenResp;
  try {
    tokenResp = await exchangeCodeForTokens(code);
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

  // 5. Upsert into user_integrations.
  try {
    await sbUpsert('user_integrations', {
      user_id: stateRow.user_id,
      oauth_provider: 'google_calendar',
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
  res.setHeader('Location', bounceUrl(stateRow.redirect_after, { connected: 'google_calendar' }));
  return res.status(302).end();
}
