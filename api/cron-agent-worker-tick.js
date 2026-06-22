// api/cron-agent-worker-tick.js
// ============================================================================
// Vercel cron tick (every minute). Reaps dead workers and ensures the warm
// pool size is maintained for every (tenant, role) that has seen activity
// in the last 24 hours.
//
// GET /api/cron-agent-worker-tick
// Auth: Bearer $CRON_SECRET
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).

const { reapDeadWorkers, ensurePool, VALID_ROLES, POOL_SIZE_PER_ROLE } = require('./_lib/worker-pool');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

export const config = { api: { bodyParser: false }, maxDuration: 30 };

async function sbGet(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`sbGet ${path} -> ${res.status} ${t.slice(0, 200)}`);
  }
  return res.json();
}

export default async function handler(req, res) {
  // Vercel cron sets the Authorization header to "Bearer $CRON_SECRET" when
  // a job is registered in vercel.json. Local dev triggers can pass the
  // header explicitly too.
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  try {
    // 1. Reap dead workers (heartbeat stale > 90s)
    const deadCount = await reapDeadWorkers();

    // 2. For every (tenant, role) that has had a queued/in-progress/done
    //    task in the last 24h, ensure POOL_SIZE_PER_ROLE warm workers.
    //    (We don't pre-spawn pools for inactive tenants — lazy on first
    //    enqueue handles that.)
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = await sbGet(
      `agent_task_queue?select=tenant_id,agent_role&created_at=gte.${encodeURIComponent(since)}&limit=5000`
    );

    const seen = new Set();
    for (const r of recent) {
      const key = `${r.tenant_id}|${r.agent_role}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }

    let ensured = 0;
    const errors = [];
    for (const key of seen) {
      const [tenantId, agentRole] = key.split('|');
      if (!VALID_ROLES.has(agentRole)) continue;
      try {
        await ensurePool(tenantId, agentRole, POOL_SIZE_PER_ROLE);
        ensured++;
      } catch (err) {
        errors.push({ tenantId, agentRole, error: err.message });
      }
    }

    return res.status(200).json({
      ok: true,
      reaped_dead: deadCount,
      pools_ensured: ensured,
      pool_size: POOL_SIZE_PER_ROLE,
      errors,
    });
  } catch (err) {
    console.error('[cron-agent-worker-tick] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'tick_failed', detail: err.message });
  }
}
