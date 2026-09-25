'use strict';

// api/_lib/outcome-causes.js
//
// Cause classification for the outcome monitor. When a pipeline produced less
// than it declared, this decides WHY, because "why" is what picks the
// remediation. A gap with no cause can only ever be escalated; a gap with a
// cause can often be fixed without waking anyone up.
//
// Each classifier is (expectation, ctx) -> null | { cause, detail, confidence }.
// They run in the order listed on the expectation row and the first hit wins,
// so order the specific ones before the general ones.
//
// The cause string matters beyond diagnosis: outcome_incidents is keyed on
// (expectation_key, cause), so a cause CHANGE opens a brand-new incident that
// no cooldown can suppress. Classifier names are therefore part of the alerting
// contract, not just a debug label.
//
// Owner: Atlas, 2026-09-25

const { sb, countRows } = require('./outcome-expectations.js');

// Structure, not thresholds: which credential channel and which upstream queue
// belongs to which pipeline. Thresholds live in outcome_expectations; this is
// the wiring diagram, which genuinely is code.
const PIPELINE_MAP = {
  fb_groups: {
    credential_channel: 'facebook_groups',
    queue: { table: 'group_posts', filters: { status: 'eq.approved' } },
    error_column: 'failure_reason',
    error_table: 'group_posts',
    owning_crons: ['cron-daily-fb-posts', 'cron-daily-group5-posts'],
    local_runner: true,
  },
  social_publish: {
    credential_channel: null, // Zernio OAuth, no local credential
    queue: { table: 'social_posts', filters: { status: 'eq.approved' } },
    error_column: 'error_message',
    error_table: 'social_posts',
    owning_crons: ['cron-publish-approved'],
    local_runner: false,
  },
  linkedin_personal: {
    credential_channel: 'linkedin_personal',
    queue: { table: 'social_posts', filters: { status: 'eq.approved', platform: 'eq.linkedin_personal' } },
    error_column: 'error_message',
    error_table: 'social_posts',
    owning_crons: [],
    local_runner: true,
  },
  fb_comments: {
    credential_channel: 'facebook_groups', // same DossieBot-Sage profile
    queue: { table: 'tc_discovery_responses', filters: { reply_status: 'eq.approved' } },
    error_column: 'reply_error',
    error_table: 'tc_discovery_responses',
    owning_crons: ['cron-comment-monitor', 'cron-comment-opp-approval'],
    local_runner: true,
  },
  video: {
    credential_channel: null,
    // The backlog that matters for the cost line is finished videos waiting on
    // a decision, not every historical row ever flagged for video. Counting the
    // latter produced a nonsense "63 videos unshipped".
    queue: { table: 'video_library', filters: { status: 'eq.pending_heath_review' } },
    error_column: 'error_message',
    error_table: 'social_posts',
    owning_crons: ['cron-render-videos', 'cron-post-videos'],
    local_runner: false,
  },
  credentials: { credential_channel: null, queue: null, owning_crons: [], local_runner: true },
  telemetry:   { credential_channel: null, queue: null, owning_crons: [], local_runner: false },
};

// Vendor errors that mean "someone has to pay a bill", not "retry later".
// Creatomate has returned 402 since 2026-06-30 and nothing ever said so.
const BILLING_RE = /\b(402|payment required|insufficient (credit|funds|balance)|quota exceeded|plan limit|billing|subscription (expired|inactive)|out of credits)\b/i;
const AUTH_RE = /\b(401|403|unauthor|not logged in|login required|authwall|session (expired|invalid)|re-?auth)\b/i;

function pipelineOf(exp) {
  return PIPELINE_MAP[exp.pipeline] || { credential_channel: null, queue: null, owning_crons: [], local_runner: false };
}

async function countQueue(exp) {
  const p = pipelineOf(exp);
  if (!p.queue) return null;
  const parts = ['select=id'];
  for (const [k, v] of Object.entries(p.queue.filters)) parts.push(`${k}=${v}`);
  const r = await countRows(`${p.queue.table}?${parts.join('&')}`);
  return r.ok ? r.count : null;
}

