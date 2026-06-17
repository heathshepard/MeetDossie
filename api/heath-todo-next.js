// Vercel Serverless Function: /api/heath-todo-next
//
// GET — Jarvis HUD calls this on load (and after each action) to get the ONE
// item Heath should see right now. Returns null when the queue is empty so the
// HUD can render its "All clear" state.
//
// Auth: Bearer JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Returns:
//   200 { ok: true, task: { id, title, detail, action_type, priority, deadline, venture, age_minutes } }
//   200 { ok: true, task: null }
//
// Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');
const { authorizeHeath, pickNext, cors } = require('./_heath_todo_helpers.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'GET or POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHeath(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  try {
    const task = await pickNext(supabase);
    return res.status(200).json({ ok: true, task });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
