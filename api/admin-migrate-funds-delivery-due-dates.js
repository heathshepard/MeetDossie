// One-time migration: add option_fee_due_date / earnest_money_due_date
// columns to public.transactions (TREC ¶5.A funds delivery deadlines).
// Run this ONCE manually, then delete. No schedule needed.
// Mirrors the SQL tracked at
// supabase/migrations/20260903_transactions_funds_delivery_due_dates.sql.
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
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const sql = `
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS option_fee_due_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS earnest_money_due_date DATE;
COMMENT ON COLUMN transactions.option_fee_due_date IS 'TREC ¶5.A option fee delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
COMMENT ON COLUMN transactions.earnest_money_due_date IS 'TREC ¶5.A earnest money delivery deadline: contract_effective_date + 3 calendar days, then ¶5A(2) weekend/Texas Legal Holiday rollover. Computed by api/_lib/business-calendar.js; NULL means never computed (no effective date, or row predates the column).';
  `;

  const result = await supabaseFetch('/rest/v1/rpc/exec', {
    method: 'POST',
    body: JSON.stringify({ sql }),
  });

  if (result.ok) {
    return res.status(200).json({
      ok: true,
      message: 'option_fee_due_date / earnest_money_due_date columns added to transactions successfully',
    });
  }
  return res.status(500).json({
    ok: false,
    error: 'Failed to add columns',
    details: result.data,
  });
};
