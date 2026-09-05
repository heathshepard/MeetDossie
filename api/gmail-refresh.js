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
// Auth:  Authorization: Bearer ${CRON_SECRET}
// Usage: GET /api/gmail-refresh?email=heath.shepard@kw.com

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

export const config = { maxDuration: 15 };

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

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(503).json({ error: 'google_oauth_not_configured' });
  }

  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email_required' });

  try {
    // Deterministic row pick: a re-consent can leave more than one row for the
    // same google_email (different user_id/provider pairs — the table is only
    // unique on user_id+oauth_provider). An unordered limit=1 here used to
    // grab whichever row Postgres returned first, including a dead one whose
    // refresh token was revoked (live failure 2026-08-29: every send hit
    // invalid_grant while a perfectly good row sat unread). Require a
    // non-null refresh token and take the most recently updated row.
    const rows = await sb(
      `user_integrations?select=id,refresh_token,google_email&google_email=eq.${encodeURIComponent(email)}`
      + `&refresh_token=not.is.null&order=updated_at.desc&limit=1`
    );
    if (!rows || !rows.length || !rows[0].refresh_token) {
      return res.status(404).json({ error: 'no_refresh_token_for_email', email });
    }

    const body = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: rows[0].refresh_token,
      grant_type: 'refresh_token',
    });
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok || !tok.access_token) {
      // A revoked or expired refresh token surfaces here as invalid_grant, and
      // the only fix is re-running consent — say so plainly rather than 500ing.
      return res.status(502).json({
        error: 'refresh_failed',
        detail: tok.error || `http_${tokenRes.status}`,
        hint: tok.error === 'invalid_grant' ? 're-run the OAuth consent flow' : undefined,
      });
    }

    const expiresAt = new Date(Date.now() + (tok.expires_in || 3600) * 1000).toISOString();
    // Write back to the exact row we refreshed — patching by google_email
    // would smear this access token across every row carrying that address
    // (e.g. a google_youtube row for the same account). Bump updated_at so
    // "most recently updated" keeps pointing at the row that actually works.
    await sb(`user_integrations?id=eq.${encodeURIComponent(rows[0].id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ access_token: tok.access_token, expires_at: expiresAt, updated_at: new Date().toISOString() }),
    });

    return res.status(200).json({ ok: true, email, expires_at: expiresAt, scope: tok.scope });
  } catch (err) {
    console.error('[gmail-refresh]', err.message);
    return res.status(500).json({ error: 'internal', detail: err.message.slice(0, 200) });
  }
}
