/**
 * /api/merge-queue-list — GET
 *
 * List all merge_queue rows, filtered by:
 * - ?filter=pending (default) — merged_to_main=false, sorted by created_at DESC
 * - ?filter=ready — merged_to_main=false AND quinn_qa_status='pass', sorted by created_at DESC.
 *   This is the only real, working gate in practice (Quinn actually runs Playwright
 *   against staging). The Jarvis Merge Queue panel uses this filter — see CLAUDE.md
 *   deploy workflow. Rows without a Quinn PASS are still tracked in `pending` for
 *   other consumers but are intentionally hidden from the merge-ready panel.
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
    } else if (filter === 'ready') {
      query = query.eq('merged_to_main', false).eq('quinn_qa_status', 'pass').order('created_at', { ascending: false });
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

    // Defense in depth: filter=ready feeds a MERGE button that posts
    // commit_sha straight to /api/merge-to-main, which rejects anything that
    // isn't 7-40 hex chars. A row with a malformed sha (e.g. a QA test
    // fixture that leaked past cleanup, 2026-08-12) would otherwise render
    // as "ready" and then fail with a raw "sha required" error the moment
    // Heath presses MERGE. Never show a row here that can't actually merge.
    let items = data || [];
    if (filter === 'ready') {
      items = items.filter((row) => /^[0-9a-f]{7,40}$/i.test(String(row.commit_sha || '')));
    }

    return res.status(200).json({
      ok: true,
      filter,
      count: items.length,
      items,
    });
  } catch (err) {
    console.error('[merge-queue-list]', err);
    return res.status(500).json({ error: err.message });
  }
};
