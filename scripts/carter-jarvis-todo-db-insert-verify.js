#!/usr/bin/env node
// scripts/carter-jarvis-todo-db-insert-verify.js
//
// Validates the "Jarvis writes to jarvis_todos" path end-to-end WITHOUT
// waiting on the parallel jarvis-bridge MCP wiring: a row is inserted
// directly via the Supabase REST API using the service-role key (same
// write path a generic Supabase MCP client would use), then this script
// loads the real PWA as Heath and confirms the row renders (collapsed,
// expandable) — either via the realtime subscription or the 20s poll
// fallback.
//
// Usage: node scripts/carter-jarvis-todo-db-insert-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-jarvis-todo-db-insert-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-todo-panels-2026-08-12');
fs.mkdirSync(OUT, { recursive: true });

async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email: EMAIL });
  if (error) throw new Error(`generateLink failed: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function insertDirectRow(title, detail) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${url}/rest/v1/jarvis_todos`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ title, detail }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`insert failed: ${res.status} ${JSON.stringify(data)}`);
  return data[0];
}

async function deleteRow(id) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  await fetch(`${url}/rest/v1/jarvis_todos?id=eq.${id}`, {
    method: 'DELETE',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();

  // Sign in FIRST (subscribes realtime channel on boot), THEN insert the row
  // — this is the real-world sequence: Heath already has the PWA open when
  // Jarvis (or here, a direct REST insert standing in for it) adds an item.
  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, sessionObj }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: sessionObj.access_token,
      refresh_token: sessionObj.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: sessionObj.user,
    }));
  }, { key: `sb-${projectRef}-auth-token`, sessionObj: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  console.log('[verify] signed in, PWA loaded with jarvis_todos realtime subscription active');

  const title = `Jarvis DB-insert verify ${Date.now()}`;
  const row = await insertDirectRow(title, 'Inserted directly via Supabase REST with the service role key, simulating the jarvis-bridge MCP write path.');
  console.log('[verify] inserted row directly via REST:', row.id);

  // Give realtime a moment; fall back to waiting out the 20s poll interval if needed.
  let appeared = false;
  for (let i = 0; i < 26; i++) {
    appeared = await page.locator('.jt-item-title', { hasText: title }).count().then((c) => c > 0);
    if (appeared) break;
    await page.waitForTimeout(1000);
  }
  console.log(`[verify] item appeared in UI: ${appeared} (waited up to 26s)`);
  await page.screenshot({ path: path.join(OUT, '06-db-insert-appeared.png'), fullPage: true });

  let expandedOk = false;
  if (appeared) {
    const item = page.locator('.jt-item', { has: page.locator(`.jt-item-title:text("${title}")`) });
    const collapsed = await item.locator('.jt-item-body').first().evaluate((el) => el.classList.contains('hidden'));
    await item.locator('.jt-item-head').first().click();
    await page.waitForTimeout(500);
    const expanded = await item.locator('.jt-item-body').first().evaluate((el) => !el.classList.contains('hidden'));
    const detailText = await item.locator('.jt-item-detail').first().innerText();
    expandedOk = collapsed && expanded && detailText.includes('jarvis-bridge MCP write path');
    console.log(`[verify] rendered collapsed=${collapsed}, expands=${expanded}, detail="${detailText}"`);
    await page.screenshot({ path: path.join(OUT, '07-db-insert-expanded.png'), fullPage: true });
  }

  await browser.close();
  await deleteRow(row.id);
  console.log('[verify] cleaned up test row from jarvis_todos');

  const overall = appeared && expandedOk;
  console.log(`\nOVERALL (DB-insert -> UI path): ${overall ? 'PASS' : 'FAIL'}`);
  process.exit(overall ? 0 : 1);
})().catch(async (e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
