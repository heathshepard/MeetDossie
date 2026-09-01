// api/_lib/microsoft-oauth.js
//
// Microsoft Graph mail client for the Email Integration add-on. Mirrors
// api/_lib/gmail-oauth.js's export surface EXACTLY (same five behaviours)
// so api/_lib/mail-client.js can hand either client to
// cron-email-to-dossier.js / cron-esign-events.js / cron-showingtime-feedback.js
// with zero changes to their parsing/matching/filing logic.
//
// Graph's JSON shape is nothing like Gmail's. All normalisation happens
// INSIDE makeMicrosoftClient() below, so the object handed back from
// `graph('messages/<id>', {format:'full'})` looks exactly like a Gmail
// `users.messages.get` response: { id, snippet, payload: { headers: [...],
// parts: [...] } }. headerMap/parseFromHeader/bodyOfMessage are pure
// functions of THAT shape, so they're simply re-exported from gmail-oauth.js
// rather than duplicated — one source of truth for normalized-message parsing.
//
// Query grammar: the three consumers only ever pass two Gmail search-query
// shapes (grep the repo before changing either):
//   1. `after:<epoch> -in:sent -in:drafts -in:spam -in:trash -in:chats`
//   2. `(from:a.com OR from:b.com OR ...) newer_than:<N>d`
// parseGmailStyleQuery() below targets exactly those two shapes, not general
// Gmail search syntax. It logs (does not throw) on an unrecognised token, so
// a future query change fails loud in logs instead of silently mis-filtering.
//
// Auth: user_integrations row with oauth_provider='microsoft_graph' and
// microsoft_email set, written by api/microsoft-oauth-callback.js. Scopes
// requested at consent: openid, email, offline_access, Mail.Read ONLY — no
// send/write scope requested or needed (read-only mail sync).
//
// Built 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH). Human gate: Azure /
// Entra app registration — MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
// MICROSOFT_OAUTH_REDIRECT_URI must exist in Vercel before any of this can
// run against a real mailbox. See docs/ENV.md for exact setup steps.

