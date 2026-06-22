/**
 * /api/merge-queue-update-signoff — POST
 *
 * Update one sign-off slot for a merge_queue row.
 * Called by sign-off agents (Atlas, Quinn, Ridge, Hadley, Sage) when they complete.
 *
 * Body:
 *   {
 *     merge_queue_id: "<uuid>",
 *     signoff_type: "atlas_apv" | "quinn_qa" | "ridge" | "hadley" | "sage_demo",
 *     status: "pass" | "fail" | "not_run",
 *     evidence_url?: "https://...",
 *     notes?: "failure details"
 *   }
 *
 * Returns:
 *   { ok: true, merge_queue_id, signoff_type, status, all_green }
 *
 * Auth: Bearer CRON_SECRET (agents run via cron)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const VALID_SIGNOFF_TYPES = ['atlas_apv', 'quinn_qa', 'ridge', 'hadley', 'sage_demo'];
const VALID_STATUSES = ['not_run', 'pass', 'fail'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: CRON_SECRET
  const auth = req.headers.authorization || '';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isCronSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing supabase env' });
  }

  const { merge_queue_id, signoff_type, status, evidence_url, notes } = req.body || {};

  if (!merge_queue_id || typeof merge_queue_id !== 'string') {
    return res.status(400).json({ error: 'merge_queue_id required' });
  }
  if (!VALID_SIGNOFF_TYPES.includes(signoff_type)) {
    return res.status(400).json({ error: `invalid signoff_type. must be one of: ${VALID_SIGNOFF_TYPES.join(',')}` });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status. must be one of: ${VALID_STATUSES.join(',')}` });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Build update object dynamically based on signoff_type
    const update = {
      [`${signoff_type}_status`]: status,
      [`${signoff_type}_evidence_url`]: evidence_url || null,
      [`${signoff_type}_notes`]: notes || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('merge_queue')
      .update(update)
      .eq('id', merge_queue_id)
      .select('id, all_green, atlas_apv_status, quinn_qa_status, ridge_status, hadley_status, sage_demo_status');

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data || data.length === 0) {
      return res.status(404).json({ error: 'merge_queue row not found' });
    }

    return res.status(200).json({
      ok: true,
      merge_queue_id: data[0].id,
      signoff_type,
      status,
      all_green: data[0].all_green,
      signoff_status: {
        atlas_apv: data[0].atlas_apv_status,
        quinn_qa: data[0].quinn_qa_status,
        ridge: data[0].ridge_status,
        hadley: data[0].hadley_status,
        sage_demo: data[0].sage_demo_status,
      },
    });
  } catch (err) {
    console.error('[merge-queue-update-signoff]', err);
    return res.status(500).json({ error: err.message });
  }
};
