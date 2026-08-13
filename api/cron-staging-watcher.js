const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { isPaused } = require('./_lib/paused-crons.js');
const { TRACKED_REPOS } = require('./_lib/tracked-repos.js');

'use strict';

// api/cron-staging-watcher.js
//
// SV-ENG-STAGING-WATCHER (Ridge, 2026-06-14)
// GENERALIZED TO MULTI-REPO 2026-08-13 (Carter, SV-ENG-MERGE-QUEUE-MULTI-REPO)
// per Heath: "I need to see all merges... across ALL my projects, not just
// MeetDossie ... it's waiting on me."
//
// PURPOSE: Kill the Cole-as-bottleneck pattern. Every Carter staging push
// today waits for Cole to manually spawn Quinn for QA — that adds 5-15 min
// of latency per ship. This cron polls GitHub for every repo in
// api/_lib/tracked-repos.js, detects new commits, and:
//
//   1. For repos with a staging tier (MeetDossie, DossieApp): diffs
//      last_seen_sha -> current staging HEAD, queues every new commit into
//      merge_queue.
//   2. For repos with NO staging tier (Rust): scans every non-main branch
//      directly and queues each branch's HEAD commit if it's not already an
//      ancestor of main. No state table needed — addToMergeQueue is
//      idempotent per (repo, commit_sha), so re-scanning every tick is safe.
//   3. ONLY for repos where auto_dispatch_quinn=true (MeetDossie today —
//      the one repo Quinn's Playwright run actually exercises against a
//      live staging URL): auto-fires Quinn dispatch + the Dossie QA loop.
//
// Safety / non-goals:
//   - This cron does NOT auto-merge. Only Heath says "merge it".
//   - This cron does NOT auto-fix failures. Quinn flags, Carter fixes.
//   - Telegram ping to Heath REMOVED 2026-06-18 per
//     feedback_atlas_apv_is_merge_gate.md — Atlas APV is the surfaced merge
//     gate now, not this watcher. Runs silently; telemetry only.
//
// Detection rules (staging-tier repos):
//   - Polls GitHub Compare API: compare last_seen_sha → staging HEAD.
//   - First poll ever for a repo (last_seen_sha NULL): bootstrap AND queue
//     the existing staging-ahead-of-main backlog (main...staging compare) so
//     Heath sees what's ALREADY waiting, not just future commits — added
//     2026-08-13 because DossieApp had 2 real commits sitting on staging
//     with zero visibility before this repo was tracked. Backfilled commits
//     are queued but NOT sent to Quinn/QA-loop (that's for fresh pushes,
//     not walking old history).
//   - On NEW commits thereafter: pick the newest, treat that as the ship to
//     QA (if auto_dispatch_quinn). Older commits in the same poll window
//     still each get their own merge_queue row.
//
// Idempotency:
//   - merge_queue.commit_sha is UNIQUE. staging_push_events.commit_sha is
//     UNIQUE. Duplicate dispatches are prevented by upsert/insert-then-skip.
//
// Fail-soft per repo: one repo's GitHub error doesn't block the others.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json (every 5 min).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
const SELF_BASE_URL             = process.env.SELF_BASE_URL || 'https://meetdossie.com';
const GITHUB_TOKEN              = process.env.GITHUB_TOKEN; // optional — higher rate limit

const POLL_NAME       = 'cron-staging-watcher';
const MAX_COMMITS_PER_TICK = 10;
const MAX_BACKLOG_BACKFILL = 30; // cap on first-ever-poll historical queue insert

// Staging URL — the Carter-published deploy. Quinn tests run against this.
// Only meaningful for repos with auto_dispatch_quinn=true (MeetDossie).
const STAGING_URL = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function sb(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, data: null, error: 'missing_supabase_env' };
  }
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: String(err && err.message || err) };
  }
}

// ─── GitHub API ───────────────────────────────────────────────────────────────

