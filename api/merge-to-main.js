/**
 * /api/merge-to-main — POST
 *
 * Fast-forwards `main` to a specific commit SHA on `staging`, then pushes.
 * Triggered by the Merge button in /today.
 *
 * Auth: Bearer JWT, MUST be heath.shepard@kw.com. No CRON_SECRET fallback —
 *       merging to main is human-only. (Even Cole/agents don't merge.)
 *
 * Safety:
 *   - Requires explicit commit SHA in the request body.
 *   - Verifies SHA exists on staging.
 *   - Verifies main can fast-forward to that SHA — refuses if NOT a strict
 *     ancestor relationship (would be a non-FF / divergent merge). Heath has
 *     to resolve those manually.
 *   - Uses the GitHub Git Refs API to update refs/heads/main directly.
 *     GitHub's update-ref endpoint defaults to `force=false`, which is exactly
 *     the fast-forward-only guarantee we want.
 *
 * Body:
 *   { sha: "<full-or-short-SHA>" }
 *
 * Returns:
 *   { ok: true, mergedSha, mainNewSha }
 *   or
 *   { error: "...", code: "NOT_FAST_FORWARD" | "SHA_NOT_ON_STAGING" | ... }
 *
 * Updated: 2026-06-17 — initial build (Atlas).
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = 'heathshepard/MeetDossie';

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
  const sha = String(body.sha || '').trim();
  if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) {
    return res.status(400).json({ error: 'sha required (7-40 hex)', code: 'BAD_SHA' });
  }

  try {
    // 1. Resolve to full SHA via the commits API. Confirms the commit exists.
    const commitLookup = await githubFetch(`/repos/${GITHUB_REPO}/commits/${sha}`);
    if (!commitLookup.ok) {
      return res.status(404).json({
        error: `commit ${sha} not found`,
        code: 'SHA_NOT_FOUND',
        detail: commitLookup.text.slice(0, 200),
      });
    }
    const fullSha = commitLookup.json.sha;

    // 2. Confirm the commit is actually on staging. We do this by walking the
    //    staging history (newest first) and looking for the sha. Cap at 250
    //    commits — beyond that, Heath should merge manually.
    let foundOnStaging = false;
    let page = 1;
    let pagesChecked = 0;
    while (page <= 5 && !foundOnStaging) {
      const list = await githubFetch(`/repos/${GITHUB_REPO}/commits?sha=staging&per_page=50&page=${page}`);
      if (!list.ok) break;
      const arr = list.json || [];
      if (arr.length === 0) break;
      if (arr.some(c => c.sha === fullSha)) { foundOnStaging = true; break; }
      page += 1;
      pagesChecked += 1;
    }
    if (!foundOnStaging) {
      return res.status(400).json({
        error: `commit ${fullSha.slice(0, 7)} not found on staging (checked last ${pagesChecked * 50} commits)`,
        code: 'SHA_NOT_ON_STAGING',
      });
    }

    // 3. Verify fast-forward is possible: compare base=main vs head=fullSha.
    //    If status is "ahead" or "identical", FF is safe. Anything else
    //    (diverged, behind) means main has commits not in this SHA — refuse.
    const compare = await githubFetch(`/repos/${GITHUB_REPO}/compare/main...${fullSha}`);
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
    if (status !== 'ahead') {
      return res.status(409).json({
        error: `cannot fast-forward main to ${fullSha.slice(0, 7)} — relationship is "${status}". main has ${compare.json.behind_by || 0} commits not in target. Resolve manually.`,
        code: 'NOT_FAST_FORWARD',
        relationship: status,
      });
    }

    // 4. Fast-forward update of refs/heads/main. GitHub's PATCH ref endpoint
    //    requires force=false for pure FF; the API will reject non-FF when
    //    force=false. That's our hard guarantee.
    const update = await githubFetch(`/repos/${GITHUB_REPO}/git/refs/heads/main`, {
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

    // 5. Record in agent_activity for the "Done Today" feed.
    try {
      await supabase
        .from('agent_activity')
        .insert({
          agent_name: 'system',
          task_summary: `Merged ${fullSha.slice(0, 7)} to main: ${(commitLookup.json.commit?.message || '').split('\n')[0].slice(0, 200)}`,
          status: 'done',
          metadata: { kind: 'merge_to_main', sha: fullSha, triggered_by: user.email },
          completed_at: new Date().toISOString(),
        });
    } catch {}

    return res.status(200).json({
      ok: true,
      mergedSha: fullSha,
      shortSha: fullSha.slice(0, 7),
      mainNewSha: update.json?.object?.sha || fullSha,
      ahead_before: compare.json.ahead_by,
      message: (commitLookup.json.commit?.message || '').split('\n')[0],
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
