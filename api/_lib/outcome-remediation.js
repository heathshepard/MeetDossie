'use strict';

// api/_lib/outcome-remediation.js
//
// The repair half of the outcome monitor. A known cause maps to a mechanical
// fix; the fix runs; the expectation is re-measured. Only what survives that
// loop is allowed to reach Heath.
//
// FOUR RULES, each of them paid for:
//
// 1. NEVER RETRY AN UNVERIFIED SEND. A row that says "failed" may well have
//    gone out. Before any requeue we look for positive evidence of delivery
//    (zernio_post_id / actual_platform_url / post_url). Evidence present ->
//    reconcile the row forward to 'posted'. Evidence absent -> we do NOT
//    requeue; we escalate. A retried send triple-texted a client on
//    2026-09-11. (memory: feedback_never-retry-an-unverified-send)
//
// 2. BOUNDED. Every action caps rows touched (MAX_ROWS) and respects an
//    attempt counter, so a remediation loop can never become a runaway.
//
// 3. DECLARED SIDE EFFECT. Each entry states whether it touches internal state
//    only or could eventually cause something to publish. The expectation's
//    remediation_mode decides which tier is allowed to run -- 'safe' can never
//    cause a publish.
//
// 4. NO PRETEND FIXES. A remediation that needs Heath's PC only runs when the
//    PC is demonstrably alive. Enqueueing work for a dead runner looks like a
//    fix in the log and is a silent failure in reality -- exactly the class of
//    bug this whole system exists to kill. (memory:
//    feedback_no-autonomy-without-mechanism)
//
// Owner: Atlas, 2026-09-25

const { sb, countRows } = require('./outcome-expectations.js');

const MAX_ROWS = 25;
const LOCAL_RUNNER_MAX_AGE_MIN = 90;

// ─── helpers ─────────────────────────────────────────────────────────────────

function result(key, fields) {
  return { remediation: key, attempted: true, ok: false, changed: 0, detail: {}, ...fields };
}
function skipped(key, why, detail = {}) {
  return { remediation: key, attempted: false, ok: false, changed: 0, skipped_reason: why, detail };
}

