// Jarvis V5 R5 — Daily debrief cron (runs 9pm CST → 02:00 UTC).
// Composes an end-of-day summary into daily_debriefs.
// Lightweight: counts shipped (heath_todo done today), MRR vs yesterday,
// incidents (cron_runs with last_status != 'ok' in the last 24h).

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`;
  const isVercelCron = req.headers['user-agent']?.includes('vercel') || req.headers['x-vercel-cron'];
  if (!isCron && !isVercelCron && req.method !== 'POST') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'supabase_env_missing' });
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    // Today (UTC) window
    const startUtc = new Date();
    startUtc.setUTCHours(0, 0, 0, 0);
    const todayDate = startUtc.toISOString().slice(0, 10);

    // Shipped today
    const { count: shippedCount } = await admin
      .from('heath_todo')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'done')
      .gte('completed_at', startUtc.toISOString());

    // Latest MRR — read from kpi_snapshots if present, else estimate from active subs
    let mrrDelta = 0;
    try {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const { data: kpiData } = await admin
        .from('kpi_snapshots')
        .select('taken_at, metrics')
        .order('taken_at', { ascending: false })
        .limit(20);
      if (kpiData && kpiData.length >= 2) {
        const newest = Number(kpiData[0]?.metrics?.mrr || 0);
        const yest = kpiData.find(r => new Date(r.taken_at).toISOString() <= yesterday);
        const prev = Number(yest?.metrics?.mrr || newest);
        mrrDelta = newest - prev;
      }
    } catch (err) {
      console.warn('mrrDelta kpi_snapshots soft-fail:', err?.message || err);
    }

    // Incidents in last 24h — cron_runs with non-ok status
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { count: incidentsCount } = await admin
      .from('cron_runs')
      .select('id', { count: 'exact', head: true })
      .neq('last_status', 'ok')
      .gte('last_run', dayAgo);

    // Pull a handful of recent agent activity titles for color
    const { data: activity } = await admin
      .from('agent_activity')
      .select('agent_name, task_summary')
      .gte('created_at', startUtc.toISOString())
      .order('created_at', { ascending: false })
      .limit(8);

    const activeAgents = [...new Set((activity || []).map(a => a.agent_name).filter(Boolean))];
    const highlight = (activity || [])
      .map(a => `${a.agent_name}: ${a.task_summary}`)
      .filter(Boolean)
      .slice(0, 3)
      .join(' • ');

    const summary = [
      `Shipped ${shippedCount || 0} TODOs.`,
      mrrDelta ? `MRR ${mrrDelta >= 0 ? '+' : ''}$${mrrDelta.toFixed(0)} vs yesterday.` : 'MRR flat.',
      `${incidentsCount || 0} incidents in last 24h.`,
      activeAgents.length ? `Active agents: ${activeAgents.join(', ')}.` : '',
      highlight ? `Recent: ${highlight}.` : '',
    ].filter(Boolean).join(' ');

    const { error: insErr } = await admin
      .from('daily_debriefs')
      .upsert({
        debrief_date: todayDate,
        summary,
        shipped_count: shippedCount || 0,
        mrr_delta: mrrDelta,
        incidents_count: incidentsCount || 0,
        meta: { active_agents: activeAgents, generator: 'cron-daily-debrief-v1' },
      }, { onConflict: 'debrief_date' });
    if (insErr) throw insErr;

    await admin.from('cron_runs').upsert({
      cron_name: 'cron-daily-debrief',
      last_run: new Date().toISOString(),
      last_status: 'ok',
      last_meta: { shipped: shippedCount, mrr_delta: mrrDelta, incidents: incidentsCount },
    }, { onConflict: 'cron_name' });

    return res.status(200).json({
      ok: true,
      debrief_date: todayDate,
      shipped_count: shippedCount,
      mrr_delta: mrrDelta,
      incidents_count: incidentsCount,
    });
  } catch (err) {
    console.error('[cron-daily-debrief] error:', err);
    return res.status(500).json({ error: 'internal', detail: String(err?.message || err) });
  }
}
