// Test: as Heath's authenticated session, does the panel query return 17 rows?
const { createClient } = require('@supabase/supabase-js');

(async () => {
  const SBURL = process.env.SUPABASE_URL;
  const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;

  const admin = createClient(SBURL, SRK, { auth: { persistSession: false } });

  // 1. Generate a magiclink to obtain a verifiable token_hash
  const { data, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'heath.shepard@kw.com',
  });
  if (error) { console.log('GEN_ERR', JSON.stringify(error)); return; }

  // 2. Verify the token_hash to mint an access_token (the JWT)
  const verifyRes = await fetch(`${SBURL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: PUB },
    body: JSON.stringify({ type: 'magiclink', token_hash: data.properties.hashed_token }),
  });
  const v = await verifyRes.json();
  if (!v.access_token) { console.log('VERIFY_FAIL', v); return; }
  console.log('JWT obtained for', v.user.email, '/', v.user.id);

  // 3. Run the exact panel query through the anon/publishable key + JWT
  //    .from('heath_actions').select(...).eq('tenant_id', session.user.id).in('status',['pending','snoozed'])
  const url = `${SBURL}/rest/v1/heath_actions?select=id,title,body,source,priority,status,created_at,snoozed_until&tenant_id=eq.${v.user.id}&status=in.(pending,snoozed)&order=created_at.asc`;
  const q = await fetch(url, {
    headers: { apikey: PUB, Authorization: `Bearer ${v.access_token}` },
  });
  const rows = await q.json();
  console.log('STATUS:', q.status);
  console.log('AS HEATH (via PUB key + JWT, RLS applied) row count:', Array.isArray(rows) ? rows.length : 'NOT_ARRAY', Array.isArray(rows) ? '' : JSON.stringify(rows));
  if (Array.isArray(rows) && rows.length > 0) {
    console.log('First 3 titles:', rows.slice(0,3).map(r => r.title));
  }
})();