// ─── Classifiers ─────────────────────────────────────────────────────────────

/**
 * The auth is gone. Reads credential_health, which the local probe writes --
 * never launches a browser itself, because a serverless function cannot and
 * because launching Chrome on a profile another agent holds is how you kill a
 * live authenticated session.
 */
async function credential_missing(exp) {
  const channel = pipelineOf(exp).credential_channel;
  if (!channel) return null;
  const { ok, data } = await sb(`credential_health?channel=eq.${encodeURIComponent(channel)}&select=*`);
  if (!ok || !Array.isArray(data) || !data[0]) {
    return { cause: 'credential_unknown', confidence: 'low',
             detail: { channel, note: 'no credential_health row -- the probe has never reported for this channel' } };
  }
  const row = data[0];
  const ageH = row.last_probe_at ? (Date.now() - new Date(row.last_probe_at).getTime()) / 3600000 : null;
  if (row.logged_in === false) {
    return {
      cause: 'credential_missing', confidence: 'high',
      detail: {
        channel,
        profile_dir: row.profile_dir,
        required_cookies: row.required_cookies,
        present_cookies: row.present_cookies,
        consecutive_failures: row.consecutive_failures,
        last_healthy_at: row.last_healthy_at,
        probe_age_hours: ageH === null ? null : Math.round(ageH * 10) / 10,
      },
    };
  }
  // ── DEGRADING SIGNALS ──────────────────────────────────────────────────────
  // Everything below here fires while the channel is still WORKING. The point
  // is to land a warning during the window where a 60-second manual login
  // prevents an outage, instead of only reporting the outage afterwards.

  // Soft-wall: the session cookie is present and the URL looks logged in, but
  // the authenticated-only element never rendered. Written by the keep-alive's
  // live touch (scripts/session-keepalive-gentle.js). This is the shape a
  // server-side invalidation takes BEFORE the cookie itself disappears -- a
  // cookie-only probe cannot see it, because an invalidated cookie is
  // byte-identical to a good one.
  if (row.detail && row.detail.soft_walled === true) {
    return { cause: 'credential_soft_walled', confidence: 'medium',
             detail: { channel, note: 'cookie present and URL looks authenticated, but the logged-in surface did not render -- likely server-side invalidation or a checkpoint',
                       landing_url: row.detail.landing_url || null, last_healthy_at: row.last_healthy_at } };
  }

  // Cookie about to lapse -- warn BEFORE it breaks. Raised 7 -> 14 days on
  // 2026-09-25 to match EXPIRY_WARN_DAYS in scripts/_lib/session-guard.js, so
  // the classifier and the probe cannot disagree about what "expiring" means.
  if (row.days_to_expiry !== null && row.days_to_expiry !== undefined && Number(row.days_to_expiry) < 14) {
    return { cause: 'credential_expiring', confidence: 'medium',
             detail: { channel, days_to_expiry: Number(row.days_to_expiry), earliest_expiry: row.earliest_expiry,
                       note: 'still working; log in again at any convenient moment to refresh it' } };
  }

  // The probe itself went quiet. THIS is the check that would have caught the
  // 9-day outage: the local state file stopped being written and nothing
  // noticed, because an absent file raises nothing. An absent ROW is loud.
  if (ageH !== null && ageH > 72) {
    return { cause: 'credential_probe_stale', confidence: 'medium',
             detail: { channel, probe_age_hours: Math.round(ageH * 10) / 10,
                       note: 'the credential probe has not reported -- its scheduled task may have been removed or the PC has been off' } };
  }
  return null;
}

/** Nothing upstream to publish. A real answer, and NOT the same bug as a dead channel. */
async function queue_empty(exp) {
  const n = await countQueue(exp);
  if (n === null) return null;
  if (n === 0) {
    return { cause: 'queue_empty', confidence: 'high',
             detail: { queue_table: pipelineOf(exp).queue.table, pending: 0,
                       note: 'upstream produced nothing -- the generator is the problem, not the publisher' } };
  }
  return null;
}

