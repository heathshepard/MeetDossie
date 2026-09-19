'use strict';

// api/_lib/ops-policy.js
//
// STANDING AUTHORITY, ENCODED. Heath's ask, 2026-09-17: "what can act
// without me" was scattered across kill switches (auto-reply-kill-switch.js),
// caps (engagement-caps.js), and prose in agent instructions — nobody could
// read one place and know the whole answer. This file IS that one place.
//
// See supabase/migrations/20260917d_ops_policy.sql for the storage this
// reads/writes (extends the existing public.ops_flags table — no new
// mechanism) and for the full policy write-up; keep the two in sync.
//
// TWO CLASSES, hard-coded below, never confused with each other:
//
//   1. AUTONOMOUS (checked against an ops_flags row, default per
//      CAPABILITIES[key].defaultEnabled, FAIL-CLOSED to disabled on any
//      read failure — same contract as scripts/_lib/auto-reply-kill-
//      switch.js):
//        publish_content, reply_low_risk_comments (the pre-existing
//        'auto_reply' flag), schedule_week_ahead, harvest_and_draft,
//        batch_routine_approvals.
//
//   2. ALWAYS_HEATH — money, a real client, anything irreversible or
//      public under his license, a pricing/demo/complaint conversation, or
//      a new account/credential. checkCapability() for any of these
//      returns allowed:false UNCONDITIONALLY — it never even looks at
//      ops_flags for these keys, and the DB itself additionally rejects
//      any row using one of these names (CHECK constraint in the
//      migration above) so there is no path, code or data, that can make
//      one of these autonomous.
//
// LOGGING: logAutonomousAction() writes to ops_action_log for every real
// firing AND every blocked attempt, so "why did/didn't the system do that"
// is answerable from history, not memory. Logging is best-effort — a
// logging failure never blocks or reverses the underlying action (the
// action already happened by the time this is called); it only ever
// console.warns and returns { ok:false }.
//
// Owner: Carter, 2026-09-17

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function envSbFetch(urlPath, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, status: 0, data: null, error: 'SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY missing' };
  }
  try {
    const headers = {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

// ── The readable policy itself ─────────────────────────────────────────────

// AUTONOMOUS capabilities. `flagKey` is the ops_flags row this reads.
// `defaultEnabled` is what's seeded in the migration and what a caller
// should assume the system intends when the flag genuinely can't be read
// (documentation only — the actual read still fails closed to false; see
// checkCapability()).
const CAPABILITIES = {
  publish_content: {
    flagKey: 'publish_content',
    defaultEnabled: true,
    description: 'Publish a post that already passed schedule/dedup/media/video-required/caption-sanitizer gates.',
    gates: ['schedule', 'dedup', 'media_required', 'caption_sanitizer'],
  },
  reply_low_risk_comments: {
    // Deliberately points at the PRE-EXISTING 'auto_reply' flag
    // (20260916_auto_reply_veto.sql) rather than a new row — one flag, one
    // meaning, read by the veto-check cron exactly as it already was.
    flagKey: 'auto_reply',
    defaultEnabled: false,
    description: 'Auto-post a reply to a comment the risk classifier scored low-risk, after a 10-minute Heath veto window with no STOP tap.',
    gates: ['risk_classifier_low_risk_high_confidence', 'content_gates', 'veto_window_10min_no_stop'],
  },
  schedule_week_ahead: {
    flagKey: 'schedule_week_ahead',
    defaultEnabled: true,
    description: 'Advance-fill the next 7 days of draft content so one failed daily run never leaves a silent gap.',
    gates: ['idempotent_per_date', 'verifier_gate'],
  },
  harvest_and_draft: {
    flagKey: 'harvest_and_draft',
    defaultEnabled: true,
    description: 'Read-only comment harvesting + drafting a reply/comment for review. Never the post/reply itself.',
    gates: ['read_only_scrape'],
  },
  batch_routine_approvals: {
    flagKey: 'batch_routine_approvals',
    defaultEnabled: true,
    description: 'Fold routine (non-time-sensitive) per-item approval pings into the one daily morning brief instead of firing individually.',
    gates: [],
  },
  ack_support_ticket: {
    // Seeded DISABLED by 20260918_support_ticket_triage.sql. This is the ONLY
    // switch between api/cron-support-ticket-triage.js and a real customer
    // inbox.
    //
    // WHY THIS ISN'T contact_real_client (ALWAYS_HEATH): that key covers a
    // message Heath INITIATES to a client, lead, or the other side of a deal
    // — a judgement call with deal consequences. This is strictly narrower:
    // a receipt, to a paying Dossie customer who just wrote in to Heath
    // unprompted, confirming his software received what they sent and
    // promising nothing. Heath granted standing authority for exactly that
    // act after ticket 503a1d1b (Amanda Nuckles, 2026-08-24) sat unanswered
    // until she cancelled.
    //
    // WHAT IT CAN NEVER COVER: a cancellation, a billing dispute, an unhappy
    // customer, or anything legal. Those are
    // pricing_demo_complaint_conversation below — ALWAYS_HEATH, no flag, no
    // path. The classifier routes them there BEFORE this capability is ever
    // consulted.
    flagKey: 'ack_support_ticket',
    defaultEnabled: false,
    description: 'Send a one-time receipt acknowledgement to a customer who filed an in-app support ticket. Acknowledges only — no timeline, no promise, no claim of a fix.',
    gates: [
      'not_internal_sender',
      'not_escalation_class',
      'within_backfill_age_window',
      'idempotent_unique_ticket',
      'suppression_list',
      'rate_caps_and_flood_guard',
      'no_promise_in_copy',
    ],
  },
};

// ALWAYS HEATH. No flagKey — there is nothing to read. checkCapability()
// short-circuits to blocked before ever touching ops_flags, and the DB
// CHECK constraint (migration 20260917d) additionally makes it impossible
// to ever create an ops_flags row under one of these names.
const ALWAYS_HEATH = {
  spend_money: 'Anything that costs money — a paid API call above the pipeline\'s normal budget, a purchase, a refund.',
  contact_real_client: 'Any message to a real client, lead, or the other side of a deal — as opposed to an anonymous FB group comment.',
  irreversible_public_under_license: 'Anything public and irreversible that carries Heath\'s TX real-estate license — a live post, a signed document, a filed disclosure.',
  pricing_demo_complaint_conversation: 'Any conversation that turns to pricing, a demo request, or a complaint — escalates immediately, never auto-answered.',
  new_account_or_credential: 'Creating a new account, API key, or credential of any kind.',
};

/**
 * Is `capabilityKey` currently allowed to fire autonomously right now?
 *
 * @param {string} capabilityKey  one of CAPABILITIES' keys, or an
 *   ALWAYS_HEATH key (always resolves to blocked).
 * @param {function} [sbFetch]  injectable REST fetch for tests.
 * @returns {Promise<{capability:string, allowed:boolean, decision:string, reason:string}>}
 */
async function checkCapability(capabilityKey, sbFetch = envSbFetch) {
  if (Object.prototype.hasOwnProperty.call(ALWAYS_HEATH, capabilityKey)) {
    return {
      capability: capabilityKey,
      allowed: false,
      decision: 'blocked_always_heath',
      reason: ALWAYS_HEATH[capabilityKey],
    };
  }

  const cap = CAPABILITIES[capabilityKey];
  if (!cap) {
    // Unknown capability — fail closed. A typo'd key must never silently
    // grant autonomy.
    return {
      capability: capabilityKey,
      allowed: false,
      decision: 'blocked_flag_off',
      reason: `unknown capability '${capabilityKey}' — not in ops-policy.js CAPABILITIES, failing closed`,
    };
  }

  try {
    const { ok, data } = await sbFetch(`/rest/v1/ops_flags?key=eq.${encodeURIComponent(cap.flagKey)}&select=enabled,reason`);
    if (!ok || !Array.isArray(data) || data.length === 0 || typeof data[0].enabled !== 'boolean') {
      return {
        capability: capabilityKey,
        allowed: false,
        decision: 'blocked_flag_off',
        reason: `ops_flags row '${cap.flagKey}' unreadable or missing — failing closed`,
      };
    }
    if (!data[0].enabled) {
      return {
        capability: capabilityKey,
        allowed: false,
        decision: 'blocked_flag_off',
        reason: data[0].reason || `ops_flags.${cap.flagKey} is off`,
      };
    }
    return { capability: capabilityKey, allowed: true, decision: 'autonomous', reason: data[0].reason || 'ops_flags enabled' };
  } catch (e) {
    return {
      capability: capabilityKey,
      allowed: false,
      decision: 'blocked_flag_off',
      reason: `ops_flags read failed: ${e.message} — failing closed`,
    };
  }
}

/**
 * Log an autonomous action (or a blocked attempt) to ops_action_log.
 * Best-effort: never throws, never blocks the caller on a logging failure.
 *
 * @param {object} entry {
 *   capability, decision ('autonomous'|'blocked_always_heath'|'blocked_flag_off'),
 *   action, firedBy, gatesPassed, refTable, refId, metadata
 * }
 * @param {function} [sbFetch]
 * @returns {Promise<{ok:boolean}>}
 */
async function logAutonomousAction(entry, sbFetch = envSbFetch) {
  const {
    capability, decision, action, firedBy,
    gatesPassed = [], refTable = null, refId = null, metadata = null,
  } = entry || {};

  if (!capability || !decision || !action || !firedBy) {
    console.warn('[ops-policy] logAutonomousAction called with missing required field(s) — not logged:', JSON.stringify(entry));
    return { ok: false };
  }

  try {
    const res = await sbFetch('/rest/v1/ops_action_log', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        capability,
        decision,
        action: String(action).slice(0, 500),
        fired_by: String(firedBy).slice(0, 200),
        gates_passed: gatesPassed,
        ref_table: refTable,
        ref_id: refId != null ? String(refId) : null,
        metadata,
      }),
    });
    if (!res.ok) {
      console.warn(`[ops-policy] ops_action_log insert failed (status ${res.status}) — action already happened, logging only`);
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.warn(`[ops-policy] ops_action_log insert threw: ${e.message} — action already happened, logging only`);
    return { ok: false };
  }
}

/**
 * Convenience: check + log in one call for a call site that fires
 * immediately when allowed. Returns the checkCapability() result; the
 * caller decides what to do when allowed=false (skip / fall back to
 * manual). Logs EVERY call, allowed or not, so blocked attempts are as
 * visible as real firings.
 */
async function checkAndLog({ capability, action, firedBy, gatesPassed, refTable, refId, metadata }, sbFetch = envSbFetch) {
  const check = await checkCapability(capability, sbFetch);
  await logAutonomousAction({
    capability,
    decision: check.decision,
    action,
    firedBy,
    gatesPassed: check.allowed ? gatesPassed : [],
    refTable,
    refId,
    metadata: check.allowed ? metadata : { ...(metadata || {}), blocked_reason: check.reason },
  }, sbFetch);
  return check;
}

module.exports = {
  CAPABILITIES,
  ALWAYS_HEATH,
  checkCapability,
  logAutonomousAction,
  checkAndLog,
  envSbFetch,
};
