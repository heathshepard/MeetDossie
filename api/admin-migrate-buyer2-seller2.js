// One-time migration: add buyer2_name/buyer2_email/buyer2_phone and
// seller2_name/seller2_email/seller2_phone columns to public.transactions.
// Run this ONCE manually, then delete. No schedule needed.
// Mirrors the SQL tracked at supabase/migrations/20260806_transactions_buyer2_seller2.sql.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const sql = `
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_name TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_email TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS buyer2_phone TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_name TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_email TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS seller2_phone TEXT;
  `;

  const result = await supabaseFetch('/rest/v1/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });

  if (result.ok) {
    return res.status(200).json({
      ok: true,
      message: 'buyer2_*/seller2_* columns added to transactions successfully',
    });
  }
  return res.status(500).json({
    ok: false,
    error: 'Failed to add columns',
    details: result.data,
  });
};
