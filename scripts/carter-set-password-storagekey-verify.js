#!/usr/bin/env node
// scripts/carter-set-password-storagekey-verify.js
//
// Real end-to-end trace of the set-password.html storageKey fix.
//
// Bug: set-password.html's createClient() had no storageKey, so it persisted
// the session under Supabase's default key instead of 'supabase.auth.token'
// -- the key the main app bundle (workspace-*.js) and workspace.html actually
// read from. Every real signup (api/signup.js), paid onboarding
// (api/complete-onboarding.js), and team invite (api/_lib/team-invite-core.js)
// redirects through set-password.html, so a real customer could set a
// password and land on workspace.html with zero working session.
//
// This exercises the EXACT same underlying mechanism api/complete-onboarding.js
// and api/signup.js use for the password-set step (auth.admin.generateLink
// type=recovery, redirect_to=set-password.html) -- without triggering a real
// Stripe charge and without needing the design-partner invite code secret.
// Real auth user created via the same admin endpoint createAuthUser() uses,
// real recovery link via the same generateRecoveryLink() mechanism, followed
// in a real browser exactly as a real customer's email link would be.
//
// Usage: node scripts/carter-set-password-storagekey-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-set-password-storagekey-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const OUT = path.join(__dirname, 'atlas-runs', 'carter-set-password-storagekey-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const TS = Date.now();
const TEST_EMAIL = `carter-verify-setpw-${TS}@mailinator.com`;
const TEST_PASSWORD = 'RealDossieTestPw!7731';

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

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── 1. Create a real auth user, same admin endpoint createAuthUser() in
  //      complete-onboarding.js / signup.js uses. ──────────────────────────
  const { data: createData, error: createErr } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    email_confirm: true,
    user_metadata: { full_name: 'Carter Verify SetPassword' },
  });
  report('real auth user created', !createErr && !!(createData && createData.user), createErr && createErr.message);
  const userId = createData && createData.user && createData.user.id;

  // ── 2. Real recovery link, same mechanism generateRecoveryLink() in
  //      complete-onboarding.js uses: type=recovery, redirect_to=set-password.html.
  //      Supabase's own redirect hop only honors allowlisted redirect URLs
  //      (meetdossie.com, not the per-push Vercel preview host), so instead
  //      of following that browser redirect chain (which would land on
  //      PRODUCTION's set-password.html, not the staging fix under test),
  //      resolve the hashed_token to real access/refresh tokens ourselves via
  //      the same /auth/v1/verify endpoint Supabase's own redirect uses
  //      internally, then hand set-password.html the exact same
  //      #access_token=...&refresh_token=...&type=recovery hash it would
  //      have received from a real email link. This exercises the identical
  //      client-side code (parseHashTokens -> supabase.auth.setSession) on
  //      the real staging preview build. ─────────────────────────────────
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'recovery',
    email: TEST_EMAIL,
    options: { redirectTo: 'https://meetdossie.com/set-password.html' },
  });
  report('real recovery action_link generated (redirect_to=set-password.html)', !linkErr && !!(linkData && linkData.properties && linkData.properties.action_link), linkErr && linkErr.message);
  const hashedToken = linkData && linkData.properties && linkData.properties.hashed_token;

  const verifyRes = await fetch(`${SUPA_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ type: 'recovery', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json().catch(() => null);
  report('real /auth/v1/verify resolved hashed_token to a real access/refresh token pair', verifyRes.ok && verifyData && verifyData.access_token && verifyData.refresh_token, `status=${verifyRes.status}`);

  const stagingLink = verifyData && verifyData.access_token
    ? `${BASE}/set-password.html#access_token=${encodeURIComponent(verifyData.access_token)}&refresh_token=${encodeURIComponent(verifyData.refresh_token)}&type=recovery`
    : null;

  // ── 3. Follow the real hash-token link in a real browser, on the real
  //      staging preview build. ────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(stagingLink, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('[nav]', e.message));
  await page.waitForTimeout(3000);
  const landedUrl = page.url();
  console.log('[trace] landed on:', landedUrl.split('#')[0]);
  await page.screenshot({ path: path.join(OUT, '01-set-password-landing.png'), fullPage: true }).catch(() => {});
  report('lands on set-password.html', landedUrl.split('#')[0].split('?')[0].endsWith('/set-password.html'), landedUrl);

  const bodyText1 = await page.evaluate(() => document.body.innerText);
  const showsSetPasswordForm = /Set your Dossie password/i.test(bodyText1) && /Create My Password/i.test(bodyText1);
  report('shows the real "Set your Dossie password" form (session established from hash tokens)', showsSetPasswordForm, bodyText1.slice(0, 200));

  if (showsSetPasswordForm) {
    // ── 4. Actually set a password, exactly what a real customer does. ────
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

    // ── 5. THE bug this fixes: does a real session exist under the key the
    //      main app actually reads (supabase.auth.token)? ─────────────────
    const sessionState = await page.evaluate(() => {
      try {
        const raw = window.localStorage.getItem('supabase.auth.token');
        const wrongKeyRaw = Object.keys(window.localStorage).find((k) => k.startsWith('sb-') && k.endsWith('-auth-token'));
        return {
          hasCorrectKeyToken: raw ? !!JSON.parse(raw).access_token : false,
          wrongDefaultKeyPresent: !!wrongKeyRaw,
        };
      } catch (e) { return { err: e.message }; }
    });
    report('session persisted under storageKey=supabase.auth.token (the key workspace-*.js reads)', sessionState.hasCorrectKeyToken === true, JSON.stringify(sessionState));
    report('no stray session under the old default sb-<ref>-auth-token key', sessionState.wrongDefaultKeyPresent === false, JSON.stringify(sessionState));

    // ── 6. Genuinely authenticated, not just "no error" -- does the workspace
    //      actually render signed-in content? ─────────────────────────────
    const dashText1 = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, '03-workspace-body.txt'), dashText1);
    const looksSignedIn1 = !/sign in|log in/i.test(dashText1.slice(0, 400)) && dashText1.length > 200;
    report('workspace.html renders signed-in content immediately after redirect (not a login screen)', looksSignedIn1, dashText1.slice(0, 150).replace(/\n/g, ' '));

    // ── 7. Reload -- session must survive a real page reload. ─────────────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const urlAfterReload = page.url();
    const dashText2 = await page.evaluate(() => document.body.innerText);
    await page.screenshot({ path: path.join(OUT, '04-after-reload.png'), fullPage: true }).catch(() => {});
    const staysSignedInAfterReload = urlAfterReload.includes('/workspace.html') && !/sign in|log in/i.test(dashText2.slice(0, 400));
    report('session persists across a real page reload', staysSignedInAfterReload, `url=${urlAfterReload}`);

    // ── 8. Sign out, then sign back in through the REAL login form on
    //      app.html using the password just set -- proves the password
    //      itself was correctly set, not just the immediate post-redirect
    //      session. ─────────────────────────────────────────────────────
    await page.evaluate(async () => {
      try {
        const raw = window.localStorage.getItem('supabase.auth.token');
        if (raw) window.localStorage.removeItem('supabase.auth.token');
      } catch (e) {}
    });
    await page.goto(`${BASE}/app.html`, { waitUntil: 'networkidle', timeout: 30000 }).catch((e) => console.log('[nav]', e.message));
    await page.waitForTimeout(2000);
    await page.screenshot({ path: path.join(OUT, '05-login-page.png'), fullPage: true }).catch(() => {});

    // Find email/password inputs generically -- app.html field IDs unknown
    // ahead of time, so probe common selectors.
    const emailSel = await page.$('input[type="email"], input[name="email"], #email, #login-email');
    const pwSel = await page.$('input[type="password"], input[name="password"], #password, #login-password');
    let realLoginWorked = false;
    let loginNote = 'could not find login form fields';
    if (emailSel && pwSel) {
      await emailSel.fill(TEST_EMAIL);
      await pwSel.fill(TEST_PASSWORD);
      const submitBtn = await page.$('button[type="submit"], #login-submit, #sign-in-submit');
      if (submitBtn) {
        await submitBtn.click();
      } else {
        await pwSel.press('Enter');
      }
      await page.waitForTimeout(3000);
      await page.waitForURL('**/workspace.html**', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const postLoginUrl = page.url();
      const postLoginText = await page.evaluate(() => document.body.innerText);
      await page.screenshot({ path: path.join(OUT, '06-after-real-login.png'), fullPage: true }).catch(() => {});
      // Judge by rendered content, not the address bar -- the workspace is an
      // SPA route and may not rewrite window.location.pathname to
      // /workspace.html even once fully signed in and rendered.
      realLoginWorked = /Morning Brief/i.test(postLoginText) && /Sign Out/i.test(postLoginText) && !/Welcome back to Dossie/i.test(postLoginText);
      loginNote = `url=${postLoginUrl} bodyStart=${postLoginText.slice(0, 80).replace(/\n/g, ' ')}`;
    }
    report('signs back in via the REAL login form on app.html with the password just set', realLoginWorked, loginNote);
  }

  await ctx.close();
  await browser.close();

  // ── Cleanup: delete the test auth user. ─────────────────────────────────
  if (userId) {
    await admin.auth.admin.deleteUser(userId).catch((e) => console.warn('[cleanup] deleteUser failed:', e.message));
    console.log(`[cleanup] removed ${TEST_EMAIL} (${userId})`);
  }
  // Also clean any profiles/subscriptions row this test might have touched
  // (createUser alone does not create these, but belt-and-suspenders).
  await admin.from('profiles').delete().eq('email', TEST_EMAIL).then(() => {}).catch(() => {});

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exitCode = 1;
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
