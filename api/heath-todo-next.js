// Vercel Serverless Function: /api/heath-todo-next
//
// GET — Jarvis HUD calls this on load (and after each action) to get Heath's
// real backlog. Returns `items` (the full ready queue, priority/age ordered),
// `task` (items[0], kept for back-compat with any old caller expecting a
// single item) and a correct `queue_count`.
//
// Fixed 2026-08-21 — this previously only ever returned a single `task` with
// no `queue_count` field, so the HUD's To-Do card silently hid every item
// past the first and its "N queued" label always rendered blank.
//
// Auth: Bearer JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Returns:
//   200 { ok: true, task: {...} | null, queue_count, items: [{ id, title, detail, action_type, priority, deadline, venture, age_minutes }] }
//
// Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');
const { authorizeHeath, pickList, cors } = require('./_heath_todo_helpers.js');

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
    const items = await pickList(supabase);
    const task = items.length ? items[0] : null;
    return res.status(200).json({ ok: true, task, queue_count: items.length, items });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
