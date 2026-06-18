const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-staging-watcher.js
//
// SV-ENG-STAGING-WATCHER (Ridge, 2026-06-14)
//
// PURPOSE: Kill the Cole-as-bottleneck pattern. Every Carter staging push
// today waits for Cole to manually spawn Quinn for QA — that adds 5-15 min
// of latency per ship. This cron polls GitHub origin/staging every 2 min,
// detects new commits, and auto-fires:
//
//   1. Quinn dispatcher (agent_requests row → cron-process-agent-requests
//      picks it up next tick → Sonnet Quinn responds with test plan + verdict).
//   2. cron-dossie-qa-loop (the Playwright-driven scenario suite, against
//      staging URL — already runs hourly; we fire it again on-demand).
//
// UPDATED 2026-06-18: Telegram ping to Heath REMOVED per
// feedback_atlas_apv_is_merge_gate.md. Atlas APV is now the merge gate that
// surfaces to Heath (with embedded evidence). This watcher runs silently —
// Quinn + QA loop telemetry only. The would-have-notified payload is logged
// for audit, but Heath no longer gets the "Reply 'merge it'" prompt from
// this cron.
//
// Cole's role on Carter ships: relay-only — wait for Heath's "merge it" and
// dispatch Carter to merge. Cole no longer in the QA critical path.
//
// Safety / non-goals:
//   - This cron does NOT auto-merge. Only Heath says "merge it" (per
//     feedback_carter_must_wait_for_quinn_and_heath.md).
//   - This cron does NOT auto-fix failures. Quinn flags, Carter fixes.
//   - This cron does NOT replace the session-based Quinn that Cole sometimes
//     spawns via the Task tool for deep test runs. It's a *velocity* layer
//     on top of existing review gates.
//
// Detection rules:
//   - Polls GitHub Compare API: compare last_seen_sha → staging HEAD.
//   - First poll (last_seen_sha NULL): bootstrap to current HEAD, no dispatch.
//   - On NEW commits: pick the newest, treat that as the ship to QA. Older
//     commits between are recorded in metadata for the audit row.
//   - Carter ship vs Engineering brief: we fire on ALL new commits because
//     staging deploys regardless of who authored them. Quinn's verdict will
//     tell Heath whether the change is risky.
//
// Idempotency:
//   - staging_push_events has a UNIQUE constraint on commit_sha. Duplicate
//     dispatches are prevented by the DB upsert + the last_seen_sha guard.
//
// Fail-soft:
//   - If staging_watch_state table missing: log warning, no-op, telemetry='warn'.
//   - If GitHub returns 5xx / rate-limited: telemetry='error', retry next tick.
//   - If Quinn dispatch fails: telemetry='partial', Telegram still fires with
//     a note that Quinn dispatch failed.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json `*/2 * * * *` (every 2 min, 24/7).

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
const SELF_BASE_URL             = process.env.SELF_BASE_URL || 'https://meetdossie.com';
const GITHUB_TOKEN              = process.env.GITHUB_TOKEN; // optional — higher rate limit

const GITHUB_REPO     = 'heathshepard/MeetDossie';
const STAGING_BRANCH  = 'staging';
const POLL_NAME       = 'cron-staging-watcher';
const MAX_COMMITS_PER_TICK = 10;

// Staging URL — the Carter-published deploy. Quinn tests run against this.
// Note: Vercel mints a fresh URL per push; the alias below is the stable
// branch-deploy URL Vercel auto-aliases for git-push deploys.
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

async function getStagingHead() {
  // GET /repos/{owner}/{repo}/branches/{branch}
  const { ok, status, data } = await ghFetch(`/repos/${GITHUB_REPO}/branches/${STAGING_BRANCH}`);
  if (!ok || !data || !data.commit) {
    return { ok: false, status, error: `github_branch_fetch_${status}` };
  }
  const c = data.commit;
  return {
    ok: true,
    sha: c.sha,
    message: (c.commit && c.commit.message) ? c.commit.message.split('\n')[0] : null,
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    committed_at: (c.commit && c.commit.committer && c.commit.committer.date) || null,
  };
}

