#!/usr/bin/env node
'use strict';

// scripts/rearm-tc-reply.js
//
// Put a tc_discovery_responses reply that failed to post BACK into the queue,
// so scripts/fb-group-commenter.js --tc-reply-queue reposts it on its next
// tick. One command, no judgement calls.
//
// WHY THIS EXISTS (2026-10-01): when a threaded reply failed on a DOM/selector
// error, the pipeline messaged Heath with "Post it manually:" and the reply
// text. Daily social ops are Cole's job, and a selector failure is mechanical —
// it should never become a manual task for Heath. The queue now retries
// pre-submit failures on its own; this script is the recovery path for the case
// where the locator genuinely needed a code fix first. After the fix lands,
// re-arm the row and the queue takes it from there.
//
// SAFETY — why re-arming cannot double-post:
//   * Only rows whose reply_error starts 'not_submitted:' are re-armed by
//     default. That marker means the failure was raised BEFORE any keystroke,
//     so nothing reached Facebook. api/_lib/silence-alarm.js already treats
//     this shape as safe-to-retry.
//   * A row whose error says 'submitted but ...' MAY be live on Facebook.
//     Re-arming it is refused unless --i-verified-it-is-absent is passed, which
//     asserts a human actually looked at the thread.
//   * Independently, postReplyToComment() re-checks the thread for an existing
//     reply from our own account before typing anything, and reconciles the row
//     to 'posted' if it finds one. Belt and braces.
//
// Usage:
//   node scripts/rearm-tc-reply.js --row <uuid>
//   node scripts/rearm-tc-reply.js --row <uuid> --i-verified-it-is-absent
//   node scripts/rearm-tc-reply.js --list
//   node scripts/rearm-tc-reply.js --row <uuid> --dry-run

const path = require('path');
const fs = require('fs');

// Load .env.local when running locally (same pattern as fb-group-commenter.js)
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const SAFE_PREFIX = 'not_submitted:';

function makeSbFetch() {
  return async function sbFetch(urlPath, init = {}) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const headers = {
      'Content-Type': 'application/json',
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(init.headers || {}),
    };
    const res = await fetch(`${process.env.SUPABASE_URL}${urlPath}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = null; } }
    return { ok: res.ok, status: res.status, data };
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : null;
}
const has = (name) => process.argv.includes(`--${name}`);

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing (expected in .env.local)');
    process.exit(1);
  }
  const sbFetch = makeSbFetch();

  if (has('list')) {
    const { ok, data } = await sbFetch(
      '/rest/v1/tc_discovery_responses?reply_status=eq.post_failed'
      + '&select=id,commenter_name,reply_error,updated_at,comment_permalink&order=updated_at.desc',
    );
    if (!ok) { console.error('query failed'); process.exit(1); }
    const rows = Array.isArray(data) ? data : [];
    console.log(`${rows.length} row(s) at reply_status='post_failed':\n`);
    for (const r of rows) {
      const safe = String(r.reply_error || '').startsWith(SAFE_PREFIX);
      console.log(`  ${r.id}  [${safe ? 'SAFE to re-arm' : 'NEEDS HUMAN CHECK'}]  ${r.commenter_name}`);
      console.log(`      error: ${String(r.reply_error || '').slice(0, 140)}`);
    }
    return;
  }

  const rowId = arg('row');
  if (!rowId) {
    console.error('usage: node scripts/rearm-tc-reply.js --row <uuid> [--dry-run] [--i-verified-it-is-absent]');
    console.error('       node scripts/rearm-tc-reply.js --list');
    process.exit(1);
  }

  const { ok, data } = await sbFetch(
    `/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(rowId)}`
    + '&select=id,commenter_name,reply_status,reply_error,reply_final,replied,reply_posted_at,comment_permalink',
  );
  if (!ok || !Array.isArray(data) || data.length === 0) {
    console.error(`row ${rowId} not found`);
    process.exit(1);
  }
  const row = data[0];

  console.log(`row:            ${row.id}`);
  console.log(`commenter_name: ${row.commenter_name}`);
  console.log(`reply_status:   ${row.reply_status}`);
  console.log(`reply_error:    ${row.reply_error}`);
  console.log(`replied:        ${row.replied}`);
  console.log(`reply_posted_at:${row.reply_posted_at}`);
  console.log(`thread:         ${row.comment_permalink}`);
  console.log('');

  if (row.replied || row.reply_posted_at) {
    console.error('REFUSING: this row is already recorded as posted. Re-arming would double-reply.');
    process.exit(2);
  }
  if (!String(row.reply_final || '').trim()) {
    console.error('REFUSING: reply_final is empty — there is no approved text to post.');
    process.exit(2);
  }
  if (row.reply_status !== 'post_failed') {
    console.error(`REFUSING: reply_status is '${row.reply_status}', expected 'post_failed'. Nothing to re-arm.`);
    process.exit(2);
  }

  const errStr = String(row.reply_error || '');
  const safe = errStr.startsWith(SAFE_PREFIX);
  if (!safe && !has('i-verified-it-is-absent')) {
    console.error('REFUSING: reply_error does not start with "not_submitted:", so this reply MAY ALREADY BE LIVE');
    console.error('on Facebook. Open the thread above and confirm the reply is absent, then re-run with');
    console.error('  --i-verified-it-is-absent');
    process.exit(2);
  }
  if (!safe) {
    console.log('NOTE: proceeding on an explicit human assertion that the reply is absent from the thread.');
  }

  if (has('dry-run')) {
    console.log("[dry-run] would set reply_status='approved', reply_error=null. Nothing written.");
    return;
  }

  const patch = await sbFetch(
    `/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(rowId)}&reply_status=eq.post_failed`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        reply_status: 'approved',
        reply_error: null,
        reply_approved_at: new Date().toISOString(), // restart the 1-hour reply SLA clock
        updated_at: new Date().toISOString(),
      }),
    },
  );
  if (!patch.ok || !Array.isArray(patch.data) || patch.data.length === 0) {
    console.error(`re-arm FAILED (status ${patch.status}) — row may have changed underneath. Nothing written.`);
    process.exit(1);
  }
  console.log("re-armed: reply_status='approved'. The next --tc-reply-queue tick will post it.");
  console.log('It re-checks the thread for an existing reply first, so this cannot double-post.');
}

main().catch((err) => { console.error(err); process.exit(1); });
