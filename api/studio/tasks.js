// Vercel Serverless Function: /api/studio/tasks
// Query organization_tasks table
// Authorization: Bearer <supabase user JWT>, restricted to heath.shepard@kw.com

const { verifySupabaseToken, AuthError } = require('../_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigins = ['https://meetdossie.com', 'https://www.meetdossie.com', 'https://staging.meetdossie.com'];
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isVercel = origin.endsWith('.vercel.app');

  if (allowedOrigins.includes(origin) || isLocalhost || isVercel) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return data;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = await verifySupabaseToken(req);

    // Restrict to heath.shepard@kw.com
    if (user.email !== 'heath.shepard@kw.com') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Parse query params
    const { status, agent, limit = '50', offset = '0' } = req.query;

    // Build query
    let query = '/rest/v1/organization_tasks?select=*&order=created_at.desc';

    if (status) {
      query += `&status=eq.${status}`;
    }
    if (agent) {
      query += `&agent_name=eq.${agent}`;
    }
    query += `&limit=${limit}&offset=${offset}`;

    const tasksData = await supabaseFetch(query);

    const tasks = tasksData.map(task => ({
      id: task.id,
      agentName: task.agent_name,
      description: task.task_description,
      status: task.status,
      assignedAt: task.assigned_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      tokensUsed: task.tokens_used,
      costEstimate: parseFloat(task.cost_estimate || 0),
      result: task.result,
      error: task.error,
    }));

    res.status(200).json({
      success: true,
      data: tasks,
      pagination: {
        limit: parseInt(limit, 10),
        offset: parseInt(offset, 10),
        total: tasks.length,
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error fetching tasks:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
