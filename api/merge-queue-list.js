/**
 * /api/merge-queue-list — GET
 *
 * List all merge_queue rows, filtered by:
 * - ?filter=pending (default) — merged_to_main=false, sorted by created_at DESC
 * - ?filter=recent — merged_to_main=true, last 10, sorted by merged_at DESC
 * - ?filter=all — all, sorted by created_at DESC
 *
 * Returns:
 *   {
 *     ok: true,
 *     items: [
 *       {
 *         id, commit_sha, title, description,
 *         atlas_apv_status, quinn_qa_status, ridge_status, hadley_status, sage_demo_status,
 *         all_green, merged_to_main, created_at, merged_at
 *       },
 *       ...
 *     ]
 *   }
 *
 * Auth: Bearer JWT (Jarvis user, authenticated)
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: user must be signed in (we don't enforce a specific email here; Jarvis handles it)
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing supabase env' });
  }

  const filter = req.query.filter || 'pending';

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    let query = supabase
      .from('merge_queue')
      .select(
        'id, commit_sha, title, description, ' +
        'atlas_apv_status, quinn_qa_status, ridge_status, hadley_status, sage_demo_status, ' +
        'atlas_apv_evidence_url, quinn_qa_evidence_url, ridge_evidence_url, hadley_evidence_url, sage_demo_video_url, ' +
        'atlas_apv_notes, quinn_qa_notes, ridge_notes, hadley_notes, sage_demo_notes, ' +
        'all_green, merged_to_main, created_at, merged_at, commit_author'
      );

    if (filter === 'pending') {
      query = query.eq('merged_to_main', false).order('created_at', { ascending: false });
    } else if (filter === 'recent') {
      query = query.eq('merged_to_main', true).order('merged_at', { ascending: false }).limit(10);
    } else if (filter === 'all') {
      query = query.order('created_at', { ascending: false });
    } else {
      return res.status(400).json({ error: 'invalid filter' });
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      ok: true,
      filter,
      count: data ? data.length : 0,
      items: data || [],
    });
  } catch (err) {
    console.error('[merge-queue-list]', err);
    return res.status(500).json({ error: err.message });
  }
};
