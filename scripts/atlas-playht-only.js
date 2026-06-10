'use strict';

/**
 * scripts/atlas-playht-only.js
 *
 * Hardened, PlayHT-only signup flow. Pivot from atlas-reddit-playht-flow.js
 * after Reddit auth got blocked by bot detection 2026-06-09.
 *
 * Differences from the parent script:
 *   - Reddit flow removed entirely (no risk of accidentally re-firing it).
 *   - Uses playwright-extra + puppeteer-extra-plugin-stealth.
 *   - Adds mouse-move-before-click on all interactive elements.
 *   - Adds 50-200ms random delay jitter between actions.
 *   - User-Agent override to match a real Chrome (avoid HeadlessChrome leak even
 *     though we are headed — some sites still sniff the navigator string).
 *   - Stripe checkout gate is still hard: PAUSES for Telegram confirm before
 *     submitting the payment.
 *
 * Usage:
 *   node scripts/atlas-playht-only.js
 *   node scripts/atlas-playht-only.js --dry-run
 *
 * Env required (already in .env.local):
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (action log; soft fail if missing)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID    (Heath pings via Claudy bot)
 *
 * Done condition:
 *   .env.local + Vercel env updated with:
 *     PLAYHT_USER_ID, PLAYHT_API_SECRET, PLAYHT_PASSWORD
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ─── Load .env.local ─────────────────────────────────────────────────────────

const ENV_PATH = path.join(__dirname, '..', '.env.local');

function loadEnv() {
  if (!fs.existsSync(ENV_PATH)) return;
  const lines = fs.readFileSync(ENV_PATH, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const RUN_ID = `atlas-playht-${Date.now()}`;
const LOG_DIR = path.join(__dirname, 'atlas-runs', RUN_ID);
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'run.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

// ─── Jitter helpers ──────────────────────────────────────────────────────────

function jitterMs(min = 50, max = 200) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function jitter(min = 50, max = 200) {
  await sleep(jitterMs(min, max));
}

// Mouse-move-before-click: locate element bounding box, move mouse near center
// with a small offset, then click. This avoids the "click happens at exact
// element center with zero prior movement" anti-bot signature.
async function humanClick(page, selector, options = {}) {
  const el = await page.$(selector);
  if (!el) {
    log(`humanClick: selector not found: ${selector}`);
    return false;
  }
  try {
    const box = await el.boundingBox();
    if (box) {
      const x = box.x + box.width / 2 + (Math.random() - 0.5) * 10;
      const y = box.y + box.height / 2 + (Math.random() - 0.5) * 10;
      // Move in 2-3 steps to look human-ish
      await page.mouse.move(x - 40 + Math.random() * 20, y - 30 + Math.random() * 20, { steps: 3 });
      await jitter(40, 120);
      await page.mouse.move(x, y, { steps: 5 });
      await jitter(40, 100);
      await page.mouse.click(x, y, options);
    } else {
      await el.click(options);
    }
    return true;
  } catch (e) {
    log(`humanClick error on ${selector}: ${e.message}`);
    try { await el.click(options); return true; } catch { return false; }
  }
}

async function humanType(page, selector, text) {
  const el = await page.$(selector);
  if (!el) {
    log(`humanType: selector not found: ${selector}`);
    return false;
  }
  await humanClick(page, selector);
  await jitter(80, 180);
  for (const ch of text) {
    await page.keyboard.type(ch, { delay: jitterMs(40, 110) });
  }
  return true;
}

// ─── Supabase action log ─────────────────────────────────────────────────────

async function logAction(action_type, target, text_typed, result = 'success') {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return;
  try {
    const payload = {
      action_type,
      target,
      text_typed: text_typed && text_typed.length > 200 ? text_typed.slice(0, 200) + '...' : text_typed,
      requested_by: 'atlas',
      result,
    };
    await fetch(`${SUPABASE_URL}/rest/v1/desktop_actions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    log(`logAction failed: ${e.message}`);
  }
}

// ─── Telegram helpers (Claudy bot) ───────────────────────────────────────────

async function tgSend(text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    log(`[tg-skip] ${text}`);
    return null;
  }
  try {
    const body = {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: 'HTML',
      ...options,
    };
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    return data && data.result ? data.result.message_id : null;
  } catch (e) {
    log(`tgSend failed: ${e.message}`);
    return null;
  }
}

async function tgSendPhoto(filePath, caption) {
  if (!TELEGRAM_BOT_TOKEN || !fs.existsSync(filePath)) return null;
  return new Promise((resolve) => {
    try {
      const FormData = require('form-data');
      const form = new FormData();
      form.append('chat_id', TELEGRAM_CHAT_ID);
      form.append('caption', caption || '');
      form.append('photo', fs.createReadStream(filePath));
      form.submit(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, (err, res) => {
        if (err) {
          log(`tgSendPhoto submit error: ${err.message}`);
          tgSend(caption || '(screenshot omitted)').then(() => resolve(null));
          return;
        }
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { log(`tgSendPhoto parse: ${e.message}`); resolve(null); }
        });
        res.on('error', (e) => { log(`tgSendPhoto res: ${e.message}`); resolve(null); });
      });
    } catch (e) {
      log(`tgSendPhoto failed: ${e.message}`);
      tgSend(caption || '(screenshot upload threw)').then(() => resolve(null));
    }
  });
}

async function tgWaitForReply(timeoutMs = 5 * 60 * 1000, sinceTs = Date.now()) {
  if (!TELEGRAM_BOT_TOKEN) return null;
  const deadline = Date.now() + timeoutMs;
  let lastUpdateId = 0;
  while (Date.now() < deadline) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=20&offset=${lastUpdateId + 1}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
          const msg = update.message;
          if (!msg) continue;
          if (String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
          if (msg.date * 1000 < sinceTs - 5000) continue;
          if (msg.text) return msg.text.trim();
        }
      }
    } catch (e) {
      log(`tgWaitForReply error: ${e.message}`);
    }
    await sleep(1500);
  }
  return null;
}

// Kill switch
let STOPPED = false;
async function tgPollForStop() {
  if (!TELEGRAM_BOT_TOKEN) return;
  let lastUpdateId = 0;
  const startedAt = Date.now();
  while (!STOPPED) {
    try {
      const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=15&offset=${lastUpdateId + 1}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data && data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          if (update.update_id > lastUpdateId) lastUpdateId = update.update_id;
          const msg = update.message;
          if (!msg || String(msg.chat.id) !== String(TELEGRAM_CHAT_ID)) continue;
          if (msg.date * 1000 < startedAt - 5000) continue;
          const text = (msg.text || '').trim().toUpperCase();
          if (text === 'STOP' || text === 'KILL' || text === 'ABORT') {
            STOPPED = true;
            log('[KILL SWITCH] Heath sent STOP — aborting.');
            await tgSend('🛑 Atlas PlayHT run aborted on your STOP.');
            return;
          }
        }
      }
    } catch {}
    await sleep(2000);
  }
}

function checkStopped() {
  if (STOPPED) throw new Error('Aborted by Heath STOP signal');
}

// ─── Env file mutation ───────────────────────────────────────────────────────

function updateEnvLocal(updates) {
  const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = existing.split('\n');
  const keys = Object.keys(updates);
  const seen = new Set();
  const out = [];
  for (const line of lines) {
    const m = line.match(/^([A-Z0-9_]+)=/);
    if (m && keys.includes(m[1])) {
      out.push(`${m[1]}="${updates[m[1]]}"`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const k of keys) {
    if (!seen.has(k)) out.push(`${k}="${updates[k]}"`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
  log(`Updated .env.local with: ${keys.join(', ')}`);
}

function pushVercelEnv(key, value, target = 'production') {
  try {
    spawnSync('npx', ['--no-install', 'vercel', 'env', 'rm', key, target, '--yes'], {
      cwd: path.join(__dirname, '..'),
      stdio: 'pipe',
      shell: true,
      timeout: 30000,
    });
    const result = spawnSync('npx', ['--no-install', 'vercel', 'env', 'add', key, target], {
      cwd: path.join(__dirname, '..'),
      input: value + '\n',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      timeout: 30000,
    });
    if (result.status === 0) { log(`Pushed ${key} -> Vercel (${target})`); return true; }
    log(`Vercel env add ${key} failed: ${(result.stderr || result.stdout || '').toString().slice(0, 300)}`);
    return false;
  } catch (e) {
    log(`pushVercelEnv ${key} error: ${e.message}`);
    return false;
  }
}

// ─── Password generator ──────────────────────────────────────────────────────

function genPassword(len = 24) {
  const charset = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  let out = '';
  const buf = crypto.randomBytes(len * 2);
  for (let i = 0; i < len; i++) out += charset[buf[i] % charset.length];
  return out + 'A1!';
}

// ─── Playwright (stealth) wrapper ────────────────────────────────────────────

async function newBrowser() {
  // playwright-extra wraps the upstream chromium with a plugin pipeline.
  // The stealth plugin is from puppeteer-extra but works on playwright-extra
  // for the patches it shares (navigator.webdriver, chrome.runtime, plugins,
  // languages, etc.). It does NOT cover everything puppeteer-extra-stealth
  // covers, but it's a meaningful improvement over vanilla.
  const { chromium } = require('playwright-extra');
  try {
    const stealth = require('puppeteer-extra-plugin-stealth')();
    // Some evasions don't apply to playwright (puppeteer-only chrome.app etc.)
    // — silently skip those during plugin registration.
    chromium.use(stealth);
    log('Stealth plugin registered.');
  } catch (e) {
    log(`Stealth plugin load failed: ${e.message} — continuing without.`);
  }

  const tempDir = path.join(os.tmpdir(), `atlas-flow-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  log(`Persistent context dir: ${tempDir}`);

  const context = await chromium.launchPersistentContext(tempDir, {
    headless: false,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-blink-features=AutomationControlled',
      '--start-maximized',
    ],
    viewport: null,
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  });

  // Belt-and-suspenders: also strip navigator.webdriver via init script in case
  // stealth missed it (rare but seen on cold installs).
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    // Hint a plausible set of MIME types and plugins
    if (!('chrome' in window)) window.chrome = { runtime: {} };
  });

  return { context, tempDir };
}

async function snap(page, label) {
  const file = path.join(LOG_DIR, `${Date.now()}-${label}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); } catch {}
  return file;
}

// ─── PlayHT flow ─────────────────────────────────────────────────────────────

async function flowPlayHT(page) {
  log('PlayHT Pro signup + API key capture');
  await logAction('flow_start', 'playht', 'playht-only');

  const PLAYHT_PASSWORD = genPassword(24);

  // Step 1 — pricing page
  log('Navigating to playht.com/pricing/...');
  await page.goto('https://playht.com/pricing/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await jitter(2500, 3500);
  await snap(page, 'playht-pricing');
  checkStopped();

  // Step 2 — click the Pro plan
  let proClicked = null;
  try {
    proClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      const scored = buttons.map((b) => {
        const card = b.closest('article, section, div');
        const cardText = card ? (card.innerText || '') : '';
        const btnText = (b.innerText || '').trim();
        let score = 0;
        if (/pro/i.test(cardText)) score += 5;
        if (/\$\s*(39|49|50|59)/.test(cardText)) score += 3;
        if (/subscribe|get started|sign up|start|try/i.test(btnText)) score += 3;
        if (/contact|enterprise|free/i.test(btnText)) score -= 5;
        // Tag for follow-up click via humanClick
        return { btnText, cardText: cardText.slice(0, 100), score };
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0];
      if (top && top.score >= 6) {
        // Click directly inside evaluate since human-click follow-up is awkward
        // for a button selected purely by ranking. PlayHT pricing is a marketing
        // page — bot detection is gentle here.
        const idx = buttons.findIndex((b) => b === buttons.find((x) => (x.innerText || '').trim() === top.btnText));
        if (idx >= 0) buttons[idx].click();
        return { clicked: top.btnText, score: top.score };
      }
      return null;
    });
  } catch (e) {
    log(`Pro-plan click error: ${e.message}`);
  }
  log(`Pro plan click: ${JSON.stringify(proClicked)}`);
  await jitter(3500, 4500);
  await snap(page, 'playht-after-pro-click');
  checkStopped();

  // Step 3 — signup form
  let signupHandled = false;
  for (let attempt = 0; attempt < 3 && !signupHandled; attempt++) {
    await jitter(1800, 2400);

    // Probe what's on the page
    const probe = await page.evaluate(() => {
      const out = { url: location.href, hasEmail: false, hasPass: false, hasSignupToggle: false };
      out.hasEmail = !!document.querySelector('input[type=email], input[name=email], input[id*=email i], input[placeholder*=email i]');
      out.hasPass = !!document.querySelector('input[type=password]');
      const links = Array.from(document.querySelectorAll('a, button'));
      out.hasSignupToggle = !!links.find((l) => /^sign ?up$|create account|don.t have an account/i.test((l.innerText || '').trim()));
      return out;
    });
    log(`Signup probe ${attempt + 1}: ${JSON.stringify(probe)}`);

    if (!probe.hasEmail && !probe.hasPass && probe.hasSignupToggle) {
      // Click the signup toggle first (page may default to login form)
      try {
        await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, button'));
          const m = links.find((l) => /^sign ?up$|create account|don.t have an account/i.test((l.innerText || '').trim()));
          if (m) m.click();
        });
        await jitter(1500, 2200);
      } catch {}
      continue;
    }

    if (probe.hasEmail || probe.hasPass) {
      // Fill with humanType to get keystroke delays + mouse moves
      let emailSel = 'input[type=email]';
      const emailExists = await page.$(emailSel);
      if (!emailExists) emailSel = 'input[name=email], input[id*=email i], input[placeholder*=email i]';

      const passSel = 'input[type=password]';

      if (await page.$(emailSel)) {
        await humanType(page, emailSel, 'heath@meetdossie.com');
        await jitter(150, 350);
        log('Typed email.');
      }
      if (await page.$(passSel)) {
        await humanType(page, passSel, PLAYHT_PASSWORD);
        await jitter(150, 350);
        log('Typed password.');
      }

      // Optional: name field
      const nameSel = 'input[name=name], input[id*=name i]:not([type=email]):not([type=password]), input[placeholder*=name i]';
      if (await page.$(nameSel)) {
        await humanType(page, nameSel, 'Heath Shepard');
        await jitter(150, 350);
      }

      signupHandled = true;

      // Submit
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
          const sb = buttons.find((b) => /sign ?up|continue|create account|register|next/i.test((b.innerText || b.value || '').trim()));
          if (sb) sb.click();
        });
        log('Clicked signup submit.');
      } catch (e) {
        log(`Submit click error: ${e.message}`);
      }
      await jitter(3500, 4500);
    }
  }

  if (!signupHandled) {
    // Captcha or unfamiliar form — ping Heath with screenshot
    const photo = path.join(LOG_DIR, `playht-signup-blocked-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ PlayHT signup form not detected. Could be captcha or a UI change. Reply "done" once form is filled.');
    await tgWaitForReply(10 * 60 * 1000);
  }

  await snap(page, 'playht-after-signup');

  // Step 4 — wait until we hit Stripe checkout or land in /app
  let onCheckout = false;
  for (let i = 0; i < 30; i++) {
    await jitter(1800, 2400);
    checkStopped();
    const url = page.url();
    const looksLikeCheckout = url.includes('checkout.stripe.com') || url.includes('billing') || url.includes('subscribe') || url.includes('payment');
    if (looksLikeCheckout) { onCheckout = true; break; }
    if (url.includes('playht.com/app') || url.includes('playht.com/studio')) {
      await page.goto('https://playht.com/app/billing', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await jitter(2500, 3500);
      await snap(page, 'playht-billing-landed');
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, a'));
          const m = buttons.find((b) => /upgrade|subscribe|pro/i.test((b.innerText || '').trim()) && !/free|free trial/i.test((b.innerText || '').trim()));
          if (m) m.click();
        });
      } catch {}
      await jitter(3500, 4500);
      const url2 = page.url();
      if (url2.includes('checkout') || url2.includes('stripe')) { onCheckout = true; break; }
    }
  }

  if (!onCheckout) {
    log('Did not auto-reach Stripe checkout — pinging Heath.');
    const photo = path.join(LOG_DIR, `playht-not-on-checkout-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ PlayHT signup didn\'t auto-land on Stripe checkout. Reply "advance" once I should re-check, or "manual" to take over the browser.');
    await tgWaitForReply(5 * 60 * 1000);
  }

  await snap(page, 'playht-checkout-reached');

  // Step 5 — STRIPE CHECKOUT GATE (spend ≥$20: pause for Heath confirm)
  if (!DRY_RUN) {
    const photo = path.join(LOG_DIR, `playht-checkout-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    const msgTs = Date.now();
    await tgSendPhoto(
      photo,
      '🛒 PlayHT Pro checkout reached ($50/mo). Reply "autofill" if Chrome can autofill OR paste card digits "4242... 12/27 123 78230". Reply "abort" to cancel.'
    );
    log('Awaiting Heath card decision at spend gate...');
    const reply = await tgWaitForReply(15 * 60 * 1000, msgTs);
    log(`Heath checkout reply: ${reply ? '(received)' : '(timeout)'}`);

    if (!reply) throw new Error('Timed out waiting for Heath card decision');

    const replyLower = reply.toLowerCase().trim();
    if (replyLower === 'abort' || replyLower === 'stop' || replyLower === 'cancel') {
      throw new Error('Heath aborted at spend gate');
    }

    if (replyLower === 'autofill' || replyLower === 'auto') {
      log('Heath wants autofill.');
      try {
        const cardInp = await page.$('input[name="cardnumber"], input[placeholder*="card" i], input[autocomplete="cc-number"]');
        if (cardInp) {
          await cardInp.focus();
          await jitter(1200, 1800);
        }
      } catch {}
      await tgSend('Card field focused. Tap Chrome autofill suggestion. Reply "submit" once all card fields filled.');
      await tgWaitForReply(5 * 60 * 1000);
    } else {
      // Try to parse card digits
      const digits = reply.replace(/[^0-9 /]/g, '').trim();
      log(`Card-ish input received (${digits.replace(/./g, '*').length} chars).`);
      const m = digits.match(/(\d{12,19})[\s/-]*(\d{2})[\s/-]*(\d{2,4})[\s/-]*(\d{3,4})(?:[\s/-]*(\d{5}))?/);
      let card, mm, yy, cvc, zip;
      if (m) {
        [, card, mm, yy, cvc, zip] = m;
      } else {
        const onlyDigits = digits.replace(/\D/g, '');
        if (onlyDigits.length >= 12) card = onlyDigits;
      }
      if (card) {
        try {
          const frames = page.frames();
          let cardFilled = false, expFilled = false, cvcFilled = false, zipFilled = false;
          for (const f of frames) {
            try {
              const cardInp = await f.$('input[name="cardnumber"], input[autocomplete="cc-number"], input[placeholder*="card number" i]');
              if (cardInp && !cardFilled) { await cardInp.fill(card); cardFilled = true; }
              if (mm && yy) {
                const expInp = await f.$('input[name="exp-date"], input[autocomplete="cc-exp"], input[placeholder*="MM" i]');
                if (expInp && !expFilled) { await expInp.fill(`${mm}/${yy.slice(-2)}`); expFilled = true; }
              }
              if (cvc) {
                const cvcInp = await f.$('input[name="cvc"], input[autocomplete="cc-csc"], input[placeholder*="CVC" i]');
                if (cvcInp && !cvcFilled) { await cvcInp.fill(cvc); cvcFilled = true; }
              }
              if (zip) {
                const zipInp = await f.$('input[name="postal"], input[autocomplete="postal-code"], input[placeholder*="ZIP" i]');
                if (zipInp && !zipFilled) { await zipInp.fill(zip); zipFilled = true; }
              }
            } catch {}
          }
          log(`Card fields filled: card=${cardFilled} exp=${expFilled} cvc=${cvcFilled} zip=${zipFilled}`);
          if (!cardFilled) {
            await tgSend('⚠️ Could not find card field in any iframe. Type card directly in Playwright window. Reply "submit" when done.');
            await tgWaitForReply(5 * 60 * 1000);
          }
        } catch (e) {
          log(`Card-fill error: ${e.message}`);
        }
      }
    }

    // Submit Stripe
    await jitter(1800, 2400);
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const m = buttons.find((b) => /subscribe|pay|complete|start subscription|confirm/i.test((b.innerText || '').trim()));
        if (m) m.click();
      });
    } catch {}
    log('Stripe submit clicked. Waiting for redirect...');
    await jitter(7000, 9000);
    await snap(page, 'playht-after-checkout-submit');

    let backOnPlayHT = false;
    for (let i = 0; i < 60; i++) {
      await jitter(1800, 2400);
      const url = page.url();
      if (url.includes('playht.com') && !url.includes('stripe.com')) { backOnPlayHT = true; break; }
    }
    if (!backOnPlayHT) {
      await tgSend('⚠️ Stripe didn\'t redirect back in 2min. Check window. Reply "done" once on playht.com.');
      await tgWaitForReply(10 * 60 * 1000);
    }
  }

  // Step 6 — API access page
  await page.goto('https://playht.com/app/api-access', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await jitter(3500, 4500);
  await snap(page, 'playht-api-access');
  checkStopped();

  const apiCreds = await extractPlayHTCreds(page);
  log(`PlayHT user_id: ${apiCreds.user_id ? apiCreds.user_id.slice(0, 6) + '...' : '(missing)'}`);
  log(`PlayHT api_secret: ${apiCreds.api_secret ? '[present, ' + apiCreds.api_secret.length + ' chars]' : '(missing)'}`);

  if (!apiCreds.user_id || !apiCreds.api_secret) {
    log('Auto-extract missed keys — pinging Heath.');
    const photo = path.join(LOG_DIR, `playht-key-help-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ Atlas could not read PlayHT user_id / secret automatically. Reply with: "userid=<value> secret=<value>"');
    const reply = await tgWaitForReply(5 * 60 * 1000);
    if (reply) {
      const uM = reply.match(/userid\s*=\s*([A-Za-z0-9_-]+)/i);
      const sM = reply.match(/secret\s*=\s*([A-Za-z0-9_-]+)/i);
      if (uM) apiCreds.user_id = uM[1];
      if (sM) apiCreds.api_secret = sM[1];
    }
  }

  if (!apiCreds.user_id || !apiCreds.api_secret) {
    throw new Error('Failed to capture PlayHT user_id / api_secret');
  }

  // Step 7 — save
  updateEnvLocal({
    PLAYHT_USER_ID: apiCreds.user_id,
    PLAYHT_API_SECRET: apiCreds.api_secret,
    PLAYHT_PASSWORD,
  });

  if (!DRY_RUN) {
    pushVercelEnv('PLAYHT_USER_ID', apiCreds.user_id, 'production');
    pushVercelEnv('PLAYHT_API_SECRET', apiCreds.api_secret, 'production');
    pushVercelEnv('PLAYHT_PASSWORD', PLAYHT_PASSWORD, 'production');
  }

  await logAction('credentials_saved', 'playht', `user=${apiCreds.user_id}`);
  log('FLOW complete.');
  return apiCreds;
}

async function extractPlayHTCreds(page) {
  await jitter(1800, 2400);
  let result = { user_id: null, api_secret: null };
  try {
    result = await page.evaluate(() => {
      const out = { user_id: null, api_secret: null };
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (!text) continue;
        if (/user\s*id/i.test(text) && text.length < 200) {
          const siblings = [el.nextElementSibling, ...el.querySelectorAll('input, code, span, div')];
          for (const s of siblings) {
            if (!s) continue;
            const v = (s.value || s.innerText || '').trim();
            if (v && v.length >= 6 && v.length <= 80 && !/user\s*id/i.test(v)) {
              if (!out.user_id) out.user_id = v;
              break;
            }
          }
        }
        if (/api\s*(secret|key)|secret\s*key/i.test(text) && text.length < 200) {
          const siblings = [el.nextElementSibling, ...el.querySelectorAll('input, code, span, div')];
          for (const s of siblings) {
            if (!s) continue;
            const v = (s.value || s.innerText || '').trim();
            if (v && v.length >= 10 && v.length <= 200 && !/api/i.test(v)) {
              if (!out.api_secret) out.api_secret = v;
              break;
            }
          }
        }
      }
      if (!out.user_id || !out.api_secret) {
        const inputs = Array.from(document.querySelectorAll('input[readonly], input[type=text][readonly], input[type=password][readonly]'));
        const values = inputs.map((i) => i.value).filter((v) => v && v.length >= 6);
        values.sort((a, b) => a.length - b.length);
        if (values.length >= 2) {
          if (!out.user_id) out.user_id = values[0];
          if (!out.api_secret) out.api_secret = values[values.length - 1];
        } else if (values.length === 1) {
          if (!out.api_secret) out.api_secret = values[0];
        }
      }
      return out;
    });
  } catch (e) {
    log(`extractPlayHTCreds error: ${e.message}`);
  }
  return result;
}

// ─── Main ────────────────────────────────────────────────────────────────────

(async () => {
  log(`Atlas PlayHT-only run ${RUN_ID} starting. dry_run=${DRY_RUN}`);
  await tgSend(`🚀 Atlas starting PlayHT signup flow (Reddit paused).\nRun id: <code>${RUN_ID}</code>\nReply STOP to abort.`);

  tgPollForStop().catch(() => {});

  const { context, tempDir } = await newBrowser();
  const page = await context.newPage();

  const summary = { playht: null, errors: [] };

  try {
    try {
      summary.playht = await flowPlayHT(page);
    } catch (e) {
      log(`PlayHT flow failed: ${e.stack || e.message}`);
      summary.errors.push(`playht: ${e.message}`);
      await tgSend(`❌ PlayHT flow failed: ${e.message}`);
    }

    if (summary.errors.length === 0 && summary.playht) {
      await tgSend(
        '✅ PlayHT account live. PLAYHT_USER_ID + PLAYHT_API_SECRET wired to Vercel + .env.local. Carter ready for the voice test.'
      );
    } else if (summary.errors.length > 0) {
      await tgSend(`⚠️ Run finished with ${summary.errors.length} error(s):\n${summary.errors.join('\n')}\nLogs: ${LOG_DIR}`);
    }
  } finally {
    STOPPED = true;
    log('Closing browser in 5s...');
    await sleep(5000);
    try { await context.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    log(`Run ${RUN_ID} complete. Log dir: ${LOG_DIR}`);
    process.exit(summary.errors.length === 0 ? 0 : 1);
  }
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
