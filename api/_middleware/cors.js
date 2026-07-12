// api/_middleware/cors.js
// Shared CORS middleware for MeetDossie API endpoints.
//
// Usage:
//   const { applyCorsHeaders } = require('./_middleware/cors');
//
//   module.exports = async function handler(req, res) {
//     const corsAllowed = applyCorsHeaders(req, res);
//     if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
//     if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed.' });
//     // ... handler logic
//   };
//
// Origin match rules:
//   - Exact allowlist: meetdossie.com, www.meetdossie.com, staging.meetdossie.com
//   - Any subdomain of .meetdossie.com (app., api., preview branches, etc.)
//   - Any Vercel preview deployment (.vercel.app)
//   - Capacitor native shell (capacitor://localhost) for the mobile APK
//   - Localhost / 127.0.0.1 with any port for local dev
//
// Returns true if the origin is allowed (or absent — same-origin server-side calls),
// false if a present origin is rejected. Caller decides how to respond.

const EXACT_ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
  'https://staging.meetdossie.com',
  'capacitor://localhost',
]);

const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function isAllowedOrigin(origin) {
  if (typeof origin !== 'string' || origin.length === 0) return false;
  if (EXACT_ALLOWED_ORIGINS.has(origin)) return true;
  if (LOCALHOST_ORIGIN_RE.test(origin)) return true;
  // Match any subdomain of meetdossie.com (https only).
  if (/^https:\/\/[a-z0-9-]+\.meetdossie\.com$/i.test(origin)) return true;
  // Match any Vercel preview deployment.
  if (/^https:\/\/[a-z0-9-]+\.vercel\.app$/i.test(origin)) return true;
  return false;
}

function applyCorsHeaders(req, res, options = {}) {
  const {
    methods = 'GET, POST, OPTIONS',
    headers = 'Content-Type, Authorization',
    credentials = false,
    maxAge = 600,
  } = options;

  const origin = (req && req.headers && req.headers.origin) || '';

  // No Origin header (e.g. server-to-server, curl without -H Origin) — allow through.
  if (!origin) return true;

  if (!isAllowedOrigin(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', headers);
  res.setHeader('Access-Control-Max-Age', String(maxAge));
  if (credentials) {
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  return true;
}

module.exports = { applyCorsHeaders, isAllowedOrigin };
