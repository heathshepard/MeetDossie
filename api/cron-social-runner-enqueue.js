'use strict';

// Vercel Serverless Function: /api/cron-social-runner-enqueue
//
// WHY: two local Playwright-driven FB pipelines went dark 2026-09-16/17
// when the Windows Task Scheduler task "Dossie TC Discovery Harvest"
// (scripts/run-tc-discovery-harvest.cmd) that used to invoke them stopped
// running -- every log file in that chain (scripts/comment-opp-poster.log,
// scripts/group5-post-queue.log, scripts/listing-group-post-queue.log, etc.)
// stops at 2026-09-16T16:30 and never resumes. Meanwhile agent_queue's own
// poller (scripts/agent-queue-poller.js, on Heath's always-on PC) is proven
// alive and draining fine (698 completed as of 2026-09-30, newest run
// minutes old). This cron is the missing trigger -- it enqueues a small,
// capped number of agent_queue rows asking an agent (sage) to run the
// EXISTING scripts. It invents NO new posting logic and duplicates NONE of
// fb-comment-opp-poster.js's own pacing/halt/cap enforcement
// (scripts/_lib/comment-hunt-halt.js, scripts/_lib/comment-caps.js) --
// those still run for real, locally, at the moment the enqueued agent
// actually executes the script. Following the established enqueue pattern
// in api/cron-content-pipeline-promote.js (load approved rows -> POST one
// agent_queue row per row -> record the link) rather than inventing a
// parallel mechanism.
//
// DELIBERATELY EXCLUDED: scripts/sage-engagement-queue-poster.js (the
// "liking/engagement" capability against engagement_queue). That script was
// DECOMMISSIONED 2026-08-18 per Heath's explicit directive -- see its own
// header. engagement_queue approvals are now a MANUAL copy-paste handoff
// via Telegram (api/cron-engagement-review.js sends the review card,
// api/telegram-webhook.js's engage_approve handler sends the permalink +
// reply text back for Heath to paste himself). Wiring an enqueue path that
// ran that script would silently re-introduce the automated posting Heath
// turned off. engagement_queue's stale 'approved' rows are a Heath-side
// manual backlog, not a mechanism gap -- not this cron's job to drain.
//
// SAFETY
//   1. OFF BY DEFAULT. Requires SOCIAL_RUNNER_ENQUEUE_ENABLED=true in
//      Vercel env. Any other value (including unset) -> responds
//      {enabled:false, skipped:true} and performs ZERO reads or writes.
//   2. STALENESS GATE. Only rows approved within SOCIAL_RUNNER_FRESH_HOURS
//      (default 48h) get a real posting trigger. Older rows are reported
//      back as `stale` and left alone -- a backlog that piled up while the
//      pipeline was dark needs a fresh Heath decision, not a silent
//      resurrection of an 11-40-day-old draft.
//   3. CAPPED. At most MAX_GROUP_POSTS_PER_RUN (1) group-post trigger and
//      MAX_COMMENT_TRIGGERS_PER_RUN (1) comment-opportunity trigger per
//      invocation -- rate discipline over volume; the FB profile behind
//      all of this was shadowbanned once already (June, automated bursts).
//      The underlying scripts each ALSO self-cap/self-space; this just
//      keeps duplicate trigger rows from piling up if this cron fires more
//      often than the poller drains.
//   4. IDEMPOTENT. Checks agent_queue for an existing pending/in_progress
//      row already tagged with the same (source_table, source_id) before
//      inserting a new one.
//   5. NOT REGISTERED ON ANY SCHEDULE by this change. Not added to
//      vercel.json (cron cap is already 20/20 -- new crons go to
//      cron-job.org per CLAUDE.md Stack context) and not registered on
//      cron-job.org either. Turning this on for real needs BOTH: the env
//      var above, AND a cron-job.org job pointed at this path with a
//      Bearer CRON_SECRET header. Neither is done here on purpose --
//      Heath was asleep and has not reviewed the current backlog.
//
// Auth: Authorization: Bearer ${CRON_SECRET} (matches every sibling cron).
//
// Owner: Atlas, 2026-09-30

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ENABLED = String(process.env.SOCIAL_RUNNER_ENQUEUE_ENABLED || '').toLowerCase() === 'true';
const FRESH_HOURS = Math.max(1, parseFloat(process.env.SOCIAL_RUNNER_FRESH_HOURS || '48'));
const MAX_GROUP_POSTS_PER_RUN = 1;
const MAX_COMMENT_TRIGGERS_PER_RUN = 1;

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function isFresh(iso) {
  if (!iso) return false;
  const ageMs = Date.now() - new Date(iso).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= FRESH_HOURS * 3600 * 1000;
}

async function alreadyQueued(sourceTable, sourceId) {
  const r = await sb(
    `agent_queue?metadata->>source_table=eq.${encodeURIComponent(sourceTable)}` +
      `&metadata->>source_id=eq.${encodeURIComponent(sourceId)}` +
      `&status=in.(pending,in_progress)&select=id&limit=1`,
  );
  return r.ok && Array.isArray(r.data) && r.data.length > 0;
}

