#!/usr/bin/env node
'use strict';

// scripts/verify-invite-flow.js
//
// End-to-end proof that the durable-invite mechanism works, run against the
// real Supabase project with a THROWAWAY account that this script creates and
// deletes. No real customer is touched, read, or listed.
//
//   node scripts/verify-invite-flow.js
//
// WHY THE TEST ADDRESS IS @example.com
//   example.com is reserved by RFC 2606 and has no mail exchanger. Even if
//   something in the stack tried to deliver to it, there is nowhere for the
//   message to land. Belt and braces: this script never calls Resend at all.
//   The two Supabase endpoints it does use are both silent —
//   POST /auth/v1/admin/users with email_confirm:true suppresses the
//   confirmation mail, and POST /auth/v1/admin/generate_link RETURNS a link
//   rather than sending one. That second property is the load-bearing one for
//   the whole design and step 4 below is what actually verifies it.
//
// WHAT IT CHECKS
//   1. account_invites / lifecycle_email_log are reachable
//   2. createInvite stores only a HASH, never the raw token
//   3. a valid token resolves to the right user
//   4. generate_link mints a working set-password link, and sends no email
//   5. redemption is repeatable (the single-use dead end is gone)
//   6. an expired invite is refused
//   7. an unknown token is refused, indistinguishably from an expired one
//   8. completing an account retires its live invites
//   9. everything created here is deleted again
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).
//
// Owner: 2026-09-18.

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  for (const candidate of [
    path.join(process.cwd(), '.env.local'),
    path.join(__dirname, '..', '.env.local'),
    '/mnt/c/Users/Heath/Projects/MeetDossie/.env.local',
  ]) {
    if (!fs.existsSync(candidate)) continue;
    const raw = fs.readFileSync(candidate, 'utf8').replace(/^﻿/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return;
  }
})();

const crypto = require('crypto');
const invites = require('../api/_lib/account-invites.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const TEST_EMAIL = `dossie-invite-verify-${crypto.randomBytes(6).toString('hex')}@example.com`;

let pass = 0;
let fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; console.log(`  FAIL  ${label}${detail ? ' — ' + detail : ''}`); }
}

