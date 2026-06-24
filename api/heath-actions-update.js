// Vercel Serverless Function: /api/heath-actions-update
//
// POST — Updates an action item (mark done, dismiss, snooze).
// Called by Jarvis HUD when Heath interacts with an action.
// POST /api/heath-actions-update
// { id, action: "done" | "dismiss" | "snooze_4h" }
//
// Auth: Bearer JWT (heath.shepard@kw.com) only.
//
// Returns:
//   200 { ok: true }
//   400 { ok: false, error: "..." }

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
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHealthTenant(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const { id, action } = req.body || {};

    if (!id || !action) {
      return res.status(400).json({ ok: false, error: 'id and action are required' });
    }

    let update = {};

    if (action === 'done') {
      update = {
        status: 'done',
        completed_at: new Date().toISOString(),
      };
    } else if (action === 'dismiss') {
      update = {
        status: 'dismissed',
      };
    } else if (action === 'snooze_4h') {
      const snoozed_until = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
      update = {
        status: 'snoozed',
        snoozed_until,
      };
    } else {
      return res.status(400).json({ ok: false, error: 'Invalid action' });
    }

    // Update the action (RLS ensures user can only update their own)
    const { error } = await supabase
      .from('heath_actions')
      .update(update)
      .eq('id', id)
      .eq('tenant_id', auth.user_id);

    if (error) throw error;

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
