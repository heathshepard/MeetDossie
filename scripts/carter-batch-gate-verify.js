'use strict';
// scripts/carter-batch-gate-verify.js
//
// Carter, 2026-08-17 — real-browser before/after verification for the
// "Approve failed: not_yet_batch_approved" bug Heath hit on the Jarvis Work
// Items "Content Approvals" panel. Signs in for real, finds the seeded
// [TEST] batch-gated row, and checks:
//   - BEFORE (mode=before): clicking Approve reproduces the raw toast.
//   - AFTER  (mode=after): no clickable Approve button on the row at all;
//     a human-readable "awaiting batch approval" note shows instead; Reject
//     is still present and still works.
//
// Usage:
//   node scripts/carter-batch-gate-verify.js before <URL>
//   node scripts/carter-batch-gate-verify.js after <URL>

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const EMAIL = 'heath.shepard@kw.com';
const TEST_SUBJECT_MATCH = 'Carter batch-gate verification';
const OUT = path.join(__dirname, 'atlas-runs', 'carter-batch-gate-2026-08-17');
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
  const mode = process.argv[2]; // 'before' | 'after'
  const baseUrl = process.argv[3];
  if (!mode || !baseUrl) { console.error('Usage: node scripts/carter-batch-gate-verify.js before|after <URL>'); process.exit(1); }
  const url = `${baseUrl.replace(/\/$/, '')}/myjarvis`;

  const session = await mintHeathSession();
  const projectRef = process.env.NEXT_PUBLIC_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.evaluate(({ key, s }) => {
    localStorage.setItem(key, JSON.stringify({
      access_token: s.access_token, refresh_token: s.refresh_token, token_type: 'bearer',
      expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: s.user,
    }));
  }, { key: `sb-${projectRef}-auth-token`, s: session });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#pending-list', { timeout: 20000 });
  await page.waitForFunction(() => {
    const el = document.getElementById('pending-list');
    return el && !el.innerText.includes('Loading');
  }, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const testCard = page.locator('.pending-card', { hasText: TEST_SUBJECT_MATCH }).first();
  const found = await testCard.count();
  console.log('TEST CARD FOUND:', found > 0 ? 'PASS' : 'FAIL');
  if (found === 0) {
    console.log('pending-list text:\n' + (await page.locator('#pending-list').innerText()).slice(0, 2000));
    await page.screenshot({ path: path.join(OUT, `${mode}-not-found.png`), fullPage: true });
    await browser.close();
    process.exit(1);
  }

  await testCard.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, `${mode}-01-card.png`), fullPage: false });

  const approveBtn = testCard.locator('[data-act="approve"]');
  const approveCount = await approveBtn.count();
  console.log('Approve button present on gated row:', approveCount > 0 ? 'YES' : 'NO');

  if (mode === 'before') {
    // Reproduce the exact bug: click Approve, expect the raw error toast.
    if (approveCount === 0) {
      console.log('UNEXPECTED: no Approve button even in "before" mode — bug may already be fixed on this deployment.');
    } else {
      await approveBtn.click();
      await page.waitForTimeout(1500);
      const toastText = await page.locator('#toast').innerText().catch(() => '');
      console.log('Toast after Approve click (BEFORE fix):', JSON.stringify(toastText));
      console.log('REPRODUCES BUG (raw not_yet_batch_approved string surfaced):',
        toastText.includes('not_yet_batch_approved') ? 'YES - CONFIRMED' : 'NO');
      await page.screenshot({ path: path.join(OUT, 'before-02-toast.png'), fullPage: false });
    }
  } else {
    // AFTER: Approve button must be gone; blocked note must be present and readable.
    console.log('T1 - Approve button ABSENT (fix applied):', approveCount === 0 ? 'PASS' : 'FAIL');
    const blockedNote = testCard.locator('.pending-blocked-note');
    const noteCount = await blockedNote.count();
    const noteText = noteCount > 0 ? await blockedNote.innerText() : '(none)';
    console.log('T2 - Blocked note present:', noteCount > 0 ? 'PASS' : 'FAIL');
    console.log('Blocked note text:', JSON.stringify(noteText));
    console.log('T3 - Note mentions Telegram/batch (human-readable, not raw code):',
      /telegram|batch/i.test(noteText) ? 'PASS' : 'FAIL');

    const rejectBtn = testCard.locator('[data-act="reject"]');
    console.log('T4 - Reject button still present:', (await rejectBtn.count()) > 0 ? 'PASS' : 'FAIL');
    await rejectBtn.click();
    await page.waitForTimeout(500);
    const submitBtn = testCard.locator('[data-reply-submit]');
    if (await submitBtn.count() > 0) {
      const textarea = testCard.locator('[data-reply-input]');
      if (await textarea.count() > 0) await textarea.fill('Carter verification — cleanup reject, not a real send.');
      await submitBtn.click();
    }
    await page.waitForTimeout(1500);
    const toastText2 = await page.locator('#toast').innerText().catch(() => '');
    console.log('Toast after Reject click:', JSON.stringify(toastText2));
    console.log('T5 - Reject still works on a batch-gated row (no error toast):',
      !toastText2.toLowerCase().includes('failed') ? 'PASS' : 'FAIL');
    await page.screenshot({ path: path.join(OUT, 'after-02-post-reject.png'), fullPage: false });
  }

  await browser.close();
  console.log('\nDONE (' + mode + ')');
})().catch((e) => { console.error('FAILED', e); process.exit(1); });
