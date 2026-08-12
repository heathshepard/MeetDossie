/**
 * /api/merge-queue-update-signoff — POST
 *
 * Update one sign-off slot for a merge_queue row.
 * Called by sign-off agents (Atlas, Quinn, Ridge, Hadley, Sage) when they complete.
 *
 * Body — identify the row EITHER by merge_queue_id OR by commit sha:
 *   {
 *     merge_queue_id?: "<uuid>",
 *     sha?: "<full-or-short-commit-sha>",   // looked up against commit_sha; if no
 *                                           // row exists yet for this sha, one is
 *                                           // created (same behavior as
 *                                           // /api/merge-queue-add) so callers like
 *                                           // Quinn don't need to know the row's id
 *                                           // or call merge-queue-add first.
 *     signoff_type: "atlas_apv" | "quinn_qa" | "ridge" | "hadley" | "sage_demo",
 *     status: "pass" | "fail" | "not_run",
 *     evidence_url?: "https://...",
 *     notes?: "failure details"
 *   }
 *
 * This is a single-field update — it only ever writes the one signoff_type
 * passed in (`${signoff_type}_status` etc.), never all five at once.
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

  let { merge_queue_id, sha, signoff_type, status, evidence_url, notes } = req.body || {};

  if (!merge_queue_id && (!sha || typeof sha !== 'string' || sha.length < 7)) {
    return res.status(400).json({ error: 'merge_queue_id or sha (min 7 chars) required' });
  }
  if (!VALID_SIGNOFF_TYPES.includes(signoff_type)) {
    return res.status(400).json({ error: `invalid signoff_type. must be one of: ${VALID_SIGNOFF_TYPES.join(',')}` });
  }
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `invalid status. must be one of: ${VALID_STATUSES.join(',')}` });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Resolve sha -> merge_queue_id, creating the row if it doesn't exist yet
    // (mirrors /api/merge-queue-add so callers like Quinn never 404 just
    // because cron-staging-watcher hasn't inserted the row yet).
    if (!merge_queue_id && sha) {
      const { data: found, error: findErr } = await supabase
        .from('merge_queue')
        .select('id')
        .or(`commit_sha.eq.${sha},commit_sha.ilike.${sha}%`)
        .order('created_at', { ascending: false })
        .limit(1);

      if (findErr) {
        return res.status(500).json({ error: findErr.message });
      }

      if (found && found.length > 0) {
        merge_queue_id = found[0].id;
      } else {
        const { data: inserted, error: insertErr } = await supabase
          .from('merge_queue')
          .insert({ commit_sha: sha, title: `Merge ${sha.slice(0, 7)}` })
          .select('id');
        if (insertErr) {
          return res.status(500).json({ error: 'auto-create row failed: ' + insertErr.message });
        }
        merge_queue_id = inserted[0].id;
      }
    }

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
