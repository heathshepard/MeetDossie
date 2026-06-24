/**
 * /api/merge-queue-add — POST
 *
 * Atomically add or get a merge_queue row for a commit SHA.
 * Called by cron-staging-watcher when a new commit is detected.
 *
 * Idempotent: UNIQUE constraint on commit_sha prevents duplicates.
 *
 * Body:
 *   { sha: "<full-or-short-SHA>", title?: "...", description?: "..." }
 *
 * Returns:
 *   { ok: true, id, created, sha, title, all_green }
 *
 * Auth: Bearer CRON_SECRET OR service role
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth: CRON_SECRET or service role
  const auth = req.headers.authorization || '';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isCronSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing supabase env' });
  }

  const { sha, title, description, commit_author, committed_at } = req.body || {};
  if (!sha || typeof sha !== 'string' || sha.length < 7) {
    return res.status(400).json({ error: 'sha required (min 7 chars)' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  try {
    // Try insert (will fail if already exists due to UNIQUE constraint)
    const { data: inserted, error: insertErr } = await supabase
      .from('merge_queue')
      .insert({
        commit_sha: sha,
        title: title || `Merge ${sha.slice(0, 7)}`,
        description: description || '',
        commit_author: commit_author || null,
        committed_at: committed_at || null,
      })
      .select('id, commit_sha, title, all_green, created_at');

    if (insertErr && insertErr.code !== '23505') {
      // 23505 = unique violation (expected on duplicate)
      return res.status(500).json({ error: insertErr.message });
    }

    // If inserted successfully, return the new row
    if (inserted && inserted.length > 0) {
      return res.status(201).json({
        ok: true,
        created: true,
        id: inserted[0].id,
        sha: inserted[0].commit_sha,
        title: inserted[0].title,
        all_green: inserted[0].all_green,
        created_at: inserted[0].created_at,
      });
    }

    // If UNIQUE violation (duplicate), fetch and return existing row
    const { data: existing, error: fetchErr } = await supabase
      .from('merge_queue')
      .select('id, commit_sha, title, all_green, created_at')
      .eq('commit_sha', sha)
      .single();

    if (fetchErr) {
      return res.status(500).json({ error: 'merge_queue fetch failed: ' + fetchErr.message });
    }

    return res.status(200).json({
      ok: true,
      created: false,
      duplicate: true,
      id: existing.id,
      sha: existing.commit_sha,
      title: existing.title,
      all_green: existing.all_green,
      created_at: existing.created_at,
    });
  } catch (err) {
    console.error('[merge-queue-add]', err);
    return res.status(500).json({ error: err.message });
  }
};
