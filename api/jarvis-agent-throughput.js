// api/jarvis-agent-throughput.js
// ============================================================================
// GET /api/jarvis-agent-throughput?window_hours=24
//
// Returns the AGENT THROUGHPUT panel payload:
//   - queue depth per role
//   - worker utilization per role (idle / busy / dead)
//   - tasks/hour per role (over the window)
//   - avg task duration per role (ms)
//   - cache hit rate per role
//   - model mix per role (haiku / sonnet / opus token counts)
//   - estimated cost (last window) + projected daily cost
//
// Auth: Bearer Supabase JWT, tenant resolved server-side.
//
// Owner: Atlas (atlas_5, 2026-06-20 Agent Speed Unlock).

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const VALID_ROLES = [
  'atlas','carter','hadley','pierce','sage','ridge','quinn','sterling','jarvis',
];

export const config = { api: { bodyParser: true }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

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

async function resolveTenantId(authUserId) {
  const rows = await sbGet(
    `jarvis_users?select=tenant_id&auth_user_id=eq.${authUserId}&limit=1`);
  return (rows && rows[0] && rows[0].tenant_id) || null;
}

function modelClass(model) {
  if (!model) return 'unknown';
  if (model.includes('haiku')) return 'haiku';
  if (model.includes('opus'))  return 'opus';
  if (model.includes('sonnet')) return 'sonnet';
  return 'other';
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  let authUser;
  try {
    authUser = await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }
  const tenantId = await resolveTenantId(authUser.userId);
  if (!tenantId) return res.status(403).json({ ok: false, error: 'no_jarvis_tenant' });

  const q = req.query || {};
  const windowHours = Math.max(1, Math.min(168, parseInt(q.window_hours, 10) || 24));
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  try {
    // Parallel fetches
    const [workers, queued, recentTasks, metrics] = await Promise.all([
      sbGet(`agent_workers?select=agent_role,status&tenant_id=eq.${tenantId}&limit=2000`),
      sbGet(`agent_task_queue?select=agent_role&tenant_id=eq.${tenantId}&status=eq.queued&limit=5000`),
      sbGet(
        `agent_task_queue?select=agent_role,status,created_at,claimed_at,completed_at&tenant_id=eq.${tenantId}&created_at=gte.${encodeURIComponent(since)}&limit=10000`
      ),
      sbGet(
        `agent_spawn_metrics?select=agent_role,model,cache_hit,cache_read_tokens,cache_creation_tokens,uncached_input_tokens,output_tokens,total_cost_usd,baseline_cost_usd,savings_usd,duration_ms,ts&tenant_id=eq.${tenantId}&ts=gte.${encodeURIComponent(since)}&limit=20000`
      ),
    ]);

    // Build per-role buckets
    const byRole = {};
    for (const r of VALID_ROLES) {
      byRole[r] = {
        role: r,
        queue_depth:        0,
        workers_idle:       0,
        workers_busy:       0,
        workers_dead:       0,
        tasks_completed:    0,
        tasks_failed:       0,
        tasks_in_progress:  0,
        avg_duration_ms:    0,
        cache_hits:         0,
        cache_attempts:     0,
        cache_hit_rate:     0,
        model_mix: { haiku: 0, sonnet: 0, opus: 0, other: 0 },
        total_cost_usd:     0,
        baseline_cost_usd:  0,
        savings_usd:        0,
      };
    }

    // Workers
    for (const w of workers) {
      const bucket = byRole[w.agent_role];
      if (!bucket) continue;
      if (w.status === 'idle') bucket.workers_idle++;
      else if (w.status === 'busy') bucket.workers_busy++;
      else if (w.status === 'dead') bucket.workers_dead++;
    }

    // Queue depth
    for (const t of queued) {
      const bucket = byRole[t.agent_role];
      if (bucket) bucket.queue_depth++;
    }

    // Recent tasks: tally completion + durations
    const durBucket = {}; // role -> [ms,...]
    for (const t of recentTasks) {
      const bucket = byRole[t.agent_role];
      if (!bucket) continue;
      if (t.status === 'done') {
        bucket.tasks_completed++;
        if (t.claimed_at && t.completed_at) {
          const ms = new Date(t.completed_at).getTime() - new Date(t.claimed_at).getTime();
          if (ms >= 0) {
            (durBucket[t.agent_role] = durBucket[t.agent_role] || []).push(ms);
          }
        }
      } else if (t.status === 'failed') {
        bucket.tasks_failed++;
      } else if (t.status === 'in_progress') {
        bucket.tasks_in_progress++;
      }
    }
    for (const role of Object.keys(durBucket)) {
      const arr = durBucket[role];
      if (!arr.length) continue;
      const sum = arr.reduce((a, b) => a + b, 0);
      byRole[role].avg_duration_ms = Math.round(sum / arr.length);
    }

    // Spawn metrics: cache + model mix + cost
    for (const m of metrics) {
      const bucket = byRole[m.agent_role];
      if (!bucket) continue;
      bucket.cache_attempts++;
      if (m.cache_hit) bucket.cache_hits++;
      const cls = modelClass(m.model);
      if (bucket.model_mix[cls] !== undefined) bucket.model_mix[cls]++;
      else bucket.model_mix.other++;
      bucket.total_cost_usd    += Number(m.total_cost_usd) || 0;
      bucket.baseline_cost_usd += Number(m.baseline_cost_usd) || 0;
      bucket.savings_usd       += Number(m.savings_usd) || 0;
    }
    for (const role of VALID_ROLES) {
      const b = byRole[role];
      b.cache_hit_rate = b.cache_attempts > 0
        ? Math.round((b.cache_hits / b.cache_attempts) * 1000) / 10  // percent w/ 1dp
        : 0;
      b.tasks_per_hour = windowHours > 0
        ? Math.round((b.tasks_completed / windowHours) * 10) / 10
        : 0;
      b.total_cost_usd    = Math.round(b.total_cost_usd * 10000) / 10000;
      b.baseline_cost_usd = Math.round(b.baseline_cost_usd * 10000) / 10000;
      b.savings_usd       = Math.round(b.savings_usd * 10000) / 10000;
    }

    // Roll-up totals
    const totals = {
      window_hours: windowHours,
      since,
      total_queued:           queued.length,
      total_workers_idle:     0,
      total_workers_busy:     0,
      total_workers_dead:     0,
      total_completed:        0,
      total_failed:           0,
      total_in_progress:      0,
      total_cache_hits:       0,
      total_cache_attempts:   0,
      total_cost_usd:         0,
      baseline_cost_usd:      0,
      savings_usd:            0,
      projected_daily_cost:   0,
      projected_monthly_cost: 0,
    };
    for (const role of VALID_ROLES) {
      const b = byRole[role];
      totals.total_workers_idle   += b.workers_idle;
      totals.total_workers_busy   += b.workers_busy;
      totals.total_workers_dead   += b.workers_dead;
      totals.total_completed      += b.tasks_completed;
      totals.total_failed         += b.tasks_failed;
      totals.total_in_progress    += b.tasks_in_progress;
      totals.total_cache_hits     += b.cache_hits;
      totals.total_cache_attempts += b.cache_attempts;
      totals.total_cost_usd       += b.total_cost_usd;
      totals.baseline_cost_usd    += b.baseline_cost_usd;
      totals.savings_usd          += b.savings_usd;
    }
    totals.cache_hit_rate = totals.total_cache_attempts > 0
      ? Math.round((totals.total_cache_hits / totals.total_cache_attempts) * 1000) / 10
      : 0;
    // Linear extrapolation to a 24h day, then *30
    const hoursPerDay = 24;
    const projectionMultiplier = hoursPerDay / windowHours;
    totals.projected_daily_cost   = Math.round(totals.total_cost_usd * projectionMultiplier * 10000) / 10000;
    totals.projected_monthly_cost = Math.round(totals.projected_daily_cost * 30 * 100) / 100;
    totals.total_cost_usd     = Math.round(totals.total_cost_usd * 10000) / 10000;
    totals.baseline_cost_usd  = Math.round(totals.baseline_cost_usd * 10000) / 10000;
    totals.savings_usd        = Math.round(totals.savings_usd * 10000) / 10000;

    return res.status(200).json({
      ok: true,
      totals,
      roles: VALID_ROLES.map((r) => byRole[r]),
    });
  } catch (err) {
    console.error('[jarvis-agent-throughput] failed:', err.message);
    return res.status(500).json({ ok: false, error: 'throughput_failed', detail: err.message });
  }
}
