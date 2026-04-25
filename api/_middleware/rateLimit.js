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
  constructor(message, retryAfterSeconds) {
    super(message);
    this.name = 'RateLimitError';
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function defaultsFor(endpoint) {
  return ENDPOINT_DEFAULTS[endpoint] || { maxRequests: 60, windowMs: 60 * 60 * 1000 };
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
      `rate_limits?select=id&identifier=eq.${safeId}&endpoint=eq.${safeEp}&created_at=gte.${safeSince}`,
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

  // Prefer Content-Range header for the count: e.g. "0-9/42"
  let count = 0;
  const cr = countResp.headers.get('content-range');
  if (cr && cr.includes('/')) {
    const total = cr.split('/')[1];
    const n = Number.parseInt(total, 10);
    if (Number.isFinite(n)) count = n;
  } else {
    try {
      const rows = await countResp.json();
      if (Array.isArray(rows)) count = rows.length;
    } catch (e) {
      // ignore — count stays 0
    }
  }

  if (count >= max) {
    const retryAfter = Math.ceil(window / 1000);
    throw new RateLimitError(
      `Rate limit exceeded for ${endpoint}. Try again in ~${retryAfter}s.`,
      retryAfter,
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

  return { allowed: true, remaining: Math.max(0, max - count - 1), limit: max };
}

module.exports = {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
  ENDPOINT_DEFAULTS,
};
