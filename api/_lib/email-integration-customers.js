// api/_lib/email-integration-customers.js
//
// Shared entitlement + mailbox lookup for the three Email Integration add-on
// watchers. A customer is in scope for all three watchers when BOTH are true:
//   (a) subscriptions.email_integration_enabled = true
//   (b) they have a connected inbox (user_integrations row with EITHER a
//       google_email (oauth_provider='google_calendar') OR a microsoft_email
//       (oauth_provider='microsoft_graph'))
//
// Added 2026-08-22 replacing the old single-hardcoded-mailbox
// (GMAIL_ACCOUNT='heath.shepard@kw.com') pattern in cron-email-to-dossier.js
// and the zero-gating pattern in cron-esign-events.js. Today this still
// resolves to just Heath's own account (he's the only connected + entitled
// row live as of 2026-08-22) — that is expected, not a bug: no paying
// customer has connected Google yet. The loop is correct for when they do.
//
// Extended 2026-09-01 to also match Microsoft Graph connections
// (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH) — see api/_lib/microsoft-oauth.js and
// api/_lib/mail-client.js. `email`/`provider` are the new fields; `googleEmail`
// is kept as an alias of `email` for any caller not yet updated (there
// should be none left in this repo — grep before removing it).

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
 * @returns {Promise<Array<{userId: string, email: string, provider: 'google'|'microsoft', googleEmail: string}>>}
 *   One entry per entitled + connected customer, regardless of which
 *   provider they connected. Tokens are NOT included here (callers should
 *   load them fresh via mail-client.js's makeMailClient right before use, to
 *   avoid carrying stale tokens across a long-running loop). `googleEmail` is
 *   a back-compat alias of `email` — same value for either provider.
 */
async function listEmailIntegrationCustomers() {
  const entitled = await sb(
    'subscriptions?select=user_id&email_integration_enabled=eq.true',
  );
  const userIds = Array.from(new Set((Array.isArray(entitled) ? entitled : []).map((r) => r.user_id).filter(Boolean)));
  if (!userIds.length) return [];

  const connected = await sb(
    `user_integrations?select=user_id,google_email,microsoft_email&user_id=in.(${userIds.map(encodeURIComponent).join(',')})`
    + `&or=(google_email.not.is.null,microsoft_email.not.is.null)`,
  );
  const seen = new Set();
  const out = [];
  for (const row of (Array.isArray(connected) ? connected : [])) {
    if (!row.user_id || seen.has(row.user_id)) continue;
    // Google wins if a user somehow has both rows connected — same
    // tie-break as api/_lib/mail-client.js.
    const email = row.google_email || row.microsoft_email;
    if (!email) continue;
    seen.add(row.user_id);
    const provider = row.google_email ? 'google' : 'microsoft';
    out.push({ userId: row.user_id, email, provider, googleEmail: email });
  }
  return out;
}

module.exports = { listEmailIntegrationCustomers };
