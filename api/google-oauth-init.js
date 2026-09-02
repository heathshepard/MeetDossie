// Vercel Serverless Function: /api/google-oauth-init
// =========================================================================
// Kick off Google OAuth 2.0 authorization code flow — CUSTOMER-FACING CLIENT.
//
// This is the OAuth client every paying customer consents to (Settings >
// Add-ons > Email Integration > "Connect Gmail"). It is READ-ONLY. It must
// never request gmail.send or gmail.compose — those are write/send scopes
// that let the app send mail AS the connecting user, which is not something
// the Dossie product does (Dossie's own mail goes out via Resend from
// dossie@meetdossie.com, never through a customer's mailbox). Asking
// customers for send-as-me access is what was blocking brokerage IT review
// and pushing them into the "Google hasn't verified this app" warning for no
// product reason.
//
// Split 2026-09-01 (SV-ENG-OAUTH-SPLIT) from a single combined client that
// used to also request calendar.readonly + gmail.send + gmail.compose for
// EVERY user. Those scopes now live only on the INTERNAL client
// (api/google-internal-oauth-init.js, GOOGLE_INTERNAL_CLIENT_ID), which only
// Heath ever consents to (see that file for why calendar + send are safe
// there and never here).
//
// GET /api/google-oauth-init
//   Authorization: Bearer <supabase-jwt>
//   ?redirect_after=/app  (optional; where the callback bounces the user)
//
// Behavior:
//   1. Verify Supabase Bearer token -> resolve user_id.
//   2. Generate opaque CSRF state, insert into public.oauth_states
//      bound to user_id, provider='google_gmail'.
//   3. Build Google consent URL with:
//        - client_id = GOOGLE_CLIENT_ID (the customer-facing Cloud project)
//        - redirect_uri = GOOGLE_OAUTH_REDIRECT_URI
//        - response_type = code
//        - scope = gmail.readonly + openid + email ONLY
//        - access_type = offline
//        - prompt = consent          (force refresh_token every time)
//        - state = <opaque token>
//   4. 302 redirect the browser to that URL.
//
// If GOOGLE_CLIENT_ID or GOOGLE_OAUTH_REDIRECT_URI are missing, return 503 —
// caller sees a clean "not configured" toast rather than a Google error page.
//
// Owner: Atlas (SV-JARVIS-CAL-1, 2026-07-06). Scope split: Carter, 2026-09-01.

import { verifySupabaseToken } from './_middleware/auth.js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

// Provider label for this client's rows in public.user_integrations /
// public.oauth_states. Deliberately NOT 'google_calendar' — this client
// never grants calendar, and 'google_calendar' is reserved for the INTERNAL
// client (api/jarvis-calendar.js filters on it explicitly). Pre-split rows
// from existing customers still carry the old 'google_calendar' label from
// before this change; that's harmless (nothing customer-facing filters by
// provider, only by user_id + google_email — see api/_lib/gmail-oauth.js).
const PROVIDER = 'google_gmail';

// Scopes — READ ONLY. Every paying customer sees exactly this consent
// screen:
//  - openid + email: identify the connected Google account
//  - gmail.readonly: inbox reads for the Email Integration add-on (deal
//    email filing, e-sign completion detection, ShowingTime feedback —
//    see api/cron-email-to-dossier.js, api/cron-esign-events.js,
//    api/cron-showingtime-feedback.js, api/_lib/gmail-oauth.js)
//
// NO calendar.readonly (nothing in the product reads a customer's calendar
// — that's Heath's personal Jarvis widget only, api/jarvis-calendar.js).
// NO gmail.send / gmail.compose (no product code path sends mail through a
// customer's mailbox — confirmed by repo-wide grep 2026-09-01, only
// scripts/kw-mail.py touches those scopes, and that's Heath's own tooling,
// now on the INTERNAL client). DO NOT add either back here without first
// checking api/google-internal-oauth-init.js exists and is what actually
// needs the scope — this file is what triggers Google verification review
// for every customer, so every scope here has a real cost.
const SCOPES = [
  'openid',
  'email',
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
    const missing = [];
    if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!GOOGLE_OAUTH_REDIRECT_URI) missing.push('GOOGLE_OAUTH_REDIRECT_URI');
    return res.status(503).json({
      ok: false,
      error: 'google_oauth_not_configured',
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
      provider: PROVIDER,
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
