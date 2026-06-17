// Vercel Serverless Function: /api/heath-todo-snooze
//
// POST — Heath tapped [Snooze 1h] / [Snooze tomorrow]. Set the item aside until
// snooze_until and return the next pending item. The heath_todo_ready view
// resurrects snoozed items automatically once snoozed_until <= now(), so a cron
// is optional (it just flips status='snoozed' back to 'pending' for cleanliness).
//
// Auth: Bearer JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Body:  { id: "uuid", snooze_until: "ISO-8601" }
//
// Returns:
//   200 { ok: true, snoozed_id, snoozed_until, next: { ... } | null }
//
// Owner: Atlas (SV-ENG-HEATH-TODO / 2026-06-17)

const { createClient } = require('@supabase/supabase-js');
const { authorizeHeath, pickNext, cors } = require('./_heath_todo_helpers.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'POST only' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase env not configured' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await authorizeHeath(req, supabase);
  if (!auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const id = String(body.id || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'id required' });

  const rawUntil = body.snooze_until || body.snoozed_until;
  if (!rawUntil) {
    return res.status(400).json({ ok: false, error: 'snooze_until required (ISO-8601)' });
  }
  const until = new Date(rawUntil);
  if (Number.isNaN(until.getTime())) {
    return res.status(400).json({ ok: false, error: 'snooze_until must be valid ISO-8601' });
  }
  if (until.getTime() <= Date.now()) {
    return res.status(400).json({ ok: false, error: 'snooze_until must be in the future' });
  }

  const { data: updated, error: updErr } = await supabase
    .from('heath_todo')
    .update({ status: 'snoozed', snoozed_until: until.toISOString() })
    .eq('id', id)
    .in('status', ['pending', 'snoozed'])
    .select('id, snoozed_until')
    .single();

  if (updErr) {
    if (updErr.code === 'PGRST116' || /no rows/i.test(updErr.message || '')) {
      return res.status(404).json({ ok: false, error: 'task not found or already terminal' });
    }
    return res.status(500).json({ ok: false, error: updErr.message });
  }

  let next = null;
  try { next = await pickNext(supabase); } catch { next = null; }

  return res.status(200).json({
    ok: true,
    snoozed_id: updated.id,
    snoozed_until: updated.snoozed_until,
    next,
  });
};
