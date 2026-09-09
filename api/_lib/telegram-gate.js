'use strict';

// api/_lib/telegram-gate.js
// =============================================================================
// SCHEDULED-TELEGRAM KILL SWITCH
//
// WHY
//   2026-08-16 — Heath: "I'm not really using Telegram very much anymore. I get
//   a bunch of notifications to Telegram and I want to just turn them off...
//   all the cron job things that I'm getting, because I don't even think
//   they're accurate."
//
//   ~56 registered crons (plus more fired from cron-job.org) each inline-fetch
//   api.telegram.org directly. There was never a shared send helper, so there
//   was no single place to turn the noise off. This is that place.
//
// WHAT THIS IS NOT
//   This does NOT touch the two-way Telegram channel. Heath still talks to
//   Claude Code over the Claudy bot via the telegram plugin, and the inbound
//   webhook handlers (claudy-webhook, telegram-webhook, sage-webhook,
//   assistant-webhook, group-post-callback, desktop-confirm-callback,
//   notify.js, and every *-webhook.js) DO NOT import this module. His replies
//   keep working exactly as before. Only unattended, schedule-driven pushes
//   are gated.
//
// HOW
//   install(jobName) monkey-patches globalThis.fetch for this lambda instance
//   and short-circuits outbound calls to api.telegram.org that would SEND
//   something. Read-only Bot API calls (getMe, getUpdates, getWebhookInfo,
//   setWebhook, answerCallbackQuery) are always allowed through so diagnostics
//   and interactive plumbing are unaffected.
//
//   Suppressed calls return a well-formed fake Telegram success response, so
//   callers that check `res.ok` or read `result.message_id` keep working and
//   no cron starts failing just because it went quiet.
//
// SWITCH
//   Env var: TELEGRAM_CRON_NOTIFICATIONS
//     unset / '' / 'off' / '0' / 'false'   -> ALL scheduled sends suppressed  (current state)
//     'on' / '1' / 'true' / 'all'          -> everything restored, pre-2026-08-16 behavior
//     comma list, e.g. 'alert-health,cron-stripe-reconcile'
//                                          -> only those job names may send
//
//   Default is OFF-by-absence deliberately: nothing needs to be set in Vercel
//   for the noise to stop on deploy. Re-enabling is a one-var change.
//
//   ALWAYS_ALLOW below is a small floor of genuine production-outage alerts
//   that fire only when something is actually broken. Add 'strict' to the env
//   var value to suppress those too (total silence).
//
// Owner: Atlas, 2026-08-16.

// Jobs that stay audible even when the switch is off, because they are
// exception-only alerts (they send nothing on a healthy system) rather than
// scheduled digests. Keep this list SHORT.
const ALWAYS_ALLOW = new Set([
  'alert-health',            // */5 — double-probes, only alerts if still broken after retry
  'cron-pc-heartbeat-check', // */5 — only fires when a PC has actually gone silent, 1x per stale window
  'cron-agent-requests-stale-check', // */15 — only fires when agent_requests rows are actually stuck (see file header, 2026-08-25 incident)
  'vercel-deploy-webhook',   // event-driven, not scheduled — only fires on an actual deploy failure/cancel (see file header, 2026-08-26)
  'cron-support-ticket-alert', // */30 — only fires when a customer support ticket sits unanswered past 2h (+24h/72h/7d escalations).
                               // Added 2026-09-07 (Carter): ticket 503a1d1b (Amanda Nuckles, a founding member asking how to
                               // cancel) had 4 escalation alerts eaten by this gate while heath_alerted_at got stamped anyway.
                               // A silent support queue is a customer-losing outage, not digest noise.
  'cron-unsubscribe-spike-monitor', // hourly probe, but only SENDS when >2 unsubscribes/24h (6h dedup) — silent on a
                                    // healthy list. Deliverability/domain-reputation bleed threatens every transactional
                                    // send (deadline reminders, e-sign) — Carter, 2026-09-07.
  'cron-tc-reply-approval',  // sends ONLY when a real human commented on a TC discovery post — or replied to a
                             // comment Heath left on someone else's post (thread_role='guest') — and Heath's
                             // approval is required before anything can post back. Interactive approval plumbing,
                             // not digest noise. A swallowed message here silently kills the whole reply loop (the
                             // exact failure mode that hid five finished videos for three weeks) — Carter, 2026-09-08.
  'cron-comment-opp-approval', // daily comment-opportunity Approve/Edit/Skip loop (comment_opportunities).
                               // Same class as cron-tc-reply-approval: interactive approval plumbing, capped at
                               // 12 sends/day, silent when the hunt finds nothing. A swallowed send here stalls
                               // the entire daily engagement pipeline — Carter, 2026-09-08.
  'cron-daily-group5-posts',  // daily 5-group-post Approve/Edit/Skip loop (group_posts pipeline='daily5').
                               // Same class as cron-comment-opp-approval: interactive approval plumbing, exactly
                               // 5 sends/day (one per target group). A swallowed send here means a whole day's
                               // group post for that group never gets approved — Carter, 2026-09-09.
]);

// Bot API methods that are reads / interactive plumbing, never unsolicited noise.
const READ_ONLY_METHODS = new Set([
  'getme',
  'getupdates',
  'getwebhookinfo',
  'setwebhook',
  'deletewebhook',
  'answercallbackquery',
  'getchat',
  'getfile',
]);

function parseMode() {
  const raw = String(process.env.TELEGRAM_CRON_NOTIFICATIONS || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') {
    return { mode: 'off', allow: new Set() };
  }
  if (raw === 'on' || raw === '1' || raw === 'true' || raw === 'all' || raw === 'yes') {
    return { mode: 'on', allow: null };
  }
  if (raw === 'strict') {
    return { mode: 'strict', allow: new Set() };
  }
  return {
    mode: 'list',
    allow: new Set(raw.split(',').map((s) => s.trim()).filter(Boolean)),
  };
}

