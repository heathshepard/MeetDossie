#!/usr/bin/env node
// scripts/carter-team-doc-vault-verify.js
//
// Real-browser + real-DB verification for the compliance vault + team-wide
// document search (2026-08-24). Uses the seeded Whitley Realty Team (DEMO)
// org's real transactions/documents (checked live before writing this
// script, not assumed).
//
// Usage: node scripts/carter-team-doc-vault-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-team-doc-vault-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-doc-vault-2026-08-24');
fs.mkdirSync(OUT, { recursive: true });

const ORG_ID = 'ad1decf9-0ff1-42eb-950a-8e4b67d128f6';

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
  // ── 0. Real-DB ground truth, checked fresh right now. ────────────────────
  const { data: txs } = await admin.from('transactions').select('id, user_id, property_address, dossier_number').eq('org_id', ORG_ID);
  const txIds = (txs || []).map((t) => t.id);
  const { data: docs } = await admin.from('documents').select('id, transaction_id, document_type').in('transaction_id', txIds);
  const presentSD = new Set((docs || []).filter((d) => d.document_type === 'sellers_disclosure').map((d) => d.transaction_id));
  const expectedPresentCount = presentSD.size;
  const expectedMissingCount = txIds.length - presentSD.size;
  const expectedTotalDocs = (docs || []).length;
  // Vault row count = every REAL present document (any type) + one synthetic
  // "missing" row per transaction lacking a required type. Only one required
  // type exists today (sellers_disclosure), so missing rows == expectedMissingCount.
  const expectedGrandTotal = expectedTotalDocs + expectedMissingCount;
  console.log(`[ground-truth] ${txIds.length} transactions, ${expectedTotalDocs} real documents, sellers_disclosure present on ${expectedPresentCount}, missing on ${expectedMissingCount}, expected vault total=${expectedGrandTotal}`);
  report('ground truth loaded from live DB (not assumed)', txIds.length > 0 && expectedTotalDocs > 0, `tx=${txIds.length} docs=${expectedTotalDocs}`);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
  const page = await ctx.newPage();
  await signIn(page, 'demo-team-lead@meetdossie.com');

  const teamNav = page.locator('aside.app-sidebar button', { hasText: 'Team' });
  await teamNav.waitFor({ state: 'visible', timeout: 20000 });
  await teamNav.click({ force: true });
  await page.waitForTimeout(2000);

  const docsTabBtn = page.locator('button', { hasText: 'Documents' }).first();
  const docsTabVisible = await docsTabBtn.isVisible().catch(() => false);
  report('UI: "Documents" tab is visible on the Team Dashboard', docsTabVisible);
  if (!docsTabVisible) {
    await page.screenshot({ path: path.join(OUT, 'FAIL-no-tab.png'), fullPage: true }).catch(() => {});
    await browser.close();
    process.exit(1);
  }
  await docsTabBtn.scrollIntoViewIfNeeded().catch(() => {});
  await docsTabBtn.click({ force: true, timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(OUT, '01-vault-default.png'), fullPage: true }).catch(() => {});

  const bodyText1 = await page.evaluate(() => document.body.innerText);
  const showsResultCount = new RegExp(`${expectedGrandTotal} of ${expectedGrandTotal} document`).test(bodyText1);
  report('UI: vault loads real present docs + real missing rows, unfiltered count matches live DB exactly', showsResultCount, bodyText1.match(/\d+ of \d+ document[s]?/)?.[0]);

  // ── 1. Required-type chip shows real present/missing counts. ────────────
  const chip = page.locator('button', { hasText: "Seller's Disclosure" }).first();
  const chipVisible = await chip.isVisible().catch(() => false);
  report('UI: "Seller\'s Disclosure Notice" required-type chip visible', chipVisible);
  if (chipVisible) {
    const chipText = await chip.innerText();
    console.log('[trace] chip text:', JSON.stringify(chipText));
    const chipHasPresent = chipText.includes(String(expectedPresentCount));
    const chipHasMissing = chipText.includes(String(expectedMissingCount));
    report(`chip shows real present count (${expectedPresentCount})`, chipHasPresent, chipText);
    report(`chip shows real missing count (${expectedMissingCount} missing)`, chipHasMissing, chipText);

    await chip.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, '02-filtered-sellers-disclosure.png'), fullPage: true }).catch(() => {});
    const bodyText2 = await page.evaluate(() => document.body.innerText);
    const expectedTypeTotal = expectedPresentCount + expectedMissingCount;
    const filteredCountMatches = new RegExp(`${expectedTypeTotal} of ${expectedGrandTotal} document`).test(bodyText2);
    report('filtering by the chip shows exactly present+missing rows for that type across the WHOLE team', filteredCountMatches, bodyText2.match(/\d+ of \d+ document[s]?/)?.[0]);

    // Multiple agents represented in the filtered view — not just one.
    const distinctAgentsShown = new Set();
    ['Marcus', 'Jordan', 'Priya', 'Dana'].forEach((name) => { if (bodyText2.includes(name)) distinctAgentsShown.add(name); });
    report('filtered view spans MULTIPLE agents, not just one', distinctAgentsShown.size >= 2, [...distinctAgentsShown].join(', '));

    const showsMissingBadge = /Missing/.test(bodyText2);
    const showsPresentBadge = /On file/.test(bodyText2);
    report('filtered view shows BOTH "On file" (present) and "Missing" rows', showsMissingBadge && showsPresentBadge);
  }

  // ── 2. Real search: address text search. ──────────────────────────────
  const searchInput = page.locator('input[placeholder*="Search address"]');
  await searchInput.fill('Copperfield');
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '03-search-copperfield.png'), fullPage: true }).catch(() => {});
  const bodyText3 = await page.evaluate(() => document.body.innerText);
  const searchWorks = bodyText3.includes('214 Copperfield Way') && !bodyText3.includes('482 Ridgeline Court');
  report('real search query ("Copperfield") returns only matching address, filters out others', searchWorks);
  await searchInput.fill('');
  await page.waitForTimeout(500);

  // ── 3. Agent filter. ─────────────────────────────────────────────────
  const agentSelect = page.locator('select').filter({ hasText: 'All agents' });
  const jordanUserId = (await admin.from('profiles').select('id').eq('email', 'demo-team-agent3@meetdossie.com').maybeSingle()).data.id;
  await agentSelect.selectOption(jordanUserId);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT, '04-filter-jordan.png'), fullPage: true }).catch(() => {});
  const bodyText4 = await page.evaluate(() => document.body.innerText);
  const jordanOnlyWorks = (bodyText4.includes('3021 Canyon Ridge') || bodyText4.includes('88 Meadowlark')) && !bodyText4.includes('482 Ridgeline Court') && !bodyText4.includes('214 Copperfield Way');
  report('agent filter (Jordan) shows only Jordan\'s files, excludes other agents\' files', jordanOnlyWorks);
  await agentSelect.selectOption('');
  await page.waitForTimeout(500);

  // ── 4. Status filter (missing only). ────────────────────────────────
  const statusSelect = page.locator('select').filter({ hasText: 'Present + missing' });
  await statusSelect.selectOption('missing');
  await page.waitForTimeout(800);
  const bodyText5 = await page.evaluate(() => document.body.innerText);
  const missingOnlyNoOnFile = !/On file/.test(bodyText5);
  report('status=missing filter shows zero "On file" rows', missingOnlyNoOnFile);
  await page.screenshot({ path: path.join(OUT, '05-status-missing-only.png'), fullPage: true }).catch(() => {});

  await ctx.close();

  // ── 5. TC-role access (same admin-OR-tc gate as the rest of the dashboard). ──
  const priyaMemberRow = (await admin.from('organization_members_with_roles').select('member_id, roles').eq('org_id', ORG_ID).eq('user_id', (await admin.from('profiles').select('id').eq('email','demo-team-agent2@meetdossie.com').maybeSingle()).data.id).maybeSingle()).data;
  const leadSession = await mintSession('demo-team-lead@meetdossie.com');
  await fetch(`${BASE}/api/team/update-roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadSession.access_token}` },
    body: JSON.stringify({ member_id: priyaMemberRow.member_id, add_roles: ['tc'] }),
  });
  const priyaSession = await mintSession('demo-team-agent2@meetdossie.com');
  const tcRes = await fetch(`${BASE}/api/team/org-documents?org_id=${ORG_ID}`, {
    headers: { Authorization: `Bearer ${priyaSession.access_token}` },
  });
  const tcJson = await tcRes.json().catch(() => null);
  report('backend: org-documents.js returns 200 for TC-only role (same gate as rest of dashboard)', tcRes.status === 200 && tcJson && tcJson.ok, `status=${tcRes.status}`);
  await fetch(`${BASE}/api/team/update-roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${leadSession.access_token}` },
    body: JSON.stringify({ member_id: priyaMemberRow.member_id, remove_roles: ['tc'] }),
  });
  const priyaAfter = await admin.from('organization_members_with_roles').select('roles').eq('member_id', priyaMemberRow.member_id).maybeSingle();
  report('cleanup: Priya restored to agent-only', !priyaAfter.data.roles.includes('tc'), JSON.stringify(priyaAfter.data.roles));

  // ── 6. Plain agent (no admin/tc) correctly rejected. ────────────────
  const marcusSession = await mintSession('demo-team-agent1@meetdossie.com');
  const marcusRes = await fetch(`${BASE}/api/team/org-documents?org_id=${ORG_ID}`, {
    headers: { Authorization: `Bearer ${marcusSession.access_token}` },
  });
  report('backend: plain agent (no admin/tc) gets 403 from org-documents.js', marcusRes.status === 403, `status=${marcusRes.status}`);

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
