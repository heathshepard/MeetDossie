// Vercel Serverless Function: /api/reply-monitoring-status
// GET (no params, uses the caller's own auth token)
//
// Tells the Talk-to-Dossie side panel banner whether Reply Monitoring is
// actually live for the signed-in user, so the UI stops hardcoding
// "Coming Soon" for a feature that already ships for entitled accounts.
//
// Mirrors api/cron-email-to-dossier.js's isReplyMonitoringEnabled() exactly
// (same table, same column, same "active subscription" condition, same
// HEATH_KW_USER_ID dogfood bypass) so this never drifts from what the cron
// actually gates on.
//
// IMPORTANT CAVEAT (2026-08-12): the cron itself only ever watches ONE
// mailbox (heath.shepard@kw.com, hardcoded GMAIL_ACCOUNT) and only ever
// loads HEATH_KW_USER_ID's own transactions (loadActiveDealsWithContacts()
// filters transactions by user_id=eq.HEATH_KW_USER_ID). So today, flipping
// reply_monitoring_enabled=true for any OTHER account's subscription row
// does not actually monitor anything for that account -- there is no
// per-customer inbox connection built yet. This endpoint reports the
// entitlement flag as instructed; it does not (and structurally cannot yet)
// verify that the feature is mechanically live for a non-Heath account.
// Flagged in the same commit's message -- do not grant this add-on to a
// real paying customer expecting it to work until the cron is generalized
// past a single hardcoded mailbox/owner.
//
// Authorization: Bearer <supabase user JWT>
// Response: { ok: true, enabled: boolean }

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Same hardcoded id as api/cron-email-to-dossier.js's HEATH_KW_USER_ID --
// the builder/dogfood account, always entitled, never gated behind its own
// price. Keep in sync if that file's constant ever changes.
const HEATH_KW_USER_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  if (!origin) return true;
  let allowOrigin = null;
  if (
    ALLOWED_ORIGINS.has(origin) ||
    LOCALHOST_ORIGIN_RE.test(origin) ||
    VERCEL_PREVIEW_RE.test(origin)
  ) {
    allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

function supa(path) {
  return fetch(SUPABASE_URL + '/rest/v1/' + path, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
  });
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }
  if (!corsAllowed) {
    res.status(403).json({ ok: false, error: 'Origin not allowed.' });
    return;
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    res.status(500).json({ ok: false, error: 'Service not configured.' });
    return;
  }

  try {
    const { userId } = await verifySupabaseToken(req);

    if (userId === HEATH_KW_USER_ID) {
      return res.status(200).json({ ok: true, enabled: true });
    }

    const subRes = await supa(
      'subscriptions?select=reply_monitoring_enabled&user_id=eq.' +
      encodeURIComponent(userId) +
      '&status=eq.active&order=updated_at.desc&limit=1'
    );
    if (!subRes.ok) {
      // Fail closed on a paid gate -- never claim entitlement we couldn't confirm.
      return res.status(200).json({ ok: true, enabled: false });
    }
    const rows = await subRes.json().catch(() => []);
    const enabled = !!(Array.isArray(rows) && rows[0] && rows[0].reply_monitoring_enabled === true);
    return res.status(200).json({ ok: true, enabled });

  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.status || 401).json({ ok: false, error: err.message });
    }
    console.error('[reply-monitoring-status] error:', err && err.message);
    // Fail closed.
    return res.status(200).json({ ok: true, enabled: false });
  }
};
