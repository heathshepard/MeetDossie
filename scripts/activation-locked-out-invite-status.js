#!/usr/bin/env node
'use strict';

// scripts/activation-locked-out-invite-status.js
//
// READ-ONLY. Reports the current durable-invite status for the cohort
// identified in docs/ACTIVATION-FORENSICS-2026-09-18.md as never having held
// an authenticated session: Kim Herrera, Cecilia Whitley, Lisa Nilsson.
//
//   node scripts/activation-locked-out-invite-status.js
//
// Writes nothing, sends nothing, contacts nobody. Reads:
//   - auth.users (last_sign_in_at, invited_at, recovery_sent_at)
//   - account_invites (the durable-invite mechanism in api/_lib/account-invites.js)
//
// WHY THIS EXISTS
//   auth.users.recovery_sent_at / invited_at are NOT the signal for whether
//   this cohort has a working credential anymore — the durable-invite system
//   (api/_lib/account-invites.js, shipped 2026-09-18) deliberately does not
//   touch either column; it writes to account_invites instead, and only mints
//   a GoTrue recovery link (which WOULD bump recovery_sent_at) at the instant
//   the customer clicks. Reading the old columns alone will make an already-
//   fixed account look untouched. Verified 2026-09-29: `cron-account-invite-
//   autoresend` already fired for all three on 2026-09-27 00:33 UTC
//   (ACCOUNT_INVITE_AUTORESEND_MODE was flipped to 'send' 3 days prior to this
//   script's authorship — env var change timestamp confirms it, value itself
//   is a Vercel Sensitive var and unreadable). Each of the three already has a
//   live, un-redeemed 30-day invite as of that run.
//
// IF THIS SCRIPT SHOWS AN INVITE HAS EXPIRED (or none exists) and Heath wants
// to re-issue by hand, the reviewable command is (NOT run by this script, and
// NOT run automatically by anything else — deliver=none mints a fresh durable
// invite and returns the URL, it sends no email):
//
//   curl -s -X POST https://meetdossie.com/api/invite-resend \
//     -H "Authorization: Bearer $CRON_SECRET" \
//     -H "Content-Type: application/json" \
//     -d '{"email":"<one of the three addresses below>","deliver":"none"}'
//
//   That returns { url, expires_at } for Heath to paste into a personal note
//   himself (docs/ACTIVATION-FORENSICS-2026-09-18.md's own recommendation
//   #5 — a human message from Heath, not another automated template, given
//   these three have already had one automated nudge). Pass
//   `"deliver":"email"` only with Heath's explicit go-ahead — that IS an
//   outbound customer email.
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (from .env.local).
//
// Owner: Carter, 2026-09-29.

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

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// The exact cohort from docs/ACTIVATION-FORENSICS-2026-09-18.md §2 — the
// three with ZERO auth sessions, ever. Not a general customer scan; this file
// is scoped to the known incident, on purpose.
const COHORT = [
  'cecilia@sterlingassociatesre.com',
  'kimberlyherrera@kw.com',
  'lisanilssontx@gmail.com',
];

async function findAuthUser(email) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
  });
  const data = await res.json().catch(() => null);
  const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
  return users.find((u) => String(u.email || '').toLowerCase() === email) || null;
}

async function invitesFor(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/account_invites?user_id=eq.${encodeURIComponent(userId)}` +
    '&select=source,created_at,expires_at,email_sent_at,consumed_at,completed_at&order=created_at.desc',
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }
  );
  return res.ok ? res.json() : [];
}

async function main() {
  if (!SUPABASE_URL || !KEY) {
    console.error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
    process.exit(1);
  }

  console.log('\nACTIVATION-INCIDENT COHORT — INVITE STATUS (read-only)\n');

  for (const email of COHORT) {
    const u = await findAuthUser(email);
    if (!u) {
      console.log(`  ${email}\n    NOT FOUND in auth.users\n`);
      continue;
    }
    const invites = await invitesFor(u.id);
    const live = invites.find((i) => !i.completed_at && new Date(i.expires_at).getTime() > Date.now());

    console.log(`  ${email}`);
    console.log(`    ever signed in: ${u.last_sign_in_at ? u.last_sign_in_at : 'NEVER'}`);
    if (!invites.length) {
      console.log('    account_invites: none — this account has never been through the durable-invite path.');
      console.log('    -> use the curl command in this file\'s header comment (deliver=none) to mint one.');
    } else if (live) {
      const daysLeft = Math.round((new Date(live.expires_at).getTime() - Date.now()) / 86400000);
      console.log(`    LIVE invite: sent ${live.email_sent_at ? live.email_sent_at : 'NOT CONFIRMED SENT'}, source=${live.source}, ${daysLeft}d remaining, redeemed=${!!live.consumed_at}`);
    } else {
      console.log(`    all ${invites.length} invite(s) expired or completed — no live credential.`);
      console.log('    -> use the curl command in this file\'s header comment (deliver=none) to mint a fresh one.');
    }
    console.log('');
  }
}

main().catch((err) => { console.error('threw:', err); process.exit(1); });
