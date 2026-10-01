// api/_middleware/rateLimit.js
// Append-only rate limiter backed by the Supabase `rate_limits` table.
//
// Assumed table schema (the table is reported to already exist):
//   create table rate_limits (
//     id           bigint generated always as identity primary key,
//     identifier   text not null,
//     endpoint     text not null,
//     created_at   timestamptz not null default now()
//   );
//   create index on rate_limits (identifier, endpoint, created_at desc);
//
// Strategy: count rows for (identifier, endpoint) with created_at > now-window.
// If count >= maxRequests, throw RateLimitError. Otherwise insert one row.
//
// Fail-open behavior: if SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY are missing
// or Supabase is unreachable, we LOG and ALLOW the request rather than
// brick the entire API. (Auth, by contrast, fails closed.)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ENDPOINT_DEFAULTS = {
  'scan-contract': { maxRequests: 10, windowMs: 60 * 60 * 1000 },
  leads: { maxRequests: 60, windowMs: 60 * 60 * 1000 },
  speak: { maxRequests: 100, windowMs: 60 * 60 * 1000 },
};

class RateLimitError extends Error {
  constructor(message, retryAfterSeconds, extra) {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
    // limit / remaining / resetAt / windowLabel let callers build a message
    // that states the actual number and the actual reset time instead of a
    // bare "try again later" — see api/chat.js's pattern, which this mirrors.
    if (extra) Object.assign(this, extra);
  }
}

function defaultsFor(endpoint) {
  return ENDPOINT_DEFAULTS[endpoint] || { maxRequests: 60, windowMs: 60 * 60 * 1000 };
}

// Human label for a window size, for use in client-facing messages
// ("40 scans per hour", "120 scans per day").
function labelForWindow(windowMs) {
  if (windowMs <= 60 * 60 * 1000) return 'hour';
  if (windowMs <= 24 * 60 * 60 * 1000) return 'day';
  const days = Math.round(windowMs / (24 * 60 * 60 * 1000));
  return `${days} days`;
}

function clientIpFromReq(req) {
  if (!req || !req.headers) return 'unknown';
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    // First IP in the chain is the original client.
    return xff.split(',')[0].trim() || 'unknown';
  }
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length > 0) return real.trim();
  if (req.socket && req.socket.remoteAddress) return String(req.socket.remoteAddress);
  return 'unknown';
}

async function supabaseFetch(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function checkRateLimit(identifier, endpoint, maxRequests, windowMs) {
  if (typeof identifier !== 'string' || identifier.length === 0) identifier = 'unknown';
  if (typeof endpoint !== 'string' || endpoint.length === 0) endpoint = 'default';

  const d = defaultsFor(endpoint);
  const max = Number.isFinite(maxRequests) && maxRequests > 0 ? Math.floor(maxRequests) : d.maxRequests;
  const window = Number.isFinite(windowMs) && windowMs > 0 ? Math.floor(windowMs) : d.windowMs;

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[rateLimit] Supabase not configured; allowing request (fail-open).');
    return { allowed: true, remaining: max, limit: max };
  }

  const since = new Date(Date.now() - window).toISOString();
  const safeId = encodeURIComponent(identifier);
  const safeEp = encodeURIComponent(endpoint);
  const safeSince = encodeURIComponent(since);

  let countResp;
  try {
    countResp = await supabaseFetch(
      // order=created_at.asc so row[0] (if any) is the OLDEST request still
      // inside the window — that timestamp + window is the real reset time,
      // not just "now + window", which would be wrong for a sliding window.
      `rate_limits?select=id,created_at&identifier=eq.${safeId}&endpoint=eq.${safeEp}&created_at=gte.${safeSince}&order=created_at.asc`,
      { method: 'GET', headers: { Prefer: 'count=exact' } },
    );
  } catch (err) {
    console.warn('[rateLimit] count query failed, allowing request:', err && err.message);
    return { allowed: true, remaining: max, limit: max };
  }

  if (!countResp.ok) {
    console.warn('[rateLimit] count query non-OK status', countResp.status, '— allowing.');
    return { allowed: true, remaining: max, limit: max };
  }

  let rows = [];
  try {
    rows = await countResp.json();
    if (!Array.isArray(rows)) rows = [];
  } catch (e) {
    rows = [];
  }

  // Prefer Content-Range header for the count: e.g. "0-9/42"
  let count = rows.length;
  const cr = countResp.headers.get('content-range');
  if (cr && cr.includes('/')) {
    const total = cr.split('/')[1];
    const n = Number.parseInt(total, 10);
    if (Number.isFinite(n)) count = n;
  }

  const oldestCreatedAt = rows.length > 0 ? rows[0].created_at : null;
  const resetAtMs = oldestCreatedAt ? new Date(oldestCreatedAt).getTime() + window : Date.now() + window;
  const windowLabel = labelForWindow(window);

  if (count >= max) {
    const retryAfter = Math.max(1, Math.ceil((resetAtMs - Date.now()) / 1000));
    // Generic default message (endpoint-named) — callers that want a
    // richer, feature-specific message (e.g. "document scans") should build
    // it themselves from error.limit / error.windowLabel / error.resetAt
    // rather than relying on this string. See api/scan-contract.js.
    throw new RateLimitError(
      `You've hit the ${max} requests per ${windowLabel} limit for ${endpoint}. Resets at ${new Date(resetAtMs).toISOString()}.`,
      retryAfter,
      { limit: max, remaining: 0, resetAt: new Date(resetAtMs).toISOString(), windowLabel },
    );
  }

  // Record this request (fire-and-forget on failure; we already passed the check).
  try {
    const insResp = await supabaseFetch('rate_limits', {
      method: 'POST',
      body: JSON.stringify({ identifier, endpoint }),
    });
    if (!insResp.ok) {
      console.warn('[rateLimit] insert returned non-OK', insResp.status);
    }
  } catch (err) {
    console.warn('[rateLimit] insert failed (non-fatal):', err && err.message);
  }

  return {
    allowed: true,
    remaining: Math.max(0, max - count - 1),
    limit: max,
    resetAt: new Date(resetAtMs).toISOString(),
    windowLabel,
  };
}

module.exports = {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
  ENDPOINT_DEFAULTS,
};
