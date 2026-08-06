// api/jarvis-in-flight-work.js
// ============================================================================
// GET /api/jarvis-in-flight-work
//
// The unified "in-flight work" view from the Jarvis mission-control proposal
// (2026-08-06, item 5) — one feed merging:
//   - agent_queue   (in_progress + blocked agent tasks)
//   - merge_queue   (unmerged staging->main commits + sign-off status)
//   - heath_todo    (Heath's pending/snoozed action items)
//   - live git diff (main..staging commit count, per repo — GitHub Compare
//                     API, no local clone required, same pattern as
//                     cron-merge-queue-backfill.js)
//
// This is a READ view — completion happens via /api/jarvis-mark-complete
// (or the per-item Done button on the HUD, which calls that same endpoint
// with an exact {source,id}).
//
// Every item gets `age_minutes` and a `stale` flag so the HUD can sort by
// staleness and visually flag blockers, per the proposal's staleness-as-a-
// first-class-signal principle. Staleness thresholds differ per source
// because "still running" means different things for an agent task vs. a
// merge candidate vs. a todo:
//   agent_queue (in_progress) stale after 30 min  — agents should move fast
//   agent_queue (blocked)     stale after 0 min   — blocked is ALWAYS surfaced hot
//   merge_queue               stale after 24h     — merges wait on human sign-off
//   heath_todo                stale after 48h     — Heath's own backlog
//
// Auth: Bearer Supabase JWT.
// Owner: Atlas — Jarvis mission-control consolidation, 2026-08-06.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

const REPOS = ['heathshepard/MeetDossie', 'heathshepard/Dossie'];

export const config = { api: { bodyParser: true }, maxDuration: 15 };

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

async function ghCompareAheadBy(repo, base, head) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'jarvis-in-flight-work',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, { headers });
    if (!res.ok) return { repo, ahead_by: null, error: `compare_${res.status}` };
    const data = await res.json();
    return { repo, ahead_by: typeof data.ahead_by === 'number' ? data.ahead_by : null };
  } catch (err) {
    return { repo, ahead_by: null, error: err.message };
  }
}

function ageMinutes(ts) {
  if (!ts) return null;
  return Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 60000));
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  try {
    await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  try {
    const [agentRows, mergeRows, todoRows, ...gitDiffs] = await Promise.all([
      sbGet(
        'agent_queue?select=id,agent_name,task_subject,priority,venture,status,created_at,started_at' +
        '&status=in.(in_progress,blocked)&order=priority.asc&limit=200'
      ).catch(() => []),
      sbGet(
        'merge_queue?select=id,commit_sha,title,all_green,atlas_apv_status,quinn_qa_status,ridge_status,hadley_status,sage_demo_status,created_at' +
        '&merged_to_main=eq.false&order=created_at.asc&limit=100'
      ).catch(() => []),
      sbGet(
        'heath_todo?select=id,title,priority,venture,status,created_at,snoozed_until' +
        '&status=in.(pending,snoozed)&order=priority.asc&limit=200'
      ).catch(() => []),
      ...REPOS.map((r) => ghCompareAheadBy(r, 'main', 'staging')),
    ]);

    const items = [];

    for (const t of agentRows || []) {
      const age = ageMinutes(t.started_at || t.created_at);
      const blocked = t.status === 'blocked';
      items.push({
        source: 'agent_queue',
        id: t.id,
        title: `[${t.agent_name}] ${t.task_subject}`,
        status: t.status,
        priority: t.priority,
        venture: t.venture,
        created_at: t.created_at,
        age_minutes: age,
        blocked,
        stale: blocked ? true : (age != null && age > 30),
      });
    }

    for (const m of mergeRows || []) {
      const age = ageMinutes(m.created_at);
      const signoffs = [m.atlas_apv_status, m.quinn_qa_status, m.ridge_status, m.hadley_status, m.sage_demo_status];
      const passCount = signoffs.filter((s) => s === 'pass').length;
      items.push({
        source: 'merge_queue',
        id: m.id,
        title: m.title || m.commit_sha,
        status: m.all_green ? 'ready_to_merge' : `signoff_${passCount}/5`,
        commit_sha: (m.commit_sha || '').slice(0, 7),
        created_at: m.created_at,
        age_minutes: age,
        blocked: false,
        stale: age != null && age > 24 * 60,
      });
    }

    for (const td of todoRows || []) {
      const age = ageMinutes(td.created_at);
      items.push({
        source: 'heath_todo',
        id: td.id,
        title: td.title,
        status: td.status,
        priority: td.priority,
        venture: td.venture,
        created_at: td.created_at,
        age_minutes: age,
        blocked: false,
        stale: age != null && age > 48 * 60,
      });
    }

    // Sort: blocked first, then most stale first.
    items.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1;
      return (b.age_minutes || 0) - (a.age_minutes || 0);
    });

    const counts = {
      agent_in_progress: (agentRows || []).filter((t) => t.status === 'in_progress').length,
      agent_blocked: (agentRows || []).filter((t) => t.status === 'blocked').length,
      merge_pending: (mergeRows || []).length,
      todo_pending: (todoRows || []).length,
      total: items.length,
    };

    return res.status(200).json({
      ok: true,
      items,
      counts,
      git_diffs: gitDiffs,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[jarvis-in-flight-work] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
