'use strict';

/**
 * scripts/atlas-fal-topup.js
 *
 * Autonomous fal.ai $20 top-up via Heath's logged-in Chrome (CDP on 9222).
 *
 * Flow:
 *   1. Connect to existing Chrome on 9222 (Heath's logged-in profile).
 *   2. Open new tab, navigate to https://fal.ai/dashboard/billing.
 *   3. Read current balance.
 *   4. Find "Top Up" / "Add Credits" button.
 *   5. Enter $20 amount, confirm payment method exists.
 *   6. Submit. If 3D Secure / 2FA fires → screenshot + telegram-ping Heath, exit.
 *   7. If no payment method on file → screenshot + ping Heath, exit.
 *   8. Wait for balance to update, verify, send confirmation Telegram.
 *
 * Single confirmation message on success. One blocker message on fail.
 *
 * Run from MeetDossie:
 *   node scripts/atlas-fal-topup.js
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// ─── Env ─────────────────────────────────────────────────────────────────────
const ENV_PATH = path.join(__dirname, '..', '.env.local');
function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';
const FAL_KEY = process.env.FAL_KEY;

const RUN_ID = `atlas-fal-topup-${Date.now()}`;
const LOG_DIR = path.join(__dirname, 'atlas-runs', RUN_ID);
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'run.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tg(text, photoPath) {
  if (!TELEGRAM_BOT_TOKEN) { log('no TG token; skip ping'); return; }
  try {
    if (photoPath && fs.existsSync(photoPath)) {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', TELEGRAM_CHAT_ID);
      form.append('caption', text);
      form.append('photo', fs.createReadStream(photoPath));
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        method: 'POST',
        body: form,
        headers: form.getHeaders(),
      });
      log(`tg photo: ${res.status}`);
    } else {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
      });
      log(`tg msg: ${res.status}`);
    }
  } catch (e) {
    log(`tg err: ${e.message}`);
  }
}

async function probeFalBalance() {
  // fal doesn't expose a public balance endpoint, but locked vs ok gives signal
  try {
    const r = await fetch('https://queue.fal.run/fal-ai/flux/dev', {
      method: 'POST',
      headers: { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'probe', num_inference_steps: 1 }),
    });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, body: j };
  } catch (e) {
    return { status: 0, body: { error: e.message } };
  }
}

(async () => {
  log(`run dir: ${LOG_DIR}`);

  // Probe API balance state pre-top-up
  const preProbe = await probeFalBalance();
  log(`pre-probe: ${preProbe.status} ${JSON.stringify(preProbe.body).slice(0, 200)}`);

  // Connect to existing Chrome via CDP
  let browser;
  try {
    browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  } catch (e) {
    log(`CDP connect failed: ${e.message}`);
    await tg(`fal.ai top-up FAILED: cannot connect to Chrome CDP on 9222. ${e.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (!contexts.length) {
    log('no contexts on CDP');
    await tg('fal.ai top-up FAILED: no Chrome context available.');
    process.exit(1);
  }
  const context = contexts[0];
  const page = await context.newPage();
  log('new tab created');

  try {
    await page.goto('https://fal.ai/dashboard/billing', { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    log(`nav failed: ${e.message}`);
  }
  await sleep(3500);
  const url = page.url();
  log(`landed: ${url}`);

  // If not logged in, fal will redirect to /login or /auth
  if (/login|auth|sign/i.test(url) && !url.includes('billing')) {
    const shot = path.join(LOG_DIR, 'not-logged-in.png');
    await page.screenshot({ path: shot, fullPage: true });
    log('appears not logged in');
    await tg(`fal.ai top-up BLOCKED: not logged in to fal.ai in your main Chrome. Please log in once at fal.ai then rerun.`, shot);
    process.exit(1);
  }

  // Take a snapshot of the billing page so we can debug
  const billingShot = path.join(LOG_DIR, 'billing-landing.png');
  await page.screenshot({ path: billingShot, fullPage: true });
  log(`screenshot: ${billingShot}`);

  // Try to extract the visible balance text
  const balanceText = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    // Look for $X.XX patterns near "balance" or "credit"
    const lines = txt.split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i].trim();
      if (/balance|credit|remaining|usage/i.test(l) || /^\$[\d,.]+$/.test(l)) {
        out.push(l);
      }
    }
    return out.join(' | ').slice(0, 500);
  });
  log(`balance area text: ${balanceText}`);

  // Find Top Up / Add Credits button
  const topUpCandidates = [
    'button:has-text("Top up")',
    'button:has-text("Top Up")',
    'button:has-text("Add credits")',
    'button:has-text("Add Credits")',
    'button:has-text("Add funds")',
    'a:has-text("Top up")',
    'a:has-text("Top Up")',
    'a:has-text("Add credits")',
  ];
  let opened = false;
  for (const sel of topUpCandidates) {
    const el = await page.$(sel);
    if (el) {
      log(`found top-up trigger: ${sel}`);
      try {
        await el.scrollIntoViewIfNeeded();
        await sleep(400);
        await el.click();
        opened = true;
        break;
      } catch (e) {
        log(`click err on ${sel}: ${e.message}`);
      }
    }
  }
  if (!opened) {
    const shot = path.join(LOG_DIR, 'no-topup-button.png');
    await page.screenshot({ path: shot, fullPage: true });
    await tg(`fal.ai top-up BLOCKED: couldn't locate "Top Up" button on billing page. Page text: ${balanceText.slice(0, 200)}`, shot);
    process.exit(1);
  }

  await sleep(2500);
  const dialogShot = path.join(LOG_DIR, 'topup-dialog.png');
  await page.screenshot({ path: dialogShot, fullPage: true });
  log(`dialog screenshot: ${dialogShot}`);

  // Find amount input
  const amountInput = await page.$('input[type="number"], input[name*="amount" i], input[placeholder*="amount" i], input[placeholder*="$"]');
  if (amountInput) {
    try {
      await amountInput.fill('');
      await sleep(200);
      await amountInput.fill('20');
      log('filled amount = 20');
    } catch (e) {
      log(`amount fill err: ${e.message}`);
    }
  } else {
    // Maybe there are preset buttons ($10/$20/$50)
    const presetCandidates = [
      'button:has-text("$20")',
      'button:has-text("20")',
      '[role="button"]:has-text("$20")',
    ];
    let preset = false;
    for (const sel of presetCandidates) {
      const el = await page.$(sel);
      if (el) {
        try {
          await el.click();
          preset = true;
          log(`clicked preset: ${sel}`);
          break;
        } catch {}
      }
    }
    if (!preset) {
      const shot = path.join(LOG_DIR, 'no-amount-input.png');
      await page.screenshot({ path: shot, fullPage: true });
      await tg(`fal.ai top-up BLOCKED: amount input/preset for $20 not found in dialog.`, shot);
      process.exit(1);
    }
  }

  await sleep(800);

  // Check for stored payment method indicators
  const paymentText = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const out = [];
    for (const l of txt.split('\n')) {
      const lt = l.trim();
      if (/card|payment|mastercard|visa|amex|•••|\*\*\*\*|ending/i.test(lt)) out.push(lt);
    }
    return out.join(' | ').slice(0, 400);
  });
  log(`payment area text: ${paymentText}`);

  const hasStoredCard = /•••|\*\*\*\*|ending|mastercard|visa|amex/i.test(paymentText);
  if (!hasStoredCard) {
    const shot = path.join(LOG_DIR, 'no-stored-card.png');
    await page.screenshot({ path: shot, fullPage: true });
    log('no stored payment method visible — needs Heath to add card');
    await tg(`fal.ai top-up BLOCKED: no stored payment method on file. Please open https://fal.ai/dashboard/billing and add a card once, then rerun.`, shot);
    process.exit(1);
  }
  log('stored card detected');

  // Find the confirm/pay button
  const confirmCandidates = [
    'button:has-text("Confirm")',
    'button:has-text("Pay")',
    'button:has-text("Top up")',
    'button:has-text("Top Up")',
    'button:has-text("Add")',
    'button:has-text("Charge")',
    'button[type="submit"]',
  ];
  let confirmed = false;
  for (const sel of confirmCandidates) {
    const els = await page.$$(sel);
    for (const el of els) {
      try {
        const visible = await el.isVisible();
        const enabled = await el.isEnabled();
        if (!visible || !enabled) continue;
        const txt = (await el.textContent() || '').trim().toLowerCase();
        // Avoid generic "Add" buttons that mean "add card"
        if (txt === 'add' || txt.includes('add card') || txt.includes('add payment')) continue;
        log(`clicking confirm: ${sel} ("${txt}")`);
        await el.click();
        confirmed = true;
        break;
      } catch (e) {
        log(`confirm click err on ${sel}: ${e.message}`);
      }
    }
    if (confirmed) break;
  }
  if (!confirmed) {
    const shot = path.join(LOG_DIR, 'no-confirm.png');
    await page.screenshot({ path: shot, fullPage: true });
    await tg(`fal.ai top-up BLOCKED: couldn't find confirm/pay button in dialog.`, shot);
    process.exit(1);
  }

  log('confirm clicked — waiting for charge to process / 3DS');
  // Poll for up to 90s. Look for success indicators OR 3DS redirect OR error message.
  let resultText = '';
  let success = false;
  let threeDS = false;
  let errorMsg = '';
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const u = page.url();
    const txt = await page.evaluate(() => (document.body.innerText || '').slice(0, 2000));
    if (/3d secure|3ds|authenticate|verify|approve.*bank|push notification/i.test(txt) ||
        /stripe.com\/payments\/.+\/3ds|hooks.stripe.com/i.test(u)) {
      threeDS = true;
      break;
    }
    if (/success|successful|added|topped up|payment complete|thank you/i.test(txt)) {
      success = true;
      resultText = txt.slice(0, 300);
      break;
    }
    if (/declined|failed|error|insufficient/i.test(txt)) {
      errorMsg = txt.match(/(?:declined|failed|error|insufficient)[^\n]{0,140}/i)?.[0] || txt.slice(0, 200);
      break;
    }
  }

  const postShot = path.join(LOG_DIR, 'after-confirm.png');
  await page.screenshot({ path: postShot, fullPage: true });

  if (threeDS) {
    log('3DS / bank approval required');
    await tg(`fal.ai needs you to approve the $20 charge on your card — usually a push to your bank app. Tap approve and the top-up will complete.`, postShot);
    process.exit(0);
  }

  if (errorMsg) {
    log(`error: ${errorMsg}`);
    await tg(`fal.ai top-up FAILED: ${errorMsg}`, postShot);
    process.exit(1);
  }

  if (!success) {
    log('no clear success/fail signal — re-probing API');
  }

  // Wait + re-probe API to confirm balance unlocked
  await sleep(5000);
  const postProbe = await probeFalBalance();
  log(`post-probe: ${postProbe.status} ${JSON.stringify(postProbe.body).slice(0, 200)}`);

  // Refresh billing page to read new balance
  try {
    await page.goto('https://fal.ai/dashboard/billing', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(3000);
  } catch {}
  const newBalance = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const m = txt.match(/\$\s?[\d,]+\.?\d*/g);
    return m ? m.slice(0, 6).join(' / ') : '(no $ value found)';
  });
  log(`new balance values: ${newBalance}`);
  const finalShot = path.join(LOG_DIR, 'final-billing.png');
  await page.screenshot({ path: finalShot, fullPage: true });

  const apiUnlocked = postProbe.status !== 403 &&
    !JSON.stringify(postProbe.body).toLowerCase().includes('exhausted');

  if (success || apiUnlocked) {
    await tg(`fal.ai topped up $20 — balance now ${newBalance}. (API unlocked: ${apiUnlocked ? 'yes' : 'pending'})`, finalShot);
    process.exit(0);
  } else {
    await tg(`fal.ai top-up status UNCLEAR: clicked confirm but didn't see explicit success. Balance values on page: ${newBalance}. API still ${postProbe.status === 403 ? 'locked' : 'state ' + postProbe.status}.`, finalShot);
    process.exit(1);
  }
})().catch(async (e) => {
  log(`fatal: ${e.message}\n${e.stack}`);
  try { await tg(`fal.ai top-up CRASHED: ${e.message}`); } catch {}
  process.exit(1);
});