/** Rows are waiting and nothing is draining them. */
async function queue_backed_up(exp) {
  const n = await countQueue(exp);
  if (n === null || n === 0) return null;
  return { cause: 'queue_backed_up', confidence: 'high',
           detail: { queue_table: pipelineOf(exp).queue.table, pending: n,
                     note: 'work is queued but the consumer is not consuming' } };
}

/**
 * A row claimed for publishing and never released -- a lock leak.
 * IMPORTANT: this only CLASSIFIES. Whether it is safe to retry is decided in
 * outcome-remediation.js, which refuses to requeue anything that might already
 * have gone out. (memory: feedback_never-retry-an-unverified-send -- a retried
 * "failed" send triple-texted a client on 2026-09-11.)
 */
async function stale_publish_lock(exp) {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const r = await countRows(
    `social_posts?select=id&status=eq.publishing&publishing_started_at=lt.${cutoff}`
  );
  if (!r.ok || !r.count) return null;
  return { cause: 'stale_publish_lock', confidence: 'high',
           detail: { stuck_publishing: r.count, older_than: cutoff } };
}

/** The local PC that owns the browser work is not checking in. */
async function dead_local_runner(exp) {
  if (!pipelineOf(exp).local_runner && exp.pipeline !== 'credentials') return null;
  const { ok, data } = await sb('pc_heartbeats?select=last_seen&order=last_seen.desc&limit=1');
  if (!ok || !Array.isArray(data) || !data[0]) {
    return { cause: 'dead_local_runner', confidence: 'low',
             detail: { note: 'no pc_heartbeats row at all' } };
  }
  const ageMin = (Date.now() - new Date(data[0].last_seen).getTime()) / 60000;
  if (ageMin > 90) {
    return { cause: 'dead_local_runner', confidence: 'high',
             detail: { last_seen: data[0].last_seen, age_minutes: Math.round(ageMin) } };
  }
  return null;
}

/** The cron that owns this outcome has not fired recently. */
async function dead_cron(exp) {
  const crons = pipelineOf(exp).owning_crons;
  if (!crons || !crons.length) return null;
  const list = crons.map((c) => `"${c}"`).join(',');
  const { ok, data } = await sb(`cron_runs?cron_name=in.(${encodeURIComponent(list)})&select=cron_name,last_run,last_status,last_meta`);
  if (!ok || !Array.isArray(data)) return null;
  const stale = [];
  for (const row of data) {
    const ageH = row.last_run ? (Date.now() - new Date(row.last_run).getTime()) / 3600000 : Infinity;
    if (ageH > Math.max(6, Number(exp.window_hours || 24))) {
      stale.push({ cron: row.cron_name, age_hours: Math.round(ageH * 10) / 10, last_status: row.last_status });
    }
  }
  if (!stale.length) return null;
  return { cause: 'dead_cron', confidence: 'high', detail: { stale_crons: stale } };
}

/**
 * THE cron-render-videos CLASS, generalised.
 *
 * The owning cron ran, returned 200, recorded 'ok', and matched zero rows --
 * while the queue it is supposed to drain is not empty. That combination means
 * the cron's row selector and the rows' actual shape have drifted apart. It is
 * indistinguishable from health if you only look at last_status, which is
 * exactly why it survived for weeks.
 */
async function render_selector_mismatch(exp) {
  const p = pipelineOf(exp);
  const crons = p.owning_crons || [];
  if (!crons.length) return null;

  const list = crons.map((c) => `"${c}"`).join(',');
  const { ok, data } = await sb(`cron_runs?cron_name=in.(${encodeURIComponent(list)})&select=cron_name,last_run,last_status,last_meta`);
  if (!ok || !Array.isArray(data) || !data.length) return null;

  const ranRecentlyOk = data.filter((r) => {
    if (r.last_status !== 'ok') return false;
    const ageH = r.last_run ? (Date.now() - new Date(r.last_run).getTime()) / 3600000 : Infinity;
    return ageH < 24;
  });
  if (!ranRecentlyOk.length) return null;

  // How many rows need this work at ALL, ignoring the cron's own selector.
  // For video: any row flagged for video that still has no media.
  const needy = await countRows(
    'social_posts?select=id&media_url=is.null&status=in.(draft,approved,pending_video)&video_required=not.is.null'
  );
  const matchesSelector = await countRows(
    'social_posts?select=id&video_required=eq.true&media_url=is.null&status=in.(draft,approved,pending_video)'
  );
  if (!needy.ok || !matchesSelector.ok) return null;

  const orphaned = (needy.count || 0) - (matchesSelector.count || 0);
  if (orphaned > 0 && (matchesSelector.count || 0) === 0) {
    return {
      cause: 'selector_mismatch', confidence: 'high',
      detail: {
        crons: ranRecentlyOk.map((r) => ({ cron: r.cron_name, last_status: r.last_status, last_meta: r.last_meta })),
        rows_needing_work: needy.count,
        rows_the_selector_can_see: matchesSelector.count,
        orphaned,
        note: 'the owning cron reported ok while its selector matched nothing and real work was waiting outside it',
      },
    };
  }
  return null;
}

