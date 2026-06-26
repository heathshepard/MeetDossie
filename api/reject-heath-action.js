// Vercel Serverless Function: /api/reject-heath-action
//
// POST — Marks a heath_actions row as rejected with optional reason.
// Body: { action_id: uuid, reason?: string }
// Auth: Bearer JWT — must be signed in.
//
// Returns: 200 { success: true, action: {...} }

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function corsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function authorize(req, supabase) {
  const auth = req.headers.authorization;
  if (!auth) return { ok: false, status: 401, error: 'Missing Authorization header' };
  const token = auth.replace('Bearer ', '');
  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return { ok: false, status: 401, error: 'Invalid token' };
    return { ok: true, user_id: user.id };
  } catch (err) {
    return { ok: false, status: 401, error: err.message };
  }
}

module.exports = async function handler(req, res) {
  corsHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorize(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ error: auth.error });

  const { action_id, reason } = req.body || {};
  if (!action_id) {
    return res.status(400).json({ error: 'action_id required' });
  }

  try {
    // NOTE: heath_actions.status enum is pending/done/dismissed/snoozed.
    // "rejected" semantically maps to status='dismissed' + failure_reason.
    // Tenant-scoped by auth user id to prevent cross-account writes.
    const { data, error } = await supabase
      .from('heath_actions')
      .update({
        status: 'dismissed',
        failure_reason: reason || null,
      })
      .eq('id', action_id)
      .eq('tenant_id', auth.user_id)
      .select();

    if (error) throw error;
    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'Action not found' });
    }

    return res.status(200).json({ success: true, action: data[0] });
  } catch (err) {
    console.error('reject-heath-action error:', err);
    return res.status(500).json({ error: err.message });
  }
};
