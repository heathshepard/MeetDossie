// api/_lib/email-integration-customers.js
//
// Shared entitlement + mailbox lookup for the three Email Integration add-on
// watchers. A customer is in scope for all three watchers when BOTH are true:
//   (a) subscriptions.email_integration_enabled = true
//   (b) they have a connected Gmail (user_integrations row with a google_email)
//
// Added 2026-08-22 replacing the old single-hardcoded-mailbox
// (GMAIL_ACCOUNT='heath.shepard@kw.com') pattern in cron-email-to-dossier.js
// and the zero-gating pattern in cron-esign-events.js. Today this still
// resolves to just Heath's own account (he's the only connected + entitled
// row live as of 2026-08-22) — that is expected, not a bug: no paying
// customer has connected Google yet. The loop is correct for when they do.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) throw new Error(`supabase_fetch_failed:${path}:${res.status}`);
  return res.json();
}

/**
 * @returns {Promise<Array<{userId: string, googleEmail: string}>>}
 *   One entry per entitled + connected customer. Tokens are NOT included here
 *   (callers should load them fresh via gmail-oauth.js's
 *   loadGoogleTokensForUser right before use, to avoid carrying stale tokens
 *   across a long-running loop).
 */
async function listEmailIntegrationCustomers() {
  const entitled = await sb(
    'subscriptions?select=user_id&email_integration_enabled=eq.true',
  );
  const userIds = Array.from(new Set((Array.isArray(entitled) ? entitled : []).map((r) => r.user_id).filter(Boolean)));
  if (!userIds.length) return [];

  const connected = await sb(
    `user_integrations?select=user_id,google_email&google_email=not.is.null&user_id=in.(${userIds.map(encodeURIComponent).join(',')})`,
  );
  const seen = new Set();
  const out = [];
  for (const row of (Array.isArray(connected) ? connected : [])) {
    if (!row.user_id || !row.google_email || seen.has(row.user_id)) continue;
    seen.add(row.user_id);
    out.push({ userId: row.user_id, googleEmail: row.google_email });
  }
  return out;
}

module.exports = { listEmailIntegrationCustomers };
