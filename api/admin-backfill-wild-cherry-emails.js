// One-time backfill for Quinn's QA Item 1 (round 1). Verified via
// api/admin-diag-wild-cherry.js against live data 2026-08-07:
//
//   - transaction 42a11919-ba8b-44fa-9b04-ed13563ab888 (dossier #006, "104
//     Wild Cherry Ln", status=active) is the real, currently-open dossier.
//     seller_name = "Chelsea Linton, Thomas Linton". buyer_email/seller_email
//     are all null — never got backfilled when this dossier was created,
//     even though a real duplicate/superseded row for the same address and
//     same user has the actual seller emails.
//   - transaction e1f12b62-8c8e-4339-b2c0-98ea0d7cd107 (dossier #003, same
//     address, same user_id, status=closed, an earlier/superseded row for
//     this property) has seller_email = "TomLintonTX@Gmail.com,
//     cmlinton88@gmail.com" — the real data, just never carried forward.
//
// No buyer_email data exists anywhere for this property (dossier #003's
// buyer_name/buyer_email are also both null) — nothing to backfill there.
//
// Email-to-person mapping is hardcoded rather than auto-matched by
// name/local-part heuristics: this only ever touches ONE known, manually-
// verified transaction, and a wrong guess here means a real earnest-money
// email goes to the wrong seller. cmlinton88 = Chelsea M. Linton (seller_name
// slot 1, "Chelsea Linton"); TomLintonTX = Thomas Linton, common "Tom"
// nickname (seller_name slot 2, "Thomas Linton") — matches deal.sellerName
// comma-order used elsewhere in the app (splitPartyName: index 0 = first
// component = seller, index 1 = second component = seller2).
//
// Idempotent — only writes fields that are currently null. Safe to re-run.
// Delete this file (and admin-diag-wild-cherry.js) once run.
//
// Auth: Authorization: Bearer ${CRON_SECRET}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const TARGET_TRANSACTION_ID = '42a11919-ba8b-44fa-9b04-ed13563ab888';
const SELLER_EMAIL = 'cmlinton88@gmail.com';   // Chelsea Linton (seller_name slot 1)
const SELLER2_EMAIL = 'TomLintonTX@Gmail.com'; // Thomas Linton (seller_name slot 2)

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
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }

  const before = await supabaseFetch(
    `/rest/v1/transactions?id=eq.${TARGET_TRANSACTION_ID}&select=id,dossier_number,property_address,seller_name,seller_email,seller2_email,buyer_email,buyer2_email`
  );
  if (!before.ok || !before.data || !before.data.length) {
    return res.status(404).json({ ok: false, error: 'Target transaction not found', before: before.data });
  }
  const row = before.data[0];

  const update = {};
  if (!row.seller_email) update.seller_email = SELLER_EMAIL;
  if (!row.seller2_email) update.seller2_email = SELLER2_EMAIL;

  if (Object.keys(update).length === 0) {
    return res.status(200).json({ ok: true, message: 'Already backfilled — no null fields left to fill.', row });
  }

  const result = await supabaseFetch(
    `/rest/v1/transactions?id=eq.${TARGET_TRANSACTION_ID}`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(update) }
  );

  if (!result.ok) {
    return res.status(500).json({ ok: false, error: 'Update failed', details: result.data });
  }

  return res.status(200).json({ ok: true, updated: update, row: result.data && result.data[0] });
};
