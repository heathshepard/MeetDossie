// Vercel Serverless Function: /api/studio/agents
// Returns agent workforce status
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

    // Get all agents with their current tasks
    const agentsData = await supabaseFetch('/rest/v1/studio_agents?select=*');

    // For each agent, fetch current task details if they have one
    const agents = await Promise.all(
      agentsData.map(async (agent) => {
        let currentTask = null;
        if (agent.current_task_id) {
          const taskData = await supabaseFetch(
            `/rest/v1/organization_tasks?id=eq.${agent.current_task_id}&select=*&limit=1`
          );
          currentTask = taskData[0] || null;
        }

        return {
          id: agent.id,
          name: agent.agent_name,
          displayName: agent.display_name,
          avatarColor: agent.avatar_color,
          description: agent.description,
          status: agent.status,
          currentTask: currentTask ? {
            id: currentTask.id,
            description: currentTask.task_description,
            status: currentTask.status,
          } : null,
          totalTasksCompleted: agent.total_tasks_completed,
          totalTokensUsed: agent.total_tokens_used,
          costEstimate: agent.total_tokens_used ? (agent.total_tokens_used / 1000000 * 3.0).toFixed(2) : '0.00',
          lastActiveAt: agent.last_active_at,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: agents,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error fetching agents:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
