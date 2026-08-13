'use strict';
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const BASE = 'https://meetdossie.com';
const URL = `${BASE}/myjarvis`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-jarvis-workitems-reject-2026-08-13');
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
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  const netErrors = [];
  page.on('response', (r) => { if (r.url().includes('/api/jarvis-approve') && r.status() >= 400) netErrors.push(`${r.status()} ${r.url()}`); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, s }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: s.access_token, refresh_token: s.refresh_token, token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: s.user,
    }));
  }, { key: `sb-${projectRef}-auth-token`, s: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForFunction(() => (document.body.innerText || '').includes('MERGE QUEUE'), { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const countBefore = await page.locator('#pending-count').innerText();
  console.log('pending-count before:', countBefore);
  await page.screenshot({ path: path.join(OUT, '01-before.png'), fullPage: true });

  const firstCard = page.locator('#pending-list .pending-card').first();
  await firstCard.waitFor({ state: 'visible', timeout: 15000 });
  const title = await firstCard.locator('[data-title]').innerText();
  console.log('rejecting item:', title);

  await firstCard.locator('[data-act="reject"]').click();
  const replyInput = firstCard.locator('[data-reply-input]');
  await replyInput.waitFor({ state: 'visible', timeout: 5000 });
  await replyInput.fill('Carter live-verify: confirming Reject works end-to-end from real UI post-fix, 2026-08-13.');
  await page.screenshot({ path: path.join(OUT, '02-reply-panel-open.png'), fullPage: true });
  await firstCard.locator('[data-reply-submit]').click();
  await page.waitForTimeout(4000);

  const countAfter = await page.locator('#pending-count').innerText();
  console.log('pending-count after:', countAfter);
  console.log('api errors seen:', JSON.stringify(netErrors));
  await page.screenshot({ path: path.join(OUT, '03-after.png'), fullPage: true });

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ title, countBefore, countAfter, netErrors }, null, 2));
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
