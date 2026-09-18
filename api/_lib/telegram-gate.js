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
//
// DEFAULT DIRECTION (Carter, 2026-09-18 — reconsidered per Heath's ask after
// TWO multi-week silent-mute incidents: cron-social-digest missing from
// ALWAYS_ALLOW for a month from 2026-08-16, then the job-name collision
// below hiding cron-tc-reply-approval from ~2026-09-12).
//
// Kept default-CLOSED rather than flipping to deliver-unless-muted. The real
// alternative -- deliver by default, mute a short explicit list -- was
// rejected for a concrete reason, not inertia: ~68 of the ~82 job names
// wired into this gate are recurring digests/reports (morning brief, weekly
// scorecard, engagement summaries, etc.) that Heath explicitly asked to go
// quiet on 2026-08-16 ("I want to just turn them off... all the cron job
// things"), repeated 3 more times since (07-28/08-06/08-07/08-25 notification-
// fatigue complaints in CLAUDE.md Section 0). Flipping the default would
// resurrect all ~68 at once on the next deploy with an unset env var --
// trading a rare, catchable failure (a forgotten allowlist entry) for a
// guaranteed regression of the exact noise Heath has now asked to stop 4+
// times. That is a real cost, not a hypothetical one -- the same class of
// justification the "cost, spam risk" escape hatch below is meant for.
//
// So the compensating control is the other half of the ask: make a forgotten
// entry LOUD instead of silent. Every suppressed send is now logged to
// telegram_gate_suppressions (best-effort, never blocks the caller -- see
// recordSuppression()), and api/_lib/silence-alarm.js's
// checkTelegramGateSuppressionSilence() alarms Heath by job name once a job
// has kept trying and getting eaten for an unusual stretch. A forgotten
// ALWAYS_ALLOW entry now surfaces within days through the alarm that already
// reaches him every morning, instead of silently for a month.
//
// AUDIT (2026-09-18): cross-referencing every install() call site against
// ALWAYS_ALLOW found FIVE more jobs in the identical class already on the
// floor (interactive human-approval plumbing, not digest noise) that were
// still muted by default -- the exact incident class this file's own
// fakeTelegramOk() comment describes, just not yet caught:
//   cron-video-approval           -- literally the job named in that incident
//   cron-send-for-approval        -- daily social-post approval cards
//   cron-send-engagement-approvals -- engagement-candidate approval cards
//   cron-cold-email-review        -- cold-email batch approval gate
//   cron-auto-approve             -- veto-window STOP/PREVIEW notice
// All five added below. Each was silently eaten by default until this fix;
// api/_lib/telegram-send-retry.js's alertFinalFailure() also claimed to
// "bypass" this gate for cron-send-for-approval's final-failure alert, but
// that alert is a plain fetch() through the SAME wrapped globalThis.fetch --
// it was never actually exempt until cron-send-for-approval landed on
// ALWAYS_ALLOW just now.
//
// BUGFIX 2026-09-17 (Carter) — MULTIPLEXED DISPATCHER JOB-NAME COLLISION.
// api/_lib/cron-multiplex.js (Atlas, 2026-09-16) fans out N sub-jobs from ONE
// dispatcher route IN-PROCESS (e.g. api/cron-dispatch-every30.js requires 9
// job modules, each calling `telegramGate.install(<its own name>)` at module
// top level). install() used to bind the gate PERMANENTLY to whichever job
// name called it FIRST (`_installedFor`, now removed) — every later
// install() call from a sibling module in the same require chain was a
// silent no-op, so ALL 9 jobs' Telegram sends were gated under the FIRST
// job's name for the lifetime of the process. Found via
// tc_discovery_responses: cron-tc-reply-approval (in ALWAYS_ALLOW) reported
// 'ok' on every run, drafted replies correctly, but every send came back
// wasSuppressed()=true and nothing ever left reply_status='new' — because
// cron-publish-approved (first in cron-dispatch-every30's HANDLERS array,
// NOT in ALWAYS_ALLOW) had locked the gate to its own name.
//
// FIX: AsyncLocalStorage-scoped job context. Each dispatcher invocation runs
// every sub-handler inside `runWithJobContext(jobName, fn)` (see
// cron-multiplex.js's runGroup); gatedFetch reads the ACTIVE job name from
// that per-call-stack context, not a module-level variable — correct even
// when multiple handlers run concurrently via Promise.all. A route invoked
// directly (not through a dispatcher, no context set) falls back to the
// name passed to the first install() call, preserving old single-job
// behavior exactly.

