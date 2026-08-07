// TEMP read-only diagnostic — Carter round-1 verification only. Lists recent
// demo-account "Wild Cherry" transactions to confirm earnest_money_confirmed_at
// landed correctly from a fresh scan-to-create-dossier run. Delete after use.
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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  const cols = ['id', 'dossier_number', 'property_address', 'stage', 'status', 'role', 'seller_name', 'buyer_name', 'parties', 'earnest_money_confirmed_at', 'created_at'].join(',');
  const result = await supabaseFetch(`/rest/v1/transactions?select=${cols}&property_address=ilike.*Wild+Cherry*&order=created_at.desc&limit=10`);
  return res.status(result.ok ? 200 : 500).json({ ok: result.ok, rows: result.data });
};
