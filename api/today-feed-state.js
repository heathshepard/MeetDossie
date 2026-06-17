/**
 * /api/today-feed-state — GET
 *
 * Returns the data for the /today mission-control page:
 *   - pendingMerges: commits on staging that haven't shipped to main yet
 *   - inFlight:      agent_activity rows in 'working'/'waiting'/'blocked' state
 *   - doneToday:     commits to main + customer support tickets in last 24h
 *
 * Auth: Bearer JWT, must be heath.shepard@kw.com.
 *
 * Pulls pending merges + done commits via GitHub API (we're on Vercel, no git CLI).
 *
 * Updated: 2026-06-17 — initial build (Atlas).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'heathshepard/MeetDossie';

const ALLOWED_EMAIL = 'heath.shepard@kw.com';

async function githubFetch(path, init = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not configured');
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meetdossie-today-feed',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

function ageLabel(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

async function getPendingMerges() {
  // Compare base=main vs head=staging — returns commits on staging not in main.
  try {
    const data = await githubFetch(`/repos/${GITHUB_REPO}/compare/main...staging`);
    const commits = (data.commits || []).map(c => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      authorDate: c.commit?.author?.date,
      age: ageLabel(c.commit?.author?.date),
      url: c.html_url,
    }));
    // Newest first.
    commits.reverse();
    return { ahead: data.ahead_by || 0, behind: data.behind_by || 0, commits };
  } catch (err) {
    return { ahead: 0, behind: 0, commits: [], error: err.message };
  }
}

async function getInFlight(supabase) {
  // Mark stale rows idle: heartbeat > 5 min old.
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  try {
    await supabase
      .from('agent_activity')
      .update({ status: 'idle' })
      .in('status', ['working', 'waiting'])
      .lt('last_heartbeat', fiveMinAgo);
  } catch (e) {
    // Non-fatal — just continue.
  }

  const { data, error } = await supabase
    .from('agent_activity')
    .select('id, agent_name, task_summary, status, started_at, last_heartbeat, metadata')
    .in('status', ['working', 'waiting', 'blocked'])
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) return { rows: [], error: error.message };
  const rows = (data || []).map(r => ({
    id: r.id,
    agent: r.agent_name,
    task: r.task_summary,
    status: r.status,
    startedAt: r.started_at,
    age: ageLabel(r.started_at),
    lastHeartbeat: r.last_heartbeat,
    heartbeatAge: ageLabel(r.last_heartbeat),
    metadata: r.metadata || {},
  }));
  return { rows };
}

async function getDoneToday(supabase) {
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sinceIso = dayAgo.toISOString();

  // Commits to main in last 24h.
  let mainCommits = [];
  try {
    const data = await githubFetch(`/repos/${GITHUB_REPO}/commits?sha=main&since=${sinceIso}&per_page=30`);
    mainCommits = (data || []).map(c => ({
      type: 'commit',
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit?.message || '').split('\n')[0],
      author: c.commit?.author?.name || c.author?.login || 'unknown',
      timestamp: c.commit?.author?.date,
      age: ageLabel(c.commit?.author?.date),
      url: c.html_url,
    }));
  } catch (err) {
    mainCommits = [{ type: 'error', message: `GitHub: ${err.message}` }];
  }

  // Support tickets in last 24h.
  let tickets = [];
  try {
    const { data } = await supabase
      .from('support_tickets')
      .select('id, agent_email, ticket_type, message, status, created_at')
      .gte('created_at', sinceIso)
      .order('created_at', { ascending: false })
      .limit(20);
    tickets = (data || []).map(t => ({
      type: 'ticket',
      id: t.id,
      ticketType: t.ticket_type,
      from: t.agent_email,
      preview: (t.message || '').slice(0, 120),
      status: t.status,
      timestamp: t.created_at,
      age: ageLabel(t.created_at),
    }));
  } catch (err) {
    // non-fatal
  }

  // Completed agent_activity rows in last 24h.
  let agentDone = [];
  try {
    const { data } = await supabase
      .from('agent_activity')
      .select('id, agent_name, task_summary, completed_at')
      .eq('status', 'done')
      .gte('completed_at', sinceIso)
      .order('completed_at', { ascending: false })
      .limit(20);
    agentDone = (data || []).map(r => ({
      type: 'agent_done',
      id: r.id,
      agent: r.agent_name,
      task: r.task_summary,
      timestamp: r.completed_at,
      age: ageLabel(r.completed_at),
    }));
  } catch (err) {
    // non-fatal
  }

  return { commits: mainCommits, tickets, agentDone };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth gate.
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized - no token' });
  }
  const token = authHeader.replace('Bearer ', '');

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'unauthorized - invalid token' });
  }
  if (user.email !== ALLOWED_EMAIL) {
    return res.status(403).json({ error: 'forbidden - not heath' });
  }

  try {
    const [pendingMerges, inFlight, doneToday] = await Promise.all([
      getPendingMerges(),
      getInFlight(supabase),
      getDoneToday(supabase),
    ]);
    return res.status(200).json({
      ok: true,
      generatedAt: new Date().toISOString(),
      repo: GITHUB_REPO,
      pendingMerges,
      inFlight,
      doneToday,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
