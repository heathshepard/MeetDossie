// api/gmail-refresh.js
//
// Refreshes the stored Google access token for a connected mailbox and writes
// it back to user_integrations. Does NOT return the token in the response —
// callers read it from Supabase, so no secret crosses the wire.
//
// Exists because GOOGLE_CLIENT_SECRET is a Sensitive var in Vercel: it can only
// be used server-side, so a local process holding the refresh token still can't
// mint an access token. This endpoint is that missing hop.
//
// SELF-HEAL LADDER (Atlas, 2026-09-28): this used to pick only the single
// newest user_integrations row (order=updated_at.desc&limit=1) and fail the
// whole request if THAT row's refresh_token was revoked — even when an
// older row for the same email still held a live grant (user_integrations
// is unique on (user_id, oauth_provider), not google_email, so a re-consent
// leaves multiple rows). Now delegates to api/_lib/google-refresh-ladder.js,
// which walks every row newest→oldest, retries transient failures, and only
// gives up once every row has confirmed invalid_grant. See that file's
// header for the full incident + why a revoked grant still can't be
// auto-fixed past that point (needs a human at Google's consent screen).
//
// Auth:  Authorization: Bearer ${CRON_SECRET}
// Usage: GET /api/gmail-refresh?email=heath.shepard@kw.com

const { refreshWithLadder } = require('./_lib/google-refresh-ladder.js');
// Per-row client resolution (Atlas, 2026-09-29): heath.shepard@kw.com holds
// BOTH a google_calendar row (INTERNAL client) and google_gmail rows
// (CUSTOMER client) under one email. A flat GOOGLE_CLIENT_ID/SECRET here
// sent the INTERNAL-minted row's refresh_token to the CUSTOMER client and
// Google rejected it with unauthorized_client — see
// api/_lib/google-oauth-clients.js header for the full incident.
const { resolveGoogleClient } = require('./_lib/google-oauth-clients.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email_required' });

  try {
    const result = await refreshWithLadder({
      account: email,
      supabaseUrl: SUPABASE_URL,
      serviceKey: SERVICE_KEY,
      resolveClient: resolveGoogleClient,
    });

    if (result.outcome === 'healthy' || result.outcome === 'healthy_persist_failed') {
      // Read back the row we just wrote for the response shape callers
      // (scripts/kw-mail.py) expect — mirrors the old behavior exactly.
      const rows = await sb(
        `user_integrations?select=access_token,expires_at,scopes&id=eq.${encodeURIComponent(result.winningRowId)}`,
      );
      const row = (rows && rows[0]) || {};
      return res.status(200).json({
        ok: true,
        email,
        expires_at: row.expires_at,
        scope: row.scopes,
        recovered_row_id: result.winningRowId,
        pruned_count: (result.prunedIds || []).length,
        persist_warning: result.outcome === 'healthy_persist_failed' ? result.persistError : undefined,
      });
    }

    if (result.outcome === 'no_rows') {
      return res.status(404).json({ error: 'no_refresh_token_for_email', email });
    }

    if (result.outcome === 'client_config_error') {
      return res.status(502).json({
        error: 'client_config_error',
        detail: result.errorCode,
        hint: 'The Google OAuth client that minted this row\'s token was rejected — check GOOGLE_CLIENT_ID/SECRET (customer) or GOOGLE_INTERNAL_CLIENT_ID/SECRET (internal) in Vercel, not consent.',
      });
    }

    if (result.outcome === 'all_revoked') {
      return res.status(502).json({
        error: 'refresh_failed',
        detail: 'invalid_grant',
        tried: result.totalRows,
        pruned_count: (result.prunedIds || []).length,
        hint: `all ${result.totalRows} stored credential(s) revoked — re-run the OAuth consent flow`,
      });
    }

    // 'inconclusive' — none succeeded, but not cleanly all-revoked either.
    return res.status(502).json({
      error: 'refresh_inconclusive',
      tried: result.totalRows,
      hint: 'transient/config errors mixed in — retry shortly',
    });
  } catch (err) {
    console.error('[gmail-refresh]', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message.slice(0, 200) });
  }
}

async function sb(path, init = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status} ${(await r.text()).slice(0, 160)}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}