async function ghFetch(path) {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'shepard-ventures-staging-watcher',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  const res = await fetch(`https://api.github.com${path}`, { headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// PLAIN-ENGLISH MERGE QUEUE TITLES (Carter, 2026-08-10 — Heath dashboard
// teardown: "shows cryptic entries like 'disable cold email cron'... it
// needs to be written in plain English"). Raw commit subjects use
// conventional-commit prefixes (fix(scope):, feat(scope):) that mean
// nothing to Heath. This strips that engineering prefix for the title, and
// carries the commit body (the paragraph most agents already write
// explaining WHY) through as `description` so the merge queue card can show
// real context instead of just a one-line jargon subject.
function humanizeCommitTitle(line) {
  if (!line) return line;
  // "fix(scan-contract): sharpen EM receipt..." -> "Sharpen EM receipt..."
  const stripped = line.replace(/^\s*[a-z]+(\([^)]*\))?!?:\s*/i, '');
  const text = stripped || line;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function commitBodyAsDescription(rawMessage) {
  if (!rawMessage) return '';
  const lines = rawMessage.split('\n').slice(1); // drop the subject line
  const kept = [];
  for (const l of lines) {
    // Drop trailer lines (Co-Authored-By, Claude-Session, etc.) — internal
    // attribution, not something Heath needs to read to decide on a merge.
    if (/^(Co-Authored-By|Claude-Session):/i.test(l.trim())) continue;
    kept.push(l);
  }
  return kept.join('\n').trim().slice(0, 1200);
}

function mapCommit(c) {
  const rawMessage = (c.commit && c.commit.message) || null;
  return {
    sha: c.sha,
    message: rawMessage ? rawMessage.split('\n')[0] : null,
    raw_message: rawMessage,
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    committed_at: (c.commit && c.commit.committer && c.commit.committer.date) || null,
  };
}

async function getBranchHead(repo, branch) {
  const { ok, status, data } = await ghFetch(`/repos/${repo}/branches/${encodeURIComponent(branch)}`);
  if (!ok || !data || !data.commit) {
    return { ok: false, status, error: `github_branch_fetch_${status}` };
  }
  return { ok: true, ...mapCommit(data.commit) };
}

async function getCommitsBetween(repo, baseSha, headSha) {
  // GET /repos/{owner}/{repo}/compare/{base}...{head}
  if (!baseSha || baseSha === headSha) return { ok: true, commits: [] };
  const { ok, status, data } = await ghFetch(`/repos/${repo}/compare/${baseSha}...${headSha}`);
  if (!ok || !data || !Array.isArray(data.commits)) {
    return { ok: false, status, error: `github_compare_${status}` };
  }
  // GitHub returns oldest→newest. Cap so a long absence doesn't blast Heath.
  const commits = data.commits.slice(-MAX_COMMITS_PER_TICK).map(mapCommit);
  return { ok: true, commits };
}

// Full backlog (uncapped by the per-tick cap, capped separately for
// first-ever-poll bootstrap) between two refs — used to seed merge_queue
// with everything already sitting on staging the first time a repo is
// tracked.
async function getBacklogCommits(repo, baseRef, headRef) {
  const { ok, status, data } = await ghFetch(`/repos/${repo}/compare/${baseRef}...${headRef}`);
  if (!ok || !data || !Array.isArray(data.commits)) {
    return { ok: false, status, error: `github_compare_${status}` };
  }
  const commits = data.commits.slice(-MAX_BACKLOG_BACKFILL).map(mapCommit);
  return { ok: true, commits, status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by };
}

async function listBranches(repo) {
  const { ok, status, data } = await ghFetch(`/repos/${repo}/branches?per_page=100`);
  if (!ok || !Array.isArray(data)) return { ok: false, status, error: `github_branches_${status}` };
  return { ok: true, branches: data.map((b) => b.name) };
}

async function compareAheadBy(repo, base, head) {
  const { ok, status, data } = await ghFetch(`/repos/${repo}/compare/${base}...${head}`);
  if (!ok || !data) return { ok: false, status, error: `github_compare_${status}` };
  return { ok: true, status: data.status, ahead_by: data.ahead_by, behind_by: data.behind_by };
}

// ─── Add to merge queue ───────────────────────────────────────────────────────

async function addToMergeQueue(repo, commit, branchFrom) {
  if (!CRON_SECRET) return { ok: false, error: 'no_cron_secret' };
  try {
    const res = await fetch(`${SELF_BASE_URL}/api/merge-queue-add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({
        sha: commit.sha,
        repo,
        branch_from: branchFrom || 'staging',
        title: humanizeCommitTitle(commit.message) || `Merge ${commit.sha.slice(0, 7)}`,
        description: commitBodyAsDescription(commit.raw_message),
        commit_author: commit.author,
        committed_at: commit.committed_at,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error || 'merge_queue_add_failed' };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ─── Quinn auto-dispatch via agent_requests ───────────────────────────────────

function buildQuinnRequestText(commit, stagingUrl, repoLabel) {
  const msg = commit.message || '(no commit message)';
  const sha = commit.sha.slice(0, 7);
  return [
    `Carter just pushed to ${repoLabel} staging — please QA before Heath merges.`,
    ``,
    `Commit: ${sha} — ${msg}`,
    `Author: ${commit.author || 'unknown'}`,
    `Staging URL: ${stagingUrl}`,
    ``,
    `Return a 4-bullet verdict in this exact shape:`,
    `1. What changed (1 line based on the commit message).`,
    `2. Top 2-3 risks to test on this push.`,
    `3. PASS / WATCH / FAIL — your read on whether Heath should merge now.`,
    `4. If WATCH or FAIL: the specific check Heath should make before merging.`,
    ``,
    `If you'd need a Playwright run to be confident, say so plainly — Heath will spawn full-Quinn separately.`,
  ].join('\n');
}

async function dispatchQuinn(commit, repoLabel) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: 'no_supabase_env' };
  }
  const requestText = buildQuinnRequestText(commit, STAGING_URL, repoLabel);
  const res = await sb('/rest/v1/agent_requests', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      from_agent: 'ridge',
      to_agent: 'quinn',
      request_text: requestText,
      source_chat_id: String(TELEGRAM_CHAT_ID || ''),
      source_message_id: null,
      status: 'pending',
    }),
  });
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) {
    return { ok: false, status: res.status, error: 'agent_requests_insert_failed' };
  }
  const row = res.data[0];
  const requestId = row.request_id || row.id;

  // Fire-and-forget kick to /api/agent-dispatch so cron-process-agent-requests
  // doesn't have to wait for its next minute boundary. Best-effort only.
  if (CRON_SECRET && requestId) {
    fetch(`${SELF_BASE_URL}/api/agent-dispatch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${CRON_SECRET}`,
      },
      body: JSON.stringify({ request_id: requestId }),
    }).catch(() => {});
  }

  return { ok: true, request_id: requestId };
}

