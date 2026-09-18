#!/usr/bin/env node
'use strict';

/**
 * Regression test: every job that sends an interactive Telegram approval
 * MUST be in api/_lib/telegram-gate.js's ALWAYS_ALLOW set.
 *
 * THE FAILURE (why this test exists)
 * -----------------------------------
 * Seven approval/veto jobs have now been found silently muted by the
 * TELEGRAM_CRON_NOTIFICATIONS kill switch (default OFF since 2026-08-16),
 * discovered ONE AT A TIME, each after weeks of real silence:
 *   cron-video-approval, cron-tc-reply-approval, cron-comment-opp-approval,
 *   cron-daily-group5-posts, cron-retry-unsent-approvals,
 *   cron-send-for-approval, cron-send-engagement-approvals,
 *   cron-cold-email-review, cron-auto-approve, cron-content-pipeline-review,
 *   cron-engagement-review, cron-generate-skit, cron-post-videos,
 *   cron-reddit-scanner, cron-weekly-batch-digest, cron-publish-approved.
 * (See api/_lib/telegram-gate.js's ALWAYS_ALLOW comments for each incident.)
 * Every one of them was found by a human reading code, not by anything that
 * runs on every commit. That is the actual bug: the DETECTION was manual.
 *
 * THE FIX
 * -------
 * A job "sends an interactive approval" if it (a) calls
 * telegramGate.install(jobName) — i.e. its Telegram sends are gate-wrapped —
 * AND (b) its own source constructs a Telegram message with a real
 * `callback_data` button (Approve/Reject/Skip/STOP/Retry/"Approve all" — the
 * literal mechanism behind every one of those labels is a callback_data
 * entry in an inline_keyboard). That combination is checked mechanically
 * below by scanning every api/*.js file — no human judgment call about
 * which jobs "count" required. Any job matching both conditions that is NOT
 * in ALWAYS_ALLOW fails this test.
 *
 * A webhook handler (telegram-webhook.js, desktop-confirm-callback.js,
 * notify-founding-application.js, admin-*-callback endpoints) that never
 * calls telegramGate.install() is correctly invisible to this scan — by
 * design those aren't gated at all (see telegram-gate.js's own "WHAT THIS IS
 * NOT" header), so they can't be silently muted by this switch.
 *
 * This is a pure static-source scan: zero network access, zero production
 * access, zero mocking required.
 *
 * Run manually:
 *   node scripts/regression-telegram-gate-approval-jobs-allowlisted.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const API_DIR = path.join(REPO, 'api');

// Matches both call shapes seen in the codebase:
//   require('./_lib/telegram-gate').install('job-name');
//   const telegramGate = require('./_lib/telegram-gate'); telegramGate.install('job-name');
const INSTALL_RE = /telegram-gate['"]\)\s*\.\s*install\(\s*['"]([^'"]+)['"]\s*\)|\.install\(\s*['"]([^'"]+)['"]\s*\)/g;

// The literal signal a message carries a tappable approval/veto/retry
// action: a callback_data entry inside an inline_keyboard. This is the
// actual mechanism behind every Approve/Reject/Skip/STOP/"Approve all"/Retry
// button in this codebase — matching on it directly (rather than the button
// LABEL text, which varies and shows up in unrelated comments/strings too)
// is what keeps this check from drowning in false positives.
const CALLBACK_DATA_RE = /callback_data\s*:/;

function listApiFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listApiFilesRecursive(full));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

function findInstalledJobNames(source) {
  const names = new Set();
  let m;
  INSTALL_RE.lastIndex = 0;
  while ((m = INSTALL_RE.exec(source))) {
    const name = m[1] || m[2];
    if (name) names.add(name);
  }
  return names;
}

(async () => {
  const failures = [];
  const check = (name, fn) => {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures.push(name); console.error(`  FAIL  ${name}\n        ${err.message}`); }
  };

  const gate = require(path.join(REPO, 'api', '_lib', 'telegram-gate.js'));
  const files = listApiFilesRecursive(API_DIR);

  // { jobName -> [relative file paths] }
  const approvalJobs = new Map();

  for (const file of files) {
    const rel = path.relative(REPO, file);
    const source = fs.readFileSync(file, 'utf8');
    const jobNames = findInstalledJobNames(source);
    if (jobNames.size === 0) continue; // not gated at all -- out of scope
    if (!CALLBACK_DATA_RE.test(source)) continue; // gated but no tappable button in THIS file

    for (const jobName of jobNames) {
      if (!approvalJobs.has(jobName)) approvalJobs.set(jobName, []);
      approvalJobs.get(jobName).push(rel);
    }
  }

  console.log(`\nScanned ${files.length} files under api/. Found ${approvalJobs.size} job name(s) that both install() the gate and send a callback_data button:\n`);
  for (const [jobName, sources] of approvalJobs) {
    console.log(`  ${jobName}  <-  ${sources.join(', ')}`);
  }
  console.log('');

  // ---- Sanity controls: prove the scan itself works before trusting it ---
  check('sanity: scan finds the KNOWN incident job (cron-video-approval)', () => {
    assert.ok(approvalJobs.has('cron-video-approval'),
      'cron-video-approval must be detected -- if it is not, the scan itself is broken ' +
      '(false negatives are worse than false positives for this test)');
  });
  check('sanity: a routine digest with no buttons is correctly NOT flagged (cron-morning-brief)', () => {
    assert.ok(!approvalJobs.has('cron-morning-brief'),
      'cron-morning-brief has no callback_data button and must not be swept into this check -- ' +
      'if it is, the regex is over-matching');
  });

  // ---- The actual gate: every detected approval job must be allow-listed --
  console.log('Every detected job must be in ALWAYS_ALLOW:\n');
  const unlisted = [];
  for (const [jobName, sources] of approvalJobs) {
    check(`isAllowed('${jobName}') with switch unset/off (${sources.join(', ')})`, () => {
      if (!gate.ALWAYS_ALLOW.has(jobName)) unlisted.push({ jobName, sources });
      assert.strictEqual(gate.isAllowed(jobName), true,
        `'${jobName}' sends a real callback_data button (Approve/Reject/Skip/STOP/Retry) from ` +
        `${sources.join(', ')} but is NOT in ALWAYS_ALLOW -- with TELEGRAM_CRON_NOTIFICATIONS ` +
        `unset (the default), every tap-to-act message this job sends is silently eaten. Add ` +
        `'${jobName}' to ALWAYS_ALLOW in api/_lib/telegram-gate.js.`);
    });
  }

  console.log('');
  if (failures.length) {
    console.error(`RESULT: FAIL (${failures.length} failing)`);
    if (unlisted.length) {
      console.error('\nMissing from ALWAYS_ALLOW:');
      for (const { jobName, sources } of unlisted) {
        console.error(`  - ${jobName}  (${sources.join(', ')})`);
      }
    }
    process.exit(1);
  }
  console.log('RESULT: PASS — every interactive-approval job is allow-listed against the kill switch');
  process.exit(0);
})().catch((err) => {
  console.error('RESULT: FAIL (harness crash)', err);
  process.exit(1);
});
