'use strict';

// api/_lib/docuseal-client.js
// =========================================================================
// ONE place that resolves which DocuSeal API key a request should send
// under: the authenticated member's OWN connected DocuSeal account
// (public.user_integrations, oauth_provider='docuseal') if they have one,
// else the shared DOCUSEAL_API_KEY env var (Heath's account — today's
// default for every member who hasn't connected their own yet).
//
// WHY THIS EXISTS: before this file, api/esign-create.js,
// api/esign-download.js, and api/fill-form-via-docuseal.js each read
// process.env.DOCUSEAL_API_KEY as a flat module constant and sent every
// member's contract under Heath's single shared DocuSeal account. That's
// fine for founding-member volume, wrong for a product — Heath's account
// is a single point of failure/rate-limit for every member, and members
// can never see their own envelopes in their own DocuSeal dashboard.
//
// HOW CALLERS USE THIS (no function-signature changes required in the
// ~12 existing DocuSeal call sites across those 3 files):
//   1. Once per request, right after resolving the authenticated userId:
//        const { apiKey } = await resolveDocusealApiKeyForUser(userId);
//        activateDocusealApiKeyForRequest(apiKey);
//   2. Every existing call site that used to read the bare identifier
//      `DOCUSEAL_API_KEY` now calls `getDocusealApiKey()` instead — same
//      value, now per-request instead of a static module-level constant.
//
// SAFE UNDER CONCURRENT REQUESTS: this uses Node's AsyncLocalStorage, which
// gives each inbound request's async call chain its own isolated context
// even when the same warm Lambda/module instance handles many requests —
// unlike reassigning a shared `let` module variable, which would leak one
// request's key into a concurrently-running request on the same instance.
//
// api/esign-download.js has no end-user JWT (it's a CRON_SECRET-only
// internal/webhook endpoint) — it resolves apiKey from the signature
// request's OWN user_id column instead of an auth header.
//
// SECURITY: never log, print, or return a DocuSeal API key — this repo is
// public and GitGuardian is active.
//
// Owner: Carter, 2026-10-01 (member integrations build).

const { AsyncLocalStorage } = require('node:async_hooks');
const { decryptSecret } = require('./secret-crypto');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const docusealKeyContext = new AsyncLocalStorage();

/**
 * Reads the DocuSeal API key for the current request's async chain, set by
 * activateDocusealApiKeyForRequest(). Falls back to the shared
 * process.env.DOCUSEAL_API_KEY when no per-request context is active (e.g.
 * a test harness calling a DocuSeal helper directly, or a code path that
 * never calls activateDocusealApiKeyForRequest).
 * @returns {string|null}
 */
function getDocusealApiKey() {
  const fromContext = docusealKeyContext.getStore();
  if (fromContext) return fromContext;
  return process.env.DOCUSEAL_API_KEY || null;
}

/**
 * Sets the DocuSeal API key for the remainder of THIS request's async
 * execution chain. Call once, early in a handler, after resolving apiKey
 * via resolveDocusealApiKeyForUser(). Uses enterWith() (not run()) so
 * callers don't have to restructure existing try/catch control flow into
 * a callback.
 * @param {string|null} apiKey
 */
function activateDocusealApiKeyForRequest(apiKey) {
  docusealKeyContext.enterWith(apiKey || null);
}

/**
 * Looks up the member's own connected DocuSeal API key. Returns the
 * shared env key (source:'shared') when the member has no connected row,
 * their stored key fails to decrypt, or Supabase env vars are missing —
 * every one of those is "fall back to today's default," never a hard
 * failure for the caller.
 * @param {string} userId
 * @returns {Promise<{apiKey: string|null, source: 'member'|'shared'|'none', accountEmail?: string}>}
 */
async function resolveDocusealApiKeyForUser(userId) {
  const sharedFallback = () => ({
    apiKey: process.env.DOCUSEAL_API_KEY || null,
    source: process.env.DOCUSEAL_API_KEY ? 'shared' : 'none',
  });

  if (!userId || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return sharedFallback();
  }

  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/user_integrations`
      + `?select=docuseal_api_key_encrypted,docuseal_account_email`
      + `&user_id=eq.${encodeURIComponent(userId)}&oauth_provider=eq.docuseal&limit=1`,
      { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
    );
    if (r.ok) {
      const rows = await r.json().catch(() => []);
      const row = Array.isArray(rows) ? rows[0] : null;
      if (row && row.docuseal_api_key_encrypted) {
        const apiKey = decryptSecret(row.docuseal_api_key_encrypted);
        if (apiKey) {
          return { apiKey, source: 'member', accountEmail: row.docuseal_account_email || null };
        }
      }
    }
  } catch (err) {
    console.warn('[docuseal-client] resolveDocusealApiKeyForUser lookup failed:', err && err.message);
  }
  return sharedFallback();
}

module.exports = {
  getDocusealApiKey,
  activateDocusealApiKeyForRequest,
  resolveDocusealApiKeyForUser,
  docusealKeyContext,
};