// ─── Fire cron-dossie-qa-loop ─────────────────────────────────────────────────

async function fireQaLoop() {
  if (!CRON_SECRET) return { ok: false, error: 'no_cron_secret' };
  // 2026-07-04 (Atlas) — PAUSE-AWARE GUARD.
  // cron-dossie-qa-loop is on the cost-freeze schedule '0 0 1 1 *'. This
  // helper used to fire it on every staging push, which re-ran the loop's
  // Anthropic calls despite the freeze. Skip if paused.
  if (isPaused('/api/cron-dossie-qa-loop')) {
    console.log('[staging-watcher] skipped qa-loop fire — target is paused (cost freeze)');
    return { ok: false, skipped: true, skipped_paused: true, reason: 'cost_freeze' };
  }
  try {
    // Best-effort — we don't await the Playwright run. The QA loop itself has
    // a 90s maxDuration and its own guardrails (cost cap, demo collision).
    // It will Telegram-ping Heath separately on findings.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 5000);
    const res = await fetch(`${SELF_BASE_URL}/api/cron-dossie-qa-loop`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: controller.signal,
    }).catch((err) => ({ ok: false, status: 0, error: String(err && err.message || err) }));
    clearTimeout(t);
    if (!res || !res.ok) {
      return { ok: false, status: res && res.status, error: 'qa_loop_fire_failed' };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    // Abort errors are fine — the QA loop is running in the background.
    if (err && err.name === 'AbortError') return { ok: true, status: 'background' };
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ─── State helpers (per-repo row in staging_watch_state) ──────────────────────

async function readState(repo) {
  const res = await sb(`/rest/v1/staging_watch_state?select=*&repo=eq.${encodeURIComponent(repo)}&limit=1`);
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `read_state_${res.status}` };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // Bootstrap row missing — try to insert one (migration should have done this).
    const ins = await sb('/rest/v1/staging_watch_state', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ repo, last_seen_sha: null }),
    });
    if (!ins.ok) return { ok: false, status: ins.status, error: 'bootstrap_failed' };
    return { ok: true, state: (ins.data && ins.data[0]) || {} };
  }
  return { ok: true, state: res.data[0] };
}

