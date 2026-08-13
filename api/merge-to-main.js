/**
 * /api/merge-to-main — POST
 *
 * Fast-forwards a repo's main branch to a specific commit SHA, then pushes.
 * Triggered by the Merge button on the Jarvis PWA Merge Queue panel.
 *
 * GENERALIZED TO MULTI-REPO 2026-08-13 (Carter, SV-ENG-MERGE-QUEUE-MULTI-REPO)
 * — was hardcoded to heathshepard/MeetDossie only. Now resolves repo +
 * branch_from from the merge_queue row itself so the same endpoint safely
 * merges any repo in api/_lib/tracked-repos.js.
 *
 * Auth: Bearer JWT, MUST be heath.shepard@kw.com. No CRON_SECRET fallback —
 *       merging to main is human-only. (Even Cole/agents don't merge.)
 *
 * Safety:
 *   - Requires either `id` (preferred — merge_queue row uuid, resolves repo
 *     + branch_from server-side so the client can't spoof which repo it's
 *     merging) or a legacy `sha`-only body (defaults to MeetDossie/staging
 *     for backward compatibility with existing callers/tests).
 *   - Refuses to touch any repo not in the tracked-repos registry.
 *   - Verifies SHA exists on the row's source branch (staging, or the real
 *     feature branch for no-staging-tier repos like Rust).
 *   - Verifies main can fast-forward to that SHA — refuses if NOT a strict
 *     ancestor relationship (would be a non-FF / divergent merge), UNLESS
 *     the repo's qa_gate='none' (Rust today), in which case it falls back
 *     to a real merge commit via GitHub's Merges API (server-side 3-way
 *     merge — refuses cleanly with MERGE_CONFLICT on real content
 *     conflicts, never a silent rewrite). MeetDossie/DossieApp
 *     (qa_gate='quinn') get no such fallback — still strict-FF-only.
 *     Added 2026-08-13 after Quinn's post-hoc QA found live Rust rows
 *     rendering an enabled MERGE button that predictably 409'd because the
 *     branch had genuinely diverged from main (main moved on since the
 *     branch was cut) — see api/merge-queue-list.js header comment for the
 *     matching read-side fix (merge_status/merge_action per row).
 *   - Uses the GitHub Git Refs API to update refs/heads/main directly for
 *     the fast-forward path. GitHub's update-ref endpoint defaults to
 *     `force=false`, which is exactly the fast-forward-only guarantee we
 *     want.
 *
 * Body:
 *   { id: "<merge_queue row uuid>" }             — preferred
 *   { sha: "<full-or-short-SHA>" }                — legacy, MeetDossie only
 *   { id, sha } — both sent by the current PWA; id wins when present.
 *
 * Returns:
 *   { ok: true, mergedSha, mainNewSha, strategy: "fast_forward" | "merge_commit" }
 *   or
 *   { error: "...", code: "NOT_FAST_FORWARD" | "MERGE_CONFLICT" | "SHA_NOT_ON_STAGING" | "REPO_NOT_TRACKED" | ... }
 *
 * Updated: 2026-06-17 — initial build (Atlas). 2026-08-13 — multi-repo
 * (Carter); merge-commit fallback for qa_gate='none' repos (Carter, same
 * day, post-hoc Quinn QA fix).
 */

