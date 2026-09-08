#!/usr/bin/env node
'use strict';

// scripts/carter-funds-due-trigger-verify.js
//
// Full-stack verification of trg_transactions_funds_due_dates (2026-09-03 QA
// round 2). Exercises ALL THREE write paths QA identified, against a
// DISPOSABLE fixture transaction owned by the LOCKED demo@meetdossie.com
// account (inserted, then deleted — zero residue, per docs/DEMO-ACCOUNTS.md):
//
//   PATH A — direct PostgREST writes (service role): the exact class of write
//            the client-side upsert makes; INSERT + PATCH + precedence + clear
//            + 2027/2028 no-expiry cases.
//   PATH B — POST /api/dossie-update-and-refill with a real member JWT: the
//            endpoint computes the due dates itself; trigger must not fight it.
//   PATH C — the REAL UI via Playwright: sign in as demo, open the fixture
//            deal, edit "Effective date" in the Deal details panel exactly as
//            a member would (this is the path that was broken), then read the
//            row back.
//
// Also asserts no live production row got touched: the count of transactions
// with a non-NULL due-date column is measured before and after, excluding the
// fixture.
//
// Usage: node scripts/carter-funds-due-trigger-verify.js <BASE_URL>

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-funds-due-trigger-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const OUT = path.join(__dirname, 'atlas-runs', 'carter-funds-due-trigger-2026-09-03');
fs.mkdirSync(OUT, { recursive: true });

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const DEMO_EMAIL = 'demo@meetdossie.com';
const FIXTURE_ADDR = 'CARTER TRIGGER FIXTURE 1 Test Ln';

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

