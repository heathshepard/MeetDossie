/**
 * api/dossiesign-save-field-map.js
 *
 * POST /api/dossiesign-save-field-map
 * {
 *   "job_id": "uuid",
 *   "fields": [{ id, name, type, x_pct, y_pct, w_pct, h_pct, required, party, page }]
 * }
 *
 * Saves the edited field map back to dossiesign_auto_map_runs.fields.
 * Sets qa_status to 'in_progress'.
 *
 * Auth: Bearer <supabase user JWT>. User must own the job or be admin.
 */

const { createClient } = require('@supabase/supabase-js');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }

  let user;
  try {
    user = await verifySupabaseToken(req);
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(err.statusCode).json({ ok: false, error: err.message });
    }
    return res.status(500).json({ ok: false, error: 'Auth error' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  body = body || {};

  const jobId = body.job_id;
  const fields = body.fields;

  if (!jobId) {
    return res.status(400).json({ ok: false, error: 'job_id required' });
  }

  if (!Array.isArray(fields)) {
    return res.status(400).json({ ok: false, error: 'fields must be an array' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    // Fetch the existing row to check ownership
    const { data, error: fetchErr } = await supabase
      .from('dossiesign_auto_map_runs')
      .select('id, created_by')
      .eq('id', jobId)
      .maybeSingle();

    if (fetchErr) {
      return res.status(500).json({ ok: false, error: fetchErr.message });
    }

    if (!data) {
      return res.status(404).json({ ok: false, error: 'Job not found' });
    }

    // Auth check
    const isAdmin = user.email === 'heath.shepard@kw.com';
    if (data.created_by && data.created_by !== user.id && !isAdmin) {
      return res.status(403).json({ ok: false, error: 'Unauthorized' });
    }

    // Update the fields + qa_status
    // Note: dossiesign_auto_map_runs schema does not include an updated_at column;
    // qa_reviewed_at doubles as the last-touched timestamp.
    const { error: updateErr } = await supabase
      .from('dossiesign_auto_map_runs')
      .update({
        fields: fields,
        qa_status: 'in_progress',
        qa_reviewed_at: new Date().toISOString(),
      })
      .eq('id', jobId);

    if (updateErr) {
      return res.status(500).json({ ok: false, error: updateErr.message });
    }

    return res.status(200).json({
      ok: true,
      job_id: jobId,
      status: 'in_progress',
      field_count: fields.length,
    });
  } catch (err) {
    console.error('[dossiesign-save-field-map]', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}

module.exports = handler;