async function enqueueGroupPosts() {
  const r = await sb(
    'group_posts?status=eq.approved&posted_at=is.null&order=created_at.desc&limit=10' +
      '&select=id,group_name,template_id,pipeline,created_at',
  );
  if (!r.ok) return { queued: [], stale: [], error: 'load_failed', http_status: r.status };
  const rows = Array.isArray(r.data) ? r.data : [];
  const fresh = rows.filter((row) => isFresh(row.created_at));
  const stale = rows.filter((row) => !isFresh(row.created_at)).map((row) => row.id);

  const queued = [];
  for (const row of fresh.slice(0, MAX_GROUP_POSTS_PER_RUN)) {
    if (await alreadyQueued('group_posts', row.id)) continue;
    const brief = [
      '# Social runner -- post approved FB group content',
      '',
      `Heath approved group_posts row ${row.id} ("${row.group_name}") within the last ${FRESH_HOURS}h.`,
      '',
      'Run from the MeetDossie repo root:',
      '```',
      `node scripts/fb-group-poster.js --post-id ${row.id}`,
      '```',
      '',
      "This script drives the DossieBot-Sage Chrome profile, posts, and updates group_posts.status / group_registry itself -- do not edit those rows directly.",
      'If the DossieBot-Sage Chrome profile is already held by another agent/process, do NOT force-close it -- report BLOCKED and stop (see feedback_isolate-agents-in-worktrees.md).',
      '',
      "RESULT_SUMMARY: report the script's exit code and final status line verbatim.",
    ].join('\n');
    const ins = await sb('agent_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_name: 'sage',
        task_subject: `Social runner: post FB group content (${row.group_name})`.slice(0, 280),
        task_brief: brief,
        priority: 3,
        venture: 'general',
        status: 'pending',
        metadata: {
          source: 'cron-social-runner-enqueue',
          source_table: 'group_posts',
          source_id: row.id,
          autonomous: true,
          idempotency_key: `group_posts:${row.id}`,
          enqueued_at: new Date().toISOString(),
        },
      }),
    });
    if (ins.ok && Array.isArray(ins.data) && ins.data[0]) {
      queued.push({ id: row.id, agent_queue_id: ins.data[0].id });
    }
  }
  return { queued, stale, total_approved_unposted: rows.length };
}

async function enqueueCommentOpportunities() {
  const r = await sb(
    'comment_opportunities?status=eq.approved&posted_at=is.null&order=approved_at.desc&limit=10' +
      '&select=id,group_name,approved_at,post_url',
  );
  if (!r.ok) return { queued: [], stale: [], error: 'load_failed', http_status: r.status };
  const rows = Array.isArray(r.data) ? r.data : [];
  const fresh = rows.filter((row) => isFresh(row.approved_at));
  const stale = rows.filter((row) => !isFresh(row.approved_at)).map((row) => row.id);

  const queued = [];
  for (const row of fresh.slice(0, MAX_COMMENT_TRIGGERS_PER_RUN)) {
    if (await alreadyQueued('comment_opportunities', row.id)) continue;
    const brief = [
      '# Social runner -- run the comment-opportunity poster',
      '',
      `comment_opportunities row ${row.id} ("${row.group_name}") is Heath-approved and fresh (approved within the last ${FRESH_HOURS}h).`,
      '',
      'Run from the MeetDossie repo root, with NO other flags:',
      '```',
      'node scripts/fb-comment-opp-poster.js',
      '```',
      '',
      'This script enforces its OWN caps (facebook_auto budget, 8/day default), 45-60min varied spacing, and the shared circuit breaker (scripts/_lib/comment-hunt-halt.js) -- it posts AT MOST ONE approved row per run and no-ops safely (exit ~2s) if paced out, halted, or nothing is due. That is expected and correct, not a failure.',
      'If the DossieBot-Sage Chrome profile is already held by another agent/process, do NOT force-close it -- report BLOCKED and stop.',
      '',
      "RESULT_SUMMARY: report the script's exit code and final status line verbatim.",
    ].join('\n');
    const ins = await sb('agent_queue', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        agent_name: 'sage',
        task_subject: `Social runner: run comment-opportunity poster (${row.group_name})`.slice(0, 280),
        task_brief: brief,
        priority: 3,
        venture: 'general',
        status: 'pending',
        metadata: {
          source: 'cron-social-runner-enqueue',
          source_table: 'comment_opportunities',
          source_id: row.id,
          autonomous: true,
          idempotency_key: `comment_opportunities:${row.id}`,
          enqueued_at: new Date().toISOString(),
        },
      }),
    });
    if (ins.ok && Array.isArray(ins.data) && ins.data[0]) {
      queued.push({ id: row.id, agent_queue_id: ins.data[0].id });
    }
  }
  return { queued, stale, total_approved_unposted: rows.length };
}

module.exports = withTelemetry('cron-social-runner-enqueue', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!ENABLED) {
    return res.status(200).json({ ok: true, enabled: false, skipped: true });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const group_posts = await enqueueGroupPosts();
  const comment_opportunities = await enqueueCommentOpportunities();

  return res.status(200).json({
    ok: true,
    enabled: true,
    fresh_hours: FRESH_HOURS,
    group_posts,
    comment_opportunities,
  });
});