const { createClient } = require('@supabase/supabase-js');
const { getRepoConfig } = require('./_lib/tracked-repos.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const LEGACY_REPO = 'heathshepard/MeetDossie';
const LEGACY_BRANCH_FROM = 'staging';

const ALLOWED_EMAIL = 'heath.shepard@kw.com';

async function githubFetch(path, init = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN not configured');
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meetdossie-merge-to-main',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, ok: res.ok, json, text };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'supabase env not configured' });
  }
  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN not configured', code: 'NO_GITHUB_TOKEN' });
  }

  // Auth gate — Heath ONLY.
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'unauthorized - no token' });
  }
  const token = authHeader.replace('Bearer ', '');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'unauthorized - invalid token' });
  }
  if (user.email !== ALLOWED_EMAIL) {
    return res.status(403).json({ error: 'forbidden - heath only' });
  }

  const body = req.body || {};
  const idInput = String(body.id || '').trim();
  const shaInput = String(body.sha || '').trim();
  if (!idInput && (!shaInput || !/^[0-9a-f]{7,40}$/i.test(shaInput))) {
    return res.status(400).json({ error: 'id or sha required (sha must be 7-40 hex)', code: 'BAD_SHA' });
  }

  // Resolve which repo + source branch this merge_queue row belongs to.
  // Prefer `id` (server-side lookup — client can't spoof the repo this way).
  // Fall back to legacy sha-only behavior (MeetDossie/staging) so existing
  // callers/tests that only ever sent `sha` keep working.
  let queueRow = null;
  if (idInput) {
    const { data, error: rowErr } = await supabase
      .from('merge_queue')
      .select('id, commit_sha, repo, branch_from, merged_to_main')
      .eq('id', idInput)
      .maybeSingle();
    if (rowErr) {
      return res.status(500).json({ error: `merge_queue lookup failed: ${rowErr.message}`, code: 'ROW_LOOKUP_FAILED' });
    }
    if (!data) {
      return res.status(404).json({ error: `merge_queue row ${idInput} not found`, code: 'ROW_NOT_FOUND' });
    }
    queueRow = data;
  }

  const repo = queueRow ? (queueRow.repo || LEGACY_REPO) : LEGACY_REPO;
  const branchFrom = queueRow ? (queueRow.branch_from || LEGACY_BRANCH_FROM) : LEGACY_BRANCH_FROM;
  const sha = queueRow ? queueRow.commit_sha : shaInput;

  const repoCfg = getRepoConfig(repo);
  if (!repoCfg) {
    return res.status(400).json({ error: `repo "${repo}" is not in the tracked-repos registry — refusing to merge`, code: 'REPO_NOT_TRACKED' });
  }
  const mainBranch = repoCfg.main_branch || 'main';

  if (queueRow && queueRow.merged_to_main) {
    return res.status(200).json({ ok: true, noop: true, message: 'row already marked merged_to_main', mainNewSha: sha });
  }

  try {
    // 1. Resolve to full SHA via the commits API. Confirms the commit exists.
    const commitLookup = await githubFetch(`/repos/${repo}/commits/${sha}`);
    if (!commitLookup.ok) {
      return res.status(404).json({
        error: `commit ${sha} not found`,
        code: 'SHA_NOT_FOUND',
        detail: commitLookup.text.slice(0, 200),
      });
    }
    const fullSha = commitLookup.json.sha;

    // 2. Confirm the commit is actually on its source branch. We do this by
    //    walking that branch's history (newest first) and looking for the
    //    sha. Cap at 250 commits — beyond that, Heath should merge manually.
    let foundOnBranch = false;
    let page = 1;
    let pagesChecked = 0;
    while (page <= 5 && !foundOnBranch) {
      const list = await githubFetch(`/repos/${repo}/commits?sha=${encodeURIComponent(branchFrom)}&per_page=50&page=${page}`);
      if (!list.ok) break;
      const arr = list.json || [];
      if (arr.length === 0) break;
      if (arr.some(c => c.sha === fullSha)) { foundOnBranch = true; break; }
      page += 1;
      pagesChecked += 1;
    }
    if (!foundOnBranch) {
      return res.status(400).json({
        error: `commit ${fullSha.slice(0, 7)} not found on ${branchFrom} (checked last ${pagesChecked * 50} commits)`,
        code: 'SHA_NOT_ON_STAGING',
      });
    }

    // 3. Verify fast-forward is possible: compare base=main vs head=fullSha.
    //    If status is "ahead" or "identical", FF is safe. Anything else
    //    (diverged, behind) means main has commits not in this SHA — refuse.
    const compare = await githubFetch(`/repos/${repo}/compare/${mainBranch}...${fullSha}`);
    if (!compare.ok) {
      return res.status(500).json({
        error: 'github compare failed',
        code: 'COMPARE_FAILED',
        detail: compare.text.slice(0, 200),
      });
    }
    const status = compare.json.status;
    if (status === 'identical') {
      return res.status(200).json({
        ok: true,
        noop: true,
        message: 'main is already at this SHA',
        mainNewSha: fullSha,
      });
    }
    let mergeStrategy = 'fast_forward';
    let mainNewSha = fullSha;

    if (status !== 'ahead') {
      // NOT a clean fast-forward — main has moved since this branch was cut
      // (confirmed live 2026-08-13, Quinn's post-hoc QA: both real Rust
      // rows were "diverged", not just stale display — a genuine
      // ahead/behind split, not a queue bug on its own).
      //
      // MERGE-COMMIT FALLBACK — only for qa_gate='none' repos (Rust today).
      // Those repos have no QA/history-hygiene requirement, so a real merge
      // commit via GitHub's Merges API is an acceptable, safe self-service
      // path: GitHub performs the actual 3-way merge server-side and
      // refuses cleanly (409) on a real content conflict — never a silent
      // rewrite. MeetDossie/DossieApp (qa_gate='quinn') get ZERO behavior
      // change here — still strict-FF-only, refused exactly as before.
      if (repoCfg.qa_gate === 'none') {
        const merge = await githubFetch(`/repos/${repo}/merges`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            base: mainBranch,
            head: fullSha,
            commit_message: `Merge ${branchFrom} into ${mainBranch} (Jarvis merge queue, qa_gate=none — no QA harness on this repo, Heath reviewed before clicking)`,
          }),
        });
        if (merge.status === 204) {
          // Base already contains head — nothing to merge, effectively done.
          return res.status(200).json({ ok: true, noop: true, message: `${mainBranch} already contains this branch`, mainNewSha: fullSha });
        }
        if (merge.status === 409) {
          return res.status(409).json({
            error: `real merge conflict merging ${branchFrom} into ${mainBranch} — GitHub could not auto-merge. This needs a manual resolution in the actual repo, not a queue fix.`,
            code: 'MERGE_CONFLICT',
            relationship: status,
          });
        }
        if (!merge.ok) {
          return res.status(500).json({
            error: 'github merge-commit failed',
            code: 'MERGE_COMMIT_FAILED',
            status: merge.status,
            detail: merge.text.slice(0, 300),
          });
        }
        mergeStrategy = 'merge_commit';
        mainNewSha = merge.json && merge.json.sha ? merge.json.sha : fullSha;
      } else {
        return res.status(409).json({
          error: `cannot fast-forward ${mainBranch} to ${fullSha.slice(0, 7)} — relationship is "${status}". ${mainBranch} has ${compare.json.behind_by || 0} commits not in target. Resolve manually.`,
          code: 'NOT_FAST_FORWARD',
          relationship: status,
        });
      }
    } else {
      // 4. Fast-forward update of refs/heads/{main}. GitHub's PATCH ref
      //    endpoint requires force=false for pure FF; the API rejects
      //    non-FF when force=false. That's our hard guarantee.
      const update = await githubFetch(`/repos/${repo}/git/refs/heads/${mainBranch}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: fullSha, force: false }),
      });
      if (!update.ok) {
        return res.status(500).json({
          error: 'github ref update failed',
          code: 'REF_UPDATE_FAILED',
          status: update.status,
          detail: update.text.slice(0, 300),
        });
      }
      mainNewSha = update.json?.object?.sha || fullSha;
    }

    // 5. Record in agent_activity for the "Done Today" feed.
    try {
      await supabase
        .from('agent_activity')
        .insert({
          agent_name: 'system',
          task_summary: `Merged ${fullSha.slice(0, 7)} to ${repo}#${mainBranch} (${mergeStrategy}): ${(commitLookup.json.commit?.message || '').split('\n')[0].slice(0, 200)}`,
          status: 'done',
          metadata: { kind: 'merge_to_main', repo, sha: fullSha, strategy: mergeStrategy, triggered_by: user.email },
          completed_at: new Date().toISOString(),
        });
    } catch {}

    // 6. Mark merge_queue row(s) as merged — scoped to this repo only, so a
    //    fast-forward on one repo never touches another repo's rows.
    //    Two paths:
    //      a. Direct match on this SHA.
    //      b. Any pending queue row (same repo) whose SHA is now an ancestor
    //         of main (fast-forward brings intermediate commits with it).
    //         Bounded to 50 rows to keep this call cheap.
    try {
      const nowIso = new Date().toISOString();
      // (a) direct
      await supabase
        .from('merge_queue')
        .update({
          merged_to_main: true,
          merged_at: nowIso,
          merged_by_user_id: user.id,
        })
        .eq('commit_sha', fullSha)
        .eq('repo', repo);

      // (b) sweep other pending rows in the SAME repo that may now be
      // ancestors of main
      const { data: pending } = await supabase
        .from('merge_queue')
        .select('id, commit_sha')
        .eq('merged_to_main', false)
        .eq('repo', repo)
        .order('created_at', { ascending: false })
        .limit(50);

      if (Array.isArray(pending) && pending.length > 0) {
        for (const row of pending) {
          const c = await githubFetch(`/repos/${repo}/compare/${row.commit_sha}...${fullSha}`);
          if (!c.ok || !c.json) continue;
          const s = c.json.status;
          if (s === 'identical' || s === 'ahead') {
            await supabase
              .from('merge_queue')
              .update({
                merged_to_main: true,
                merged_at: nowIso,
                merged_by_user_id: user.id,
              })
              .eq('id', row.id);
          }
        }
      }
    } catch {}

    return res.status(200).json({
      ok: true,
      mergedSha: fullSha,
      shortSha: fullSha.slice(0, 7),
      mainNewSha,
      strategy: mergeStrategy,
      ahead_before: compare.json.ahead_by,
      message: (commitLookup.json.commit?.message || '').split('\n')[0],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
