#!/usr/bin/env node
// scripts/carter-team-add-member-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-23 add-team-member feature — both paths:
//   1. Self-serve UI: the new "+ Add team member" form in TeamView.jsx,
//      calling api/team/invite.js for real.
//   2. Chat-driven: demo-team-lead@meetdossie.com telling Dossie in plain
//      language to add a team member, which should call the exact same
//      invite path server-side and confirm back what it did.
//
// Both use disposable @mailinator.com test addresses (a real public
// disposable-inbox domain — @example.com/.org are on Supabase Auth's own
// invalid-domain denylist, confirmed by a direct probe before writing this
// script). Both are cleaned up at the end via api/team/remove-member.js (org
// membership) + a direct auth.users delete (service-role), so the demo org
// is left exactly as it was found.
//
// Usage: node scripts/carter-team-add-member-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-team-add-member-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-add-member-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = 'ad1decf9-0ff1-42eb-950a-8e4b67d128f6'; // Whitley Realty Team (DEMO)
const TS = Date.now();
const UI_TEST_EMAIL = `cole-verify-teamadd-ui-${TS}@mailinator.com`;
const CHAT_TEST_EMAIL = `cole-verify-teamadd-chat-${TS}@mailinator.com`;

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

async function signIn(page, email) {
  const session = await mintSession(email);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((sessionObj) => {
    const payload = {
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    };
    localStorage.setItem('supabase.auth.token', JSON.stringify(payload));
  }, session);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  return session;
}

async function findMemberByEmail(email) {
  // profiles carries the email for every seeded/invited user we care about.
  const { data: profileRows } = await admin.from('profiles').select('id, email').eq('email', email);
  let userId = profileRows && profileRows[0] ? profileRows[0].id : null;
  if (!userId) {
    const { data: byEmail } = await admin.auth.admin.getUserByEmail
      ? await admin.auth.admin.getUserByEmail(email)
      : { data: null };
    userId = byEmail && byEmail.user ? byEmail.user.id : null;
  }
  if (!userId) return null;
  const { data: memberRows } = await admin
    .from('organization_members_with_roles')
    .select('member_id, org_id, user_id, roles, removed_at')
    .eq('org_id', ORG_ID)
    .eq('user_id', userId);
  return { userId, member: (memberRows || [])[0] || null };
}

