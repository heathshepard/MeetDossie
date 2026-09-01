// api/_lib/mail-client.js
//
// Provider dispatcher for the Email Integration add-on. Reads whichever
// user_integrations row a customer actually connected (Google or Microsoft
// Graph) and hands back a client with the SAME shape either way, so
// cron-email-to-dossier.js / cron-esign-events.js / cron-showingtime-feedback.js
// don't branch on provider at all.
//
// Built 2026-09-01 alongside api/_lib/microsoft-oauth.js
// (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH).

const { loadGoogleTokensForUser, makeGmailClient } = require('./gmail-oauth');
const { loadMicrosoftTokensForUser, makeMicrosoftClient } = require('./microsoft-oauth');

/**
 * @param {{userId: string}} args
 * @returns {Promise<{provider: 'google'|'microsoft', email: string, tokens: object, client: Function} | null>}
 *   null when the user has no connected inbox for either provider.
 */
async function makeMailClient({ userId }) {
  const [googleTokens, microsoftTokens] = await Promise.all([
    loadGoogleTokensForUser(userId),
    loadMicrosoftTokensForUser(userId),
  ]);

  // A user connecting both is an edge case (e.g. testing, or switching
  // providers without disconnecting the old one first) — Google wins the
  // tie-break deterministically rather than guessing at "freshness". This
  // only matters until the customer disconnects one of the two.
  if (googleTokens) {
    return {
      provider: 'google',
      email: googleTokens.google_email,
      tokens: googleTokens,
      client: makeGmailClient({ userId, tokens: googleTokens }),
    };
  }
  if (microsoftTokens) {
    return {
      provider: 'microsoft',
      email: microsoftTokens.microsoft_email,
      tokens: microsoftTokens,
      client: makeMicrosoftClient({ userId, tokens: microsoftTokens }),
    };
  }
  return null;
}

module.exports = { makeMailClient };