const { AsyncLocalStorage } = require('async_hooks');
const jobContext = new AsyncLocalStorage();

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
  'cron-auto-reply-veto-check', // auto-reply-with-veto resolver + 60-min SLA alert (supabase/migrations/
                             // 20260916_auto_reply_veto.sql). A swallowed veto-resolution confirmation or SLA
                             // breach alert here is the exact failure mode Heath is trying to avoid by having
                             // this feature at all — Carter, 2026-09-16.
  'cron-comment-opp-approval', // daily comment-opportunity Approve/Edit/Skip loop (comment_opportunities).
                               // Same class as cron-tc-reply-approval: interactive approval plumbing, capped at
                               // 12 sends/day, silent when the hunt finds nothing. A swallowed send here stalls
                               // the entire daily engagement pipeline — Carter, 2026-09-08.
  'cron-daily-group5-posts',  // daily 5-group-post Approve/Edit/Skip loop (group_posts pipeline='daily5').
                               // Same class as cron-comment-opp-approval: interactive approval plumbing, exactly
                               // 5 sends/day (one per target group). A swallowed send here means a whole day's
                               // group post for that group never gets approved — Carter, 2026-09-09.
  'cron-verify-zernio-deliveries', // */30 — sends nothing on a healthy pipeline; only alerts on a confirmed
                               // Zernio delivery failure, a 30%+ 24h failure-rate crisis, or a video_library
                               // post that's gone unconfirmed past the stale window (Pipeline B, added
                               // 2026-09-17). Gating this is the exact silent-failure class the alert exists
                               // to close — a video marked 'posted' that never actually delivered must not
                               // depend on TELEGRAM_CRON_NOTIFICATIONS being set — Carter, 2026-09-17.
  'cron-retry-unsent-approvals', // */30 — bounded retry for group_posts drafts whose approval card never
                                  // reached Heath (daily5 + listing-groups pipelines). Gating THIS job would
                                  // defeat its entire purpose (delivering an approval Heath already missed once)
                                  // and its final-failure alert is exactly the outage signal this floor exists
                                  // for — Carter, 2026-09-12.
  'cron-silence-alarm', // daily. Originally: sends NOTHING on a healthy pipeline, only alerts when a
                        // platform has gone dark, approvals are stuck, drafts never reached Telegram, or
                        // a status is accumulating rows without moving — the exact class of alert the
                        // 2026-09-12 Instagram/TikTok silence (18 days unnoticed) proves must never be
                        // gateable. EXTENDED 2026-09-16 into a daily morning heartbeat (posted-last-24h,
                        // scheduled-next-7d, stuck items, comments awaiting reply, cron sanity) that now
                        // sends EVERY run, healthy or not — Heath's explicit ask, "consistent posting" top
                        // priority. Stays on this list either way: a digest he asked to always see is not
                        // the noise this gate exists to quiet — Carter, 2026-09-12 / 2026-09-16.
  'cron-regression-suite', // daily 09:00 UTC. Qualifies for this floor ONLY because its alert policy was
                           // rewritten at the same time (api/_lib/regression-alert-policy.js, 2026-09-17,
                           // backlog B3): it no longer pushes on RED unconditionally, it pushes when the
                           // FAILURE SET CHANGES — a PASS→FAIL regression, a FAIL→PASS recovery, a new
                           // failing test, or a return to green — plus one still-broken reminder per week.
                           // That makes it exception-only, which is the bar this list documents.
                           // Un-gating it WITHOUT that policy change would have been worse than leaving it
                           // gated: the suite has been RED with an identical 6-test failure set every day
                           // since 2026-07-12, so it would have sent the same message every morning until
                           // Heath tuned it out. What it was doing instead: a genuine regression on
                           // cron.cron-deadline-reminders (2026-09-10) was swallowed here and nobody knew.
                           // A regression detector nobody hears is the silent-failure class this whole
                           // system exists to close — feedback_silent-failure-is-the-enemy.md.
  'cron-video-approval', // sends the Approve/Reject card for a rendered video/skit (video_library /
                          // skits). THE job this file's own fakeTelegramOk() comment names: on
                          // 2026-08-17 it got the fake success, marked five videos pending_approval, and
                          // they sat invisible for three weeks. wasSuppressed() now reverts state on a
                          // suppressed send instead of lying about it (fixed 2026-09-07) -- but it was
                          // still muted by default until this audit, meaning the approval card itself
                          // simply never reached Heath. Same class as cron-tc-reply-approval /
                          // cron-comment-opp-approval already above — Carter, 2026-09-18.
  'cron-send-for-approval', // daily social_posts Approve/Reject/Edit cards. Also carries
                             // api/_lib/telegram-send-retry.js's alertFinalFailure() bounded-retry
                             // escape hatch, whose own comment claims it sends "even if
                             // TELEGRAM_CRON_NOTIFICATIONS would otherwise gate it" — false until this
                             // entry existed, since that alert is a plain fetch() through this SAME
                             // wrapped globalThis.fetch, not an actual bypass — Carter, 2026-09-18.
  'cron-send-engagement-approvals', // engagement_candidates Approve/Reject cards to DossieMarketingBot,
                                     // 15-min cadence. Same interactive-approval class as the others on
                                     // this floor — Carter, 2026-09-18.
  'cron-cold-email-review', // the ONLY path that flips a cold-email batch to approval_status='approved'
                             // (built 2026-08-16 after the 2026-08-13 unapproved-send incident). A
                             // muted approval card here means the batch just sits at pending_approval
                             // forever — silently defeating the exact gate it exists to be — Carter,
                             // 2026-09-18.
  'cron-auto-approve', // sends the STOP/PREVIEW notice for veto-mode content and the fb_comment_replies
                        // veto card — Heath's only visible chance to stop an auto-post before it goes
                        // out under his name/license. Muting this is a silent auto-post, not digest
                        // noise — Carter, 2026-09-18.
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

