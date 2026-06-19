// ATLAS-ONLY: one-shot session token minter for headless APV runs.
// V5 R7 polish — restored 2026-06-18, will be deleted after R7 cuts verified.
//
// Guarded by knowledge of Heath's auth.users.id (a 36-char UUID).

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const supplied = (req.headers['x-atlas-user-id'] || req.query.uid || '').toString();
  const EXPECTED = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';
  if (supplied.length !== EXPECTED.length) return res.status(401).json({ error: 'unauthorized' });
  let ok = 0;
  for (let i = 0; i < EXPECTED.length; i++) ok |= supplied.charCodeAt(i) ^ EXPECTED.charCodeAt(i);
  if (ok !== 0) return res.status(401).json({ error: 'unauthorized' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'env_missing' });
  }

  try {
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: 'heath.shepard@kw.com',
    });
    if (error) return res.status(500).json({ error: 'generate_failed', detail: error.message });

    const properties = data?.properties || {};
    const actionLink = properties.action_link;
    let tokenHash = null;
    try {
      const u = new URL(actionLink);
      tokenHash = u.searchParams.get('token');
    } catch {}
    if (!tokenHash) {
      return res.status(500).json({ error: 'no_token_hash' });
    }

    const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
    if (!SUPABASE_ANON_KEY) {
      return res.status(503).json({ error: 'anon_key_missing' });
    }
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data: vData, error: vErr } = await userClient.auth.verifyOtp({
      type: 'magiclink',
      token_hash: tokenHash,
    });
    if (vErr) return res.status(502).json({ error: 'verify_failed', detail: vErr.message });

    return res.status(200).json({
      access_token: vData.session?.access_token,
      refresh_token: vData.session?.refresh_token,
      expires_at: vData.session?.expires_at,
      user: vData.user?.email,
    });
  } catch (err) {
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
  }
}
