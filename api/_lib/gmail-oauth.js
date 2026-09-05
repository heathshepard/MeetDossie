// api/_lib/gmail-oauth.js
//
// Shared Gmail OAuth client for the three Email Integration add-on watchers
// (cron-email-to-dossier.js, cron-esign-events.js, cron-showingtime-feedback.js).
// Extracted 2026-08-22 when those crons went multi-tenant — each previously had
// its own near-identical copy of this same refresh/fetch dance hardcoded to
// heath.shepard@kw.com.
//
// Auth: reuses the same user_integrations OAuth row shape as scripts/kw-mail.py
// and api/gmail-refresh.js. oauth_provider is 'google_calendar' historically
// (the row also carries gmail.* scopes — see api/google-oauth-callback.js) so
// this looks up by user_id, not by provider name.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

async function sb(path, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// Returns { id, access_token, refresh_token, expires_at, google_email } or null.
// refresh_token=not.is.null: re-consent stragglers can leave a dead row for
// the same user (unique key is user_id+oauth_provider) — never hand back a
// row that can't be refreshed when a usable one exists.
async function loadGoogleTokensForUser(userId) {
  const { ok, data } = await sb(
    `user_integrations?select=id,access_token,refresh_token,expires_at,google_email&user_id=eq.${encodeURIComponent(userId)}&google_email=not.is.null&refresh_token=not.is.null&order=updated_at.desc&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function persistAccessToken(userId, accessToken, expiresAt, rowId) {
  // Prefer the exact row id — a bare user_id filter would smear this Google
  // access token across the user's OTHER integration rows too
  // (microsoft_graph, google_youtube), clobbering their tokens.
  const filter = rowId
    ? `id=eq.${encodeURIComponent(rowId)}`
    : `user_id=eq.${encodeURIComponent(userId)}&google_email=not.is.null`;
  await sb(`user_integrations?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function refreshGoogleToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    const detail = data?.error_description || data?.error || `http_${res.status}`;
    const err = new Error(`google_refresh_failed:${detail}`);
    err.isInvalidGrant = data?.error === 'invalid_grant';
    throw err;
  }
  return data;
}

// Builds a `gmail(path, params)` fetcher bound to one user, auto-refreshing
// the access token on a 401 and persisting the new one.
function makeGmailClient({ userId, tokens }) {
  let accessToken = tokens.access_token;

  async function raw(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `https://gmail.googleapis.com/gmail/v1/users/me/${path}${qs ? `?${qs}` : ''}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const err = new Error(`gmail_failed:${path}:${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return async function gmail(path, params) {
    try {
      return await raw(path, params);
    } catch (err) {
      if (err.status === 401) {
        const refreshed = await refreshGoogleToken(tokens.refresh_token);
        accessToken = refreshed.access_token;
        const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
        await persistAccessToken(userId, accessToken, expiresAt, tokens.id);
        return raw(path, params);
      }
      throw err;
    }
  };
}

function headerMap(headers) {
  const m = {};
  for (const h of headers || []) m[String(h.name).toLowerCase()] = h.value || '';
  return m;
}

function parseFromHeader(fromHeader) {
  const m = String(fromHeader || '').match(/^(?:"?([^"<]+?)"?\s*)?<?([^<>\s]+@[^<>\s]+)>?$/);
  if (!m) return { name: '', email: String(fromHeader || '').trim().toLowerCase() };
  return { name: (m[1] || '').trim(), email: (m[2] || '').trim().toLowerCase() };
}

function bodyOfMessage(msg) {
  const plain = [];
  const html = [];
  const walk = (part) => {
    if (!part) return;
    const data = part.body && part.body.data;
    if (data) {
      let txt = '';
      try { txt = Buffer.from(data, 'base64url').toString('utf-8'); } catch (_) { txt = ''; }
      if (part.mimeType === 'text/plain') plain.push(txt);
      else if (part.mimeType === 'text/html') html.push(txt);
    }
    (part.parts || []).forEach(walk);
  };
  walk(msg.payload);
  if (plain.length) return plain.join('\n');
  if (html.length) {
    // Entity decode order matters: &amp; must run LAST, or "&amp;#x27;" (a
    // double-encoded apostrophe some ESPs send, ShowingTime included) would
    // decode to a literal "&#x27;" instead of "'". Confirmed against real
    // ShowingTime feedback emails 2026-08-22 — "Buyer&#x27;s Agent Details"
    // was breaking cron-showingtime-feedback.js's agent-name regex until this
    // was added.
    return html.join('\n')
      .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');
  }
  return msg.snippet || '';
}

module.exports = {
  loadGoogleTokensForUser,
  persistAccessToken,
  refreshGoogleToken,
  makeGmailClient,
  headerMap,
  parseFromHeader,
  bodyOfMessage,
};