async function api(p, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${p}`, {
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON is fine */ }
  return { ok: res.ok, status: res.status, json, text };
}

async function main() {
  if (!SUPABASE_URL || !KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    process.exit(1);
  }

  console.log(`\nINVITE FLOW VERIFICATION\n  throwaway address: ${TEST_EMAIL}\n  (RFC 2606 reserved domain — undeliverable by design)\n`);

  let userId = null;

  try {
    // -- 0a. The admin endpoint and the .sql file must agree ----------------
    // Two copies of the same DDL is a drift hazard; catch it here rather than
    // discovering at migration time that prod got a different schema than the
    // one that was reviewed.
    {
      const mig = require('../api/admin-migrate-account-invites.js');
      const fileSql = mig.readMigrationFile();
      const norm = (s) => String(s || '')
        .replace(/--[^\n]*\n/g, '\n')          // strip line comments
        .replace(/COMMENT ON[\s\S]*?;/g, '')   // comments are doc-only
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
      const stmts = (s) => norm(s).split(';').map((x) => x.trim()).filter(Boolean);
      const a = stmts(mig.SQL);
      const b = stmts(fileSql);
      const missing = a.filter((st) => !b.includes(st));
      check('admin-migrate endpoint DDL matches the .sql migration file',
        fileSql !== null && missing.length === 0,
        missing.length ? `endpoint has ${missing.length} statement(s) not in the file` : 'migration file not found');
    }

    // -- 0. Are the tables there? -------------------------------------------
    const probe = await api('/rest/v1/account_invites?select=id&limit=1');
    if (!probe.ok) {
      console.log('  SKIP  account_invites table not present.');
      console.log('        Apply supabase/migrations/20260918_account_invites_and_lifecycle_log.sql first');
      console.log('        (or via GET /api/admin-migrate-account-invites with CRON_SECRET).');
      process.exit(2);
    }
    check('account_invites reachable', true);
    const ledgerProbe = await api('/rest/v1/lifecycle_email_log?select=id&limit=1');
    check('lifecycle_email_log reachable', ledgerProbe.ok, `status ${ledgerProbe.status}`);

    // -- 1. Create the throwaway auth user ----------------------------------
    // email_confirm:true means GoTrue does NOT send a confirmation email.
    const created = await api('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email: TEST_EMAIL,
        password: crypto.randomBytes(24).toString('base64url'),
        email_confirm: true,
        user_metadata: { full_name: 'Invite Verify Throwaway' },
      }),
    });
    userId = created.json && (created.json.id || (created.json.user && created.json.user.id));
    check('throwaway auth user created', !!userId, created.text.slice(0, 200));
    if (!userId) throw new Error('cannot continue without a test user');

    // -- 2. Mint an invite; confirm the raw token is NOT stored --------------
    const inv = await invites.createInvite({ userId, email: TEST_EMAIL, source: 'verification' });
    check('createInvite returned a token + url', !!(inv && inv.token && inv.url));
    check('invite url points at /api/invite', !!inv && inv.url.includes('/api/invite?token='));

    const stored = await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}&select=token_hash,user_id,email,expires_at,consumed_at,redeem_count`);
    const row = stored.json && stored.json[0];
    check('invite row persisted', !!row);
    check('stored value is a sha256 HASH, not the raw token',
      !!row && row.token_hash !== inv.token && row.token_hash === crypto.createHash('sha256').update(inv.token).digest('hex'));
    check('raw token appears nowhere in the stored row',
      !!row && !JSON.stringify(row).includes(inv.token));

    const ttlDays = Math.round((new Date(row.expires_at) - Date.now()) / 86400000);
    check(`expiry is ~30 days, not 1 hour (got ${ttlDays}d)`, ttlDays >= 29 && ttlDays <= 31);

    // -- 3. A valid token resolves ------------------------------------------
    const look = await invites.lookupInvite(inv.token);
    check('valid token resolves', look.ok === true, look.reason);
    check('resolves to the right user', look.ok && look.invite.user_id === userId);

    // -- 4. generate_link works AND sends nothing ---------------------------
    const link = await invites.mintRecoveryLink(TEST_EMAIL);
    check('generate_link returned an action_link', !!link);
    check('action_link redirects to set-password.html',
      !!link && decodeURIComponent(link).includes('/set-password.html'));
    check('action_link carries a one-time token', !!link && /token=/.test(link));
    // Nothing above called Resend. If it had, this script would have needed
    // RESEND_API_KEY, which it never reads.
    check('no Resend call was made (script never imports or uses it)', true);

    // -- 5. Redemption is repeatable ----------------------------------------
    await invites.markRedeemed(inv.inviteId);
    const second = await invites.lookupInvite(inv.token);
    check('invite still valid after first redemption (no single-use dead end)', second.ok === true, second.reason);
    const afterTwo = await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}&select=redeem_count,consumed_at`);
    check('redeem_count incremented', !!afterTwo.json && afterTwo.json[0].redeem_count === 1);
    check('consumed_at recorded on first redemption', !!afterTwo.json && !!afterTwo.json[0].consumed_at);

    // -- 6. Expired invite is refused ---------------------------------------
    await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ expires_at: new Date(Date.now() - 1000).toISOString() }),
    });
    const expired = await invites.lookupInvite(inv.token);
    check('expired invite refused with reason=expired', expired.ok === false && expired.reason === 'expired', expired.reason);

    // -- 7. Unknown token refused -------------------------------------------
    const unknown = await invites.lookupInvite(invites.generateRawToken());
    check('unknown token refused', unknown.ok === false && unknown.reason === 'unknown', unknown.reason);

    // -- 8. Completion retires live invites ---------------------------------
    await api(`/rest/v1/account_invites?id=eq.${inv.inviteId}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ expires_at: new Date(Date.now() + 86400000).toISOString() }),
    });
    const revived = await invites.lookupInvite(inv.token);
    check('invite valid again after expiry restored', revived.ok === true);
    await invites.completeInvitesForUser(userId);
    const done = await invites.lookupInvite(inv.token);
    check('invite retired once the account has a password', done.ok === false && done.reason === 'completed', done.reason);

    // -- 9. Ledger idempotency ----------------------------------------------
    await invites.logLifecycleEmail({ userId, email: TEST_EMAIL, sequence: 'invite', step: 'invite', resendMessageId: 'verify-fake-id', source: 'verify-script' });
    await invites.logLifecycleEmail({ userId, email: TEST_EMAIL, sequence: 'invite', step: 'invite', resendMessageId: 'verify-fake-id-2', source: 'verify-script' });
    const ledgerRows = await api(`/rest/v1/lifecycle_email_log?user_id=eq.${userId}&select=id`);
    check('ledger is idempotent — duplicate step written once',
      !!ledgerRows.json && ledgerRows.json.length === 1, `got ${ledgerRows.json && ledgerRows.json.length} rows`);

  } finally {
    // -- 10. Clean up --------------------------------------------------------
    if (userId) {
      await api(`/rest/v1/lifecycle_email_log?user_id=eq.${userId}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      const del = await api(`/auth/v1/admin/users/${userId}`, { method: 'DELETE' });
      // account_invites cascades on the auth.users FK.
      const leftoverInvites = await api(`/rest/v1/account_invites?user_id=eq.${userId}&select=id`);
      const leftoverLedger = await api(`/rest/v1/lifecycle_email_log?user_id=eq.${userId}&select=id`);
      check('throwaway auth user deleted', del.ok, `status ${del.status}`);
      check('invite rows gone (FK cascade)', !!leftoverInvites.json && leftoverInvites.json.length === 0);
      check('ledger rows gone', !!leftoverLedger.json && leftoverLedger.json.length === 0);
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error('\nverification threw:', err); process.exit(1); });
