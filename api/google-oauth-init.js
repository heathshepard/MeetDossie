// Vercel Serverless Function: /api/google-oauth-init
// =========================================================================
// Kick off Google OAuth 2.0 authorization code flow.
//
// GET /api/google-oauth-init
//   Authorization: Bearer <supabase-jwt>
//   ?redirect_after=/myjarvis  (optional; where the callback bounces the user)
//
// Behavior:
//   1. Verify Supabase Bearer token -> resolve user_id.
//   2. Generate opaque CSRF state, insert into public.oauth_states
//      bound to user_id.
//   3. Build Google consent URL with:
//        - client_id
//        - redirect_uri = GOOGLE_OAUTH_REDIRECT_URI
//        - response_type = code
//        - scope = calendar.readonly + gmail.readonly (+ openid email)
//        - access_type = offline
//        - prompt = consent          (force refresh_token every time)
//        - state = <opaque token>
//   4. 302 redirect the browser to that URL.
//
// If GOOGLE_CLIENT_ID or GOOGLE_OAUTH_REDIRECT_URI are missing, return 503 —
// caller sees a clean "not configured" toast rather than a Google error page.
//
// Owner: Atlas (SV-JARVIS-CAL-1, 2026-07-06).

import { verifySupabaseToken } from './_middleware/auth.js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

// Scopes:
//  - openid + email: identify the connected Google account
//  - calendar.readonly: /api/jarvis-calendar consumer
//  - gmail.readonly: future /api/cron-inbox-scan consumer (per user)
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];

export const config = { api: { bodyParser: false }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function sbInsert(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
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
    throw new Error(`sbInsert ${path} -> ${r.status} ${t.slice(0, 200)}`);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_OAUTH_REDIRECT_URI) {
    return res.status(503).json({
      ok: false,
      error: 'google_oauth_not_configured',
      hint: 'Missing GOOGLE_CLIENT_ID or GOOGLE_OAUTH_REDIRECT_URI env var.',
    });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const redirectAfter = (req.query.redirect_after || '/myjarvis').toString().slice(0, 200);
  const state = randomBytes(32).toString('base64url');

  try {
    await sbInsert('oauth_states', {
      state,
      user_id: authUser.userId,
      provider: 'google_calendar',
      redirect_after: redirectAfter,
    });
  } catch (err) {
    console.error('[google-oauth-init] state insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'state_persist_failed' });
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  const consentUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  // JSON if client asked for it, else 302 (browser flow).
  const wantsJson =
    (req.headers.accept || '').includes('application/json') ||
    req.query.format === 'json';

  if (wantsJson) {
    return res.status(200).json({ ok: true, url: consentUrl });
  }

  res.setHeader('Location', consentUrl);
  return res.status(302).end();
}
