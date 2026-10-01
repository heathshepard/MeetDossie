'use strict';

// api/_lib/microsoft-token-health.js
// =========================================================================
// Per-member Microsoft Graph connection health. A THIN wrapper around the
// existing api/_lib/microsoft-oauth.js exports (loadMicrosoftTokensForUser,
// refreshMicrosoftToken, persistAccessToken) — no parallel refresh
// implementation. Microsoft hasn't shown Google's Testing-mode weekly
// revoke bug, and user_integrations is unique on (user_id, oauth_provider)
// so there is never more than one microsoft_graph row per member — the
// multi-row self-heal ladder google-refresh-ladder.js exists for doesn't
// apply here. One row, one refresh attempt, one verdict.
//
// Status vocabulary matches every other provider's health check
// (never_connected / connected / expired / error) — see
// api/integrations-status.js.
//
// Owner: Carter, 2026-10-01 (member integrations build).

const { loadMicrosoftTokensForUser, refreshMicrosoftToken, persistAccessToken } = require('./microsoft-oauth');

/**
 * @param {string} userId
 * @returns {Promise<{status: 'never_connected'|'connected'|'expired'|'error', detail?: string, accountEmail?: string}>}
 */
async function checkMicrosoftTokenHealth(userId) {
  let tokens;
  try {
    tokens = await loadMicrosoftTokensForUser(userId);
  } catch (err) {
    return { status: 'error', detail: `Could not read stored Microsoft tokens: ${String(err && err.message || err).slice(0, 160)}` };
  }
  if (!tokens || !tokens.refresh_token) {
    return { status: 'never_connected', detail: 'No Microsoft account connected.' };
  }

  try {
    const refreshed = await refreshMicrosoftToken(tokens.refresh_token);
    const expiresAt = new Date(Date.now() + (refreshed.expires_in || 3600) * 1000).toISOString();
    await persistAccessToken(userId, refreshed.access_token, expiresAt);
    return { status: 'connected', accountEmail: tokens.microsoft_email || null };
  } catch (err) {
    if (err && err.isInvalidGrant) {
      return {
        status: 'expired',
        detail: 'Microsoft access was revoked or expired. Reconnect in Settings.',
        accountEmail: tokens.microsoft_email || null,
      };
    }
    return {
      status: 'error',
      detail: String((err && err.message) || err).slice(0, 160),
      accountEmail: tokens.microsoft_email || null,
    };
  }
}

module.exports = { checkMicrosoftTokenHealth };
