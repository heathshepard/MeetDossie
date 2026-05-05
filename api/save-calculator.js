// Vercel Serverless Function: /api/save-calculator
// Persists a calculator user's email + computed deadlines to
// public.calculator_signups so we can email reminders 3 days before each
// deadline. Public endpoint — no auth required (validates input + rate-limits
// per IP via a small in-memory window).
//
// POST { email, contract: {...inputs}, deadlines: [{id,label,paragraph,date}] }
// Returns { ok: true, id }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) allowOrigin = origin;
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  return Boolean(allowOrigin) || !origin;
}

const isValidEmail = (e) => typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length < 200;
const isISODate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

// Coarse, per-instance rate limiter — cold-start resets it, but it stops
// the obvious "10k POSTs in a loop" abuse without needing Redis.
const RATE_BUCKET = new Map();
const RATE_LIMIT = 12; // requests
const RATE_WINDOW_MS = 60 * 1000;
function rateLimit(ip) {
  const now = Date.now();
  const arr = RATE_BUCKET.get(ip) || [];
  const fresh = arr.filter((t) => now - t < RATE_WINDOW_MS);
  fresh.push(now);
  RATE_BUCKET.set(ip, fresh);
  return fresh.length <= RATE_LIMIT;
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(corsAllowed ? 204 : 403).end();
  if (!corsAllowed) return res.status(403).json({ ok: false, error: 'Origin not allowed' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }
  if (!rateLimit(clientIp(req))) {
    return res.status(429).json({ ok: false, error: 'Too many requests — try again in a minute' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ ok: false, error: 'Invalid JSON body' }); }
  }
  body = body || {};
  const { email, contract, deadlines } = body;

  if (!isValidEmail(email)) return res.status(400).json({ ok: false, error: 'A valid email is required' });
  if (!contract || typeof contract !== 'object') return res.status(400).json({ ok: false, error: 'contract object required' });
  if (!isISODate(contract.effectiveDate) || !isISODate(contract.closingDate)) {
    return res.status(400).json({ ok: false, error: 'effectiveDate and closingDate must be YYYY-MM-DD' });
  }
  if (!Array.isArray(deadlines) || deadlines.length === 0) {
    return res.status(400).json({ ok: false, error: 'deadlines array required' });
  }

  // Trim deadlines to the fields we'll need server-side. Don't trust labels —
  // re-derive what we'll send in the reminder from id + paragraph + date.
  const sanitized = deadlines.slice(0, 12).map((d) => ({
    id: String(d.id || '').slice(0, 64),
    label: String(d.label || '').slice(0, 120),
    paragraph: String(d.paragraph || '').slice(0, 64),
    date: String(d.date || '').slice(0, 32),
  })).filter((d) => d.id && d.date);

  const sanitizedContract = {
    effectiveDate: contract.effectiveDate,
    closingDate: contract.closingDate,
    optionDays: Number.isFinite(+contract.optionDays) ? +contract.optionDays : null,
    optionFeeDays: Number.isFinite(+contract.optionFeeDays) ? +contract.optionFeeDays : null,
    earnestDays: Number.isFinite(+contract.earnestDays) ? +contract.earnestDays : null,
    financingDays: Number.isFinite(+contract.financingDays) ? +contract.financingDays : null,
    surveyDays: Number.isFinite(+contract.surveyDays) ? +contract.surveyDays : null,
  };

  try {
    const upstream = await fetch(`${SUPABASE_URL}/rest/v1/calculator_signups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        email: String(email).trim().toLowerCase(),
        contract_data: sanitizedContract,
        deadlines: sanitized,
      }),
    });
    const text = await upstream.text();
    if (!upstream.ok) {
      console.error('[save-calculator] supabase insert failed', upstream.status, text.slice(0, 400));
      return res.status(502).json({ ok: false, error: 'Could not save right now' });
    }
    let row = null;
    try { row = JSON.parse(text); } catch {}
    return res.status(200).json({ ok: true, id: Array.isArray(row) ? row[0]?.id : null });
  } catch (err) {
    console.error('[save-calculator] threw', err && err.message);
    return res.status(502).json({ ok: false, error: 'Network error' });
  }
};
