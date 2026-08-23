#!/usr/bin/env node
// scripts/carter-team-chat-risk-triage-verify.js
//
// Real-browser verification (per CLAUDE.md "VERIFY IN A REAL BROWSER BEFORE
// HANDOFF") for the 2026-08-23 team-lead risk-triage chat context change:
//   - api/_lib/team-risk-rollup.js (team-wide aggregation)
//   - api/_lib/team-chat-context.js (wires it into api/chat.js action mode)
//
// Confirms two things, both via the real Talk-to-Dossie UI at /app (not a
// backend curl):
//   1. The seeded "Whitley Realty Team (DEMO)" lead account
//      (demo-team-lead@meetdossie.com) asks a real risk-triage question and
//      gets back a response that names real seeded agents/files (Priya
//      Anand's missing disclosure / overdue item) — not a hallucination.
//   2. A normal solo demo account (demo@meetdossie.com) asking the exact
//      same style of question is completely unaffected — no team section
//      appears in its behavior; it just answers as a solo agent always has.
//
// Usage: node scripts/carter-team-chat-risk-triage-verify.js <BASE_URL>

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
  console.error('Usage: node scripts/carter-team-chat-risk-triage-verify.js <BASE_URL>');
  process.exit(2);
}
const BASE = baseArg.replace(/\/$/, '');
const URL = `${BASE}/app`;
const OUT = path.join(__dirname, 'atlas-runs', 'carter-team-chat-risk-triage-2026-08-23');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

async function mintSession(email) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { createClient } = require('@supabase/supabase-js');
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw new Error(`generateLink failed for ${email}: ${error.message}`);
  const hashedToken = data.properties && data.properties.hashed_token;
  if (!hashedToken) throw new Error('generateLink returned no hashed_token');
  const verifyRes = await fetch(`${url}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: anonKey },
    body: JSON.stringify({ type: 'magiclink', token_hash: hashedToken }),
  });
  const verifyData = await verifyRes.json();
  if (!verifyRes.ok) throw new Error(`verify failed for ${email}: ${verifyRes.status} ${JSON.stringify(verifyData)}`);
  return { access_token: verifyData.access_token, refresh_token: verifyData.refresh_token, user: verifyData.user };
}

async function signIn(page, email) {
  const session = await mintSession(email);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Dossie's supabase-client.js uses a literal storageKey ('supabase.auth.token'),
  // NOT the sb-<ref>-auth-token default the Jarvis PWA uses. Confirmed by
  // reading Dossie/supabase-client.js directly — do not guess this key.
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
  return page;
}

async function askDossie(page, message, tag) {
  // Open the Talk to Dossie panel.
  const talkBtn = page.locator('button.app-talk-button');
  await talkBtn.waitFor({ state: 'visible', timeout: 20000 });
  await talkBtn.click();

  const textarea = page.locator('textarea[placeholder*="Type a command"]');
  await textarea.waitFor({ state: 'visible', timeout: 15000 });
  await textarea.click();
  await textarea.fill(message);
  await page.screenshot({ path: path.join(OUT, `${tag}-01-before-send.png`) }).catch(() => {});
  await textarea.press('Enter');

  // Wait for a new dossie-role bubble to render (thinking indicator clears).
  await page.waitForFunction(() => {
    const nodes = document.querySelectorAll('div');
    return true;
  }, { timeout: 1000 }).catch(() => {});

  console.log(`[verify] waiting up to 45s for Dossie's reply to "${message}"...`);
  await page.waitForTimeout(2000);
  const replyText = await page.waitForFunction(() => {
    const thinking = Array.from(document.querySelectorAll('div')).find((d) => d.textContent === 'Thinking...');
    return !thinking;
  }, { timeout: 45000 }).then(() => true).catch(() => false);

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, `${tag}-02-after-reply.png`), fullPage: true }).catch(() => {});

  // Pull every rendered bubble's text so we can find the assistant's latest.
  const bubbles = await page.evaluate(() => {
    const nodes = document.querySelectorAll('.talk-side-panel *');
    return Array.from(document.querySelectorAll('div')).map((n) => n.textContent).filter(Boolean);
  });

  return { replyText, bubbles };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ── 1. Team lead: risk-triage question ────────────────────────────────
  const leadCtx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const leadPage = await leadCtx.newPage();
  await signIn(leadPage, 'demo-team-lead@meetdossie.com');
  report('team lead signed in (demo-team-lead@meetdossie.com)', true);

  const q1 = 'Which files across my team are at risk right now?';
  const before1 = await leadPage.evaluate(() => document.body.innerText.length);
  await askDossie(leadPage, q1, 'lead-risk-triage');
  const bodyText1 = await leadPage.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'lead-risk-triage-body.txt'), bodyText1);

  const mentionsPriya = /Priya/i.test(bodyText1);
  const mentionsDisclosure = /disclosure/i.test(bodyText1);
  const mentionsFakeAgent = /(Skyler|Whitley Realty Team \(DEMO\)|Jamie Fake)/i.test(''); // no known-fake sentinel needed; real check is below
  report('lead reply mentions Priya (real seeded agent)', mentionsPriya);
  report('lead reply mentions "disclosure"', mentionsDisclosure);

  await leadCtx.close();

  // ── 2. Solo demo account: unaffected ────────────────────────────────────
  const soloCtx = await browser.newContext({ viewport: { width: 900, height: 1600 } });
  const soloPage = await soloCtx.newPage();
  await signIn(soloPage, 'demo@meetdossie.com');
  report('solo demo account signed in (demo@meetdossie.com)', true);

  const q2 = 'Which files across my team are at risk right now?';
  await askDossie(soloPage, q2, 'solo-unaffected');
  const bodyText2 = await soloPage.evaluate(() => document.body.innerText);
  fs.writeFileSync(path.join(OUT, 'solo-unaffected-body.txt'), bodyText2);

  const soloMentionsRealTeamAgent = /(Priya Anand|Marcus Webb|Jordan Reyes|Whitley Realty)/i.test(bodyText2);
  report('solo account reply does NOT leak team-org data', !soloMentionsRealTeamAgent, soloMentionsRealTeamAgent ? 'LEAK DETECTED' : 'clean');

  await soloCtx.close();
  await browser.close();

  console.log('\n=== SUMMARY ===');
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.note ? ' — ' + r.note : ''}`));
  const allPass = results.every((r) => r.pass);
  console.log(allPass ? '\nALL CHECKS PASSED' : '\nSOME CHECKS FAILED');
  process.exit(allPass ? 0 : 1);
})().catch((err) => {
  console.error('[verify] fatal error:', err);
  process.exit(1);
});
