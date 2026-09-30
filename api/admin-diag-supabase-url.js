// TEMPORARY diagnostic endpoint — checks process.env.SUPABASE_URL behavior
// at runtime without ever echoing the value. Remove after use.
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isManualAuth) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;

  const report = {
    supabase_url_set: !!SUPABASE_URL,
    supabase_url_length: SUPABASE_URL ? SUPABASE_URL.length : 0,
    supabase_url_last_char_code: SUPABASE_URL ? SUPABASE_URL.charCodeAt(SUPABASE_URL.length - 1) : null,
    supabase_url_starts_https: SUPABASE_URL ? SUPABASE_URL.startsWith('https://') : null,
    next_public_supabase_url_length: NEXT_PUBLIC_SUPABASE_URL ? NEXT_PUBLIC_SUPABASE_URL.length : 0,
    urls_equal: SUPABASE_URL === NEXT_PUBLIC_SUPABASE_URL,
    service_role_key_set: !!SUPABASE_SERVICE_ROLE_KEY,
    service_role_key_length: SUPABASE_SERVICE_ROLE_KEY ? SUPABASE_SERVICE_ROLE_KEY.length : 0,
  };

  try {
    const testRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?select=id&limit=1`, {
      headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
    });
    report.test_fetch_status = testRes.status;
    report.test_fetch_ok = testRes.ok;
    report.test_fetch_body_snippet = (await testRes.text()).slice(0, 200);
  } catch (err) {
    report.test_fetch_threw = err.message;
  }

  try {
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/onboarding_document_extractions`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({
        user_id: 'c29ce34c-1434-44e5-a260-8d1a45213ec3',
        source_document_types: ['diag-test'],
        fields_found: [],
        fields_confirmed: [],
        trec_validation_summary: null,
        documents_retained: false,
      }),
    });
    report.insert_status = insertRes.status;
    report.insert_ok = insertRes.ok;
    report.insert_body_snippet = (await insertRes.text()).slice(0, 300);
  } catch (err) {
    report.insert_threw = err.message;
  }

  return res.status(200).json(report);
};
