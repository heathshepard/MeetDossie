// Vercel Serverless Function: /api/microsoft-oauth-init
// =========================================================================
// Kick off Microsoft identity platform (Entra ID) authorization code flow,
// for the Email Integration add-on's Outlook / Microsoft 365 connection.
// Mirrors api/google-oauth-init.js exactly — same request/response shape,
// same oauth_states handoff to the callback — just a different provider.
//
// GET /api/microsoft-oauth-init
//   Authorization: Bearer <supabase-jwt>
//   ?redirect_after=/app  (optional; where the callback bounces the user)
//
// Behavior:
//   1. Verify Supabase Bearer token -> resolve user_id.
//   2. Generate opaque CSRF state, insert into public.oauth_states
//      bound to user_id, provider='microsoft_graph'.
//   3. Build Microsoft consent URL with:
//        - client_id
//        - redirect_uri = MICROSOFT_OAUTH_REDIRECT_URI
//        - response_type = code
//        - scope = openid email offline_access Mail.Read (READ-ONLY —
//          do not add Mail.Send / Mail.ReadWrite without an explicit ask)
//        - response_mode = query
//        - state = <opaque token>
//   4. 302 redirect the browser to that URL (or return JSON when the client
//      asks for it, same as google-oauth-init.js).
//
// If MICROSOFT_CLIENT_ID or MICROSOFT_OAUTH_REDIRECT_URI are missing, return
// 503 — caller sees a clean "not configured" toast rather than a Microsoft
// error page. This is the expected state until Heath completes the Azure /
// Entra app registration — see docs/ENV.md for the exact steps.
//
// Owner: Carter, 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH).

import { verifySupabaseToken } from './_middleware/auth.js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_OAUTH_REDIRECT_URI = process.env.MICROSOFT_OAUTH_REDIRECT_URI;

// Read-only. Mail.Read + offline_access is everything the three Email
// Integration watchers need (list + read messages + attachments across a
// refresh). Do NOT add Mail.Send or Mail.ReadWrite — we don't send mail on
// the customer's behalf today, and requesting write access we don't use
// only adds attack surface and consent friction.
const SCOPES = [
  'openid',
  'email',
  'offline_access',
  'https://graph.microsoft.com/Mail.Read',
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
  if (!MICROSOFT_CLIENT_ID || !MICROSOFT_OAUTH_REDIRECT_URI) {
    const missing = [];
    if (!MICROSOFT_CLIENT_ID) missing.push('MICROSOFT_CLIENT_ID');
    if (!MICROSOFT_OAUTH_REDIRECT_URI) missing.push('MICROSOFT_OAUTH_REDIRECT_URI');
    return res.status(503).json({
      ok: false,
      error: 'microsoft_oauth_not_configured',
      missing,
      hint: 'Set these env vars in Vercel and redeploy. See docs/ENV.md for the Azure app registration steps.',
    });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  // Same-origin path only (open-redirect prevention).
  let redirectAfter = (req.query.redirect_after || '/app').toString().slice(0, 200);
  if (!redirectAfter.startsWith('/') || redirectAfter.startsWith('//')) {
    redirectAfter = '/app';
  }
  const state = randomBytes(32).toString('base64url');

  try {
    await sbInsert('oauth_states', {
      state,
      user_id: authUser.userId,
      provider: 'microsoft_graph',
      redirect_after: redirectAfter,
    });
  } catch (err) {
    console.error('[microsoft-oauth-init] state insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'state_persist_failed' });
  }

  const params = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    redirect_uri: MICROSOFT_OAUTH_REDIRECT_URI,
    response_type: 'code',
    response_mode: 'query',
    scope: SCOPES.join(' '),
    state,
  });

  // "common" endpoint accepts both work/school (Microsoft 365) and personal
  // Microsoft accounts — matches the mixed KW-brokerage-domain + personal
  // inbox reality we saw across the 4 Microsoft-hosted paying customers.
  const consentUrl = `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`;

  const wantsJson =
    (req.headers.accept || '').includes('application/json') ||
    req.query.format === 'json';

  if (wantsJson) {
    return res.status(200).json({ ok: true, url: consentUrl });
  }

  res.setHeader('Location', consentUrl);
  return res.status(302).end();
}
