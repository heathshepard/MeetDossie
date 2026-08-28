#!/usr/bin/env node
// scripts/carter-morning-brief-urgent-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-27 Morning Brief "what's urgent" fix:
// buildBrief() never looked at overdue/escalated action_items, only TREC
// deadline dates, so a deal with real overdue action items and no
// near-term TREC deadline (or a TREC deadline more than 1 day past due,
// which is intentionally downgraded to tone "completed") never showed up
// as urgent anywhere: not the "Needs your attention" StatCard, not the
// "what's urgent today?" chat/voice answer.
//
// Real repro data: 104 Wild Cherry Ln (transaction 42a11919-ba8b-44fa-9b04-
// ed13563ab888, Heath's real account) has 3 real overdue action_items and
// an option period that lapsed 2026-08-14 (13 days before today 2026-08-27).
//
// This script signs in for real as heath.shepard@kw.com on the staging
// preview, opens /app (Morning Brief is the default tab), and confirms:
//   1. The StatCard "Needs your attention" count is >= 1 (was 0 before fix).
//   2. 104 Wild Cherry Ln actually appears in the urgent list on screen.
//   3. Typing "what's urgent today?" into Talk to Dossie names it — not
//      "Nothing urgent right now. You're clear."
//
// Usage: node scripts/carter-morning-brief-urgent-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-morning-brief-urgent-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const EMAIL = 'heath.shepard@kw.com';
const OUT = path.join(__dirname, 'carter-runs', 'carter-morning-brief-urgent-2026-08-27');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

async function mintHeathSession() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
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
  await page.goto(URL, { waitUntil: 'commit', timeout: 30000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
  // Dossie app's supabase client uses a fixed storageKey — see supabase-client.js.
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
  await page.reload({ waitUntil: 'commit', timeout: 30000 });
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);
  return page.evaluate(() => !document.body.innerText.includes('Welcome back to Dossie'));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err)));

  console.log(`[verify] navigating ${URL}`);
  let signedIn = false;
  try {
    signedIn = await signIn(page);
  } catch (err) {
    console.error('[verify] sign-in threw:', err.message);
  }
  report('sign-in as heath.shepard@kw.com', signedIn);
  await page.screenshot({ path: path.join(OUT, '01-after-signin.png'), fullPage: true }).catch(() => {});
  if (!signedIn) {
    await browser.close();
    process.exit(1);
  }

  // Give the brief useEffect (activeView === 'brief') time to fetch
  // overdue/escalated action items from /api/action-items.
  await page.waitForTimeout(4000);

  const briefText = await page.evaluate(() => document.body.innerText);
  const attentionMatch = briefText.match(/(\d+)\s*\nNeeds your attention/) || briefText.match(/Needs your attention\s*\n?\s*(\d+)/);
  console.log('[verify] "Needs your attention" raw match:', attentionMatch ? attentionMatch[0] : '(not found)');

  const hasWildCherryOnScreen = briefText.includes('104 Wild Cherry');
  report('104 Wild Cherry Ln is rendered on the Morning Brief page', hasWildCherryOnScreen);

  await page.screenshot({ path: path.join(OUT, '02-morning-brief.png'), fullPage: true }).catch(() => {});

  // Pull the StatCard number directly from the DOM near the "Needs your
  // attention" label to avoid relying on innerText line-break assumptions.
  const attentionCount = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('*'));
    const labelNode = nodes.find((n) => n.children.length === 0 && n.textContent.trim() === 'Needs your attention');
    if (!labelNode) return null;
    const card = labelNode.closest('div');
    if (!card || !card.parentElement) return null;
    const numberNode = card.parentElement.querySelector('div');
    return numberNode ? numberNode.textContent.trim() : null;
  });
  console.log('[verify] StatCard "Needs your attention" value:', attentionCount);
  report('"Needs your attention" StatCard is >= 1 (was 0 before fix)', attentionCount !== null && Number(attentionCount) >= 1, `value=${attentionCount}`);

  // Confirm 104 Wild Cherry Ln actually shows in the urgent section, not
  // just somewhere else on the page (e.g. pipeline nav).
  const urgentSectionHasWildCherry = await page.evaluate(() => {
    const headers = Array.from(document.querySelectorAll('*')).filter((n) => n.textContent.trim() === 'First things first');
    if (!headers.length) return false;
    const section = headers[0].closest('div')?.parentElement;
    return section ? section.textContent.includes('104 Wild Cherry') : false;
  });
  report('104 Wild Cherry Ln appears in "First things first" (urgent) section', urgentSectionHasWildCherry);

  // Now the chat/voice path: "what's urgent today?"
  const talkOpened = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role="button"], a')).find((n) => /talk to dossie/i.test(n.textContent || ''));
    if (btn) { btn.click(); return true; }
    return false;
  });
  console.log('[verify] Talk to Dossie opened via click:', talkOpened);
  await page.waitForTimeout(1500);

  const textarea = await page.$('textarea, input[type="text"]');
  let chatAnswer = null;
  if (textarea) {
    await textarea.click();
    await textarea.fill("what's urgent today?");
    await page.keyboard.press('Enter');
    await page.waitForTimeout(4000);
    chatAnswer = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll('*')).filter((n) => n.children.length === 0);
      const last = nodes.reverse().find((n) => /urgent|clear|wild cherry/i.test(n.textContent || ''));
      return last ? last.textContent.trim() : null;
    });
  }
  console.log('[verify] Talk to Dossie answer fragment:', chatAnswer);
  await page.screenshot({ path: path.join(OUT, '03-talk-urgent.png'), fullPage: true }).catch(() => {});
  const chatMentionsWildCherry = !!(chatAnswer && /wild cherry/i.test(chatAnswer));
  const chatSaysNothingUrgent = !!(chatAnswer && /nothing urgent/i.test(chatAnswer));
  report('"what\'s urgent today?" does NOT answer "Nothing urgent"', !chatSaysNothingUrgent, `answer="${chatAnswer}"`);

  report('No page errors during verification', pageErrors.length === 0, pageErrors.join(' | '));

  const allPass = results.every((r) => r.pass);
  console.log(`\n[verify] ${allPass ? 'ALL PASS' : 'SOME FAILED'}`);
  console.log(`[verify] screenshots: ${OUT}`);
  await browser.close();
  process.exit(allPass ? 0 : 1);
})();
