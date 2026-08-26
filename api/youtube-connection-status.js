// Vercel Serverless Function: /api/youtube-connection-status
// =========================================================================
// GET /api/youtube-connection-status
//   Authorization: Bearer <supabase-jwt>
//
// Reports whether the calling user has a live google_youtube OAuth grant
// (api/youtube-oauth-init.js + api/google-oauth-callback.js) and, if so,
// which channel it resolves to. Cheap sanity check for a "Connect YouTube"
// UI, and for scripts confirming a grant is usable before calling
// /api/youtube-upload.
//
// Returns:
//   { ok: true, connected: false }
//   { ok: true, connected: true, google_email, channel: { id, title, uploadsAllowed } }
//   { ok: true, connected: true, channel: null, error: "<reason>" }  -- token stored but dead (revoked/expired refresh token)
//
// Owner: Atlas (2026-08-25).

const { verifySupabaseToken } = require('./_middleware/auth.js');
const { loadYouTubeTokensForUser, getMyChannel } = require('./_lib/youtube-oauth.js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  const tokens = await loadYouTubeTokensForUser(authUser.userId).catch(() => null);
  if (!tokens || !tokens.refresh_token) {
    return res.status(200).json({ ok: true, connected: false });
  }

  try {
    const channel = await getMyChannel(authUser.userId);
    return res.status(200).json({
      ok: true,
      connected: true,
      google_email: tokens.google_email || null,
      channel,
    });
  } catch (err) {
    return res.status(200).json({
      ok: true,
      connected: true,
      google_email: tokens.google_email || null,
      channel: null,
      error: err.message.slice(0, 200),
    });
  }
};

module.exports.config = { maxDuration: 15 };
