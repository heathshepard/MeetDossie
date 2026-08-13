/**
 * /api/merge-queue-list — GET
 *
 * List all merge_queue rows, filtered by:
 * - ?filter=pending (default) — merged_to_main=false, sorted by created_at DESC
 * - ?filter=ready — merged_to_main=false AND the row's repo-appropriate QA
 *   gate is satisfied, sorted by created_at DESC. GENERALIZED 2026-08-13
 *   (Carter, SV-ENG-MERGE-QUEUE-MULTI-REPO) — per repo in
 *   api/_lib/tracked-repos.js:
 *     qa_gate='quinn' (MeetDossie, DossieApp) -> row must have
 *       quinn_qa_status='pass'. This is the only real, working automated
 *       gate today (Quinn actually runs Playwright against the MeetDossie
 *       staging preview). DossieApp rows realistically won't flip until a
 *       human/Quinn actually reviews that commit — correct, not a bug.
 *     qa_gate='none' (Rust, any future repo without a QA harness) -> row
 *       counts as ready once it's simply unmerged. NEVER fabricate a Quinn
 *       pass for these — the UI must show an honest "no QA gate" label
 *       (see item.qa_gate / item.ready_reason below).
 *   Rows for an untracked/legacy repo value fall back to the original
 *   quinn_qa_status='pass' requirement.
 *
 *   MERGEABILITY CHECK — added 2026-08-13 (Carter, post-hoc bug found by
 *   Quinn's QA pass on the multi-repo rebuild). Passing the QA gate does
 *   NOT mean a row can actually fast-forward: branch-scan mode
 *   (cron-staging-watcher.js, for no-staging-tier repos like Rust) queues
 *   any branch ahead of main with zero check that main hasn't since moved
 *   past it, and even a staging-tier row can go stale between being queued
 *   and being clicked. The old code let a genuinely-diverged row render
 *   with a plain, enabled MERGE button that would predictably 409 the
 *   instant Heath clicked it (confirmed live: both real Rust rows were
 *   diverged from main — ahead 1/behind 1 and ahead 1/behind 20).
 *
 *   Every row returned by filter=ready now carries a live GitHub-compare
 *   verdict (capped at MAX_MERGEABILITY_CHECKS rows to bound API cost):
 *     merge_status: 'clean' | 'diverged' | 'unknown'
 *     merge_action: 'fast_forward' | 'merge_commit' | 'blocked'
 *       fast_forward — status is identical/ahead, a plain FF will work.
 *       merge_commit — repo qa_gate='none' AND diverged. merge-to-main.js
 *         will attempt a real (non-FF) merge commit via GitHub's Merges
 *         API for these — safe to offer self-service on a repo that has no
 *         QA/history-hygiene requirement, never offered for MeetDossie/
 *         DossieApp (qa_gate='quinn' stays strict-FF-only, no behavior
 *         change to the primary product's safety guarantee).
 *       blocked — diverged AND qa_gate='quinn' (or the compare check
 *         itself failed) — no automatic resolution path today; the row
 *         still SHOWS (visibility is the whole point of this feature) but
 *         the PWA renders it disabled with an honest "needs manual
 *         rebase" note instead of a button that would just fail.
 *   'ready' still means "QA-gate satisfied" (unchanged meaning) — it is
 *   deliberately NOT narrowed to merge_action='fast_forward' only, because
 *   doing so would silently drop diverged rows out of the panel entirely,
 *   which is the exact regression this whole feature was built to fix
 *   (Heath: "I need to see everything that needs merging").
 * - ?filter=recent — merged_to_main=true, last 10, sorted by merged_at DESC
 * - ?filter=all — all, sorted by created_at DESC
 *
 * Returns:
 *   {
 *     ok: true,
 *     items: [
 *       {
 *         id, commit_sha, repo, repo_label, branch_from, qa_gate, ready_reason,
 *         merge_status, merge_action,
 *         title, description,
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
const { getRepoConfig } = require('./_lib/tracked-repos.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const DEFAULT_REPO = 'heathshepard/MeetDossie';
const MAX_MERGEABILITY_CHECKS = 30; // bound GitHub API cost per list call

async function ghCompare(repo, base, head) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'meetdossie-merge-queue-list',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`, { headers });
    if (!res.ok) return { ok: false, error: `compare_${res.status}` };
    const data = await res.json();
    return { ok: true, status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

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
        'id, commit_sha, repo, branch_from, title, description, ' +
        'atlas_apv_status, quinn_qa_status, ridge_status, hadley_status, sage_demo_status, ' +
        'atlas_apv_evidence_url, quinn_qa_evidence_url, ridge_evidence_url, hadley_evidence_url, sage_demo_video_url, ' +
        'atlas_apv_notes, quinn_qa_notes, ridge_notes, hadley_notes, sage_demo_notes, ' +
        'all_green, merged_to_main, created_at, merged_at, commit_author'
      );

    // 'ready' needs per-row repo policy (see getRowReadiness below), so it
    // pulls from the same base query as 'pending' and filters in JS rather
    // than a single DB-level quinn_qa_status='pass' condition.
    if (filter === 'pending' || filter === 'ready') {
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

    // Attach per-row repo policy fields — the PWA needs these regardless of
    // filter (pending/all rows still show a project label + honest status).
    let items = (data || []).map((row) => {
      const repo = row.repo || DEFAULT_REPO;
      const cfg = getRepoConfig(repo);
      const qaGate = (cfg && cfg.qa_gate) || 'quinn'; // untracked/legacy repo -> old behavior
      const repoLabel = (cfg && cfg.label) || repo;
      const readyForGate = qaGate === 'none' ? true : row.quinn_qa_status === 'pass';
      const readyReason = qaGate === 'none'
        ? 'No QA gate for this repo — review before merging'
        : (readyForGate ? 'QA verified by Quinn' : 'Awaiting Quinn QA');
      return {
        ...row,
        repo,
        repo_label: repoLabel,
        qa_gate: qaGate,
        ready_reason: readyReason,
        _ready_for_gate: readyForGate, // internal — stripped below
      };
    });

    if (filter === 'ready') {
      // Defense in depth: filter=ready feeds a MERGE button that posts
      // the row to /api/merge-to-main, which rejects anything that isn't
      // 7-40 hex chars. A row with a malformed sha (e.g. a QA test fixture
      // that leaked past cleanup, 2026-08-12) would otherwise render as
      // "ready" and then fail the moment Heath presses MERGE. Never show a
      // row here that can't actually merge.
      items = items.filter((row) =>
        row._ready_for_gate && /^[0-9a-f]{7,40}$/i.test(String(row.commit_sha || ''))
      );

      // Mergeability check (see file-header comment) — capped to bound cost.
      const toCheck = items.slice(0, MAX_MERGEABILITY_CHECKS);
      const rest = items.slice(MAX_MERGEABILITY_CHECKS);
      const checked = await Promise.all(toCheck.map(async (row) => {
        const cfg = getRepoConfig(row.repo);
        const mainBranch = (cfg && cfg.main_branch) || 'main';
        const cmp = await ghCompare(row.repo, mainBranch, row.commit_sha);
        if (!cmp.ok) {
          return { ...row, merge_status: 'unknown', merge_action: 'blocked' };
        }
        const clean = cmp.status === 'identical' || cmp.status === 'ahead';
        if (clean) {
          return { ...row, merge_status: 'clean', merge_action: 'fast_forward' };
        }
        // diverged or behind — main has moved since this branch was cut.
        const action = row.qa_gate === 'none' ? 'merge_commit' : 'blocked';
        return { ...row, merge_status: 'diverged', merge_action: action };
      }));
      // Rows past the cap: fail safe rather than fail open — never claim a
      // fast_forward we haven't actually verified.
      const uncheckedTagged = rest.map((row) => ({ ...row, merge_status: 'unknown', merge_action: 'blocked' }));
      items = [...checked, ...uncheckedTagged];
    }
    items = items.map(({ _ready_for_gate, ...rest }) => rest);

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