// ─── suppression logging (Carter, 2026-09-18) ─────────────────────────────
//
// A suppressed send used to leave a trace ONLY in Vercel's function logs
// (console.warn below) -- fine for debugging a failure you already know
// about, useless for discovering one you don't. cron-social-digest's month
// of silence and cron-tc-reply-approval's job-collision outage were both
// found by Heath noticing a SYMPTOM (no digest, stuck replies), not by
// anything querying "what has this gate eaten lately." This writes every
// suppression to telegram_gate_suppressions (see
// supabase/migrations/20260918_telegram_gate_suppressions.sql) so
// api/_lib/silence-alarm.js can alarm on it directly.
//
// Best-effort by design: a logging failure (missing env, network blip,
// migration not yet applied) must NEVER throw or block the caller -- the
// caller is waiting on what it thinks is a Telegram send, and this is
// diagnostic plumbing bolted onto the side of it, not a dependency of it.
// Bounded with a short timeout for the same reason.
const SUPPRESSION_LOG_TIMEOUT_MS = 3000;

async function recordSuppression(originalFetch, { jobName, method, url, init, mode }) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey || typeof originalFetch !== 'function') return;

  let chatId = null;
  let textPreview = null;
  try {
    const parsed = init && init.body ? JSON.parse(init.body) : null;
    if (parsed) {
      if (parsed.chat_id !== undefined) chatId = String(parsed.chat_id);
      const text = parsed.text || parsed.caption;
      if (text) textPreview = String(text).replace(/\s+/g, ' ').slice(0, 200);
    }
  } catch (_) { /* body not JSON — no preview, still log the job/method */ }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), SUPPRESSION_LOG_TIMEOUT_MS) : null;
  try {
    await originalFetch(`${supabaseUrl}/rest/v1/telegram_gate_suppressions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        job_name: jobName,
        method: method || null,
        chat_id: chatId,
        text_preview: textPreview,
        mode: mode || null,
      }),
      signal: controller ? controller.signal : undefined,
    });
  } catch (err) {
    // Non-fatal. Table may not exist yet (migration not applied), Supabase
    // may be briefly unreachable, etc. -- the suppressed-send response to
    // the ORIGINAL caller must go out regardless.
    console.error('[telegram-gate] suppression log insert failed (non-fatal):', err && err.message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Name captured by the FIRST install() call in this process — the correct
// (and only) name for a standalone route invocation. Only used as a
// fallback when no per-call jobContext is active (see runWithJobContext).
let _fallbackName = null;
let _fetchWrapped = false;

/**
 * Gate scheduled Telegram sends for this function instance.
 * @param {string} jobName e.g. 'cron-morning-brief'. Used for the allowlist.
 * @returns {{ jobName: string, muted: boolean }}
 */
function install(jobName) {
  const name = String(jobName || 'unknown-cron');
  if (_fallbackName === null) _fallbackName = name;

  // Idempotent: the global fetch wrap itself only needs to happen once per
  // process — every install() call after the first just registers a
  // (possibly different) fallback candidate, which we don't overwrite; the
  // REAL per-call resolution happens in gatedFetch via jobContext.
  if (!_fetchWrapped) {
    const original = globalThis.fetch;
    if (typeof original === 'function') {
      globalThis.fetch = function gatedFetch(input, init) {
        let url = '';
        try {
          url = typeof input === 'string' ? input : (input && input.url) || '';
        } catch (_) {
          url = '';
        }

        if (url.includes('api.telegram.org')) {
          // Resolve the ACTIVE job for THIS call, not whichever job happened
          // to call install() first. Set by runWithJobContext() around each
          // sub-handler invocation in cron-multiplex.js; absent for a
          // standalone (non-multiplexed) route, where the single install()
          // call's own name is correct.
          const activeName = jobContext.getStore() || _fallbackName;
          const method = methodOf(url);
          const isSend = method && !READ_ONLY_METHODS.has(method);
          if (isSend && !isAllowed(activeName)) {
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
            const modeValue = process.env.TELEGRAM_CRON_NOTIFICATIONS || 'unset';
            console.warn(
              `[telegram-gate] SUPPRESSED ${method} from ${activeName} — NOT delivered ` +
              `(TELEGRAM_CRON_NOTIFICATIONS=${modeValue}).` +
              preview
            );
            // Durable, queryable record (best-effort, never blocks/throws —
            // see recordSuppression()'s own comment). `original` is the
            // pre-wrap fetch, so this call itself is never re-intercepted.
            return recordSuppression(original, { jobName: activeName, method, url, init, mode: modeValue })
              .catch(() => {})
              .then(() => fakeTelegramOk(method));
          }
        }

        return original.call(this, input, init);
      };
      _fetchWrapped = true;
    }
  }

  return { jobName: name, muted: !isAllowed(jobContext.getStore() || name) };
}

/**
 * Run `fn` with `jobName` bound as the ACTIVE job for any Telegram sends it
 * (or anything it awaits) makes, regardless of which job's install() call
 * happened to wrap fetch first. Used by cron-multiplex.js's runGroup so each
 * multiplexed sub-handler is gated under its OWN name, including when
 * several run concurrently via Promise.all — AsyncLocalStorage keeps each
 * call's context isolated per async execution chain.
 * @template T
 * @param {string} jobName
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
function runWithJobContext(jobName, fn) {
  return jobContext.run(String(jobName || 'unknown-cron'), fn);
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

module.exports = { install, isAllowed, wasSuppressed, ALWAYS_ALLOW, parseMode, runWithJobContext, recordSuppression };
