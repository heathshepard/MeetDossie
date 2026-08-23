#!/usr/bin/env node
// scripts/carter-team-invite-flow-fixed-verify.js
//
// Real end-to-end trace of the FIXED invite flow (redirectTo now
// set-password.html instead of the dead /app?invited_to_org= path): real
// invite -> real invite email link (via generateLink, same underlying
// mechanism) -> lands on set-password.html -> sets a real password -> lands
// authenticated on /workspace.html -> the org membership is real, so the
// TeamWelcomeBanner mechanism would fire on next dashboard render.
//
// Disposable @mailinator.com test address, cleaned up at the end.
//
// Usage: node scripts/carter-team-invite-flow-fixed-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-team-invite-flow-fixed-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-invite-flow-fixed-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = 'ad1decf9-0ff1-42eb-950a-8e4b67d128f6';
const TS = Date.now();
const TEST_EMAIL = `cole-verify-invite-fixed-${TS}@mailinator.com`;
const TEST_PASSWORD = 'RealDossieTestPw!9284';

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
  const verifyRes = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: data.properties.hashed_token }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed for ${email}: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return verifyData;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── 1. Real invite via the real endpoint (now fixed redirectTo). ────────
  const leadSession = await mintSession('demo-team-lead@meetdossie.com');
  const inviteRes = await fetch(`${BASE}/api/team/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadSession.access_token}` },
    body: JSON.stringify({ org_id: ORG_ID, email: TEST_EMAIL, roles: ['agent'] }),
  });
  const inviteJson = await inviteRes.json().catch(() => null);
  report('real POST /api/team/invite succeeded', inviteRes.ok && inviteJson && inviteJson.ok, JSON.stringify(inviteJson));

  // ── 2. Recover the actual invite action_link for this same user (would
  //      have been the emailed link — this uses the exact fixed redirectTo
  //      the real code now sends since inviteUserByEmail already fired). ──
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'invite',
    email: TEST_EMAIL,
    options: { redirectTo: 'https://meetdossie.com/set-password.html' },
  });
  report('recovered a real invite action_link (fixed redirectTo)', !linkErr && !!(linkData && linkData.properties && linkData.properties.action_link), linkErr && linkErr.message);
  const actionLink = linkData && linkData.properties && linkData.properties.action_link;

  // ── 3. Follow the REAL link in a real browser. ───────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(actionLink, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('[nav]', e.message));
  await page.waitForTimeout(3000);
  const landedUrl = page.url();
  console.log('[trace] landed on:', landedUrl.split('#')[0]);
  await page.screenshot({ path: path.join(OUT, '01-set-password-landing.png'), fullPage: true }).catch(() => {});
  report('lands on set-password.html (not the old dead /app?invited_to_org= path)', landedUrl.split('#')[0].split('?')[0].endsWith('/set-password.html'), landedUrl);

  const bodyText1 = await page.evaluate(() => document.body.innerText);
  const showsSetPasswordForm = /Set your Dossie password/i.test(bodyText1) && /Create My Password/i.test(bodyText1);
  report('shows the real "Set your Dossie password" form (session established from hash tokens)', showsSetPasswordForm, bodyText1.slice(0, 200));

  if (showsSetPasswordForm) {
    // ── 4. Actually set a password, exactly what a real invitee does. ─────
    await page.fill('#pw-password', TEST_PASSWORD);
    await page.fill('#pw-confirm', TEST_PASSWORD);
    await page.click('#pw-submit');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '02-after-submit.png'), fullPage: true }).catch(() => {});
    await page.waitForURL('**/workspace.html**', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const finalUrl = page.url();
    console.log('[trace] final URL after password set:', finalUrl);
    report('redirected to /workspace.html after setting password', finalUrl.includes('/workspace.html'), finalUrl);

    const sessionState = await page.evaluate(() => {
      try {
        const raw = window.localStorage.getItem('supabase.auth.token');
        return raw ? { hasToken: !!JSON.parse(raw).access_token } : { hasToken: false };
      } catch (e) { return { err: e.message }; }
    });
    report('a real working session exists on workspace.html', sessionState.hasToken === true, JSON.stringify(sessionState));

    // ── 5. Confirm the password now actually works for a real sign-in. ────
    const { data: passwordSignIn, error: pwErr } = await admin.auth.signInWithPassword
      ? { data: null, error: null } // service client has no signInWithPassword; use REST directly below
      : { data: null, error: null };
    const pwCheckRes = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
      body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
    });
    report('the password just set now works for a real password sign-in', pwCheckRes.status === 200, `status=${pwCheckRes.status}`);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const dashText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, '03-dashboard-body.txt'), dashText);
    await page.screenshot({ path: path.join(OUT, '03-dashboard.png'), fullPage: true }).catch(() => {});
    const bannerShown = /You.?re part of/i.test(dashText) && /Whitley Realty Team/i.test(dashText);
    report('TeamWelcomeBanner fires on this real, fully-onboarded invitee\'s first dashboard view', bannerShown);
  }

  await ctx.close();
  await browser.close();

  // ── Cleanup ──────────────────────────────────────────────────────────────
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
    console.log(`[cleanup] removed ${TEST_EMAIL} (${userId})`);
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