async function rest(method, pathq, body, extraHeaders) {
  const res = await fetch(`${SUPA}/rest/v1/${pathq}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(extraHeaders || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) throw new Error(`${method} ${pathq} -> ${res.status} ${text.slice(0, 300)}`);
  return json;
}

const { createClient } = require('@supabase/supabase-js');
const admin = createClient(SUPA, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });

async function mintSession(email) {
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const verifyRes = await fetch(`${SUPA}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ type: 'magiclink', token_hash: data.properties.hashed_token }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status}`);
  return verifyData;
}

async function readFixture(id) {
  const rows = await rest('GET', `transactions?id=eq.${id}&select=contract_effective_date,option_fee_due_date,earnest_money_due_date`);
  return rows[0];
}

async function nonNullDueCount(excludeId) {
  const rows = await rest('GET', `transactions?or=(option_fee_due_date.not.is.null,earnest_money_due_date.not.is.null)&select=id`);
  return rows.filter((r) => r.id !== excludeId).length;
}

(async () => {
  let fixtureId = null;
  const browser = await chromium.launch({ headless: true });
  try {
    const { data: profile } = await admin.from('profiles').select('id').eq('email', DEMO_EMAIL).maybeSingle();
    const userId = profile.id;

    const liveBefore = await nonNullDueCount(null);
    report('ground truth: live rows with a non-NULL due-date column BEFORE test', true, `count=${liveBefore}`);

    // ═══ PATH A: direct PostgREST (the write class that bypassed the endpoints) ═══
    // A1. INSERT with effective date, no due dates supplied.
    const inserted = await rest('POST', 'transactions', {
      user_id: userId,
      dossier_number: 'CARTER-FIX-001',
      status: 'active',
      stage: 'under-contract',
      role: 'buyer',
      property_address: FIXTURE_ADDR,
      sale_price: 1,
      contract_effective_date: '2026-08-21', // Friday
    });
    fixtureId = inserted[0].id;
    let row = await readFixture(fixtureId);
    report('A1 INSERT: Friday 2026-08-21 effective -> both due Monday 2026-08-24 (no rollover)',
      row.option_fee_due_date === '2026-08-24' && row.earnest_money_due_date === '2026-08-24',
      JSON.stringify(row));

    // A2. PATCH across Labor Day.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: '2026-09-02' });
    row = await readFixture(fixtureId);
    report('A2 PATCH: Wed 2026-09-02 -> Sat -> Sun -> Labor Day Mon -> Tue 2026-09-08',
      row.option_fee_due_date === '2026-09-08' && row.earnest_money_due_date === '2026-09-08',
      JSON.stringify(row));

    // A3. Juneteenth chain.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: '2026-06-16' });
    row = await readFixture(fixtureId);
    report('A3 PATCH: 2026-06-16 -> lands Juneteenth Fri 06-19 -> Mon 2026-06-22',
      row.option_fee_due_date === '2026-06-22' && row.earnest_money_due_date === '2026-06-22',
      JSON.stringify(row));

    // A4. Thanksgiving-Friday chain.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: '2026-11-23' });
    row = await readFixture(fixtureId);
    report('A4 PATCH: 2026-11-23 -> Thanksgiving Thu + (b)(6) Fri + weekend -> Mon 2026-11-30',
      row.option_fee_due_date === '2026-11-30' && row.earnest_money_due_date === '2026-11-30',
      JSON.stringify(row));

    // A5. 2027 + 2028 — nothing expires.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: '2027-09-01' });
    row = await readFixture(fixtureId);
    const ok2027 = row.option_fee_due_date === '2027-09-07' && row.earnest_money_due_date === '2027-09-07';
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: '2028-06-16' });
    row = await readFixture(fixtureId);
    const ok2028 = row.option_fee_due_date === '2028-06-20' && row.earnest_money_due_date === '2028-06-20';
    report('A5 PATCH: 2027-09-01 -> 2027-09-07 (Labor Day) and 2028-06-16 -> 2028-06-20 (Juneteenth) — no expiry',
      ok2027 && ok2028, JSON.stringify(row));

    // A6. Precedence: caller explicitly supplies due dates in the SAME statement — caller wins.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, {
      contract_effective_date: '2026-08-21',
      option_fee_due_date: '2026-08-25',
      earnest_money_due_date: '2026-08-26',
    });
    row = await readFixture(fixtureId);
    report('A6 precedence: caller-supplied 08-25/08-26 kept, NOT recomputed to 08-24',
      row.option_fee_due_date === '2026-08-25' && row.earnest_money_due_date === '2026-08-26',
      JSON.stringify(row));

    // A7. Clearing the effective date clears both.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, { contract_effective_date: null });
    row = await readFixture(fixtureId);
    report('A7 clear: effective NULL -> both due dates NULL',
      row.contract_effective_date === null && row.option_fee_due_date === null && row.earnest_money_due_date === null,
      JSON.stringify(row));

    // ═══ PATH B: the API endpoint (computes due dates itself; trigger must agree, not fight) ═══
    const session = await mintSession(DEMO_EMAIL);
    const apiRes = await fetch(`${BASE}/api/dossie-update-and-refill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ dossier_id: fixtureId, field_name: 'contract_effective_date', field_value: '2026-09-02' }),
    });
    const apiJson = await apiRes.json().catch(() => null);
    row = await readFixture(fixtureId);
    report('B1 API endpoint: dossie-update-and-refill sets 2026-09-02 -> due 2026-09-08 (endpoint + trigger agree)',
      apiRes.status === 200 && apiJson && apiJson.ok !== false &&
      row.option_fee_due_date === '2026-09-08' && row.earnest_money_due_date === '2026-09-08',
      `status=${apiRes.status} row=${JSON.stringify(row)}`);

    // ═══ PATH C: the REAL UI (the path QA reproduced the bug on) ═══
    // Reset so the UI edit is the thing that populates the columns.
    await rest('PATCH', `transactions?id=eq.${fixtureId}`, {
      contract_effective_date: null, option_fee_due_date: null, earnest_money_due_date: null,
    });

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await ctx.newPage();
    const sess = await mintSession(DEMO_EMAIL);
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.evaluate((s) => {
      localStorage.setItem('supabase.auth.token', JSON.stringify({
        access_token: s.access_token, refresh_token: s.refresh_token, token_type: 'bearer',
        expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: s.user,
      }));
    }, sess);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT, '01-signed-in.png'), fullPage: false }).catch(() => {});

    // Open the fixture deal.
    const dealCard = page.locator(`text=${FIXTURE_ADDR}`).first();
    const dealVisible = await dealCard.isVisible().catch(() => false);
    report('C1 UI: fixture deal visible on dashboard after real sign-in', dealVisible);
    await dealCard.click({ timeout: 15000 });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: path.join(OUT, '02-deal-open.png'), fullPage: false }).catch(() => {});

    // Find the "Effective date" field card and click its EditableField.
    const effLabel = page.locator('text=Effective date').first();
    await effLabel.scrollIntoViewIfNeeded({ timeout: 15000 });
    const fieldCard = page.locator('div', { has: page.locator('text="Effective date"') }).last();
    // EditableField renders display text (or placeholder) that becomes an input on click.
    await effLabel.evaluate((el) => {
      // click the sibling editable display inside the same card
      const card = el.parentElement;
      const clickable = card.querySelector('[role="button"], span, div:not(:first-child)');
      (clickable || card.lastElementChild).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await page.waitForTimeout(800);
    const dateInput = page.locator('input[type="date"]').first();
    const inputVisible = await dateInput.isVisible().catch(() => false);
    report('C2 UI: clicking Effective date opens the date editor', inputVisible);
    await dateInput.fill('2026-09-02');
    await dateInput.press('Enter');
    await page.waitForTimeout(3500); // allow the client-side upsert to land
    await page.screenshot({ path: path.join(OUT, '03-after-edit.png'), fullPage: false }).catch(() => {});

    row = await readFixture(fixtureId);
    report('C3 UI EDIT (the previously-broken path): member edit of Effective date populates BOTH due-date columns via the trigger',
      row.contract_effective_date === '2026-09-02' &&
      row.option_fee_due_date === '2026-09-08' && row.earnest_money_due_date === '2026-09-08',
      JSON.stringify(row));

    await ctx.close();

    // ═══ No production rows touched ═══
    const liveAfter = await nonNullDueCount(fixtureId);
    report('no live production row gained a due date during this run', liveAfter === liveBefore, `before=${liveBefore} after=${liveAfter}`);
  } catch (err) {
    console.error('[FATAL]', err);
    process.exitCode = 1;
  } finally {
    if (fixtureId) {
      await rest('DELETE', `transactions?id=eq.${fixtureId}`).catch((e) => console.error('cleanup failed:', e.message));
      const leftover = await rest('GET', `transactions?id=eq.${fixtureId}&select=id`).catch(() => null);
      report('cleanup: fixture transaction deleted (demo account back to original state)', leftover && leftover.length === 0);
    }
    await browser.close().catch(() => {});
    console.log('\n=== SUMMARY ===');
    const failed = results.filter((r) => !r.pass);
    console.log(`${results.length - failed.length}/${results.length} passed`);
    if (failed.length) process.exit(1);
  }
})();