/** A vendor is erroring. Splits billing (needs a human + a card) from transient. */
async function vendor_error(exp) {
  const p = pipelineOf(exp);
  if (!p.error_table || !p.error_column) return null;
  const since = new Date(Date.now() - Number(exp.window_hours || 24) * 3600000).toISOString();
  const timeCol = p.error_table === 'tc_discovery_responses' ? 'updated_at' : 'created_at';
  const { ok, data } = await sb(
    `${p.error_table}?select=id,${p.error_column}&${p.error_column}=not.is.null&${timeCol}=gte.${since}&limit=25`
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  const msgs = data.map((r) => String(r[p.error_column] || '')).filter(Boolean);
  if (!msgs.length) return null;
  const billing = msgs.find((m) => BILLING_RE.test(m));
  if (billing) {
    return { cause: 'vendor_billing', confidence: 'high',
             detail: { sample: billing.slice(0, 300), count: msgs.length } };
  }
  const auth = msgs.find((m) => AUTH_RE.test(m));
  if (auth) {
    return { cause: 'vendor_auth', confidence: 'high',
             detail: { sample: auth.slice(0, 300), count: msgs.length } };
  }
  return { cause: 'vendor_error', confidence: 'medium',
           detail: { sample: msgs[0].slice(0, 300), count: msgs.length } };
}

/** Explicit billing check even when no row carries an error string. */
async function vendor_billing(exp) {
  const hit = await vendor_error(exp);
  return hit && hit.cause === 'vendor_billing' ? hit : null;
}

/**
 * The work is done and waiting on Heath's tap.
 *
 * "Waiting on a human" is a legitimate state and NOT a defect -- so this
 * deliberately splits it in two, because only one half is real:
 *
 *   awaiting_human_approval   -- asked, not yet answered. Fine. Nudge, do not alarm.
 *   approval_never_requested  -- telegram_message_id IS NULL. Nobody was ever
 *                                asked. There is no message in Telegram to tap,
 *                                so this can sit forever and every nudge that
 *                                says "sent for review" is untrue.
 *
 * HOW THIS INTERACTS WITH ops_flags.batch_routine_approvals (ON since
 * 2026-09-17 -- Heath's call, deliberately untouched here):
 *   The flag routes routine approvals into a batch digest instead of an
 *   immediate per-item ping. That is a reasonable trade and not the bug. The
 *   bug is that a row can enter the batch lane and never get a
 *   telegram_message_id, at which point it is in neither lane -- not pinged,
 *   not batched, just parked. Verified live 2026-09-25: 6 video_library rows at
 *   pending_heath_review, all 6 with telegram_message_id NULL, oldest 2026-09-16.
 *   The monitor therefore does NOT read the flag and does not care what it is
 *   set to. It asks the only question that survives either setting: did anyone
 *   actually get asked? Turning the flag off would not fix these six rows, and
 *   leaving it on does not hide them.
 */
async function awaiting_human_approval(exp) {
  const probes = [
    { table: 'video_library', filters: 'status=eq.pending_heath_review', idCol: 'telegram_message_id' },
    { table: 'social_posts',  filters: 'status=eq.draft&requires_approval=eq.true', idCol: 'telegram_message_id' },
    { table: 'comment_opportunities', filters: 'status=eq.approved&posted_at=is.null', idCol: 'telegram_message_id' },
  ];
  for (const p of probes) {
    const total = await countRows(`${p.table}?select=id&${p.filters}`);
    if (!total.ok || !total.count) continue;
    const unsent = await countRows(`${p.table}?select=id&${p.filters}&${p.idCol}=is.null`);
    if (unsent.ok && unsent.count > 0) {
      return {
        cause: 'approval_never_requested', confidence: 'high',
        detail: {
          table: p.table, pending: total.count, never_sent_to_telegram: unsent.count,
          note: 'these are waiting on a human decision that was never actually asked for -- ' +
                'telegram_message_id is NULL, so no message exists to tap',
        },
      };
    }
    return { cause: 'awaiting_human_approval', confidence: 'high',
             detail: { table: p.table, pending: total.count } };
  }
  return null;
}

/**
 * The meta-check. A cron whose telemetry carries no item count cannot tell
 * "ran and did the work" apart from "ran and did nothing". Every one of the
 * eight failures presented as the former.
 */
async function telemetry_blind() {
  const { ok, data } = await sb('cron_runs?select=cron_name,last_run,last_status,last_meta&limit=500');
  if (!ok || !Array.isArray(data)) return null;
  // Same 24h window the cron_outcome_reporting expectation measures, so the
  // headline count and the classifier's detail can never disagree.
  const since = Date.now() - 24 * 3600 * 1000;
  const blind = [];
  for (const row of data) {
    if (!row.last_run || new Date(row.last_run).getTime() < since) continue;
    if (row.last_status !== 'ok') continue;
    const m = row.last_meta || {};
    if (m.outcome === undefined && extractItems(m) === null) blind.push(row.cron_name);
  }
  if (!blind.length) return null;
  return {
    cause: 'telemetry_blind', confidence: 'high',
    detail: { blind_cron_count: blind.length, sample: blind.slice(0, 15),
              note: 'reported ok with no item count -- indistinguishable from doing nothing' },
  };
}

// Count keys we recognise as "items this run actually produced/handled".
// Shared with cron-telemetry.js so the writer and the auditor agree.
const ITEM_KEYS = [
  'items', 'processed', 'published', 'posted', 'sent', 'rendered', 'claimed',
  'created', 'updated', 'handled', 'count', 'rows', 'generated', 'replied',
  'harvested', 'synced', 'queued', 'approved', 'delivered', 'fixed',
];

function extractItems(meta) {
  if (!meta || typeof meta !== 'object') return null;
  let total = null;
  for (const k of ITEM_KEYS) {
    const v = meta[k];
    if (typeof v === 'number' && Number.isFinite(v)) total = (total || 0) + v;
  }
  return total;
}

const CLASSIFIERS = {
  credential_missing,
  queue_empty,
  queue_backed_up,
  stale_publish_lock,
  dead_local_runner,
  dead_cron,
  render_selector_mismatch,
  vendor_error,
  vendor_billing,
  awaiting_human_approval,
  telemetry_blind,
};

/**
 * Run an expectation's classifiers in order; first hit wins.
 * Returns { cause, detail, confidence } -- always something, so an incident
 * always has a key. 'unclassified' is honest and still actionable.
 */
async function classify(exp) {
  const names = Array.isArray(exp.classifiers) ? exp.classifiers : [];
  const tried = [];
  for (const name of names) {
    const fn = CLASSIFIERS[name];
    if (!fn) { tried.push(`${name}(missing)`); continue; }
    try {
      const hit = await fn(exp);
      tried.push(name);
      if (hit && hit.cause) return { ...hit, classifiers_tried: tried };
    } catch (e) {
      tried.push(`${name}(threw:${e.message.slice(0, 60)})`);
    }
  }
  return { cause: 'unclassified', confidence: 'none', detail: {}, classifiers_tried: tried };
}

module.exports = {
  classify, CLASSIFIERS, PIPELINE_MAP, pipelineOf, countQueue,
  extractItems, ITEM_KEYS, BILLING_RE, AUTH_RE,
};
