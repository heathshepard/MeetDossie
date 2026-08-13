'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const REPO = '/mnt/c/Users/Heath/Projects/MeetDossie';
for (const line of fs.readFileSync(path.join(REPO, '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const BASE = 'https://meetdossie.com';
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = '/tmp/claude-1000/-mnt-c-Users-Heath-Projects-MeetDossie/cfa4d869-fe7b-4066-8212-1d7d43963f46/scratchpad/jarvis-verify';
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

(async () => {
  const session = await mintHeathSession();
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate((s) => {
    localStorage.setItem('sb-pgwoitbdiyubjugwufhk-auth-token', JSON.stringify({
      access_token: s.access_token,
      refresh_token: s.refresh_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      user: s.user,
    }));
  }, session);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const authGateVisible = await page.locator('#auth-gate').isVisible().catch(() => 'ERR');
  console.log('auth-gate visible:', authGateVisible);

  const ballsText = await page.locator('#jb-list').innerText().catch(() => 'MISSING');
  const workItemsCount = await page.locator('#pending-count').innerText().catch(() => 'MISSING');
  const approvalsList = await page.locator('#approvals-list').innerText().catch(() => 'MISSING');
  const todoPanel = await page.locator('#jt-list').innerText().catch(() => 'MISSING');

  await page.screenshot({ path: path.join(OUT, 'full.png'), fullPage: true });

  console.log('=== BALLS IN THE AIR ===');
  console.log(ballsText);
  console.log('=== WORK ITEMS COUNT ===');
  console.log(workItemsCount);
  console.log('=== APPROVALS LIST ===');
  console.log(approvalsList);
  console.log('=== TO-DO PANEL (jarvis_todos) ===');
  console.log(todoPanel);

  await browser.close();
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
