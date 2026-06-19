// Jarvis V5 R4 — Money Pulse read endpoint
// Returns the most recent money_pulse_snapshots row plus a 7-day spark series.
// Heath-only (email gate). The cron writes; this endpoint reads.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) return res.status(401).json({ error: 'unauthorized' });
  const token = auth.slice(7);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'supabase_env_missing' });
  }

  // Identity gate
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return res.status(401).json({ error: 'invalid_token' });
  if (userData.user.email !== 'heath.shepard@kw.com') return res.status(403).json({ error: 'forbidden' });

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Most recent snapshot
    const { data: latest, error: latestErr } = await admin
      .from('money_pulse_snapshots')
      .select('*')
      .order('captured_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestErr) throw latestErr;

    // 7-day spend trail (one point per day, max)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
    const { data: trail } = await admin
      .from('money_pulse_snapshots')
      .select('captured_at, mtd_spend_usd, mtd_revenue_usd')
      .gte('captured_at', sevenDaysAgo)
      .order('captured_at', { ascending: true });

    return res.status(200).json({
      generated_at: new Date().toISOString(),
      latest: latest || null,
      trail: trail || [],
    });
  } catch (err) {
    console.error('jarvis-money-pulse error:', err);
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
  }
}