// Cleanup uses api/team/remove-member.js's real RPC (remove_org_member) via
// the lead's own bearer token — the same code path a real admin uses in the
// product — then deletes the synthetic auth.users row entirely so the demo
// org carries zero residue from this test run.
async function cleanup(email, tag, leadAccessToken) {
  const found = await findMemberByEmail(email);
  if (!found || !found.userId) {
    console.log(`[cleanup] ${tag} test user ${email} not found — nothing to remove`);
    return;
  }
  if (found.member && !found.member.removed_at && leadAccessToken) {
    const res = await fetch(`${BASE}/api/team/remove-member`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadAccessToken}` },
      body: JSON.stringify({ member_id: found.member.member_id }),
    }).catch(() => null);
    const json = res ? await res.json().catch(() => null) : null;
    console.log(`[cleanup] remove-member.js for ${email}: ${res ? res.status : 'no response'} ${JSON.stringify(json)}`);
  }
  await admin.auth.admin.deleteUser(found.userId).catch((e) => console.warn(`[cleanup] deleteUser(${email}) failed:`, e.message));
  console.log(`[cleanup] removed ${tag} test user ${email} (${found.userId})`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── 1. UI path ───────────────────────────────────────────────────────
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const page = await ctx.newPage();
  const leadSession = await signIn(page, 'demo-team-lead@meetdossie.com');
  report('team lead signed in for UI test', true);

  const teamNavBtn = page.locator('aside.app-sidebar button', { hasText: 'Team' });
  await teamNavBtn.waitFor({ state: 'visible', timeout: 20000 });
  await teamNavBtn.scrollIntoViewIfNeeded().catch(() => {});
  await page.screenshot({ path: path.join(OUT, 'ui-00-before-team-click.png') }).catch(() => {});
  await teamNavBtn.click({ force: true, timeout: 15000 });
  await page.waitForTimeout(2500);

  const addBtn = page.locator('button', { hasText: '+ Add team member' });
  const addBtnVisible = await addBtn.isVisible().catch(() => false);
  report('Team view loaded with "+ Add team member" button visible', addBtnVisible);
  if (!addBtnVisible) {
    await page.screenshot({ path: path.join(OUT, 'ui-fail-no-button.png'), fullPage: true }).catch(() => {});
  } else {
    await addBtn.click();
    const emailInput = page.locator('input[type="email"]');
    await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    await emailInput.fill(UI_TEST_EMAIL);
    await page.screenshot({ path: path.join(OUT, 'ui-01-form-filled.png') }).catch(() => {});
    const submitBtn = page.locator('button[type="submit"]', { hasText: 'Send invite' });
    await submitBtn.click();

    await page.waitForFunction((email) => document.body.innerText.includes(email), UI_TEST_EMAIL, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    const bodyText = await page.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, 'ui-body-after-submit.txt'), bodyText);
    await page.screenshot({ path: path.join(OUT, 'ui-02-after-submit.png'), fullPage: true }).catch(() => {});
    const successShown = /invite sent to|added to the team/i.test(bodyText) && bodyText.includes(UI_TEST_EMAIL);
    report('UI form shows a real success confirmation naming the test email', successShown);
  }

  // Real DB check — not just trusting the 200/UI text.
  await new Promise((r) => setTimeout(r, 1500));
  const uiFound = await findMemberByEmail(UI_TEST_EMAIL);
  report(
    'UI invite: a real organization_members row exists for the test email',
    !!(uiFound && uiFound.member && !uiFound.member.removed_at),
    uiFound && uiFound.member ? `member_id=${uiFound.member.member_id} roles=${JSON.stringify(uiFound.member.roles)}` : 'not found'
  );

  await ctx.close();

  // ── 2. Chat path ─────────────────────────────────────────────────────
  const ctx2 = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const page2 = await ctx2.newPage();
  await signIn(page2, 'demo-team-lead@meetdossie.com');
  report('team lead signed in for chat test', true);

  const talkBtn = page2.locator('button.app-talk-button');
  await talkBtn.waitFor({ state: 'visible', timeout: 20000 });
  await talkBtn.click();
  const textarea = page2.locator('textarea[placeholder*="Type a command"]');
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  const chatMessage = `Add Jordan Reyes, ${CHAT_TEST_EMAIL}, as an agent`;
  await textarea.click();
  await textarea.fill(chatMessage);
  await page2.screenshot({ path: path.join(OUT, 'chat-01-before-send.png') }).catch(() => {});
  await textarea.press('Enter');

  console.log('[verify] waiting up to 45s for Dossie to execute + confirm...');
  await page2.waitForTimeout(2000);
  await page2.waitForFunction(() => {
    const thinking = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'Thinking...');
    return !thinking;
  }, { timeout: 45000 }).catch(() => {});
  await page2.waitForTimeout(1500);

  const chatBodyText = await page2.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'chat-body-after-reply.txt'), chatBodyText);
  await page2.screenshot({ path: path.join(OUT, 'chat-02-after-reply.png'), fullPage: true }).catch(() => {});

  const chatConfirmed = chatBodyText.includes(CHAT_TEST_EMAIL) && /sending the invite now|invite is on its way|on the team/i.test(chatBodyText);
  report('chat reply confirms the exact email + "sending the invite now" style message', chatConfirmed);

  await new Promise((r) => setTimeout(r, 1500));
  const chatFound = await findMemberByEmail(CHAT_TEST_EMAIL);
  report(
    'chat invite: a real organization_members row exists for the test email',
    !!(chatFound && chatFound.member && !chatFound.member.removed_at),
    chatFound && chatFound.member ? `member_id=${chatFound.member.member_id} roles=${JSON.stringify(chatFound.member.roles)}` : 'not found'
  );

  await ctx2.close();

  // ── 3. Solo-account guardrail: confirm add_team_member never fires ────
  const ctx3 = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const page3 = await ctx3.newPage();
  await signIn(page3, 'demo@meetdossie.com');
  const talkBtn3 = page3.locator('button.app-talk-button');
  await talkBtn3.waitFor({ state: 'visible', timeout: 20000 });
  await talkBtn3.click();
  const textarea3 = page3.locator('textarea[placeholder*="Type a command"]');
  await textarea3.waitFor({ state: 'visible', timeout: 15000 });
  const soloEmail = `cole-verify-teamadd-solo-${TS}@mailinator.com`;
  await textarea3.click();
  await textarea3.fill(`Add Test Person, ${soloEmail}, as an agent`);
  await textarea3.press('Enter');
  await page3.waitForTimeout(2000);
  await page3.waitForFunction(() => {
    const thinking = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'Thinking...');
    return !thinking;
  }, { timeout: 45000 }).catch(() => {});
  await page3.waitForTimeout(1500);
  const soloBodyText = await page3.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'solo-guardrail-body.txt'), soloBodyText);
  const soloRefused = /team-lead|admin access|can't add team members/i.test(soloBodyText);
  report('solo (non-admin) account is refused — never reaches inviteTeamMember', soloRefused);
  await new Promise((r) => setTimeout(r, 1000));
  const soloFound = await findMemberByEmail(soloEmail);
  report('solo attempt created NO organization_members row', !(soloFound && soloFound.member), soloFound ? JSON.stringify(soloFound) : 'confirmed absent');
  await ctx3.close();

  await browser.close();

  // ── 4. Cleanup ──────────────────────────────────────────────────────
  console.log('\n[cleanup] removing test invites via api/team/remove-member.js (real admin path)...');
  await cleanup(UI_TEST_EMAIL, 'UI', leadSession.access_token);
  await cleanup(CHAT_TEST_EMAIL, 'chat', leadSession.access_token);
  // solo attempt should have created nothing, but clean up defensively in case.
  await cleanup(`cole-verify-teamadd-solo-${TS}@mailinator.com`, 'solo-guardrail (defensive)', leadSession.access_token);

  const uiAfterCleanup = await findMemberByEmail(UI_TEST_EMAIL);
  const chatAfterCleanup = await findMemberByEmail(CHAT_TEST_EMAIL);
  report('UI test invite fully removed after cleanup', !uiAfterCleanup || !uiAfterCleanup.member || !!uiAfterCleanup.member.removed_at || false, !uiAfterCleanup ? 'user deleted entirely' : 'residual');
  report('chat test invite fully removed after cleanup', !chatAfterCleanup || !chatAfterCleanup.member || !!chatAfterCleanup.member.removed_at || false, !chatAfterCleanup ? 'user deleted entirely' : 'residual');

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.note ? ' — ' + r.note : ''}`));
  const allPass = results.every((r) => r.pass);
  console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exit(allPass ? 0 : 1);
})().catch(async (err) => {
  console.error('[verify] fatal error:', err);
  // Best-effort cleanup even on failure so a broken run doesn't leave residue.
  try {
    await cleanup(UI_TEST_EMAIL, 'UI (fatal-path cleanup)');
    await cleanup(CHAT_TEST_EMAIL, 'chat (fatal-path cleanup)');
  } catch (_) { /* ignore */ }
  process.exit(1);
});
