// Vercel Serverless Function: /api/studio/status
// Returns overall Shepard Studio organization status
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

    // Get total revenue from all products
    const productsData = await supabaseFetch('/rest/v1/studio_products?select=mrr,active_customers');
    const totalRevenue = productsData.reduce((sum, p) => sum + parseFloat(p.mrr || 0), 0);
    const totalCustomers = productsData.reduce((sum, p) => sum + parseInt(p.active_customers || 0, 10), 0);

    // Get agent costs (sum of token costs)
    const tasksData = await supabaseFetch('/rest/v1/organization_tasks?select=cost_estimate');
    const totalCosts = tasksData.reduce((sum, t) => sum + parseFloat(t.cost_estimate || 0), 0);

    // Get task velocity (completed this week)
    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const completedTasksData = await supabaseFetch(
      `/rest/v1/organization_tasks?status=eq.completed&completed_at=gte.${oneWeekAgo}&select=id`
    );
    const tasksCompletedThisWeek = completedTasksData.length;

    // Calculate net profit
    const netProfit = totalRevenue - totalCosts;

    res.status(200).json({
      success: true,
      data: {
        totalRevenue,
        totalCosts,
        netProfit,
        totalCustomers,
        tasksCompletedThisWeek,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error fetching studio status:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
