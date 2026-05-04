// Vercel Serverless Function: /api/founding-count
// Returns the number of founding-member spots remaining.
//
// GET → { ok: true, total: 50, taken: <n>, remaining: <50-n> }
//
// "Taken" is read from the subscriptions table (source of truth for billing
// state) where plan='founding' AND status='active'. Subscriptions cascade
// from auth.users on delete and Stripe webhook updates the row directly, so
// this auto-reflects cancellations without a separate profiles-sync hop.
// No auth — the count is intentionally public so the homepage banner reads it.
//
// Environment:
//   SUPABASE_URL              — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY — service-role JWT (server-side only)

const FOUNDING_TOTAL = 50;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  // Cache lightly so a homepage burst doesn't hammer Supabase.
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/subscriptions?select=user_id&plan=eq.founding&status=eq.active`;
    const r = await fetch(url, {
      method: 'GET',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    if (!r.ok) {
      return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
    }
    const contentRange = r.headers.get('content-range') || '';
    const m = contentRange.match(/\/(\d+)$/);
    const taken = m ? Math.max(0, parseInt(m[1], 10)) : 0;
    const remaining = Math.max(0, FOUNDING_TOTAL - taken);
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken, remaining });
  } catch (err) {
    console.error('[founding-count] error:', err && err.message);
    return res.status(200).json({ ok: true, total: FOUNDING_TOTAL, taken: 0, remaining: FOUNDING_TOTAL, fallback: true });
  }
};
