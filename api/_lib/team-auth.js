// api/_lib/team-auth.js
// Shared authentication + authorization helpers for /api/team/* endpoints.
//
// Pattern: every team API requires a Bearer JWT from the caller. We verify
// the JWT against Supabase Auth, then use the service-role client to call
// the SECURITY DEFINER RPCs with `p_acting_user_id` set to the caller's
// user_id. RLS does NOT protect these endpoints — the RPC itself enforces
// the role checks (admin / member / agent / TC).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// CORS allowed origins. Match MeetDossie's standard set.
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const STAGING_VERCEL_RE = /^https:\/\/meet-dossie(-[a-z0-9-]+)?\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allow = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || STAGING_VERCEL_RE.test(origin)) {
      allow = origin;
    }
  }
  if (allow) {
    res.setHeader('Access-Control-Allow-Origin', allow);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return Boolean(allow);
}

function getServiceClient() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase env vars not configured');
  }
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function verifyBearer(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) {
    const e = new Error('Missing or malformed Authorization header');
    e.status = 401;
    throw e;
  }
  const token = header.slice('Bearer '.length).trim();
  if (!token) {
    const e = new Error('Empty bearer token');
    e.status = 401;
    throw e;
  }
  const supabase = getServiceClient();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) {
    const e = new Error('Invalid or expired session');
    e.status = 401;
    throw e;
  }
  return { user: data.user, supabase };
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.length > 0) {
    return xf.split(',')[0].trim();
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
}

function preflight(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

function sendError(res, err) {
  const status = err && err.status ? err.status : 500;
  const msg = err && err.message ? err.message : 'Internal error';
  res.status(status).json({ ok: false, error: msg });
}

module.exports = {
  applyCors,
  preflight,
  verifyBearer,
  getServiceClient,
  clientIp,
  sendError,
};