// Decide whether `jobName` is permitted to push a Telegram message right now.
//
// BUGFIX 2026-08-26 (Atlas): this used to only consult ALWAYS_ALLOW in the
// 'off' branch, so switching to mode='list' (a specific comma-separated
// allowlist) silently dropped every ALWAYS_ALLOW job unless it happened to
// also be named in the list -- contradicting the header comment above,
// which documents 'strict' as the ONLY way to fully silence the floor.
// Found while wiring vercel-deploy-webhook into ALWAYS_ALLOW and discovering
// a real test alert got eaten with TELEGRAM_CRON_NOTIFICATIONS in list mode.
// Now ALWAYS_ALLOW is honored in every mode except 'strict', matching docs.
function isAllowed(jobName) {
  const { mode, allow } = parseMode();
  if (mode === 'strict') return false;
  if (ALWAYS_ALLOW.has(jobName)) return true;
  if (mode === 'on') return true;
  if (mode === 'list') return allow.has(jobName);
  // mode === 'off' and not in ALWAYS_ALLOW.
  return false;
}

// Pull the Bot API method name out of a Telegram URL:
//   https://api.telegram.org/bot<token>/sendMessage -> 'sendmessage'
// The token itself is never read, logged, or retained.
function methodOf(url) {
  const m = /api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)/.exec(url);
  return m ? m[1].toLowerCase() : '';
}

// CONTRACT (Carter, 2026-09-07 — after the cron-video-approval incident):
// a suppressed send is NOT a delivery and must never be mistaken for one.
// The fake payload carries three explicit markers callers can branch on:
//   delivered: false        <- the human did NOT receive this message
//   suppressed: true        <- the gate ate it (configured state, not an error)
//   suppressed_by: 'telegram-gate'
// HTTP status stays 200 and json.ok stays true so passive digest crons that
// only fire-and-forget don't start erroring — but ANY caller that advances
// state on "the human was notified" (pending_approval, *_sent_at, debounce
// stamps) MUST call wasSuppressed() on the parsed body first.
//
// WHY: on 2026-08-17 cron-video-approval got this fake success, marked five
// videos pending_approval, and they sat invisible for three weeks. Same
// silent-failure class as the fill-engine bugs.
function fakeTelegramOk(method) {
  const payload = {
    ok: true,
    delivered: false,
    suppressed: true,
    suppressed_by: 'telegram-gate',
    result: { message_id: 0, date: Math.floor(Date.now() / 1000) },
  };
  const body = JSON.stringify(payload);
  // Prefer a real Response when the runtime has one (Node 18+ / Vercel does).
  if (typeof Response === 'function') {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Suppressed': method || 'send' },
    });
  }
  // Minimal duck-typed fallback.
  return {
    ok: true,
    status: 200,
    statusText: 'OK (suppressed)',
    headers: new Map(),
    json: async () => payload,
    text: async () => body,
  };
}

let _installedFor = null;

/**
 * Gate scheduled Telegram sends for this function instance.
 * @param {string} jobName e.g. 'cron-morning-brief'. Used for the allowlist.
 * @returns {{ jobName: string, muted: boolean }}
 */
function install(jobName) {
  const name = String(jobName || 'unknown-cron');

  // Idempotent: repeated requires in the same lambda must not stack wrappers.
  if (_installedFor === name) return { jobName: name, muted: !isAllowed(name) };
  if (_installedFor !== null) return { jobName: name, muted: !isAllowed(name) };
  _installedFor = name;

  const original = globalThis.fetch;
  if (typeof original !== 'function') return { jobName: name, muted: !isAllowed(name) };

  globalThis.fetch = function gatedFetch(input, init) {
    let url = '';
    try {
      url = typeof input === 'string' ? input : (input && input.url) || '';
    } catch (_) {
      url = '';
    }

    if (url.includes('api.telegram.org')) {
      const method = methodOf(url);
      const isSend = method && !READ_ONLY_METHODS.has(method);
      if (isSend && !isAllowed(name)) {
        // WARN-level and self-describing: a suppressed notification must leave
        // a trace someone can find later. The 2026-08-17 video_library incident
        // cost three weeks because suppression was silent-and-invisible.
        let preview = '';
        try {
          const parsed = init && init.body ? JSON.parse(init.body) : null;
          const text = parsed && (parsed.text || parsed.caption);
          if (text) preview = ` text="${String(text).replace(/\s+/g, ' ').slice(0, 120)}"`;
          if (parsed && parsed.chat_id) preview += ` chat_id=${parsed.chat_id}`;
        } catch (_) { /* body not JSON — no preview */ }
        console.warn(
          `[telegram-gate] SUPPRESSED ${method} from ${name} — NOT delivered ` +
          `(TELEGRAM_CRON_NOTIFICATIONS=${process.env.TELEGRAM_CRON_NOTIFICATIONS || 'unset'}).` +
          preview
        );
        return Promise.resolve(fakeTelegramOk(method));
      }
    }

    return original.call(this, input, init);
  };

  return { jobName: name, muted: !isAllowed(name) };
}

// Did the gate eat this send? Accepts either the parsed Telegram JSON body or
// a caller's own { ok, data } wrapper around it. Callers that advance state on
// "the human was notified" MUST check this before stamping anything.
function wasSuppressed(x) {
  if (!x || typeof x !== 'object') return false;
  if (x.suppressed === true && x.suppressed_by === 'telegram-gate') return true;
  if (x.data && typeof x.data === 'object') return wasSuppressed(x.data);
  return false;
}

module.exports = { install, isAllowed, wasSuppressed, ALWAYS_ALLOW, parseMode };