async function getCommitsBetween(baseSha, headSha) {
  // GET /repos/{owner}/{repo}/compare/{base}...{head}
  if (!baseSha || baseSha === headSha) return { ok: true, commits: [] };
  const { ok, status, data } = await ghFetch(
    `/repos/${GITHUB_REPO}/compare/${baseSha}...${headSha}`,
  );
  if (!ok || !data || !Array.isArray(data.commits)) {
    return { ok: false, status, error: `github_compare_${status}` };
  }
  // GitHub returns oldest→newest. Cap so a long absence doesn't blast Heath.
  const commits = data.commits.slice(-MAX_COMMITS_PER_TICK).map((c) => ({
    sha: c.sha,
    message: (c.commit && c.commit.message) ? c.commit.message.split('\n')[0] : null,
    author: (c.commit && c.commit.author && c.commit.author.name) || (c.author && c.author.login) || null,
    committed_at: (c.commit && c.commit.committer && c.commit.committer.date) || null,
  }));
  return { ok: true, commits };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return { ok: false, error: 'no_telegram_env' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, status: res.status, error: 'telegram_send_failed' };
    return { ok: true, message_id: j && j.result && j.result.message_id };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

// ─── Quinn auto-dispatch via agent_requests ───────────────────────────────────

function buildQuinnRequestText(commit, stagingUrl) {
  const msg = commit.message || '(no commit message)';
  const sha = commit.sha.slice(0, 7);
  return [
    `Carter just pushed to staging — please QA before Heath merges.`,
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

async function dispatchQuinn(commit) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: 'no_supabase_env' };
  }
  const requestText = buildQuinnRequestText(commit, STAGING_URL);
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

// ─── State helpers ────────────────────────────────────────────────────────────

async function readState() {
  const res = await sb('/rest/v1/staging_watch_state?select=*&limit=1');
  if (!res.ok) {
    return { ok: false, status: res.status, error: res.error || `read_state_${res.status}` };
  }
  if (!Array.isArray(res.data) || res.data.length === 0) {
    // Bootstrap row missing — try to insert one (migration should have done this).
    const ins = await sb('/rest/v1/staging_watch_state', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ last_seen_sha: null }),
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

async function recordPushEvent(commit, outcome) {
  // Idempotent insert: UNIQUE index on commit_sha makes a duplicate land as 409.
  // We swallow 409 (already recorded) and treat as success.
  const res = await sb('/rest/v1/staging_push_events', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
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

  // 1. Read state (fail-soft if migration not applied)
  const stateRes = await readState();
  if (!stateRes.ok) {
    // Most likely cause: migration 20260614_staging_watcher.sql not applied yet.
    console.warn(`[${POLL_NAME}] state read failed:`, stateRes.error);
    return res.status(200).json({
      ok: true,
      noop: true,
      reason: 'state_table_unavailable',
      detail: stateRes.error,
    });
  }
  const state = stateRes.state;

  // 2. Bump poll counter (best-effort, don't block on this)
  updateState(state, {
    last_polled_at: new Date().toISOString(),
    poll_count: (Number(state.poll_count) || 0) + 1,
  }).catch(() => {});

  // 3. Fetch staging HEAD
  const head = await getStagingHead();
  if (!head.ok) {
    return res.status(200).json({
      ok: false,
      reason: 'github_unreachable',
      detail: head.error,
    });
  }

  // 4. Bootstrap: first run ever. Record current HEAD as seen, do not dispatch.
  if (!state.last_seen_sha) {
    await updateState(state, {
      last_seen_sha: head.sha,
      last_seen_commit_message: head.message,
      last_seen_author: head.author,
      last_seen_committed_at: head.committed_at,
    });
    return res.status(200).json({
      ok: true,
      bootstrap: true,
      head_sha: head.sha,
    });
  }

  // 5. No change? quick exit.
  if (head.sha === state.last_seen_sha) {
    return res.status(200).json({
      ok: true,
      no_change: true,
      head_sha: head.sha,
    });
  }

  // 6. New commits! Compare last_seen → HEAD.
  const between = await getCommitsBetween(state.last_seen_sha, head.sha);
  if (!between.ok) {
    // Couldn't compare (rebase / force-push possible). Treat HEAD as the
    // single new commit and proceed — better to over-notify than miss.
    console.warn(`[${POLL_NAME}] compare failed (likely force-push); falling back to HEAD only:`, between.error);
  }
  const newCommits = (between.ok && between.commits.length > 0)
    ? between.commits
    : [{ sha: head.sha, message: head.message, author: head.author, committed_at: head.committed_at }];

  // The newest commit is the one we QA. Older ones are recorded in metadata.
  const targetCommit = newCommits[newCommits.length - 1];
  const olderShas = newCommits.slice(0, -1).map((c) => c.sha);

  // 7. Auto-dispatch Quinn
  const quinnResult = await dispatchQuinn(targetCommit);

  // 8. Fire the QA loop (Playwright suite) against staging
  const qaResult = await fireQaLoop();

  // 9. Telegram ping to Heath — REMOVED 2026-06-18 per feedback_atlas_apv_is_merge_gate.md
  //
  // Atlas APV is now the merge gate that surfaces to Heath (with embedded evidence),
  // NOT this watcher. This cron continues to run silently for Quinn auto-dispatch +
  // QA loop fire telemetry, but no longer pings Heath. The "would-have-notified"
  // payload is logged for audit only.
  const shortSha = targetCommit.sha.slice(0, 7);
  const quinnNote = quinnResult.ok
    ? `Quinn auto-dispatched (req ${String(quinnResult.request_id || '').slice(0, 8)})`
    : `Quinn dispatch FAILED (${quinnResult.error})`;
  const qaNote = qaResult.ok ? 'QA loop fired' : `QA loop fire failed (${qaResult.error})`;

  console.log(`[${POLL_NAME}] would-have-notified (ping suppressed): sha=${shortSha} author=${targetCommit.author || 'unknown'} | ${quinnNote} | ${qaNote}`);

  const tgResult = { ok: false, error: 'ping_suppressed_by_apv_gate', message_id: null };

  // 10. Record event + advance state
  const outcome = {
    quinn_dispatched: quinnResult.ok,
    quinn_request_id: quinnResult.request_id || null,
    qa_loop_fired: qaResult.ok,
    qa_loop_status: qaResult.ok ? 'fired' : (qaResult.error || 'unknown'),
    telegram_sent: tgResult.ok,
    telegram_message_id: tgResult.message_id || null,
    metadata: {
      staging_url: STAGING_URL,
      older_shas: olderShas,
      prior_sha: state.last_seen_sha,
    },
  };
  await recordPushEvent(targetCommit, outcome);

  await updateState(state, {
    last_seen_sha: targetCommit.sha,
    last_seen_commit_message: targetCommit.message,
    last_seen_author: targetCommit.author,
    last_seen_committed_at: targetCommit.committed_at,
    last_quinn_dispatch_at: quinnResult.ok ? new Date().toISOString() : state.last_quinn_dispatch_at,
    last_qa_loop_fire_at: qaResult.ok ? new Date().toISOString() : state.last_qa_loop_fire_at,
  });

  return res.status(200).json({
    ok: true,
    dispatched: true,
    sha: targetCommit.sha,
    quinn_ok: quinnResult.ok,
    qa_loop_ok: qaResult.ok,
    telegram_ok: tgResult.ok,
    older_commit_count: olderShas.length,
  });
});
