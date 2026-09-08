// Vercel Serverless Function: /api/google-internal-oauth-init
// =========================================================================
// Kick off Google OAuth 2.0 authorization code flow — INTERNAL CLIENT.
//
// This is Heath's own tooling client, split off 2026-09-01 (SV-ENG-OAUTH-SPLIT)
// from the combined client that used to hand these same scopes to every
// paying customer. Only Heath ever consents to this client, so:
//   - the ~100-user cap on unverified Google apps is irrelevant (1 user)
//   - the "Google hasn't verified this app" warning is harmless (Heath knows
//     what he built)
//   - this client never needs to go through Google's verification review
//
// Scopes here are the ones the CUSTOMER client (api/google-oauth-init.js)
// must never carry:
//   - calendar.readonly: api/jarvis-calendar.js (Jarvis PWA calendar widget,
//     meetdossie.com/myjarvis — Heath's own dashboard, not a customer page)
//   - gmail.send + gmail.compose: scripts/kw-mail.py send (users.messages.send)
//     — Heath's own mail tooling. No product code path sends mail through a
//     customer's mailbox (confirmed by repo-wide grep 2026-09-01); this is
//     the ONLY reason these two scopes exist anywhere in this codebase.
//   - gmail.readonly: same inbox reads kw-mail.py / the Email Integration
//     crons use for Heath's own connection.
//
// GET /api/google-internal-oauth-init
//   Authorization: Bearer <supabase-jwt>, MUST resolve to heath.shepard@kw.com
//   ?redirect_after=/myjarvis  (optional; where the callback bounces the user)
//
// Behavior mirrors api/google-oauth-init.js (same oauth_states /
// user_integrations tables, same shared /api/google-oauth-callback) except:
//   - gated to Heath's email only (403 for anyone else — this client grants
//     send-as-me access, so it must never be reachable by a customer JWT)
//   - uses GOOGLE_INTERNAL_CLIENT_ID / GOOGLE_INTERNAL_OAUTH_REDIRECT_URI
//   - writes oauth_states.provider = 'google_calendar' (unchanged from the
//     pre-split combined client — this is what api/jarvis-calendar.js and
//     Heath's existing kw-mail.py connection already key off of)
//
// DO NOT REMOVE THE SEND SCOPES. On 2026-08-13 the (then-combined) init
// array requested only gmail.readonly, so sending was silently broken for
// the entire life of the integration — the OAuth flow succeeded, the token
// stored fine, and mail simply failed at send time. Any change here must
// keep scripts/preflight-check.js (gmail-send) green.
//
// Owner: Carter, 2026-09-01 (SV-ENG-OAUTH-SPLIT).

import { verifySupabaseToken } from './_middleware/auth.js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_INTERNAL_CLIENT_ID = process.env.GOOGLE_INTERNAL_CLIENT_ID;
const GOOGLE_INTERNAL_OAUTH_REDIRECT_URI = process.env.GOOGLE_INTERNAL_OAUTH_REDIRECT_URI;

// Only Heath may mint a token on this client — it grants send-as-me access.
const ALLOWED_EMAIL = 'heath.shepard@kw.com';

const PROVIDER = 'google_calendar';

const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.compose',
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
  if (!GOOGLE_INTERNAL_CLIENT_ID || !GOOGLE_INTERNAL_OAUTH_REDIRECT_URI) {
    const missing = [];
    if (!GOOGLE_INTERNAL_CLIENT_ID) missing.push('GOOGLE_INTERNAL_CLIENT_ID');
    if (!GOOGLE_INTERNAL_OAUTH_REDIRECT_URI) missing.push('GOOGLE_INTERNAL_OAUTH_REDIRECT_URI');
    return res.status(503).json({
      ok: false,
      error: 'google_internal_oauth_not_configured',
      missing,
      hint: 'Set these env vars in Vercel and redeploy.',
    });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  if (authUser.email !== ALLOWED_EMAIL) {
    return res.status(403).json({ ok: false, error: 'internal_client_restricted' });
  }

  // Same-origin path only (open-redirect prevention).
  let redirectAfter = (req.query.redirect_after || '/myjarvis').toString().slice(0, 200);
  if (!redirectAfter.startsWith('/') || redirectAfter.startsWith('//')) {
    redirectAfter = '/myjarvis';
  }
  const state = randomBytes(32).toString('base64url');

  try {
    await sbInsert('oauth_states', {
      state,
      user_id: authUser.userId,
      provider: PROVIDER,
      redirect_after: redirectAfter,
    });
  } catch (err) {
    console.error('[google-internal-oauth-init] state insert failed:', err.message);
    return res.status(500).json({ ok: false, error: 'state_persist_failed' });
  }

  const params = new URLSearchParams({
    client_id: GOOGLE_INTERNAL_CLIENT_ID,
    redirect_uri: GOOGLE_INTERNAL_OAUTH_REDIRECT_URI,
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