async function updateState(state, patch) {
  if (!state || !state.id) return { ok: false, error: 'no_state_id' };
  const body = { ...patch, updated_at: new Date().toISOString() };
  return sb(`/rest/v1/staging_watch_state?id=eq.${encodeURIComponent(state.id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

async function recordPushEvent(repo, commit, outcome) {
  // Idempotent insert: UNIQUE index on commit_sha makes a duplicate land as 409.
  // We swallow 409 (already recorded) and treat as success.
  const res = await sb('/rest/v1/staging_push_events', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      repo,
      commit_sha: commit.sha,
      commit_message: commit.message,
      commit_author: commit.author,
      committed_at: commit.committed_at,
      quinn_dispatched: outcome.quinn_dispatched || false,
      quinn_request_id: outcome.quinn_request_id || null,
      qa_loop_fired: outcome.qa_loop_fired || false,
      qa_loop_status: outcome.qa_loop_status || null,
      telegram_sent: outcome.telegram_sent || false,
      telegram_message_id: outcome.telegram_message_id || null,
      metadata: outcome.metadata || {},
    }),
  });
  if (res.status === 409) return { ok: true, duplicate: true };
  return { ok: res.ok, status: res.status, data: res.data };
}

// ─── Per-repo: staging-tier watcher (MeetDossie, DossieApp) ───────────────────

async function watchStagingRepo(repoCfg) {
  const { repo, label, staging_branch, main_branch, auto_dispatch_quinn } = repoCfg;

  const stateRes = await readState(repo);
  if (!stateRes.ok) {
    console.warn(`[${POLL_NAME}] ${repo} state read failed:`, stateRes.error);
    return { repo, ok: true, noop: true, reason: 'state_table_unavailable', detail: stateRes.error };
  }
  const state = stateRes.state;

  // Bump poll counter (best-effort, don't block on this)
  updateState(state, {
    last_polled_at: new Date().toISOString(),
    poll_count: (Number(state.poll_count) || 0) + 1,
  }).catch(() => {});

  const head = await getBranchHead(repo, staging_branch);
  if (!head.ok) {
    return { repo, ok: false, reason: 'github_unreachable', detail: head.error };
  }

  // First-ever poll for this repo: bootstrap AND queue the existing backlog
  // (main...staging) so Heath sees what's already waiting, not just future
  // commits. No Quinn/QA-loop dispatch for backfilled history.
  if (!state.last_seen_sha) {
    const backlog = await getBacklogCommits(repo, main_branch, staging_branch);
    let queued = 0;
    if (backlog.ok) {
      for (const c of backlog.commits) {
        const r = await addToMergeQueue(repo, c, staging_branch);
        if (r.ok) queued += 1;
      }
    }
    await updateState(state, {
      last_seen_sha: head.sha,
      last_seen_commit_message: head.message,
      last_seen_author: head.author,
      last_seen_committed_at: head.committed_at,
    });
    return {
      repo, ok: true, bootstrap: true, head_sha: head.sha,
      backlog_queued: queued, backlog_ok: backlog.ok, backlog_error: backlog.error,
    };
  }

  // No change? quick exit.
  if (head.sha === state.last_seen_sha) {
    return { repo, ok: true, no_change: true, head_sha: head.sha };
  }

  // New commits! Compare last_seen → HEAD.
  const between = await getCommitsBetween(repo, state.last_seen_sha, head.sha);
  if (!between.ok) {
    console.warn(`[${POLL_NAME}] ${repo} compare failed (likely force-push); falling back to HEAD only:`, between.error);
  }
  const newCommits = (between.ok && between.commits.length > 0)
    ? between.commits
    : [{ sha: head.sha, message: head.message, author: head.author, committed_at: head.committed_at }];

  // The newest commit is the one we QA (if this repo has a working QA
  // harness). Older ones in the same poll window still each need their own
  // merge_queue row — otherwise a fast double-push silently drops the older
  // commit from the queue forever.
  const targetCommit = newCommits[newCommits.length - 1];
  const olderCommits = newCommits.slice(0, -1);
  const olderShas = olderCommits.map((c) => c.sha);

  for (const c of olderCommits) {
    await addToMergeQueue(repo, c, staging_branch);
  }
  const queueResult = await addToMergeQueue(repo, targetCommit, staging_branch);

  let quinnResult = { ok: false, skipped: true };
  let qaResult = { ok: false, skipped: true };
  if (auto_dispatch_quinn) {
    quinnResult = await dispatchQuinn(targetCommit, label);
    qaResult = await fireQaLoop();
  }

  const shortSha = targetCommit.sha.slice(0, 7);
  const quinnNote = !auto_dispatch_quinn
    ? 'Quinn dispatch skipped (no live preview for this repo)'
    : quinnResult.ok
      ? `Quinn auto-dispatched (req ${String(quinnResult.request_id || '').slice(0, 8)})`
      : `Quinn dispatch FAILED (${quinnResult.error})`;
  console.log(`[${POLL_NAME}] ${repo} sha=${shortSha} author=${targetCommit.author || 'unknown'} | ${quinnNote}`);

  const outcome = {
    merge_queue_added: queueResult.ok,
    merge_queue_id: queueResult.id || null,
    quinn_dispatched: quinnResult.ok || false,
    quinn_request_id: quinnResult.request_id || null,
    qa_loop_fired: qaResult.ok || false,
    qa_loop_status: qaResult.ok ? 'fired' : (qaResult.error || qaResult.skipped ? 'skipped' : 'unknown'),
    telegram_sent: false,
    telegram_message_id: null,
    metadata: {
      staging_url: auto_dispatch_quinn ? STAGING_URL : null,
      older_shas: olderShas,
      prior_sha: state.last_seen_sha,
    },
  };
  await recordPushEvent(repo, targetCommit, outcome);

  await updateState(state, {
    last_seen_sha: targetCommit.sha,
    last_seen_commit_message: targetCommit.message,
    last_seen_author: targetCommit.author,
    last_seen_committed_at: targetCommit.committed_at,
    last_quinn_dispatch_at: quinnResult.ok ? new Date().toISOString() : state.last_quinn_dispatch_at,
    last_qa_loop_fire_at: qaResult.ok ? new Date().toISOString() : state.last_qa_loop_fire_at,
  });

  return {
    repo, ok: true, dispatched: true, sha: targetCommit.sha,
    merge_queue_ok: queueResult.ok, quinn_ok: quinnResult.ok, qa_loop_ok: qaResult.ok,
    older_commit_count: olderShas.length,
  };
}

// ─── Per-repo: branch-scan watcher (Rust — no staging tier) ───────────────────
//
// DESIGN NOTE (2026-08-13, post-hoc Quinn QA): this queues any branch that's
// ahead_by>0 of main — deliberately, for VISIBILITY. It does NOT check
// whether the branch is a clean fast-forward candidate, and on purpose:
// that's a point-in-time check that goes stale the moment main moves again,
// so doing it here (write time) would just be wrong again later. Real
// mergeability (fast-forward vs diverged vs blocked) is computed live at
// READ time instead — see the merge_status/merge_action fields in
// api/merge-queue-list.js. A genuinely-diverged branch still needs to show
// up here (Heath needs to know it exists and needs attention); it just
// won't render an enabled plain MERGE button.

async function watchBranchScanRepo(repoCfg) {
  const { repo, main_branch } = repoCfg;

  const branchesRes = await listBranches(repo);
  if (!branchesRes.ok) {
    return { repo, ok: false, reason: 'github_branches_unreachable', detail: branchesRes.error };
  }
  const candidateBranches = branchesRes.branches.filter((b) => b !== main_branch);

  let queued = 0;
  let skippedNoNewCommits = 0;
  const errors = [];

  for (const branch of candidateBranches) {
    const cmp = await compareAheadBy(repo, main_branch, branch);
    if (!cmp.ok) { errors.push({ branch, error: cmp.error }); continue; }
    // Only branches with commits main doesn't have are merge candidates.
    if (!cmp.ahead_by || cmp.ahead_by === 0) { skippedNoNewCommits += 1; continue; }

    const head = await getBranchHead(repo, branch);
    if (!head.ok) { errors.push({ branch, error: head.error }); continue; }

    const r = await addToMergeQueue(repo, head, branch);
    if (r.ok) queued += 1;
    else errors.push({ branch, error: r.error });
  }

  return {
    repo, ok: true, mode: 'branch_scan',
    branches_scanned: candidateBranches.length,
    queued, skipped_no_new_commits: skippedNoNewCommits,
    errors: errors.slice(0, 10),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

module.exports = withTelemetry(POLL_NAME, async function handler(req, res) {
  const auth = req.headers.authorization || '';
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const isCronSecret = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isCronSecret) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const missing = [];
  if (!SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (missing.length) {
    return res.status(500).json({ ok: false, error: `missing_env:${missing.join(',')}` });
  }

  const results = [];
  for (const repoCfg of TRACKED_REPOS) {
    try {
      const r = repoCfg.staging_branch
        ? await watchStagingRepo(repoCfg)
        : await watchBranchScanRepo(repoCfg);
      results.push(r);
    } catch (err) {
      results.push({ repo: repoCfg.repo, ok: false, error: String(err && err.message || err) });
    }
  }

  const anyOk = results.some((r) => r.ok);
  return res.status(200).json({ ok: anyOk, repos: results });
});
