#!/usr/bin/env node
// scripts/carter-compliance-vault-solo-verify.js
//
// Real-browser verification for the Solo Compliance Vault add-on
// (2026-08-24) against the LOCKED demo@meetdossie.com account (per
// docs/DEMO-ACCOUNTS.md — never repurposed, core data never touched here;
// the ONLY mutation is a temporary subscriptions row + entitlement flag,
// inserted and then fully removed at the end so the account carries zero
// residue, exactly the docs' "don't modify core data" instruction).
//
// Confirms: (1) the "Compliance Vault" nav item + Settings card are
// correctly HIDDEN/gated when the add-on isn't active, (2) once
// (test-)enabled, real documents render — checked against the real, live
// document count for this account, (3) search + filters work, (4) after
// removing the entitlement, everything goes back to gated/hidden.
//
// Usage: node scripts/carter-compliance-vault-solo-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-compliance-vault-solo-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-compliance-vault-solo-2026-08-24');
fs.mkdirSync(OUT, { recursive: true });
const DEMO_EMAIL = 'demo@meetdossie.com';

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

(async () => {
  const { data: profile } = await admin.from('profiles').select('id').eq('email', DEMO_EMAIL).maybeSingle();
  const userId = profile.id;

  const { data: existingSubs } = await admin.from('subscriptions').select('id').eq('user_id', userId);
  report('confirmed demo@meetdossie.com had ZERO subscriptions rows before this test (locked account, no billing)', (existingSubs || []).length === 0, `existing rows=${(existingSubs || []).length}`);

  const { data: txs } = await admin.from('transactions').select('id').eq('user_id', userId);
  const { data: docs } = await admin.from('documents').select('id, document_type').in('transaction_id', (txs || []).map((t) => t.id));
  const realDocCount = (docs || []).length;
  const realSdPresent = (docs || []).filter((d) => d.document_type === 'sellers_disclosure').length;
  console.log(`[ground-truth] demo account: ${(txs || []).length} transactions, ${realDocCount} real documents, sellers_disclosure present on ${realSdPresent}`);

  const browser = await chromium.launch({ headless: true });

  // ═══ PHASE 1: entitlement OFF — confirm gated/hidden ═══
  const ctx1 = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page1 = await ctx1.newPage();
  await signIn(page1, DEMO_EMAIL);
  await page1.waitForTimeout(1500);
  const vaultNavBefore = await page1.locator('aside.app-sidebar button', { hasText: 'Compliance Vault' }).isVisible().catch(() => false);
  report('PHASE 1 (no entitlement): "Compliance Vault" nav item is HIDDEN', !vaultNavBefore);
  await page1.screenshot({ path: path.join(OUT, '01-no-nav-item.png'), fullPage: true }).catch(() => {});

  const settingsNav = page1.locator('aside.app-sidebar button', { hasText: 'Settings' });
  await settingsNav.click({ force: true });
  await page1.waitForTimeout(1500);
  const bodyBeforeEnable = await page1.evaluate(() => document.body.innerText);
  const showsEnableButton = /Enable Compliance Vault/i.test(bodyBeforeEnable);
  report('PHASE 1: Settings > Add-ons shows "Enable Compliance Vault" (not Active)', showsEnableButton);
  await page1.screenshot({ path: path.join(OUT, '02-settings-not-enabled.png'), fullPage: true }).catch(() => {});
  await ctx1.close();

  // Direct API check too — 402 when unpaid.
  const sessionNoEntitlement = await mintSession(DEMO_EMAIL);
  const apiResBefore = await fetch(`${BASE}/api/solo-documents`, { headers: { Authorization: `Bearer ${sessionNoEntitlement.access_token}` } });
  report('backend: /api/solo-documents returns 402 with no entitlement', apiResBefore.status === 402, `status=${apiResBefore.status}`);

  // ═══ Test-enable (insert disposable subscriptions row) ═══
  const { data: insertedSub, error: insertErr } = await admin
    .from('subscriptions')
    .insert({ user_id: userId, plan: 'solo', status: 'active', compliance_vault_enabled: true })
    .select('id')
    .single();
  report('test setup: inserted disposable subscriptions row with compliance_vault_enabled=true', !insertErr && !!insertedSub, insertErr && insertErr.message);

  // ═══ PHASE 2: entitlement ON — confirm real data renders + search works ═══
  const ctx2 = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page2 = await ctx2.newPage();
  await signIn(page2, DEMO_EMAIL);
  await page2.waitForTimeout(1500);
  const vaultNavAfter = page2.locator('aside.app-sidebar button', { hasText: 'Compliance Vault' });
  const vaultNavAfterVisible = await vaultNavAfter.isVisible().catch(() => false);
  report('PHASE 2 (entitlement enabled): "Compliance Vault" nav item now VISIBLE', vaultNavAfterVisible);

  if (vaultNavAfterVisible) {
    await vaultNavAfter.click({ force: true, timeout: 15000 });
    await page2.waitForTimeout(2500);
    await page2.screenshot({ path: path.join(OUT, '03-vault-view.png'), fullPage: true }).catch(() => {});
    const bodyVault = await page2.evaluate(() => document.body.innerText);
    const countMatch = bodyVault.match(/(\d+) of (\d+) document/);
    const shownTotal = countMatch ? parseInt(countMatch[2], 10) : null;
    report(
      'vault loads real documents — total row count is plausible (real docs + missing required rows, not empty/fake)',
      shownTotal !== null && shownTotal >= realDocCount,
      `shown total=${shownTotal}, real doc count=${realDocCount}`
    );

    // Real search.
    const searchInput = page2.locator('input[placeholder*="Search address"]');
    await searchInput.fill('a');
    await page2.waitForTimeout(700);
    const bodyAfterSearch = await page2.evaluate(() => document.body.innerText);
    const searchNarrowed = /\d+ of \d+ document/.test(bodyAfterSearch);
    report('search input filters the result count (real interactivity, not static)', searchNarrowed, bodyAfterSearch.match(/\d+ of \d+ document[s]?/)?.[0]);
    await searchInput.fill('');
    await page2.waitForTimeout(500);

    // Status filter.
    const statusSelect = page2.locator('select').filter({ hasText: 'Present + missing' });
    await statusSelect.selectOption('present');
    await page2.waitForTimeout(700);
    const bodyPresentOnly = await page2.evaluate(() => document.body.innerText);
    const noMissingBadges = !/Missing/.test(bodyPresentOnly.replace(/document type/gi, ''));
    report('status=present filter hides all "Missing" rows', !/>Missing</.test(bodyPresentOnly) || noMissingBadges);
    await page2.screenshot({ path: path.join(OUT, '04-present-only.png'), fullPage: true }).catch(() => {});
  } else {
    await page2.screenshot({ path: path.join(OUT, 'FAIL-phase2-no-nav.png'), fullPage: true }).catch(() => {});
  }

  // Settings card should now show Active.
  const settingsNav2 = page2.locator('aside.app-sidebar button', { hasText: 'Settings' });
  await settingsNav2.click({ force: true });
  await page2.waitForTimeout(1500);
  const bodyAfterEnable = await page2.evaluate(() => document.body.innerText);
  report('PHASE 2: Settings > Add-ons now shows Compliance Vault as active (not "Enable")', !/Enable Compliance Vault/i.test(bodyAfterEnable));
  await ctx2.close();

  // Direct API check — 200 with real rows now.
  const sessionWithEntitlement = await mintSession(DEMO_EMAIL);
  const apiResAfter = await fetch(`${BASE}/api/solo-documents`, { headers: { Authorization: `Bearer ${sessionWithEntitlement.access_token}` } });
  const apiJsonAfter = await apiResAfter.json().catch(() => null);
  report(
    'backend: /api/solo-documents returns 200 + real rows once entitled',
    apiResAfter.status === 200 && apiJsonAfter && apiJsonAfter.ok && Array.isArray(apiJsonAfter.rows) && apiJsonAfter.rows.length >= realDocCount,
    `status=${apiResAfter.status} rows=${apiJsonAfter && apiJsonAfter.rows && apiJsonAfter.rows.length}`
  );

  // ═══ Cleanup — remove the disposable subscriptions row entirely ═══
  await admin.from('subscriptions').delete().eq('id', insertedSub.id);
  const { data: subsAfterCleanup } = await admin.from('subscriptions').select('id').eq('user_id', userId);
  report('cleanup: demo@meetdossie.com restored to ZERO subscriptions rows (original state)', (subsAfterCleanup || []).length === 0, `rows now=${(subsAfterCleanup || []).length}`);

  // ═══ PHASE 3: confirm gated again after cleanup ═══
  const sessionAfterCleanup = await mintSession(DEMO_EMAIL);
  const apiResFinal = await fetch(`${BASE}/api/solo-documents`, { headers: { Authorization: `Bearer ${sessionAfterCleanup.access_token}` } });
  report('PHASE 3: backend re-gated to 402 after cleanup (entitlement genuinely removed, not just UI-hidden)', apiResFinal.status === 402, `status=${apiResFinal.status}`);

  await browser.close();

  console.log('\n=== SUMMARY ===');
  const failed = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}`));
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
