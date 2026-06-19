// Jarvis V5 — combined dashboard ticker endpoint.
// Returns: header tickers (MRR, customers, date, shipped count) + bottom marquee feed.
// Single round-trip so today.html can render the chrome in one pull.
//
// Heath-only. Bearer Supabase JWT required; email gate on the user object.

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const token = auth.slice(7);

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'supabase_env_missing' });
  }

  // Verify the caller is heath via anon-client w/ user token
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'invalid_token' });
  }
  if (userData.user.email !== 'heath.shepard@kw.com') {
    return res.status(403).json({ error: 'forbidden' });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Run all reads in parallel
    const [
      subsRes,
      profilesRes,
      agentRes,
      activityRes,
      todoDoneRes,
    ] = await Promise.all([
      admin
        .from('subscriptions')
        .select('id, plan, status, stripe_price_id, metadata')
        .eq('status', 'active'),
      admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .or('is_demo.is.null,is_demo.eq.false'),
      admin
        .from('agent_state')
        .select('agent_name, status, last_heartbeat_at'),
      admin
        .from('agent_activity')
        .select('agent_name, task_summary, status, started_at, last_heartbeat, completed_at, created_at')
        .order('created_at', { ascending: false })
        .limit(40),
      admin
        .from('heath_todo')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'done')
        .gte('completed_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
    ]);

    // MRR — best-effort. We don't have an amount column; infer from plan/price.
    // Founding = $29, Solo monthly = $79, Team monthly = $199.
    const PRICE_MAP = {
      price_1TPxxNL920SKTEEiN7Gphq8T: 29, // founding
    };
    const PLAN_MAP = {
      founding: 29,
      solo_monthly: 79,
      team_monthly: 199,
      solo_annual: 39,
      team_annual: 119,
    };
    let mrrCents = 0;
    const subs = subsRes.data || [];
    for (const s of subs) {
      let price = PRICE_MAP[s.stripe_price_id];
      if (!price) price = PLAN_MAP[s.plan] || 29;
      mrrCents += price * 100;
    }

    const customerCount = profilesRes.count || 0;
    const activeAgentCount = (agentRes.data || []).filter(a => a.status === 'working').length;
    const totalAgentCount = (agentRes.data || []).length;
    const shippedToday = todoDoneRes.count || 0;

    // Marquee feed — last 40 agent activity rows, most recent first
    const activity = (activityRes.data || []).map(a => ({
      agent: a.agent_name,
      summary: a.task_summary || '(idle)',
      status: a.status,
      ts: a.last_heartbeat || a.started_at || a.created_at,
    }));

    // Stylized date — "FRIDAY JUN 19 / 2026"
    const now = new Date();
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    const dateStr = `${days[now.getDay()]} ${months[now.getMonth()]} ${now.getDate()} / ${now.getFullYear()}`;

    return res.status(200).json({
      generated_at: now.toISOString(),
      header: {
        mrr_usd: Math.round(mrrCents / 100),
        customer_count: customerCount,
        active_agents: activeAgentCount,
        total_agents: totalAgentCount,
        shipped_today: shippedToday,
        date_label: dateStr,
      },
      activity,
    });
  } catch (err) {
    console.error('jarvis-tickers error:', err);
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
  }
}
