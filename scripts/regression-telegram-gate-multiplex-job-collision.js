#!/usr/bin/env node
'use strict';

/**
 * Regression test for the 2026-09-17 multiplexed-dispatcher job-name
 * collision in api/_lib/telegram-gate.js.
 *
 * THE FAILURE
 * -----------
 * api/_lib/cron-multiplex.js (Atlas, 2026-09-16) fans out N job modules
 * in-process from one dispatcher route (e.g. api/cron-dispatch-every30.js
 * requires 9 modules). Each module calls `telegramGate.install(<its own
 * name>)` at its own top level. The OLD install() bound the gate
 * PERMANENTLY to whichever job called it FIRST (`_installedFor` guard) --
 * every later install() from a sibling module was a silent no-op. Result:
 * ALL 9 jobs' Telegram sends were gated under the FIRST job's name for the
 * life of the process. Concretely: cron-publish-approved (first in
 * cron-dispatch-every30's HANDLERS array, NOT in ALWAYS_ALLOW) locked the
 * gate, so cron-tc-reply-approval's sends (cron-tc-reply-approval IS in
 * ALWAYS_ALLOW) were suppressed anyway -- discovered via 14 real
 * tc_discovery_responses rows stuck at reply_status='new' for up to 22h
 * with cron_runs reporting 'ok' on every run.
 *
 * THE FIX
 * -------
 * AsyncLocalStorage-scoped job context (runWithJobContext). Each
 * multiplexed sub-handler is invoked inside
 * `telegramGate.runWithJobContext(h.name, () => h.mod(req, shim))`
 * (cron-multiplex.js's runGroup) so gatedFetch resolves the ACTIVE job
 * from the current async context, not a module-level variable frozen at
 * the first install() call. A standalone (non-multiplexed) route with no
 * context set still falls back to the first install()'s name, unchanged.
 *
 * Run manually:
 *   node scripts/regression-telegram-gate-multiplex-job-collision.js
 */

const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');

let passed = 0;
function check(label, fn) {
  fn();
  passed++;
  console.log(`  PASS: ${label}`);
}

async function main() {
  // Stub the network BEFORE telegram-gate.js ever wraps fetch, so an
  // "allowed" send in this test hits our stub, never the real internet.
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body });
    return {
      ok: true,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 999 } }),
    };
  };

  delete process.env.TELEGRAM_CRON_NOTIFICATIONS; // default 'off' mode: only ALWAYS_ALLOW gets through

  const gate = require(path.join(REPO, 'api', '_lib', 'telegram-gate.js'));

  // Simulate cron-multiplex's require() order inside ONE dispatcher process:
  // a job NOT in ALWAYS_ALLOW requires (and installs) telegram-gate FIRST --
  // exactly like cron-publish-approved being position 0 in
  // cron-dispatch-every30's HANDLERS array.
  gate.install('cron-not-in-allowlist');
  // A sibling module later in the same require chain, WHICH IS in
  // ALWAYS_ALLOW, does its own top-level install() call too -- exactly like
  // cron-tc-reply-approval.js line 51.
  gate.install('cron-tc-reply-approval');

  // Tag-based (not array-length-based) so two calls can run concurrently
  // via Promise.all without racing each other over a shared reset.
  let tagCounter = 0;
  async function sendAsJob(jobName) {
    const tag = `probe-${jobName}-${tagCounter++}`;
    const before = calls.length;
    await gate.runWithJobContext(jobName, async () => {
      await fetch('https://api.telegram.org/botFAKE/sendMessage', {
        method: 'POST',
        body: JSON.stringify({ chat_id: 1, text: tag }),
      });
    });
    // true = our stub actually saw a NEW call carrying this exact tag =
    // the send reached the network = NOT suppressed.
    return calls.slice(before).some((c) => typeof c.body === 'string' && c.body.includes(tag));
  }

  console.log('Test 1: multiplexed sub-handler gated under its OWN name, not the first-installed sibling\'s');

  const tcReplyWentThrough = await sendAsJob('cron-tc-reply-approval');
  check(
    'cron-tc-reply-approval (ALWAYS_ALLOW) send reaches the network even though cron-not-in-allowlist installed first',
    () => assert.strictEqual(tcReplyWentThrough, true, 'cron-tc-reply-approval send was wrongly suppressed under the first-installed job\'s name'),
  );

  const otherJobSuppressed = await sendAsJob('cron-not-in-allowlist');
  check(
    'a job genuinely NOT in ALWAYS_ALLOW is still correctly suppressed (the gate still gates)',
    () => assert.strictEqual(otherJobSuppressed, false, 'cron-not-in-allowlist send should have been suppressed'),
  );

  // A THIRD sibling, also not allow-listed, run concurrently with an
  // allow-listed one -- proves AsyncLocalStorage isolates contexts under
  // Promise.all, the actual execution shape of cron-multiplex's runGroup.
  console.log('\nTest 2: concurrent multiplexed handlers (Promise.all) do not bleed context into each other');
  const [aWentThrough, bWentThrough] = await Promise.all([
    sendAsJob('cron-not-in-allowlist'),
    sendAsJob('cron-tc-reply-approval'),
  ]);
  check(
    'concurrent non-allowed job stays suppressed even while an allowed job runs at the same time',
    () => assert.strictEqual(aWentThrough, false),
  );
  check(
    'concurrent allowed job still gets through even while a non-allowed job runs at the same time',
    () => assert.strictEqual(bWentThrough, true),
  );

  console.log('\nTest 3: standalone (non-multiplexed) route with no context falls back to the first install() name — old single-job behavior preserved');
  calls.length = 0;
  await fetch('https://api.telegram.org/botFAKE/sendMessage', {
    method: 'POST',
    body: JSON.stringify({ chat_id: 1, text: 'probe-no-context' }),
  });
  check(
    'no active job context -> resolves to the first-installed fallback name (cron-not-in-allowlist) -> suppressed',
    () => assert.strictEqual(calls.length, 0),
  );

  console.log(`\n${passed} passed`);
  console.log('ALL PASS');
}

main().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});
