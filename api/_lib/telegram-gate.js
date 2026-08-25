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
function isAllowed(jobName) {
  const { mode, allow } = parseMode();
  if (mode === 'on') return true;
  if (mode === 'strict') return false;
  if (mode === 'list') return allow.has(jobName);
  // mode === 'off' — only the outage-alert floor survives.
  return ALWAYS_ALLOW.has(jobName);
}

// Pull the Bot API method name out of a Telegram URL:
//   https://api.telegram.org/bot<token>/sendMessage -> 'sendmessage'
// The token itself is never read, logged, or retained.
function methodOf(url) {
  const m = /api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)/.exec(url);
  return m ? m[1].toLowerCase() : '';
}

function fakeTelegramOk(method) {
  const payload = {
    ok: true,
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
        // Visible in Vercel logs so "why did it go quiet" is answerable, but
        // no message reaches Heath's phone.
        console.log(
          `[telegram-gate] suppressed ${method} from ${name} ` +
          `(TELEGRAM_CRON_NOTIFICATIONS=${process.env.TELEGRAM_CRON_NOTIFICATIONS || 'unset'})`
        );
        return Promise.resolve(fakeTelegramOk(method));
      }
    }

    return original.call(this, input, init);
  };

  return { jobName: name, muted: !isAllowed(name) };
}

module.exports = { install, isAllowed, ALWAYS_ALLOW, parseMode };
