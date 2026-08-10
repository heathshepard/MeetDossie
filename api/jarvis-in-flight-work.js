// api/jarvis-in-flight-work.js
// ============================================================================
// GET /api/jarvis-in-flight-work
//
// The IN-FLIGHT WORK panel — "what is being worked on right now." Redesigned
// 2026-08-10 per Heath's dashboard teardown: this used to merge agent_queue
// (in_progress + blocked, 14-day cutoff) + merge_queue + heath_todo into one
// list nested under business-line groups, which produced 46 items including
// week-old blocked rows and cryptic internal task IDs — not a real-time
// "what's active" view.
//
// Scope, per spec: ONLY agent_queue rows with status='in_progress' — genuinely
// running right now. No blocked, no done/cancelled/completed, no merge_queue,
// no heath_todo (those live in MERGE QUEUE and WORK ITEMS respectively). A
// row disappears from this list the moment the agent's status changes away
// from in_progress — no manual "Done" button, nothing to mark, it's just live.
//
// Internal QA/verification noise (agents testing their own changes, e.g.
// "BL panel verify 1786381769910") is filtered via the same heuristic used
// by jarvis-agent-throughput.js — see _lib/internal-task-filter.js for why
// this is a stopgap, not the real fix.
//
// Auth: Bearer Supabase JWT.
// Owner: Atlas — Jarvis mission-control consolidation, 2026-08-06.
//        Redesigned Carter, 2026-08-10 (Heath dashboard teardown).
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
const { isInternalTaskNoise } = require('./_lib/internal-task-filter.js');

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
    const [inProgressRows, ...gitDiffs] = await Promise.all([
      sbGet(
        'agent_queue?select=id,agent_name,task_subject,priority,venture,status,created_at,started_at' +
        '&status=eq.in_progress&order=priority.asc&limit=200'
      ).catch(() => []),
      ...REPOS.map((r) => ghCompareAheadBy(r, 'main', 'staging')),
    ]);

    const items = (inProgressRows || [])
      .filter((t) => !isInternalTaskNoise(t.task_subject))
      .map((t) => {
        const age = ageMinutes(t.started_at || t.created_at);
        return {
          source: 'agent_queue',
          id: t.id,
          agent: t.agent_name,
          title: t.task_subject || '(no description)',
          status: t.status,
          created_at: t.created_at,
          age_minutes: age,
        };
      })
      // Longest-running first — the ones most likely to actually be worth a look.
      .sort((a, b) => (b.age_minutes || 0) - (a.age_minutes || 0));

    return res.status(200).json({
      ok: true,
      items,
      counts: { total: items.length },
      git_diffs: gitDiffs,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[jarvis-in-flight-work] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
