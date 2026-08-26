// Vercel Serverless Function: /api/youtube-oauth-init
// =========================================================================
// Kick off Google OAuth 2.0 authorization code flow scoped to YouTube upload.
//
// GET /api/youtube-oauth-init
//   Authorization: Bearer <supabase-jwt>
//   ?redirect_after=/myjarvis  (optional; where the callback bounces the user)
//
// Behavior mirrors google-oauth-init.js (same Google Cloud OAuth client,
// same public.oauth_states / public.user_integrations tables, same shared
// /api/google-oauth-callback) but requests a different, narrower scope set
// and stores the result under oauth_provider='google_youtube' — a separate
// row from any 'google_calendar' connection on the same user, so granting
// upload access never touches (or requires re-granting) Gmail/Calendar.
//
//   1. Verify Supabase Bearer token -> resolve user_id.
//   2. Generate opaque CSRF state, insert into public.oauth_states bound to
//      user_id, provider='google_youtube'.
//   3. Build Google consent URL with:
//        - client_id / redirect_uri = same GOOGLE_OAUTH_REDIRECT_URI as the
//          calendar/gmail flow (one redirect_uri registered in Google Cloud
//          Console handles every provider; the callback reads provider off
//          the state row, not off the URL).
//        - scope = youtube.upload + youtube.readonly (+ openid email)
//        - access_type = offline, prompt = consent (force refresh_token)
//        - state = <opaque token>
//   4. 302 redirect the browser to that URL (or return JSON if requested).
//
// youtube.upload is a Google "restricted/sensitive" scope. Until the OAuth
// consent screen for this Cloud project lists it (and, if the app is in
// Testing mode, the connecting Google account is added as a test user),
// Google will bounce the consent request with invalid_scope or an
// unverified-app warning — that's a one-time manual step in Google Cloud
// Console (APIs & Services -> OAuth consent screen -> Scopes, and
// Credentials -> enable "YouTube Data API v3"), not something fixable from
// this code. Human action, not a bug here.
//
// Owner: Atlas (2026-08-25).

import { verifySupabaseToken } from './_middleware/auth.js';
import { randomBytes } from 'node:crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_OAUTH_REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI;

const PROVIDER = 'google_youtube';

// Scopes:
//  - openid + email: identify the connected Google account (same as calendar flow)
//  - youtube.upload: required for videos.insert (upload) and videos.update
//    (set thumbnail/metadata after upload)
//  - youtube.readonly: check upload/processing status, list uploaded videos,
//    confirm channel identity before upload (channels.list mine=true)
// Deliberately NOT requesting the full 'youtube' (read/write, manage
// playlists/comments/subscriptions) or 'youtubepartner' scopes — upload +
// status-read is the entire job here.
const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.readonly',
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
    console.error('[youtube-oauth-init] state insert failed:', err.message);
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
    return res.status(200).json({ ok: true, url: consentUrl, provider: PROVIDER });
  }

  res.setHeader('Location', consentUrl);
  return res.status(302).end();
}
