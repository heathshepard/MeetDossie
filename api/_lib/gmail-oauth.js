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
//
// Per-row client resolution (Atlas, 2026-09-29): oauth_provider determines
// which Google Cloud client actually minted this row's refresh_token --
// google_calendar rows come from the INTERNAL client, google_gmail rows from
// the CUSTOMER client. Refreshing with the wrong one gets unauthorized_client
// from Google, not a helpful error. See api/_lib/google-oauth-clients.js.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const { resolveGoogleClient } = require('./google-oauth-clients.js');

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
//
// ACCOUNT SELECTION: this is a per-USER lookup, not per-account — it's built
// for the Email Integration add-on where one customer connects exactly one
// mailbox. It does NOT filter by google_email, so a user_id that ends up
// with more than one Google row (e.g. a customer reconnects a different
// address without disconnecting the old one first) gets whichever row was
// updated most recently, silently. Pass `email` explicitly whenever the
// caller knows which mailbox it wants — never rely on the implicit
// most-recent pick for a user known to have more than one connected
// account. Heath's own tooling (scripts/kw-mail.py, api/gmail-refresh.js,
// scripts/preflight-check.js) does NOT go through this function — it always
// filters by google_email directly.
async function loadGoogleTokensForUser(userId, email) {
  const emailFilter = email ? `&google_email=eq.${encodeURIComponent(email)}` : '&google_email=not.is.null';
  const { ok, data } = await sb(
    `user_integrations?select=id,access_token,refresh_token,expires_at,google_email,oauth_provider&user_id=eq.${encodeURIComponent(userId)}${emailFilter}&refresh_token=not.is.null&order=updated_at.desc&limit=1`,
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

async function refreshGoogleToken(refreshToken, provider) {
  const client = resolveGoogleClient(provider);
  if (client.missingEnvNames.length > 0) {
    const err = new Error(`google_refresh_failed:client_config_error:${client.missingEnvNames.join(',')}`);
    err.isInvalidGrant = false;
    throw err;
  }
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
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
        const refreshed = await refreshGoogleToken(tokens.refresh_token, tokens.oauth_provider);
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

// Parses one address. Two forms, tried in order: `Display Name <a@b.com>` and
// a bare `a@b.com`.
//
// The previous single regex made the display-name group both OPTIONAL and
// LAZY, with no requirement that an angle bracket follow it. On a bare
// address it therefore matched the shortest possible "name" and handed the
// rest to the address group: "bwhyte@hotmail.com" parsed as
// {name:'b', email:'whyte@hotmail.com'}, silently dropping the first
// character of every address sent without a display name. Confirmed against
// the real mailbox 2026-09-20 on a message addressed to bare
// `bwhyte@hotmail.com`. That corrupted `from_email` in the inbox tools and
// broke sender matching in the three watcher crons for the same senders.
function parseFromHeader(fromHeader) {
  const raw = String(fromHeader || '').trim();
  if (!raw) return { name: '', email: '' };

  const angled = raw.match(/^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+?)\s*>$/);
  if (angled) {
    return {
      name: angled[1].trim().replace(/^"(.*)"$/, '$1').trim(),
      email: angled[2].trim().toLowerCase(),
    };
  }

  const bare = raw.match(/^([^<>\s]+@[^<>\s]+)$/);
  if (bare) return { name: '', email: bare[1].toLowerCase() };

  return { name: '', email: raw.toLowerCase() };
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
