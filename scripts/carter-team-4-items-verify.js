#!/usr/bin/env node
// scripts/carter-team-4-items-verify.js
//
// Real-browser + real-DB verification for the 2026-08-23 Team Plan 4-item
// build (Carter): TC role scoping, transaction reassignment, first-run
// welcome banner, per-agent closings trend. Uses the seeded Whitley Realty
// Team (DEMO) org (Dana Whitley lead, Marcus/Priya/Jordan agents).
//
// Every mutation this script makes to the demo org (Priya's 'tc' role grant,
// the DEMO-03 reassignment, the localStorage dismiss flag) is reverted at
// the end so the org is left exactly as found.
//
// Usage: node scripts/carter-team-4-items-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Worktree has no .env.local of its own (untracked, per-checkout) — read
// from the main MeetDossie repo root, same as every other worktree-run
// admin/verify script this session.
for (const line of fs.readFileSync('/mnt/c/Users/Heath/Projects/MeetDossie/.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-team-4-items-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-4-items-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = 'ad1decf9-0ff1-42eb-950a-8e4b67d128f6'; // Whitley Realty Team (DEMO)

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

async function getUserId(email) {
  const { data } = await admin.from('profiles').select('id').eq('email', email).maybeSingle();
  return data ? data.id : null;
}

async function getMemberRow(userId) {
  const { data } = await admin
    .from('organization_members_with_roles')
    .select('member_id, org_id, user_id, roles, removed_at')
    .eq('org_id', ORG_ID)
    .eq('user_id', userId)
    .maybeSingle();
  return data || null;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  const leadUserId = await getUserId('demo-team-lead@meetdossie.com');
  const marcusUserId = await getUserId('demo-team-agent1@meetdossie.com');
  const priyaUserId = await getUserId('demo-team-agent2@meetdossie.com');
  const jordanUserId = await getUserId('demo-team-agent3@meetdossie.com');
  console.log('[setup] leadUserId', leadUserId, 'marcusUserId', marcusUserId, 'priyaUserId', priyaUserId, 'jordanUserId', jordanUserId);

  // ═══════════════════════════════════════════════════════════════════════
  // Get a lead (Dana) access token up front — used for setup RPCs.
  // ═══════════════════════════════════════════════════════════════════════
  const leadSessionRaw = await mintSession('demo-team-lead@meetdossie.com');
  const leadToken = leadSessionRaw.access_token;

  // ═══════════════════════════════════════════════════════════════════════
  // ITEM 1 — TC role scoping
  // ═══════════════════════════════════════════════════════════════════════
  const priyaMemberBefore = await getMemberRow(priyaUserId);
  report('setup: Priya found on org, agent-only before grant', !!priyaMemberBefore && !priyaMemberBefore.roles.includes('tc'), JSON.stringify(priyaMemberBefore && priyaMemberBefore.roles));

  // Grant 'tc' via the REAL admin-only endpoint, as Dana.
  const grantRes = await fetch(`${BASE}/api/team/update-roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadToken}` },
    body: JSON.stringify({ member_id: priyaMemberBefore.member_id, add_roles: ['tc'] }),
  });
  const grantJson = await grantRes.json().catch(() => null);
  report('setup: granted Priya the tc role via update-roles.js', grantRes.ok && grantJson && grantJson.ok, JSON.stringify(grantJson));

  // Backend: org-dossiers.js as Priya (tc-only, no admin) should now be 200.
  const priyaSessionRaw = await mintSession('demo-team-agent2@meetdossie.com');
  const priyaToken = priyaSessionRaw.access_token;
  const priyaDossiersRes = await fetch(`${BASE}/api/team/org-dossiers?org_id=${ORG_ID}`, {
    headers: { Authorization: `Bearer ${priyaToken}` },
  });
  const priyaDossiersJson = await priyaDossiersRes.json().catch(() => null);
  report(
    'backend: org-dossiers.js returns 200 for TC-only Priya (was admin-only before today)',
    priyaDossiersRes.status === 200 && priyaDossiersJson && priyaDossiersJson.ok,
    `status=${priyaDossiersRes.status}`
  );

  // Backend: admin-only invite.js must still 403 Priya (tc lacks admin caps).
  const priyaInviteRes = await fetch(`${BASE}/api/team/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${priyaToken}` },
    body: JSON.stringify({ org_id: ORG_ID, email: 'should-not-be-invited@mailinator.com', roles: ['agent'] }),
  });
  report(
    'backend: invite.js still rejects TC-only Priya (admin-only capability correctly withheld)',
    priyaInviteRes.status === 403 || priyaInviteRes.status === 400,
    `status=${priyaInviteRes.status}`
  );

  // Real browser: Priya should see the Team nav item + read data, but NOT
  // the admin-only controls (Add member, Remove, Rename).
  const priyaCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const priyaPage = await priyaCtx.newPage();
  await signIn(priyaPage, 'demo-team-agent2@meetdossie.com');
  const priyaTeamNav = priyaPage.locator('aside.app-sidebar button', { hasText: 'Team' });
  const priyaTeamNavVisible = await priyaTeamNav.isVisible().catch(() => false);
  report('UI: "Team" nav item visible for TC-only Priya', priyaTeamNavVisible);
  if (priyaTeamNavVisible) {
    await priyaTeamNav.click({ force: true });
    await priyaPage.waitForTimeout(2500);
    await priyaPage.screenshot({ path: path.join(OUT, 'item1-priya-team-view.png'), fullPage: true }).catch(() => {});
    const bodyText = await priyaPage.evaluate(() => document.body.innerText);
    const seesRoster = /Marcus Webb|Priya Anand|Jordan Reyes|demo-team-/i.test(bodyText);
    report('UI: TC Priya sees real team roster/dossier data', seesRoster);
    const addBtnVisible = await priyaPage.locator('button', { hasText: '+ Add team member' }).isVisible().catch(() => false);
    report('UI: TC Priya does NOT see "+ Add team member" (admin-only)', !addBtnVisible);
    const removeBtnVisible = await priyaPage.locator('button', { hasText: 'Remove' }).first().isVisible().catch(() => false);
    report('UI: TC Priya does NOT see any "Remove" button (admin-only)', !removeBtnVisible);
    const renameTriggerVisible = await priyaPage.locator('button', { hasText: 'Rename' }).isVisible().catch(() => false);
    report('UI: TC Priya does NOT see "Rename" control (admin-only)', !renameTriggerVisible);
  } else {
    await priyaPage.screenshot({ path: path.join(OUT, 'item1-priya-FAIL.png'), fullPage: true }).catch(() => {});
  }
  await priyaCtx.close();

  // Cleanup item 1: revoke tc from Priya, restore original agent-only state.
  const revokeRes = await fetch(`${BASE}/api/team/update-roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadToken}` },
    body: JSON.stringify({ member_id: priyaMemberBefore.member_id, remove_roles: ['tc'] }),
  });
  const revokeJson = await revokeRes.json().catch(() => null);
  const priyaMemberAfter = await getMemberRow(priyaUserId);
  report(
    'cleanup: Priya restored to agent-only (tc revoked)',
    revokeRes.ok && revokeJson && revokeJson.ok && !priyaMemberAfter.roles.includes('tc'),
    JSON.stringify(priyaMemberAfter && priyaMemberAfter.roles)
  );

  // ═══════════════════════════════════════════════════════════════════════
  // ITEM 2 — Transaction reassignment (admin-only)
  // ═══════════════════════════════════════════════════════════════════════
  const { data: demo03Before } = await admin
    .from('transactions')
    .select('id, user_id, property_address, dossier_number')
    .eq('org_id', ORG_ID)
    .eq('dossier_number', 'DEMO-03')
    .maybeSingle();
  report('setup: DEMO-03 (77 Preston Hollow, Marcus) found', !!demo03Before && demo03Before.user_id === marcusUserId, JSON.stringify(demo03Before));

  const danaCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const danaPage = await danaCtx.newPage();
  await signIn(danaPage, 'demo-team-lead@meetdossie.com');
  const danaTeamNav = danaPage.locator('aside.app-sidebar button', { hasText: 'Team' });
  await danaTeamNav.waitFor({ state: 'visible', timeout: 20000 });
  await danaTeamNav.click({ force: true });
  await danaPage.waitForTimeout(2500);

  // Select Marcus in the roster.
  const marcusRosterItem = danaPage.locator('div[role="button"]', { hasText: 'demo-team-agent1' }).first();
  await marcusRosterItem.waitFor({ state: 'visible', timeout: 15000 });
  await marcusRosterItem.click();
  await danaPage.waitForTimeout(1500);

  // ── ITEM 4 (closings trend) checked here too — Marcus's board header is
  // already loaded at this point in the flow.
  const boardText = await danaPage.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'item4-marcus-board-text.txt'), boardText);
  const hasClosedThisMonth = /Closed this mo\./i.test(boardText);
  report('UI: MemberBoard shows "Closed this mo." stat', hasClosedThisMonth);
  await danaPage.screenshot({ path: path.join(OUT, 'item4-marcus-board.png'), fullPage: true }).catch(() => {});

  const danaDossiersRes = await fetch(`${BASE}/api/team/org-dossiers?org_id=${ORG_ID}`, {
    headers: { Authorization: `Bearer ${leadToken}` },
  });
  const danaDossiersJson = await danaDossiersRes.json().catch(() => null);
  const marcusMember = danaDossiersJson && danaDossiersJson.members && danaDossiersJson.members.find((m) => m.user_id === marcusUserId);
  report(
    'backend: org-dossiers.js returns closings_this_month/closings_last_month for Marcus',
    !!marcusMember && typeof marcusMember.closings_this_month === 'number' && typeof marcusMember.closings_last_month === 'number',
    JSON.stringify(marcusMember && { closings_this_month: marcusMember.closings_this_month, closings_last_month: marcusMember.closings_last_month })
  );
  report(
    'backend: Marcus shows exactly 1 closing this month (DEMO-02, closing_date 10 days ago)',
    !!marcusMember && marcusMember.closings_this_month === 1
  );

  // Find + expand DEMO-03's card, click Reassign to Priya.
  const dealCard = danaPage.locator('div', { hasText: '77 Preston Hollow' }).last();
  await dealCard.waitFor({ state: 'visible', timeout: 15000 });
  await dealCard.click();
  await danaPage.waitForTimeout(1500);
  await danaPage.screenshot({ path: path.join(OUT, 'item2-01-expanded.png'), fullPage: true }).catch(() => {});

  const reassignSelect = danaPage.locator('select').filter({ hasText: 'Reassign to...' }).first();
  const reassignVisible = await reassignSelect.isVisible().catch(() => false);
  report('UI: admin sees the Reassign dropdown on an expanded dossier', reassignVisible);
  if (reassignVisible) {
    await reassignSelect.selectOption(priyaUserId);
    const reassignBtn = danaPage.locator('button', { hasText: 'Reassign' }).last();
    await reassignBtn.click();
    await danaPage.waitForTimeout(2000);
    await danaPage.screenshot({ path: path.join(OUT, 'item2-02-after-reassign.png'), fullPage: true }).catch(() => {});
  }

  await new Promise((r) => setTimeout(r, 1000));
  const { data: demo03After } = await admin
    .from('transactions')
    .select('id, user_id, property_address, dossier_number')
    .eq('id', demo03Before.id)
    .maybeSingle();
  report(
    'DB: DEMO-03 transactions.user_id moved from Marcus to Priya',
    demo03After && demo03After.user_id === priyaUserId,
    `before=${demo03Before.user_id} after=${demo03After && demo03After.user_id}`
  );

  const { data: auditRow } = await admin
    .from('admin_actions_audit')
    .select('action_type, target_resource_id, payload_json, created_at')
    .eq('org_id', ORG_ID)
    .eq('target_resource_id', demo03Before.id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  report(
    'DB: admin_actions_audit has a reassign row for DEMO-03',
    !!auditRow && auditRow.payload_json && auditRow.payload_json.action === 'reassign',
    JSON.stringify(auditRow)
  );

  // Cleanup item 2: reassign DEMO-03 back to Marcus via the real API.
  const restoreRes = await fetch(`${BASE}/api/team/reassign-transaction`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadToken}` },
    body: JSON.stringify({ transaction_id: demo03Before.id, new_user_id: marcusUserId }),
  });
  const restoreJson = await restoreRes.json().catch(() => null);
  const { data: demo03Restored } = await admin
    .from('transactions')
    .select('user_id')
    .eq('id', demo03Before.id)
    .maybeSingle();
  report(
    'cleanup: DEMO-03 reassigned back to Marcus, org restored to original state',
    restoreRes.ok && restoreJson && restoreJson.ok && demo03Restored && demo03Restored.user_id === marcusUserId,
    JSON.stringify(restoreJson)
  );

  await danaCtx.close();

  // ═══════════════════════════════════════════════════════════════════════
  // ITEM 3 — First-run welcome banner (Jordan, non-admin, fresh browser ctx)
  // ═══════════════════════════════════════════════════════════════════════
  const jordanCtx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  const jordanPage = await jordanCtx.newPage();
  await signIn(jordanPage, 'demo-team-agent3@meetdossie.com');
  await jordanPage.waitForTimeout(2000);
  await jordanPage.screenshot({ path: path.join(OUT, 'item3-01-first-login.png'), fullPage: true }).catch(() => {});
  const jordanBodyText = await jordanPage.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'item3-body-text.txt'), jordanBodyText);
  const bannerShown = /You.?re part of/i.test(jordanBodyText) && /Whitley Realty Team/i.test(jordanBodyText) && /Dana Whitley/i.test(jordanBodyText);
  report('UI: Jordan (fresh session, non-admin) sees the team welcome banner naming team + lead', bannerShown);

  const gotItBtn = jordanPage.locator('button', { hasText: 'Got it' });
  const gotItVisible = await gotItBtn.isVisible().catch(() => false);
  report('UI: welcome banner has a "Got it" dismiss button', gotItVisible);
  if (gotItVisible) {
    await gotItBtn.click();
    await jordanPage.waitForTimeout(500);
    const afterDismissText = await jordanPage.evaluate(() => document.body.innerText);
    const bannerGoneAfterDismiss = !/You.?re part of/i.test(afterDismissText);
    report('UI: banner disappears immediately after clicking "Got it"', bannerGoneAfterDismiss);

    await jordanPage.reload({ waitUntil: 'domcontentloaded' });
    await jordanPage.waitForTimeout(2500);
    const afterReloadText = await jordanPage.evaluate(() => document.body.innerText);
    fs.writeFileSync(path.join(OUT, 'item3-body-after-reload.txt'), afterReloadText);
    await jordanPage.screenshot({ path: path.join(OUT, 'item3-02-after-reload.png'), fullPage: true }).catch(() => {});
    const staysGoneAfterReload = !/You.?re part of/i.test(afterReloadText);
    report('UI: banner stays dismissed after a page reload (localStorage persisted)', staysGoneAfterReload);
  }
  await jordanCtx.close();

  await browser.close();

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.log('\nFAILURES:');
    failed.forEach((r) => console.log(`- ${r.name}: ${r.note || ''}`));
    process.exit(1);
  }
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