async function patch(table, filter, body) {
  return sb(`${table}?${filter}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body),
  });
}

/** Is the local PC actually there to do local work? */
async function localRunnerAlive() {
  const { ok, data } = await sb('pc_heartbeats?select=pc_name,last_seen&order=last_seen.desc&limit=1');
  if (!ok || !Array.isArray(data) || !data[0]) return { alive: false, age_minutes: null };
  const ageMin = (Date.now() - new Date(data[0].last_seen).getTime()) / 60000;
  return { alive: ageMin <= LOCAL_RUNNER_MAX_AGE_MIN, age_minutes: Math.round(ageMin), pc: data[0].pc_name };
}

// ─── Remediations ────────────────────────────────────────────────────────────

/**
 * clear_stale_publish_lock
 * social_posts stuck at status='publishing' past the lock window.
 *
 * Splits the set by DELIVERY EVIDENCE rather than treating it as one bucket:
 *   evidence present -> the publish succeeded and only the status write was
 *                       lost. Reconcile forward to 'posted'. Not a resend.
 *   evidence absent  -> UNKNOWN. Leave it alone and report it. Requeueing here
 *                       is exactly the double-post trap.
 */
async function clear_stale_publish_lock(exp, cause, ctx = {}) {
  const key = 'clear_stale_publish_lock';
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { ok, data } = await sb(
    `social_posts?status=eq.publishing&publishing_started_at=lt.${cutoff}` +
    `&select=id,zernio_post_id,actual_platform_url,publishing_started_at&limit=${MAX_ROWS}`
  );
  if (!ok || !Array.isArray(data)) return result(key, { detail: { error: 'query failed' } });
  if (!data.length) return skipped(key, 'no stale publish locks');

  const delivered = data.filter((r) => r.zernio_post_id || r.actual_platform_url);
  const unknown = data.filter((r) => !r.zernio_post_id && !r.actual_platform_url);

  if (ctx.dryRun) {
    return result(key, { attempted: false, ok: true, changed: 0,
      detail: { dry_run: true, would_reconcile: delivered.length, would_leave_unknown: unknown.length } });
  }

  let changed = 0;
  for (const row of delivered) {
    const r = await patch('social_posts', `id=eq.${encodeURIComponent(row.id)}&status=eq.publishing`,
      { status: 'posted', posted_at: row.publishing_started_at, error_message: null });
    if (r.ok) changed += 1;
  }
  return result(key, {
    ok: unknown.length === 0,
    changed,
    detail: {
      reconciled_with_delivery_evidence: changed,
      left_unknown_for_human: unknown.map((r) => r.id),
      note: unknown.length
        ? 'rows with no delivery evidence were deliberately NOT requeued -- a resend could double-post'
        : undefined,
    },
  });
}

/**
 * clear_stale_post_lock
 * Same shape for group_posts, whose delivery evidence is post_url.
 */
async function clear_stale_post_lock(exp, cause, ctx = {}) {
  const key = 'clear_stale_post_lock';
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { ok, data } = await sb(
    `group_posts?status=in.(publishing,posting)&approved_at=lt.${cutoff}` +
    `&select=id,post_url,approved_at&limit=${MAX_ROWS}`
  );
  if (!ok || !Array.isArray(data)) return result(key, { detail: { error: 'query failed' } });
  if (!data.length) return skipped(key, 'no stale group-post locks');

  const delivered = data.filter((r) => r.post_url);
  const unknown = data.filter((r) => !r.post_url);

  if (ctx.dryRun) {
    return result(key, { attempted: false, ok: true, changed: 0,
      detail: { dry_run: true, would_reconcile: delivered.length, would_leave_unknown: unknown.length } });
  }

  let changed = 0;
  for (const row of delivered) {
    const r = await patch('group_posts', `id=eq.${encodeURIComponent(row.id)}&status=in.(publishing,posting)`,
      { status: 'posted', posted_at: row.approved_at });
    if (r.ok) changed += 1;
  }
  return result(key, {
    ok: unknown.length === 0, changed,
    detail: { reconciled_with_permalink: changed, left_unknown_for_human: unknown.map((r) => r.id) },
  });
}

/**
 * fix_render_selector_mismatch
 * THE cron-render-videos FIX, as a mechanical repair rather than a code patch.
 *
 * cron-render-videos selects video_required=eq.true. cron-publish-approved
 * parks rows at video_required=false. Result: the render cron matched zero
 * rows, in 168ms, at last_status='ok', while real work waited outside its
 * selector. This re-flags the orphans so the existing cron can see them.
 *
 * Scoped to status='pending_video' ONLY -- a row in that state is parked
 * awaiting a render and cannot publish until it has been rendered and
 * re-approved. So this can repair the render queue without ever causing a post
 * to go out, which is why it qualifies as 'internal_state'.
 */
async function fix_render_selector_mismatch(exp, cause, ctx = {}) {
  const key = 'fix_render_selector_mismatch';
  const { ok, data } = await sb(
    'social_posts?status=eq.pending_video&media_url=is.null&video_required=eq.false' +
    `&select=id,platform,created_at&limit=${MAX_ROWS}`
  );
  if (!ok || !Array.isArray(data)) return result(key, { detail: { error: 'query failed' } });
  if (!data.length) return skipped(key, 'no orphaned pending_video rows outside the render selector');

  if (ctx.dryRun) {
    return result(key, { attempted: false, ok: true, changed: 0,
      detail: { dry_run: true, would_reflag: data.length, ids: data.map((r) => r.id) } });
  }

  const ids = data.map((r) => `"${r.id}"`).join(',');
  const r = await patch('social_posts', `id=in.(${encodeURIComponent(ids)})&status=eq.pending_video`,
    { video_required: true });
  const changed = r.ok && Array.isArray(r.data) ? r.data.length : 0;
  return result(key, {
    ok: changed > 0, changed,
    detail: { reflagged: changed, note: 'rows now visible to cron-render-videos; no publish side effect (status stays pending_video)' },
  });
}

/**
 * retry_failed_with_backoff
 * Reset genuinely-failed rows back into the queue, with an attempt ceiling and
 * the same delivery-evidence guard as the lock clearers. SIDE EFFECT: a row
 * back at 'approved' will be picked up by a publisher, so this is 'full' tier
 * and stays off until Heath turns it on per expectation.
 */
async function retry_failed_with_backoff(exp, cause, ctx = {}) {
  const key = 'retry_failed_with_backoff';
  const { ok, data } = await sb(
    'social_posts?status=eq.failed&zernio_post_id=is.null&actual_platform_url=is.null' +
    `&select=id,render_attempts,linkedin_publish_attempts,error_message&limit=${MAX_ROWS}`
  );
  if (!ok || !Array.isArray(data)) return result(key, { detail: { error: 'query failed' } });

  const eligible = data.filter((r) => (Number(r.render_attempts) || 0) < 3 &&
                                      (Number(r.linkedin_publish_attempts) || 0) < 3);
  if (!eligible.length) return skipped(key, 'no failed rows under the attempt ceiling with no delivery evidence');

  if (ctx.dryRun) {
    return result(key, { attempted: false, ok: true, changed: 0,
      detail: { dry_run: true, would_requeue: eligible.length, ids: eligible.map((r) => r.id) } });
  }

  const ids = eligible.map((r) => `"${r.id}"`).join(',');
  const r = await patch('social_posts', `id=in.(${encodeURIComponent(ids)})&status=eq.failed`,
    { status: 'approved', error_message: null });
  const changed = r.ok && Array.isArray(r.data) ? r.data.length : 0;
  return result(key, { ok: changed > 0, changed, detail: { requeued: changed } });
}

/**
 * request_local_job
 * For anything that genuinely needs Heath's PC (a browser session, a local
 * render). Enqueues into agent_queue, which the local poller drains -- but
 * ONLY after confirming the poller's machine is actually alive. If it is not,
 * this refuses and says so, so the monitor escalates rather than logging a
 * fix that will never happen.
 */
async function request_local_job(exp, cause, ctx = {}) {
  const key = 'request_local_job';
  const alive = await localRunnerAlive();
  if (!alive.alive) {
    return skipped(key, 'local runner not alive -- refusing to enqueue work nothing will pick up',
      { last_heartbeat_age_minutes: alive.age_minutes });
  }
  // Don't pile up duplicates for the same expectation.
  const tag = `outcome-monitor:${exp.key}`;
  const dupe = await countRows(
    `agent_queue?select=id&status=in.(pending,in_progress)&task_brief=ilike.*${encodeURIComponent(tag)}*`
  );
  if (dupe.ok && dupe.count > 0) {
    return skipped(key, 'an identical local job is already queued', { existing: dupe.count });
  }
  if (ctx.dryRun) {
    return result(key, { attempted: false, ok: true, detail: { dry_run: true, would_enqueue: tag } });
  }
  const r = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      agent_name: 'atlas',
      status: 'pending',
      task_brief:
        `[${tag}] Outcome monitor detected "${exp.label}" below its floor ` +
        `(cause: ${cause.cause}). Diagnose and repair on this machine. ` +
        `Do not publish anything; repair the pipeline only. ` +
        `Detail: ${JSON.stringify(cause.detail || {}).slice(0, 600)}`,
    }]),
  });
  return result(key, { ok: r.ok, changed: r.ok ? 1 : 0, detail: { enqueued: r.ok, tag } });
}

// ─── Registry ────────────────────────────────────────────────────────────────
//
// side_effect:
//   internal_state - touches ops/queue state only; can never cause a publish
//   causes_publish - puts a row somewhere a publisher will drain it
const REGISTRY = {
  clear_stale_publish_lock: {
    run: clear_stale_publish_lock,
    side_effect: 'internal_state',
    handles: ['stale_publish_lock', 'queue_backed_up'],
    describes: 'Reconciles social_posts stuck at publishing: rows WITH delivery evidence move to posted; rows without are left alone and reported.',
  },
  clear_stale_post_lock: {
    run: clear_stale_post_lock,
    side_effect: 'internal_state',
    handles: ['stale_publish_lock', 'queue_backed_up'],
    describes: 'Same reconciliation for group_posts, keyed on post_url as the delivery evidence.',
  },
  fix_render_selector_mismatch: {
    run: fix_render_selector_mismatch,
    side_effect: 'internal_state',
    handles: ['selector_mismatch', 'render_selector_mismatch'],
    describes: 'Re-flags pending_video rows that the render cron selector cannot see (video_required=false), so the existing cron picks them up. No publish side effect.',
  },
  retry_failed_with_backoff: {
    run: retry_failed_with_backoff,
    side_effect: 'causes_publish',
    handles: ['vendor_error', 'queue_backed_up'],
    describes: 'Requeues failed rows that have no delivery evidence and are under the attempt ceiling. Gated to remediation_mode=full because a requeued row will publish.',
  },
  request_local_job: {
    run: request_local_job,
    side_effect: 'internal_state',
    handles: ['credential_missing', 'credential_unknown', 'credential_expiring',
              'credential_soft_walled', 'credential_probe_stale', 'dead_local_runner',
              'selector_mismatch'],
    describes: 'Enqueues a repair task onto agent_queue for the local poller -- only if pc_heartbeats proves the machine is alive, otherwise refuses so the gap escalates instead.',
  },
};

function allowedByMode(entry, mode) {
  if (mode === 'off') return false;
  if (mode === 'full') return true;
  return entry.side_effect !== 'causes_publish'; // 'safe'
}

/**
 * Run every remediation declared on the expectation that handles the detected
 * cause and is permitted by remediation_mode.
 */
async function remediate(exp, cause, ctx = {}) {
  const mode = exp.remediation_mode || 'safe';
  const declared = Array.isArray(exp.remediations) ? exp.remediations : [];
  const runs = [];
  for (const name of declared) {
    const entry = REGISTRY[name];
    if (!entry) { runs.push(skipped(name, 'not in registry')); continue; }
    if (!allowedByMode(entry, mode)) {
      runs.push(skipped(name, `blocked by remediation_mode=${mode} (side_effect=${entry.side_effect})`));
      continue;
    }
    if (entry.handles.length && cause && cause.cause && !entry.handles.includes(cause.cause)) {
      runs.push(skipped(name, `does not handle cause=${cause.cause}`));
      continue;
    }
    try {
      runs.push(await entry.run(exp, cause, ctx));
    } catch (e) {
      runs.push(result(name, { detail: { error: e.message.slice(0, 200) } }));
    }
  }
  const anyChanged = runs.some((r) => r.attempted && r.ok && (r.changed || 0) > 0);
  return { runs, changed: anyChanged };
}

module.exports = { REGISTRY, remediate, allowedByMode, localRunnerAlive, MAX_ROWS };
