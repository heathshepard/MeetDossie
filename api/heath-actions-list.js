// Vercel Serverless Function: /api/heath-actions-list
//
// GET — Retrieves all pending/snoozed actions for Heath, grouped by priority.
// Called by Jarvis HUD on load and via realtime subscription.
// GET /api/heath-actions-list
//
// Auth: Bearer JWT (heath.shepard@kw.com) only.
//
// Returns:
//   200 { ok: true, actions: { urgent: [...], soon: [...], whenever: [...] } }

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authorizeHealthTenant(req, supabase) {
  const auth = req.headers.authorization;
  if (!auth) return { ok: false, status: 401, error: 'Missing Authorization header' };

  const token = auth.replace('Bearer ', '');

  // Verify JWT
  try {
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid token' };
    return { ok: true, user_id: user.id };
  } catch (err) {
    return { ok: false, status: 401, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') {
    return res.status(405).json({ ok: false, error: 'GET only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHealthTenant(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    // Fetch all pending and snoozed actions
    const { data: actions, error } = await supabase
      .from('heath_actions')
      .select('*')
      .eq('tenant_id', auth.user_id)
      .in('status', ['pending', 'snoozed'])
      .order('priority', { ascending: true }) // urgent first
      .order('deadline', { ascending: true, nullsLast: true });

    if (error) throw error;

    // Group by priority
    const grouped = {
      urgent: [],
      soon: [],
      whenever: [],
    };

    actions.forEach((action) => {
      grouped[action.priority].push(action);
    });

    // Calculate total count (non-dismissed, non-done)
    const totalCount = actions.length;

    return res.status(200).json({
      ok: true,
      actions: grouped,
      total_pending: totalCount,
      status: totalCount === 0 ? 'ALL CLEAR' : `${totalCount} PENDING`,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
