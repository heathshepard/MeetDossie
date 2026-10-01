'use strict';

// api/_lib/docuseal-health.js
// =========================================================================
// Live validation of a DocuSeal API key. Used both at connect-time (does
// this key the member just pasted actually work?) and on-demand from the
// Connections health check endpoint (is the stored key still good?).
//
// DocuSeal has no OAuth flow — a member connects by generating their own
// API key in their own DocuSeal account (Settings > API) and pasting it
// in. There is nothing to "refresh" the way Google/Microsoft tokens
// refresh; a DocuSeal key is either valid or it's been revoked/rotated by
// the member on DocuSeal's side. So this check is deliberately simple:
// ONE cheap, read-only, side-effect-free call (GET /templates?limit=1)
// that proves the key authenticates, nothing more.
//
// Categories returned mirror api/_lib/google-token-health.js's vocabulary
// (connected / expired / error / never_connected) so every provider's
// health reads the same way in the Connections UI — see
// api/integrations-status.js.
//
// SECURITY: never logs or returns the API key itself.
//
// Owner: Carter, 2026-10-01 (member integrations build).

const DOCUSEAL_BASE = 'https://api.docuseal.com';

/**
 * @param {string} apiKey
 * @param {Function} [fetchImpl] - injectable for tests
 * @returns {Promise<{ok: boolean, status: 'connected'|'invalid_key'|'network_error', detail?: string}>}
 */
async function checkDocusealKey(apiKey, fetchImpl) {
  const doFetch = fetchImpl || global.fetch;
  if (!apiKey) {
    return { ok: false, status: 'invalid_key', detail: 'No API key provided.' };
  }
  try {
    const res = await doFetch(`${DOCUSEAL_BASE}/templates?limit=1`, {
      headers: { 'X-Auth-Token': apiKey },
    });
    if (res.ok) {
      return { ok: true, status: 'connected' };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: 'invalid_key', detail: `DocuSeal rejected the key (HTTP ${res.status}).` };
    }
    const text = await res.text().catch(() => '');
    return { ok: false, status: 'network_error', detail: `DocuSeal returned HTTP ${res.status}: ${text.slice(0, 160)}` };
  } catch (err) {
    return { ok: false, status: 'network_error', detail: String((err && err.message) || err).slice(0, 160) };
  }
}

module.exports = { checkDocusealKey, DOCUSEAL_BASE };