const { headerMap, parseFromHeader, bodyOfMessage } = require('./gmail-oauth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MICROSOFT_CLIENT_ID = process.env.MICROSOFT_CLIENT_ID;
const MICROSOFT_CLIENT_SECRET = process.env.MICROSOFT_CLIENT_SECRET;

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';

// Read-only. Do not add Mail.Send / Mail.ReadWrite without an explicit ask —
// see task note in docs/ENV.md.
const SCOPES = ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Mail.Read'];

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

// Returns { access_token, refresh_token, expires_at, microsoft_email } or null.
async function loadMicrosoftTokensForUser(userId) {
  const { ok, data } = await sb(
    `user_integrations?select=access_token,refresh_token,expires_at,microsoft_email&user_id=eq.${encodeURIComponent(userId)}`
    + `&oauth_provider=eq.microsoft_graph&microsoft_email=not.is.null&order=updated_at.desc&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

// Scoped to oauth_provider=microsoft_graph so this never clobbers a Google
// row for the same user (user_integrations is unique on user_id+oauth_provider).
async function persistAccessToken(userId, accessToken, expiresAt) {
  await sb(`user_integrations?user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.microsoft_graph`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ access_token: accessToken, expires_at: expiresAt }),
  }).catch(() => {});
}

async function refreshMicrosoftToken(refreshToken) {
  const body = new URLSearchParams({
    client_id: MICROSOFT_CLIENT_ID,
    client_secret: MICROSOFT_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES.join(' '),
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.access_token) {
    // Microsoft uses the same RFC 6749 "invalid_grant" error string Google
    // does for a revoked/expired refresh token (AADSTS70008 / AADSTS65001
    // etc. ride along in error_description) — isInvalidGrant means the same
    // thing to callers either way: the customer needs to reconnect.
    const detail = data?.error_description || data?.error || `http_${res.status}`;
    const err = new Error(`microsoft_refresh_failed:${detail}`);
    err.isInvalidGrant = data?.error === 'invalid_grant';
    throw err;
  }
  return data;
}

// --------------------------------------------------------------------------
// Gmail-style query -> Graph filter translation (see module header for the
// exact two grammars this supports).
// --------------------------------------------------------------------------
function parseGmailStyleQuery(q) {
  const raw = String(q || '');
  let sinceEpochSec = null;
  const fromNeedles = [];
  const unrecognized = [];

  // after:<epoch>
  const afterMatch = raw.match(/after:(\d+)/);
  if (afterMatch) sinceEpochSec = Number(afterMatch[1]);

  // newer_than:<N>d  (only "d" unit is ever used in this repo)
  const newerMatch = raw.match(/newer_than:(\d+)d/);
  if (newerMatch) {
    const cutoff = Math.floor(Date.now() / 1000) - Number(newerMatch[1]) * 86400;
    sinceEpochSec = sinceEpochSec === null ? cutoff : Math.max(sinceEpochSec, cutoff);
  }

  // from:<domain-or-address>  (may repeat, OR'd together in this repo's usage)
  const fromRe = /from:([^\s()]+)/g;
  let m;
  while ((m = fromRe.exec(raw))) fromNeedles.push(m[1].toLowerCase());

  // Everything else we recognise as a structural no-op given Inbox-folder
  // scoping already excludes it: -in:sent/-in:drafts/-in:spam/-in:trash/-in:chats,
  // the "OR"/parens tokens themselves, and -in:<anything>.
  const known = /after:\d+|newer_than:\d+d|from:[^\s()]+|-in:\w+|OR|\(|\)/g;
  const leftover = raw.replace(known, '').trim();
  if (leftover) unrecognized.push(leftover);
  if (unrecognized.length) {
    console.warn('[microsoft-oauth] unrecognised query token(s), ignoring:', unrecognized.join(' | '), '| full query:', raw);
  }

  // Safety cap so a query with neither after: nor newer_than: never becomes
  // an unbounded full-mailbox scan.
  if (sinceEpochSec === null) {
    sinceEpochSec = Math.floor(Date.now() / 1000) - 3 * 86400;
  }

  return { sinceIso: new Date(sinceEpochSec * 1000).toISOString(), fromNeedles };
}

function matchesFromNeedles(fromAddress, needles) {
  if (!needles.length) return true;
  const addr = String(fromAddress || '').toLowerCase();
  return needles.some((n) => addr.includes(n));
}

function graphMessageToGmailShape(gm) {
  const fromAddr = gm.from?.emailAddress?.address || '';
  const fromName = gm.from?.emailAddress?.name || '';
  const fromHeader = fromName ? `"${fromName}" <${fromAddr}>` : fromAddr;

  const headers = [
    { name: 'From', value: fromHeader },
    { name: 'Subject', value: gm.subject || '' },
    { name: 'Date', value: gm.receivedDateTime || '' },
  ];

  const bodyContentType = (gm.body?.contentType || 'text').toLowerCase();
  const parts = [
    {
      mimeType: bodyContentType === 'html' ? 'text/html' : 'text/plain',
      body: { data: Buffer.from(gm.body?.content || '', 'utf-8').toString('base64url') },
    },
  ];

  for (const att of (gm.attachments || [])) {
    if (att['@odata.type'] && att['@odata.type'] !== '#microsoft.graph.fileAttachment') continue; // skip item/reference attachments
    parts.push({
      filename: att.name || '',
      mimeType: att.contentType || 'application/octet-stream',
      body: { attachmentId: att.id, size: att.size || 0 },
    });
  }

  return {
    id: gm.id,
    snippet: gm.bodyPreview || '',
    payload: { headers, parts },
  };
}

// Builds a `graph(path, params)` fetcher bound to one user, with the SAME
// call signature makeGmailClient() returns — consumers pass the same three
// path shapes ('messages', 'messages/<id>', 'messages/<id>/attachments/<id>')
// regardless of which provider is behind it.
function makeMicrosoftClient({ userId, tokens }) {
  let accessToken = tokens.access_token;

  async function rawFetch(url, init = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
    });
    if (!res.ok) {
      const err = new Error(`graph_failed:${url}:${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  async function listMessages(params) {
    const { sinceIso, fromNeedles } = parseGmailStyleQuery(params?.q);
    const maxResults = Number(params?.maxResults) || 50;
    // Overfetch date-filtered candidates so the client-side from: filter
    // still has enough to work with; Graph does the date filtering server-side.
    const top = Math.min(Math.max(maxResults * 4, maxResults), 200);
    const filter = `receivedDateTime ge ${sinceIso}`;
    const qs = new URLSearchParams({
      $select: 'id,from,receivedDateTime',
      $filter: filter,
      $orderby: 'receivedDateTime desc',
      $top: String(top),
    });
    const url = `${GRAPH_BASE}/me/mailFolders/inbox/messages?${qs.toString()}`;
    const data = await rawFetch(url);
    const all = Array.isArray(data.value) ? data.value : [];
    const filtered = all.filter((m) => matchesFromNeedles(m.from?.emailAddress?.address, fromNeedles));
    return { messages: filtered.slice(0, maxResults).map((m) => ({ id: m.id })) };
  }

  async function getMessage(messageId) {
    const qs = new URLSearchParams({
      $select: 'id,subject,from,receivedDateTime,bodyPreview,body',
      $expand: 'attachments($select=id,name,contentType,size)',
    });
    const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}?${qs.toString()}`;
    // outlook.body-content-type="text" -> Graph returns body.content as plain
    // text instead of HTML, so we don't need HTML-stripping for the common case
    // (bodyOfMessage() still handles HTML as a fallback for any account where
    // this preference header is ignored).
    const gm = await rawFetch(url, { headers: { Prefer: 'outlook.body-content-type="text"' } });
    return graphMessageToGmailShape(gm);
  }

  async function getAttachment(messageId, attachmentId) {
    const url = `${GRAPH_BASE}/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const att = await rawFetch(url);
    const base64url = Buffer.from(att.contentBytes || '', 'base64').toString('base64url');
    return { data: base64url, size: att.size || 0 };
  }

  async function dispatch(path, params) {
    if (path === 'messages') return listMessages(params);
    const getMatch = /^messages\/([^/]+)$/.exec(path);
    if (getMatch) return getMessage(getMatch[1]);
    const attMatch = /^messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (attMatch) return getAttachment(attMatch[1], attMatch[2]);
    throw new Error(`microsoft_client_unsupported_path:${path}`);
  }

  return async function graph(path, params) {
    try {
      return await dispatch(path, params);
    } catch (err) {
      if (err.status === 401) {
        const refreshed = await refreshMicrosoftToken(tokens.refresh_token);
        accessToken = refreshed.access_token;
        const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
        await persistAccessToken(userId, accessToken, expiresAt);
        return dispatch(path, params);
      }
      throw err;
    }
  };
}

module.exports = {
  loadMicrosoftTokensForUser,
  persistAccessToken,
  refreshMicrosoftToken,
  makeMicrosoftClient,
  headerMap,
  parseFromHeader,
  bodyOfMessage,
  // exported for unit tests only
  _internal: { parseGmailStyleQuery, matchesFromNeedles, graphMessageToGmailShape },
};
