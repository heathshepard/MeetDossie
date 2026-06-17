// Vercel Serverless Function: /api/heath-todo-skip
//
// POST — Heath tapped [Skip] on the HUD. Mark the item skipped and return the
// next pending item. Optional reason gets stamped to metadata.skip_reason.
//
// Auth: Bearer JWT (heath.shepard@kw.com) OR Bearer ${CRON_SECRET}.
//
// Body:  { id: "uuid", reason?: "string" }
//
// Returns:
//   200 { ok: true, skipped_id, next: { ... } | null }
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
  const reason = body.reason != null ? String(body.reason).slice(0, 1000) : null;

  // Load existing metadata so we can merge skip_reason without clobbering.
  const { data: existing, error: loadErr } = await supabase
    .from('heath_todo')
    .select('id, metadata, status')
    .eq('id', id)
    .single();

  if (loadErr || !existing) {
    return res.status(404).json({ ok: false, error: 'task not found' });
  }
  if (existing.status === 'done' || existing.status === 'skipped') {
    return res.status(400).json({ ok: false, error: `task already ${existing.status}` });
  }

  const mergedMeta = {
    ...(existing.metadata || {}),
    ...(reason ? { skip_reason: reason, skipped_at: new Date().toISOString() } : { skipped_at: new Date().toISOString() }),
  };

  const { error: updErr } = await supabase
    .from('heath_todo')
    .update({ status: 'skipped', metadata: mergedMeta })
    .eq('id', id);

  if (updErr) return res.status(500).json({ ok: false, error: updErr.message });

  let next = null;
  try { next = await pickNext(supabase); } catch { next = null; }

  return res.status(200).json({ ok: true, skipped_id: id, next });
};
