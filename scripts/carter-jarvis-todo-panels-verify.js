#!/usr/bin/env node
// scripts/carter-jarvis-todo-panels-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-12 Jarvis PWA build:
//   1. Panel drag-and-drop reorder + localStorage persistence
//   2. New TO-DO panel (jarvis_todos): add / expand / delete via real UI
//   3. Brokerage venture card added to the top strip
//
// Usage: node scripts/carter-jarvis-todo-panels-verify.js <BASE_URL>

'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Load .env.local (repo convention — same pattern as scripts/atlas-runs/atlas-get-session.js)
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const baseArg = process.argv[2];
if (!baseArg) {
  console.error('Usage: node scripts/carter-jarvis-todo-panels-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-todo-panels-2026-08-12');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// Mints a real Supabase session for heath.shepard@kw.com via the service-role
// admin API (magic-link generate + redeem) — same pattern already used
// elsewhere in this repo (scripts/atlas-runs/atlas-get-session.js). Avoids
// needing Heath's actual password, which isn't available to this script.
async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  if (!hashedToken) throw new Error('generateLink returned no hashed_token');
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function signIn(page) {
  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  // Navigate first so localStorage is same-origin, THEN inject the session
  // and reload — supabase-js reads sb-<ref>-auth-token on boot.
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, sessionObj }) => {
    const payload = {
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    };
    localStorage.setItem(key, JSON.stringify(payload));
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.body.innerText || '';
    return t.includes('MERGE QUEUE') && !document.querySelector('input[type="password"]');
  }, { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  return page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    const gateHidden = !gate || window.getComputedStyle(gate).display === 'none';
    return (document.body.innerText || '').includes('MERGE QUEUE') && gateHidden;
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

  console.log(`[verify] navigating ${URL}`);
  const signedIn = await signIn(page);
  report('sign-in as heath.shepard@kw.com', signedIn);
  if (!signedIn) {
    await page.screenshot({ path: path.join(OUT, '00-signin-fail.png'), fullPage: true });
    console.log('Console errors:', consoleErrors.slice(0, 20));
    console.log('Page errors:', pageErrors.slice(0, 20));
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: path.join(OUT, '01-signed-in.png'), fullPage: true });

  // ---------- FEATURE 3: BROKERAGE VENTURE CARD ----------
  const ventureNames = (await page.locator('.venture-name').allInnerTexts()).map((s) => s.trim().toLowerCase());
  report('venture strip has Dossie/Rust/Sawyer/Brokerage',
    ['dossie', 'rust', 'sawyer', 'brokerage'].every((n) => ventureNames.includes(n)),
    `found: ${ventureNames.join(', ')}`);
  await page.locator('#venture-strip').screenshot({ path: path.join(OUT, '02-venture-strip.png') }).catch(() => {});

  // ---------- FEATURE 1: PANEL DRAG-AND-DROP REORDER ----------
  const orderBefore = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dash-primary > .panel')).map((el) => el.id));
  console.log('[verify] panel order before drag:', orderBefore);

  // Drag the LAST panel's title bar to the TOP of dash-primary (drop above
  // the first panel) — native HTML5 DnD needs manual dispatch in headless
  // Chromium (mouse-based drag doesn't reliably trigger it), so simulate
  // the drag/drop events directly against the wired listeners.
  const dragResult = await page.evaluate(() => {
    const container = document.querySelector('.dash-primary');
    const panels = Array.from(container.querySelectorAll(':scope > .panel'));
    if (panels.length < 2) return { ok: false, reason: 'not enough panels' };
    const source = panels[panels.length - 1];
    const target = panels[0];
    const sourceTitle = source.querySelector(':scope > .panel-title');
    if (!sourceTitle || sourceTitle.getAttribute('draggable') !== 'true') {
      return { ok: false, reason: 'source title not draggable', hasHandle: !!sourceTitle, draggable: sourceTitle && sourceTitle.getAttribute('draggable') };
    }
    const dt = new DataTransfer();
    const targetRect = target.getBoundingClientRect();
    const dragStartEv = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
    sourceTitle.dispatchEvent(dragStartEv);
    const overEv = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: targetRect.left + 10, clientY: targetRect.top + 5 });
    Object.defineProperty(overEv, 'target', { value: target });
    container.dispatchEvent(overEv);
    const dropEv = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: targetRect.left + 10, clientY: targetRect.top + 5 });
    Object.defineProperty(dropEv, 'target', { value: target });
    container.dispatchEvent(dropEv);
    return { ok: true, sourceId: source.id, targetId: target.id };
  });
  console.log('[verify] drag simulation result:', dragResult);

  await page.waitForTimeout(500);
  const orderAfter = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dash-primary > .panel')).map((el) => el.id));
  console.log('[verify] panel order after drag:', orderAfter);
  const reordered = dragResult.ok && orderAfter[0] === dragResult.sourceId && JSON.stringify(orderAfter) !== JSON.stringify(orderBefore);
  report('drag reorders panels in DOM', reordered, `before=${JSON.stringify(orderBefore)} after=${JSON.stringify(orderAfter)}`);

  const savedOrder = await page.evaluate(() => localStorage.getItem('jarvis:panelOrder:primary'));
  report('drag persists order to localStorage', !!savedOrder && JSON.parse(savedOrder)[0] === (dragResult.sourceId || ''), `saved=${savedOrder}`);
  await page.screenshot({ path: path.join(OUT, '02c-after-drag.png'), fullPage: true });

  // Reload and confirm the persisted order survives a real page load.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  const orderAfterReload = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.dash-primary > .panel')).map((el) => el.id));
  console.log('[verify] panel order after reload:', orderAfterReload);
  report('drag order survives reload', reordered && orderAfterReload[0] === dragResult.sourceId, `after reload=${JSON.stringify(orderAfterReload)}`);
  await page.screenshot({ path: path.join(OUT, '02d-after-reload.png'), fullPage: true });

  // ---------- FEATURE 2: JARVIS TO-DO PANEL (manual add/expand/delete) ----------
  const gateBlocking = await page.evaluate(() => {
    const gate = document.getElementById('auth-gate');
    return gate && window.getComputedStyle(gate).display !== 'none';
  });
  if (gateBlocking) {
    console.log('Console errors:', consoleErrors.slice(0, 20));
    console.log('Page errors:', pageErrors.slice(0, 20));
    report('manual add via UI — item appears', false, 'auth gate blocking after reload');
    report('item renders collapsed by default', false, 'skipped');
    report('click expands item to show detail', false, 'skipped');
    report('delete removes item from UI', false, 'skipped');
  } else {
    await page.waitForSelector('#jarvis-todos-panel', { timeout: 10000 });
    const testTitle = `Carter verify ${Date.now()}`;
    await page.fill('#jt-add-input', testTitle);
    await page.click('#jt-add-btn');
    await page.waitForTimeout(2500);

    const itemLocator = page.locator('.jt-item', { has: page.locator(`.jt-item-title:text("${testTitle}")`) });
    const addedVisible = (await itemLocator.count()) > 0;
    report('manual add via UI — item appears', addedVisible);

    const bodyHiddenAfterAdd = addedVisible
      ? await itemLocator.locator('.jt-item-body').first().evaluate((el) => el.classList.contains('hidden'))
      : false;
    report('item renders collapsed by default', bodyHiddenAfterAdd);
    await page.screenshot({ path: path.join(OUT, '03-todo-added-collapsed.png'), fullPage: true });

    if (addedVisible) {
      await itemLocator.locator('.jt-item-head').first().click();
      await page.waitForTimeout(500);
      const expanded = await itemLocator.locator('.jt-item-body').first().evaluate((el) => !el.classList.contains('hidden'));
      report('click expands item to show detail', expanded);
      await page.screenshot({ path: path.join(OUT, '04-todo-expanded.png'), fullPage: true });

      await itemLocator.locator('.jt-del-btn').first().click();
      await page.waitForTimeout(2000);
      const stillThere = await page.locator('.jt-item-title', { hasText: testTitle }).count();
      report('delete removes item from UI', stillThere === 0);
    } else {
      report('click expands item to show detail', false, 'skipped, item never appeared');
      report('delete removes item from UI', false, 'skipped, item never appeared');
    }
  }

  await page.screenshot({ path: path.join(OUT, '05-final.png'), fullPage: true });
  await browser.close();

  // ---------- SUMMARY ----------
  const overall = results.every((r) => r.pass);
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ results, pageErrors, overall }, null, 2));
  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  console.log(`Page errors: ${pageErrors.length}`);
  pageErrors.forEach((e) => console.log('  ' + e));
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
