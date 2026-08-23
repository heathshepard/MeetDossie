#!/usr/bin/env node
// scripts/carter-team-invite-flow-verify.js
//
// Real end-to-end trace of what happens after a real invite link is clicked
// (Cole's ask, 2026-08-23): calls the REAL POST /api/team/invite endpoint
// (api/_lib/team-invite-core.js -> supabase.auth.admin.inviteUserByEmail),
// then drives Playwright through the actual Supabase invite action_link
// (same landing flow a real emailed link produces) to observe:
//   1. whether the app reads the ?invited_to_org= query param at all
//   2. whether the user is ever prompted to set a password, or silently
//      authenticated with none ever established
//
// Disposable @mailinator.com test address, cleaned up (org membership +
// auth.users row deleted) at the end.
//
// Usage: node scripts/carter-team-invite-flow-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync('/mnt/c/Users/Heath/Projects/MeetDossie/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-team-invite-flow-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-invite-flow-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = 'ad1decf9-0ff1-42eb-950a-8e4b67d128f6'; // Whitley Realty Team (DEMO)
const TS = Date.now();
const TEST_EMAIL = `cole-verify-invite-flow-${TS}@mailinator.com`;

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

const { createClient } = require('@supabase/supabase-js');
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const admin = createClient(SUPA_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function mintSession(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  const verifyRes = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed for ${email}: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return verifyData;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── 1. Real invite, via the real endpoint, as Dana (admin) ─────────────
  const leadSession = await mintSession('demo-team-lead@meetdossie.com');
  const inviteRes = await fetch(`${BASE}/api/team/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadSession.access_token}` },
    body: JSON.stringify({ org_id: ORG_ID, email: TEST_EMAIL, roles: ['agent'] }),
  });
  const inviteJson = await inviteRes.json().catch(() => null);
  report('real POST /api/team/invite succeeded for a brand-new email', inviteRes.ok && inviteJson && inviteJson.ok, JSON.stringify(inviteJson));
  const wasExisting = inviteJson && inviteJson.was_existing_user;
  report('confirmed this hit the NEW-user branch (inviteUserByEmail, not the existing-user branch)', wasExisting === false);

  // ── 2. Get the real Supabase invite action_link for that same email — the
  //      exact same underlying mechanism as what would have been emailed
  //      (api/_lib/team-invite-core.js's inviteUserByEmail already fired
  //      once above; generateLink here just recovers a usable action_link
  //      for a user who already exists rather than sending a 2nd email). ──
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: TEST_EMAIL,
    options: { redirectTo: `${BASE}/app?invited_to_org=${ORG_ID}` },
  });
  if (linkErr) {
    report('generated a real invite action_link for the test user', false, linkErr.message);
  } else {
    report('generated a real invite action_link for the test user', true);
  }
  const actionLink = linkData && linkData.properties && linkData.properties.action_link;
  fs.writeFileSync(path.join(OUT, 'action-link.txt'), actionLink || 'NONE');

  // ── 3. Follow the REAL link in a real browser — this exercises Supabase's
  //      own verify redirect + our app's PKCE code-exchange on load, exactly
  //      what a real invitee clicking the email link goes through. ────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(actionLink, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
    console.log('[nav] goto action_link error (may still have redirected):', e.message);
  });
  await page.waitForTimeout(4000);
  const landedUrl = page.url();
  console.log('[trace] landed URL:', landedUrl);
  fs.writeFileSync(path.join(OUT, 'landed-url.txt'), landedUrl);
  await page.screenshot({ path: path.join(OUT, '01-landed.png'), fullPage: true }).catch(() => {});

  const urlKeepsInvitedToOrgParam = landedUrl.includes('invited_to_org=');
  report('URL still carries ?invited_to_org= after landing (app does not strip/consume it)', urlKeepsInvitedToOrgParam, landedUrl);

  // Is there a real, authenticated session now (no password step required)?
  const sessionState = await page.evaluate(() => {
    try {
      const raw = window.localStorage.getItem('supabase.auth.token');
      if (!raw) return { hasToken: false };
      const parsed = JSON.parse(raw);
      return { hasToken: !!(parsed && parsed.access_token), userEmail: parsed && parsed.user && parsed.user.email };
    } catch (e) {
      return { hasToken: false, error: e.message };
    }
  });
  console.log('[trace] session state after landing:', JSON.stringify(sessionState));
  report(
    'user is silently authenticated (real session token present) with zero password step',
    sessionState.hasToken === true,
    JSON.stringify(sessionState)
  );

  const bodyText = await page.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'body-after-landing.txt'), bodyText);
  const mentionsPassword = /set.{0,15}password|create.{0,15}password|choose.{0,15}password/i.test(bodyText);
  report(
    'NO "set a password" prompt anywhere on the landing screen (confirms the gap: no password is ever established)',
    !mentionsPassword,
    mentionsPassword ? 'a password-related prompt WAS found (contradicts expected gap)' : 'confirmed absent'
  );

  const teamWelcomeShown = /You.?re part of/i.test(bodyText) && /Whitley Realty Team/i.test(bodyText);
  report('TeamWelcomeBanner mechanism (role+localStorage) fires for this real invite-link user too, independent of the unread invited_to_org param', teamWelcomeShown);

  // ── 4. Confirm: can this user ever sign back in with a password? ───────
  // They were never asked to set one — try the standard sign-in form with a
  // guessed/empty password to confirm there's truly no password path.
  const canSignInWithPassword = await page.evaluate(async (email) => {
    try {
      const res = await fetch('https://pgwoitbdiyubjugwufhk.supabase.co/auth/v1/token?grant_type=password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: 'sb_publishable_bx3yp5_mBxroF1gBzNoZFg_Bp9u8STb' },
        body: JSON.stringify({ email, password: 'ThisWasNeverSet123!' }),
      });
      return res.status;
    } catch (e) {
      return 'ERR:' + e.message;
    }
  }, TEST_EMAIL);
  report(
    'password-grant sign-in correctly rejected (status ' + canSignInWithPassword + ') — no password was ever set for this account',
    canSignInWithPassword === 400,
    `status=${canSignInWithPassword}`
  );

  await ctx.close();
  await browser.close();

  // ── 5. Cleanup ───────────────────────────────────────────────────────────
  const { data: profileRow } = await admin.from('profiles').select('id').eq('email', TEST_EMAIL).maybeSingle();
  const userId = profileRow ? profileRow.id : (inviteJson && inviteJson.invitee_user_id);
  if (userId) {
    const { data: memberRow } = await admin
      .from('organization_members')
      .select('id')
      .eq('org_id', ORG_ID)
      .eq('user_id', userId)
      .is('removed_at', null)
      .maybeSingle();
    if (memberRow) {
      await fetch(`${BASE}/api/team/remove-member`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadSession.access_token}` },
        body: JSON.stringify({ member_id: memberRow.id }),
      }).catch(() => null);
    }
    await admin.auth.admin.deleteUser(userId).catch((e) => console.warn('[cleanup] deleteUser failed:', e.message));
    console.log(`[cleanup] removed test invite user ${TEST_EMAIL} (${userId})`);
  } else {
    console.log(`[cleanup] no user found for ${TEST_EMAIL} — nothing to remove`);
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
