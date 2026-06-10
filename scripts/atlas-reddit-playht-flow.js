'use strict';

/**
 * scripts/atlas-reddit-playht-flow.js
 *
 * Atlas runs two web flows on Heath's behalf:
 *   Flow 1 — Reddit dev-platform registration + create script app at reddit.com/prefs/apps
 *   Flow 2 — PlayHT Pro signup ($50/mo) + API key capture
 *
 * Headed Playwright Chromium, fresh persistent context in a temp dir.
 * Auto-logs in to Reddit via REDDIT_USERNAME/REDDIT_PASSWORD from .env.local.
 * Pings Heath via Telegram only when truly stuck (captcha image puzzles,
 * PlayHT card field if autofill misses).
 *
 * Usage:
 *   node scripts/atlas-reddit-playht-flow.js
 *   node scripts/atlas-reddit-playht-flow.js --skip-reddit   # PlayHT only
 *   node scripts/atlas-reddit-playht-flow.js --skip-playht   # Reddit only
 *   node scripts/atlas-reddit-playht-flow.js --dry-run       # log only, no clicks past navigation
 *
 * Env required:
 *   REDDIT_USERNAME, REDDIT_PASSWORD (already in .env.local)
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (action log)
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID    (Heath pings)
 *
 * Done condition:
 *   .env.local + Vercel env updated with:
 *     REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET
 *     PLAYHT_USER_ID, PLAYHT_API_SECRET, PLAYHT_PASSWORD
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

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
const SKIP_REDDIT = args.includes('--skip-reddit');
const SKIP_PLAYHT = args.includes('--skip-playht');
const DRY_RUN = args.includes('--dry-run');

const REDDIT_USERNAME = process.env.REDDIT_USERNAME;
const REDDIT_PASSWORD = process.env.REDDIT_PASSWORD;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const RUN_ID = `atlas-${Date.now()}`;
const LOG_DIR = path.join(__dirname, 'atlas-runs', RUN_ID);
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'run.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
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

// ─── Telegram helpers ────────────────────────────────────────────────────────

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
  // Use form-data with a callback-style submit to avoid node-fetch + form-data
  // stream-length issues that produce "Unexpected end of JSON input".
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
          // Fall back to text-only ping so Heath still gets notified
          tgSend(caption || '(screenshot omitted — photo upload failed)').then(() => resolve(null));
          return;
        }
        let chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve(JSON.parse(body));
          } catch (e) {
            log(`tgSendPhoto parse error: ${e.message}`);
            resolve(null);
          }
        });
        res.on('error', (e) => {
          log(`tgSendPhoto res error: ${e.message}`);
          resolve(null);
        });
      });
    } catch (e) {
      log(`tgSendPhoto failed: ${e.message}`);
      // Fall back to text ping
      tgSend(caption || '(screenshot upload threw — see logs)').then(() => resolve(null));
    }
  });
}

// Poll Telegram getUpdates for a Heath reply since a given timestamp.
async function tgWaitForReply(promptMessageId, timeoutMs = 5 * 60 * 1000, sinceTs = Date.now()) {
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
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null; // timeout
}

// ─── Kill switch (Heath texting STOP) ────────────────────────────────────────

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
            log('[KILL SWITCH] Heath sent STOP — aborting run.');
            await tgSend('🛑 Atlas run aborted on your STOP.');
            return;
          }
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
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
      out.push(`${m[1]}=${updates[m[1]]}`);
      seen.add(m[1]);
    } else {
      out.push(line);
    }
  }
  for (const k of keys) {
    if (!seen.has(k)) out.push(`${k}=${updates[k]}`);
  }
  fs.writeFileSync(ENV_PATH, out.join('\n'), 'utf8');
  log(`Updated .env.local with: ${keys.join(', ')}`);
}

function pushVercelEnv(key, value, target = 'production') {
  // Use vercel env add. Need to pipe value via stdin to avoid showing it in process list.
  try {
    // Remove if exists (idempotent)
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
    if (result.status === 0) {
      log(`Pushed ${key} -> Vercel (${target})`);
      return true;
    } else {
      log(`Vercel env add ${key} failed: ${(result.stderr || result.stdout || '').toString().slice(0, 300)}`);
      return false;
    }
  } catch (e) {
    log(`pushVercelEnv ${key} error: ${e.message}`);
    return false;
  }
}

// ─── Password generator ──────────────────────────────────────────────────────

function genPassword(len = 24) {
  // Use a charset that avoids ambiguous chars and works in most form validators.
  const charset = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#$%';
  let out = '';
  const buf = crypto.randomBytes(len * 2);
  for (let i = 0; i < len; i++) out += charset[buf[i] % charset.length];
  // Ensure at least one of each class
  return out + 'A1!';
}

// ─── Playwright wrapper ──────────────────────────────────────────────────────

async function newBrowser() {
  const { chromium } = require('playwright');
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
  });
  return { context, tempDir };
}

async function snap(page, label) {
  const file = path.join(LOG_DIR, `${Date.now()}-${label}.png`);
  try { await page.screenshot({ path: file, fullPage: false }); } catch {}
  return file;
}

// ─── Flow 1 — Reddit ─────────────────────────────────────────────────────────

async function flowReddit(page) {
  log('FLOW 1 — Reddit dev registration + create script app');
  await logAction('flow_start', 'reddit', 'flow1');

  if (!REDDIT_USERNAME || !REDDIT_PASSWORD) {
    throw new Error('REDDIT_USERNAME / REDDIT_PASSWORD missing from .env.local');
  }

  // Step 1 — login
  log('Logging into Reddit (old.reddit.com — simpler DOM, no shadow root)...');
  // old.reddit.com still hosts /prefs/apps and uses a plain HTML login form.
  // Modern reddit.com/login wraps fields in Faceplate web components / shadow DOM,
  // which breaks programmatic typing. old.reddit.com cookies are shared.
  await page.goto('https://old.reddit.com/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(2500);
  await snap(page, 'reddit-old-login-page');
  checkStopped();

  // Old-reddit login form: form.login-form with input[name=user] + input[name=passwd]
  // and button.btn[type=submit]
  let formFound = false;
  for (let attempt = 0; attempt < 3 && !formFound; attempt++) {
    try {
      const userInp = await page.$('form.login-form input[name="user"], #user_login, input[name="user"]');
      const passInp = await page.$('form.login-form input[name="passwd"], #passwd_login, input[name="passwd"]');
      if (userInp && passInp) {
        await userInp.click({ clickCount: 3 });
        await userInp.type(REDDIT_USERNAME, { delay: 50 });
        await passInp.click({ clickCount: 3 });
        await passInp.type(REDDIT_PASSWORD, { delay: 30 });
        formFound = true;
        log('Filled old.reddit login form (user + passwd)');
        break;
      }
    } catch (e) {
      log(`Login-form fill attempt ${attempt + 1}: ${e.message}`);
    }
    await page.waitForTimeout(1500);
  }

  if (!formFound) {
    // Fallback: new reddit shadow-DOM login. Modern reddit.com/login uses
    // <faceplate-text-input> wrapping an <input> inside an open shadow root.
    log('old.reddit login form not found — falling back to new reddit shadow-DOM flow.');
    await page.goto('https://www.reddit.com/login/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    await snap(page, 'reddit-new-login-page');

    // Strategy: locate each input via shadow walker, mark them with a unique
    // attribute so Playwright can find them outside the shadow root via the
    // attribute selector. Then page.click() + keyboard.type each separately.
    // Tab key is unreliable on the Faceplate component (focus may go to the
    // show-password eye icon or to nothing).
    const probe = await page.evaluate(() => {
      function walk(root, label) {
        const inputs = root.querySelectorAll('input');
        for (const inp of inputs) {
          if (label === 'user' && (inp.type === 'email' || inp.type === 'text' || /user|email/i.test((inp.name || '') + (inp.id || '')))) return inp;
          if (label === 'pass' && (inp.type === 'password' || /pass/i.test((inp.name || '') + (inp.id || '')))) return inp;
        }
        const all = root.querySelectorAll('*');
        for (const el of all) {
          if (el.shadowRoot) {
            const hit = walk(el.shadowRoot, label);
            if (hit) return hit;
          }
        }
        return null;
      }
      const userInp = walk(document, 'user');
      const passInp = walk(document, 'pass');
      // Tag them so Playwright can click via attribute selector even inside shadow DOM
      // (Playwright pierces open shadow roots when selecting by attribute).
      if (userInp) {
        userInp.setAttribute('data-atlas-marker', 'user-input');
        userInp.scrollIntoView({ block: 'center' });
      }
      if (passInp) {
        passInp.setAttribute('data-atlas-marker', 'pass-input');
      }
      return { found_user: !!userInp, found_pass: !!passInp };
    });
    log(`New-reddit shadow probe: ${JSON.stringify(probe)}`);

    if (probe.found_user && probe.found_pass) {
      // Playwright pierces shadow roots when using CSS selectors. Try click+type
      // on each marker; fall back to JS focus + page.keyboard.type if click fails.
      async function focusAndType(marker, value) {
        // First attempt: page.click pierces shadow DOM
        try {
          await page.click(`[data-atlas-marker="${marker}"]`, { timeout: 5000 });
        } catch (e) {
          log(`page.click on ${marker} failed: ${e.message} — falling back to JS focus.`);
          await page.evaluate((m) => {
            function find(root) {
              const hit = root.querySelector(`[data-atlas-marker="${m}"]`);
              if (hit) return hit;
              const all = root.querySelectorAll('*');
              for (const el of all) {
                if (el.shadowRoot) {
                  const found = find(el.shadowRoot);
                  if (found) return found;
                }
              }
              return null;
            }
            const el = find(document);
            if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); }
          }, marker);
        }
        await page.waitForTimeout(250);
        await page.keyboard.type(value, { delay: 60 });
        await page.waitForTimeout(300);
      }

      await focusAndType('user-input', REDDIT_USERNAME);
      await focusAndType('pass-input', REDDIT_PASSWORD);
      formFound = true;
    } else {
      log(`Shadow probe missed at least one field — cannot fill.`);
    }
  }

  if (!formFound) {
    await snap(page, 'reddit-login-form-missing');
    throw new Error('Could not locate Reddit login form fields');
  }

  await logAction('type', 'reddit-login-username', REDDIT_USERNAME);
  await logAction('type', 'reddit-login-password', '[redacted]');

  // Submit — try click first (more reliable on old reddit), fall back to Enter.
  let submitted = false;
  try {
    // Old reddit: button.btn-primary[type=submit] inside .login-form
    const submitBtn = await page.$('form.login-form button[type="submit"], form.login-form input[type="submit"]');
    if (submitBtn) {
      await submitBtn.click();
      submitted = true;
      log('Clicked old.reddit login submit button');
    }
  } catch {}
  if (!submitted) {
    // New reddit: find an enabled "Log In" button — disabled state is grey.
    const newSubmit = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const m = buttons.find((b) => /^log in$/i.test((b.innerText || '').trim()) && !b.disabled);
      if (m) { m.click(); return true; }
      return false;
    });
    if (newSubmit) {
      submitted = true;
      log('Clicked new reddit Log In button');
    }
  }
  if (!submitted) {
    await page.keyboard.press('Enter');
    log('Login submit fell back to Enter key');
  }

  log('Login submitted, waiting for authenticated session...');

  // Reliable check: fetch /api/v1/me.json from inside the page.
  // - Logged in: returns user JSON with "name" key
  // - Not logged in: returns 403 with { error: 403, ... }
  // Reddit's token_v2 cookie is set even for anonymous browsers, so we cannot
  // trust cookie presence alone.
  async function checkLoggedInViaApi() {
    try {
      return await page.evaluate(async () => {
        const r = await fetch('https://www.reddit.com/api/v1/me.json', {
          credentials: 'include',
          headers: { Accept: 'application/json' },
        });
        if (r.status !== 200) return { logged_in: false, status: r.status };
        const j = await r.json().catch(() => null);
        if (j && j.name) return { logged_in: true, name: j.name };
        return { logged_in: false, body: JSON.stringify(j).slice(0, 200) };
      });
    } catch (e) {
      return { logged_in: false, err: e.message };
    }
  }

  let loggedIn = false;
  let loginInfo = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    checkStopped();
    const status = await checkLoggedInViaApi();
    if (status.logged_in) {
      loggedIn = true;
      loginInfo = status;
      break;
    }
    // Log first few checks for debug, then quiet down
    if (i < 3) log(`Auth probe ${i + 1}: ${JSON.stringify(status)}`);
  }

  if (!loggedIn) {
    await snap(page, 'reddit-login-stalled');
    const photo = path.join(LOG_DIR, `reddit-login-stalled-${Date.now()}.png`);
    await page.screenshot({ path: photo }).catch(() => {});
    await tgSendPhoto(photo, '⚠️ Reddit login did not complete. Could be captcha, 2FA, or wrong password. Finish login in the Playwright window. Reply "done" when you see your Reddit username top-right.').catch(() => {});
    log('Pinging Heath for login help.');
    const reply = await tgWaitForReply(null, 10 * 60 * 1000);
    log(`Heath reply: ${reply || '(timeout)'}`);
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(2000);
      const status = await checkLoggedInViaApi();
      if (status.logged_in) { loggedIn = true; loginInfo = status; break; }
    }
    if (!loggedIn) throw new Error('Reddit login did not complete after Heath intervention');
  }

  log(`Reddit login confirmed via /api/v1/me. Username: ${loginInfo && loginInfo.name}`);
  await snap(page, 'reddit-logged-in');
  await logAction('login', 'reddit', loginInfo && loginInfo.name);

  // Step 2 — navigate to prefs/apps
  await page.goto('https://www.reddit.com/prefs/apps', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await snap(page, 'reddit-prefs-apps');
  checkStopped();

  // Step 3 — check for dev-platform registration link and the "create another app"
  // button. If create button is disabled / form blocked, click the registration
  // link first.
  let needsDevReg = false;
  try {
    needsDevReg = await page.evaluate(() => {
      // Look for text like "register to use the API" or a banner mentioning
      // the Developer Platform.
      const txt = document.body.innerText.toLowerCase();
      return txt.includes('register to use the api') ||
             txt.includes('developer platform') && txt.includes('register');
    });
  } catch {}

  log(`Dev-platform registration required: ${needsDevReg}`);

  if (needsDevReg) {
    // Try to find and click the "register to use the API" link
    try {
      const linkClicked = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        const m = links.find((a) => /register to use the api|developer platform|dev platform/i.test(a.innerText));
        if (m) {
          m.click();
          return m.href || true;
        }
        return false;
      });
      log(`Dev-platform link click result: ${JSON.stringify(linkClicked)}`);
      await page.waitForTimeout(4000);
      checkStopped();
    } catch (e) {
      log(`Dev-link click error: ${e.message}`);
    }

    // After click, we're likely on developers.reddit.com or a similar dev portal.
    // Fill out the dev registration form if one appears.
    await snap(page, 'reddit-dev-portal-landed');
    await fillDevRegistrationForm(page);
  }

  // Step 4 — go to www.reddit.com/prefs/apps (modern URL — old.reddit handoff
  // does not always carry session cookies cleanly across subdomains).
  log('Navigating to www.reddit.com/prefs/apps to create the script app...');
  await page.goto('https://www.reddit.com/prefs/apps', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  await snap(page, 'reddit-prefs-apps');
  checkStopped();

  // Verify we're actually logged in (not redirected to /login)
  const currentUrl = page.url();
  if (currentUrl.includes('/login')) {
    throw new Error(`Redirected to /login when accessing /prefs/apps — session not valid. URL: ${currentUrl}`);
  }

  // Check whether the dev-platform gate is present
  const needsDevReg2 = await page.evaluate(() => {
    const txt = document.body.innerText.toLowerCase();
    return txt.includes('register to use the api') ||
           (txt.includes('developer platform') && txt.includes('register'));
  }).catch(() => false);
  log(`Dev-platform gate visible on /prefs/apps: ${needsDevReg2}`);
  if (needsDevReg2) {
    await fillDevRegistrationForm(page);
    await page.goto('https://www.reddit.com/prefs/apps', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);
  }

  // Old reddit's "create another app" button has id=create-app-button (anchor/button).
  let createOpened = false;
  try {
    createOpened = await page.evaluate(() => {
      // Old reddit: <button id="create-app-button">create app...</button>
      const direct = document.querySelector('#create-app-button, button.create-app, .create-app-button');
      if (direct) { direct.click(); return 'id-match'; }
      const buttons = Array.from(document.querySelectorAll('button, a.btn, input[type=button], input[type=submit]'));
      const m = buttons.find((b) => /create (another )?app|are you a developer/i.test((b.innerText || b.value || '').trim()));
      if (m) { m.click(); return 'text-match'; }
      return false;
    });
  } catch {}
  log(`Create-app button clicked: ${createOpened}`);
  await page.waitForTimeout(2000);

  // The create-app form should now be visible inline.
  await snap(page, 'reddit-create-form-visible');

  // Step 5 — fill the create-app form
  await fillCreateAppForm(page);
  await snap(page, 'reddit-create-form-filled');

  // Step 6 — submit (old reddit: button.c-btn.c-btn-primary with text "create app")
  let createSubmitted = false;
  if (!DRY_RUN) {
    try {
      createSubmitted = await page.evaluate(() => {
        // Old reddit form has a submit button labeled "create app"
        const forms = Array.from(document.querySelectorAll('form.json-section, form[action*="updateapp"], form'));
        for (const f of forms) {
          // Only act on forms that contain our redirect_uri value
          const inputs = Array.from(f.querySelectorAll('input[type=text], input[type=url]'));
          const hasOurs = inputs.some((i) => i.value === 'http://localhost:8080');
          if (!hasOurs) continue;
          const submit = f.querySelector('button[type=submit], input[type=submit], button.c-btn-primary');
          if (submit) { submit.click(); return 'form-submit'; }
        }
        // Fallback: any button labeled "create app"
        const buttons = Array.from(document.querySelectorAll('button, input[type=submit], input[type=button]'));
        const m = buttons.find((b) => /^create app$|create application/i.test((b.innerText || b.value || '').trim()));
        if (m) { m.click(); return 'text-submit'; }
        return false;
      });
      log(`Create-app submit clicked: ${createSubmitted}`);
      await page.waitForTimeout(4000);
    } catch (e) {
      log(`Submit error: ${e.message}`);
    }
  } else {
    log('DRY_RUN — skipping create-app submit');
  }

  await snap(page, 'reddit-after-create');

  // Step 7 — handle captcha if present (only ACTIVE captchas, not just embedded recaptcha)
  const captchaState = await page.evaluate(() => {
    // An ACTIVE recaptcha challenge has a visible iframe with a non-empty src
    // for the bframe / challenge frame. The hidden anchor frame is always there
    // and is not a real challenge.
    const iframes = Array.from(document.querySelectorAll('iframe'));
    const challenge = iframes.find((f) => /recaptcha\/.*bframe|hcaptcha\/.*challenge/i.test(f.src || ''));
    const visible = challenge && challenge.offsetParent !== null && challenge.getBoundingClientRect().height > 50;
    return { hasChallenge: !!visible, iframeCount: iframes.length };
  }).catch(() => ({ hasChallenge: false }));
  if (captchaState.hasChallenge) {
    log('ACTIVE captcha challenge detected after submit.');
    const photo = path.join(LOG_DIR, `reddit-captcha-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ Reddit captcha challenge. Solve in the Playwright window. Reply "done" when through.').catch(() => {});
    const reply = await tgWaitForReply(null, 10 * 60 * 1000);
    log(`Heath captcha reply: ${reply || '(timeout)'}`);
    // Re-submit if needed
    if (!DRY_RUN) {
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
          const m = buttons.find((b) => /^create app$/i.test((b.innerText || b.value || '').trim()));
          if (m) m.click();
        });
        await page.waitForTimeout(3000);
      } catch {}
    }
  } else {
    log(`No active captcha (${captchaState.iframeCount} iframes on page).`);
  }

  // Step 8 — capture client_id and client_secret
  const creds = await extractRedditCreds(page);
  await snap(page, 'reddit-creds-captured');

  if (!creds.client_id || !creds.client_secret) {
    log('Could not auto-extract Reddit creds — pinging Heath.');
    const photo = path.join(LOG_DIR, `reddit-creds-help-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ Atlas could not read Reddit client_id / secret automatically. Reply with: "id=<14char> secret=<27char>"');
    const reply = await tgWaitForReply(null, 5 * 60 * 1000);
    if (reply) {
      const idM = reply.match(/id\s*=\s*([A-Za-z0-9_-]+)/i);
      const secM = reply.match(/secret\s*=\s*([A-Za-z0-9_-]+)/i);
      if (idM) creds.client_id = idM[1];
      if (secM) creds.client_secret = secM[1];
    }
  }

  if (!creds.client_id || !creds.client_secret) {
    throw new Error('Failed to capture Reddit client_id / client_secret');
  }

  log(`Reddit client_id: ${creds.client_id} (${creds.client_id.length} chars)`);
  log(`Reddit client_secret: ${creds.client_secret.slice(0, 4)}... (${creds.client_secret.length} chars)`);

  // Step 9 — save to .env.local + push to Vercel
  updateEnvLocal({
    REDDIT_CLIENT_ID: creds.client_id,
    REDDIT_CLIENT_SECRET: creds.client_secret,
  });

  if (!DRY_RUN) {
    pushVercelEnv('REDDIT_CLIENT_ID', creds.client_id, 'production');
    pushVercelEnv('REDDIT_CLIENT_SECRET', creds.client_secret, 'production');
  }

  await logAction('credentials_saved', 'reddit', `id=${creds.client_id}`);
  log('FLOW 1 complete.');
  return creds;
}

async function fillDevRegistrationForm(page) {
  log('Attempting to fill dev-platform registration form...');
  // We don't know the exact field labels, so probe common patterns.
  const fields = {
    use_case: 'Personal automation for social media engagement on real estate listings I post.',
    volume: '< 1000 requests/day',
    project_url: 'https://meetdossie.com',
    name: 'Heath Shepard',
    full_name: 'Heath Shepard',
    first_name: 'Heath',
    last_name: 'Shepard',
    email: 'heath@meetdossie.com',
    location: 'Texas, USA',
    country: 'United States',
    state: 'Texas',
    company: 'Shepard Ventures',
    description: 'Personal automation for social media engagement on real estate listings I post.',
  };

  // Try to fill any visible inputs / textareas by inspecting their label or placeholder.
  let filled = 0;
  try {
    filled = await page.evaluate((fields) => {
      let count = 0;
      const inputs = Array.from(document.querySelectorAll('input[type=text], input[type=email], input[type=url], input:not([type]), textarea'));
      for (const inp of inputs) {
        if (inp.value) continue; // don't overwrite
        const label = (inp.placeholder || inp.name || inp.id || '').toLowerCase();
        // Find associated <label>
        let labelText = '';
        if (inp.id) {
          const lab = document.querySelector(`label[for="${inp.id}"]`);
          if (lab) labelText = lab.innerText.toLowerCase();
        }
        const blob = label + ' ' + labelText;
        let val = null;
        if (/use[- _]?case|why|purpose/i.test(blob)) val = fields.use_case;
        else if (/volume|requests|rate/i.test(blob)) val = fields.volume;
        else if (/url|website|project/i.test(blob)) val = fields.project_url;
        else if (/email/i.test(blob)) val = fields.email;
        else if (/first.?name/i.test(blob)) val = fields.first_name;
        else if (/last.?name|surname/i.test(blob)) val = fields.last_name;
        else if (/full.?name|^name/i.test(blob)) val = fields.full_name;
        else if (/company|organi[sz]ation|business/i.test(blob)) val = fields.company;
        else if (/country/i.test(blob)) val = fields.country;
        else if (/state|province/i.test(blob)) val = fields.state;
        else if (/location|city|where/i.test(blob)) val = fields.location;
        else if (/description|tell us|details/i.test(blob)) val = fields.description;
        if (val) {
          inp.focus();
          inp.value = val;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          count++;
        }
      }
      // Check the agreement checkboxes (terms / privacy)
      const checks = Array.from(document.querySelectorAll('input[type=checkbox]'));
      for (const cb of checks) {
        if (!cb.checked) {
          let labelText = '';
          if (cb.id) {
            const lab = document.querySelector(`label[for="${cb.id}"]`);
            if (lab) labelText = lab.innerText.toLowerCase();
          }
          if (/agree|terms|privacy|policy|consent/i.test(labelText)) {
            cb.click();
            count++;
          }
        }
      }
      return count;
    }, fields);
  } catch (e) {
    log(`Dev-reg field probe error: ${e.message}`);
  }
  log(`Dev-platform fields populated: ${filled}`);
  await snap(page, 'reddit-dev-reg-filled');

  if (filled > 0 && !DRY_RUN) {
    // Try to submit
    try {
      const submitted = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
        const m = buttons.find((b) => /submit|register|continue|next|agree|i agree/i.test((b.innerText || b.value || '').trim()));
        if (m) { m.click(); return true; }
        return false;
      });
      log(`Dev-reg submit clicked: ${submitted}`);
      await page.waitForTimeout(4000);
    } catch (e) {
      log(`Dev-reg submit error: ${e.message}`);
    }
  }

  await snap(page, 'reddit-dev-reg-after-submit');
}

async function fillCreateAppForm(page) {
  const FORM = {
    name: 'DossieBot',
    app_type: 'script',
    description: 'Dossie social engagement automation',
    about_url: 'https://meetdossie.com',
    redirect_uri: 'http://localhost:8080',
  };

  // Old-reddit create-app form known IDs:
  //   input#name
  //   input[type=radio][value=web-app|installed-app|script]  (we want value=script)
  //   textarea#description (or input#description)
  //   input#about_url
  //   input#redirect_uri
  try {
    const filled = await page.evaluate((FORM) => {
      const out = { name: false, type: false, description: false, about: false, redirect: false, debug: {} };

      function setInput(el, val) {
        el.focus();
        // Use the native input value setter so React/Faceplate state updates.
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                             Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
        if (nativeSetter && nativeSetter.set) nativeSetter.set.call(el, val);
        else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
      }

      // Scope to a form that is the create-app form (has a script radio and a redirect_uri).
      const allForms = Array.from(document.querySelectorAll('form'));
      let f = allForms.find((f) => f.querySelector('input[type=radio][value="script"]') && f.querySelector('input[name="redirect_uri"], #redirect_uri'));
      if (!f) f = document; // fall back to whole document
      out.debug.formScoped = f !== document;

      const nameInp = f.querySelector('#name, input[name="name"]');
      if (nameInp) { setInput(nameInp, FORM.name); out.name = true; }

      const scriptRadio = f.querySelector('input[type=radio][value="script"]');
      if (scriptRadio) {
        if (!scriptRadio.checked) scriptRadio.click();
        out.type = scriptRadio.checked;
      }

      // Description can be input OR textarea on old reddit
      const descEl = f.querySelector('#description, textarea[name="description"], input[name="description"]');
      if (descEl) { setInput(descEl, FORM.description); out.description = true; }

      const aboutInp = f.querySelector('#about_url, input[name="about_url"]');
      if (aboutInp) { setInput(aboutInp, FORM.about_url); out.about = true; }

      const redirInp = f.querySelector('#redirect_uri, input[name="redirect_uri"]');
      if (redirInp) { setInput(redirInp, FORM.redirect_uri); out.redirect = true; }

      return out;
    }, FORM);
    log(`Reddit create-app form filled: ${JSON.stringify(filled)}`);
  } catch (e) {
    log(`fillCreateAppForm error: ${e.message}`);
  }
}

async function extractRedditCreds(page) {
  // Old reddit /prefs/apps after creation:
  //   <li class="developed-app">
  //     <h2>DossieBot</h2>
  //     <div class="app-details">
  //       <span class="developed-app-icon">[icon]</span>
  //       <span class="app-type">personal use script</span>
  //       <div class="edit-app-icon"></div>
  //       <h3 class="app-developer">developed by /u/...</h3>
  //       <em>id:</em> CLIENT_ID_HERE
  //       <em>secret:</em> CLIENT_SECRET_HERE
  //     </div>
  //   </li>
  // The id is 14 chars, the secret is 27 chars (old) or 30 chars (new).
  await page.waitForTimeout(2500);
  let result = { client_id: null, client_secret: null };

  try {
    result = await page.evaluate(() => {
      const out = { client_id: null, client_secret: null };

      // Find the DossieBot app block
      const apps = Array.from(document.querySelectorAll('.developed-app, .prefs-app, li.app'));
      let block = null;
      for (const a of apps) {
        const txt = a.innerText || '';
        if (txt.includes('DossieBot')) { block = a; break; }
      }
      if (!block) {
        // Fallback: any block on the page that contains "DossieBot" + "secret"
        const all = Array.from(document.querySelectorAll('div, li, section'));
        block = all.find((b) => {
          const t = b.innerText || '';
          return t.includes('DossieBot') && t.toLowerCase().includes('secret');
        });
      }
      if (!block) return out;

      const text = block.innerText || '';

      // Parse "secret <SECRET>" — labels may be "secret" or "secret:"
      // and the secret token follows with whitespace.
      const secretMatch = text.match(/secret[:\s]+([A-Za-z0-9_-]{20,})/i);
      if (secretMatch) out.client_secret = secretMatch[1];

      // The 14-char client_id appears either:
      //   (a) directly under the app name, before "personal use script"
      //   (b) on a separate line with no label
      // Old reddit puts the id on its own line (no "id:" label in some versions),
      // sandwiched between the app name and the "personal use script" label.
      // Try labeled first.
      const idLabeled = text.match(/\bid[:\s]+([A-Za-z0-9_-]{10,20})/i);
      if (idLabeled) out.client_id = idLabeled[1];

      // If still missing, find any 14-char-ish token that's not the secret.
      if (!out.client_id) {
        const tokens = (text.match(/[A-Za-z0-9_-]{10,20}/g) || []);
        for (const t of tokens) {
          if (t.length >= 10 && t.length <= 22 && t !== out.client_secret && !/DossieBot|script|secret|developed|personal/i.test(t)) {
            out.client_id = t;
            break;
          }
        }
      }

      return out;
    });
  } catch (e) {
    log(`extractRedditCreds error: ${e.message}`);
  }

  return result;
}

// ─── Flow 2 — PlayHT ─────────────────────────────────────────────────────────

async function flowPlayHT(page) {
  log('FLOW 2 — PlayHT Pro signup + API key capture');
  await logAction('flow_start', 'playht', 'flow2');

  const PLAYHT_PASSWORD = genPassword(24);

  // Step 1 — go to pricing
  await page.goto('https://playht.com/pricing/', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3500);
  await snap(page, 'playht-pricing');
  checkStopped();

  // Step 2 — find and click the Pro plan button
  let proClicked = false;
  try {
    proClicked = await page.evaluate(() => {
      // The Pro plan card has a "Subscribe" or "Get started" button.
      const buttons = Array.from(document.querySelectorAll('button, a'));
      // Score: must be near text "Pro" / "$50" / "$39"
      const scored = buttons.map((b) => {
        const card = b.closest('article, section, div');
        const cardText = card ? (card.innerText || '') : '';
        const btnText = (b.innerText || '').trim();
        let score = 0;
        if (/pro/i.test(cardText)) score += 5;
        if (/\$\s*(39|49|50|59)/.test(cardText)) score += 3;
        if (/subscribe|get started|sign up|start|try/i.test(btnText)) score += 3;
        if (/contact|enterprise|free/i.test(btnText)) score -= 5;
        return { b, score, btnText, cardText: cardText.slice(0, 100) };
      });
      scored.sort((a, b) => b.score - a.score);
      const top = scored[0];
      if (top && top.score >= 6) {
        top.b.click();
        return { clicked: top.btnText, score: top.score };
      }
      return null;
    });
  } catch (e) {
    log(`Pro-plan click error: ${e.message}`);
  }

  log(`Pro plan button click: ${JSON.stringify(proClicked)}`);
  await page.waitForTimeout(4000);
  await snap(page, 'playht-after-pro-click');
  checkStopped();

  // Step 3 — signup form. PlayHT uses Auth0 / WorkOS for auth.
  // We'll detect email + password fields and fill them.
  let signupHandled = false;
  for (let attempt = 0; attempt < 3 && !signupHandled; attempt++) {
    await page.waitForTimeout(2000);
    const result = await page.evaluate(({ email, password, name }) => {
      const r = { email: false, password: false, name: false, button: null };
      const emailInp = document.querySelector('input[type=email], input[name=email], input[id*=email i], input[placeholder*=email i]');
      if (emailInp && !emailInp.value) {
        emailInp.focus();
        emailInp.value = email;
        emailInp.dispatchEvent(new Event('input', { bubbles: true }));
        emailInp.dispatchEvent(new Event('change', { bubbles: true }));
        r.email = true;
      }
      const passInp = document.querySelector('input[type=password]');
      if (passInp && !passInp.value) {
        passInp.focus();
        passInp.value = password;
        passInp.dispatchEvent(new Event('input', { bubbles: true }));
        passInp.dispatchEvent(new Event('change', { bubbles: true }));
        r.password = true;
      }
      const nameInp = document.querySelector('input[name=name], input[id*=name i]:not([type=email]):not([type=password]), input[placeholder*=name i]');
      if (nameInp && !nameInp.value) {
        nameInp.focus();
        nameInp.value = name;
        nameInp.dispatchEvent(new Event('input', { bubbles: true }));
        nameInp.dispatchEvent(new Event('change', { bubbles: true }));
        r.name = true;
      }
      // Find a sign up / continue button
      const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
      const sb = buttons.find((b) => /sign ?up|continue|create account|register|next/i.test((b.innerText || b.value || '').trim()));
      if (sb) r.button = (sb.innerText || sb.value || '').trim();
      return r;
    }, { email: 'heath@meetdossie.com', password: PLAYHT_PASSWORD, name: 'Heath Shepard' });

    log(`Signup attempt ${attempt + 1}: ${JSON.stringify(result)}`);
    if (result.email || result.password) {
      signupHandled = true;
      // Click the signup button
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, input[type=submit]'));
          const sb = buttons.find((b) => /sign ?up|continue|create account|register|next/i.test((b.innerText || b.value || '').trim()));
          if (sb) sb.click();
        });
      } catch {}
      await page.waitForTimeout(4000);
    } else {
      // Maybe we need to click a "Sign up" toggle from a login form
      try {
        await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, button'));
          const m = links.find((l) => /^sign ?up$|create account|don.t have an account/i.test((l.innerText || '').trim()));
          if (m) m.click();
        });
      } catch {}
    }
  }

  await snap(page, 'playht-after-signup');

  // Step 4 — handle "verify your email" intermediate steps if any
  // Just wait for the URL or page to reach checkout / dashboard.
  let onCheckout = false;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(2000);
    checkStopped();
    const url = page.url();
    const looksLikeCheckout = url.includes('checkout.stripe.com') ||
                              url.includes('billing') ||
                              url.includes('subscribe') ||
                              url.includes('payment');
    if (looksLikeCheckout) { onCheckout = true; break; }
    // Or maybe we landed in the app and need to upgrade
    if (url.includes('playht.com/app') || url.includes('playht.com/studio')) {
      // Navigate to billing / upgrade
      await page.goto('https://playht.com/app/billing', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      await snap(page, 'playht-billing-landed');
      // Click upgrade to Pro
      try {
        await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, a'));
          const m = buttons.find((b) => /upgrade|subscribe|pro/i.test((b.innerText || '').trim()) && !/free|free trial/i.test((b.innerText || '').trim()));
          if (m) m.click();
        });
      } catch {}
      await page.waitForTimeout(4000);
      const url2 = page.url();
      if (url2.includes('checkout') || url2.includes('stripe')) { onCheckout = true; break; }
    }
  }

  if (!onCheckout) {
    log('Did not reach Stripe checkout automatically — pinging Heath.');
    const photo = path.join(LOG_DIR, `playht-not-on-checkout-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ PlayHT signup didn\'t auto-land on Stripe checkout. Reply "advance" once I should re-check, or "manual" to take over the browser.');
    await tgWaitForReply(null, 5 * 60 * 1000);
  }

  await snap(page, 'playht-checkout-reached');

  // Step 5 — Stripe checkout — PAUSE for Heath (per spec)
  if (!DRY_RUN) {
    const photo = path.join(LOG_DIR, `playht-checkout-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    const msgTs = Date.now();
    await tgSendPhoto(photo, '🛒 PlayHT Pro $50/mo checkout reached. Card field — autofill working OR need you to paste/type the card? Reply "autofill" or paste card number (no spaces).');
    log('Awaiting Heath card decision...');
    const reply = await tgWaitForReply(null, 10 * 60 * 1000, msgTs);
    log(`Heath checkout reply: ${reply ? '(received)' : '(timeout)'}`);

    if (!reply) {
      throw new Error('Timed out waiting for Heath card decision');
    }

    const replyLower = reply.toLowerCase().trim();
    if (replyLower === 'autofill' || replyLower === 'auto') {
      log('Heath wants autofill — clicking Chrome autofill if present.');
      // We can try to focus the card field and press Tab/Enter to accept the
      // browser autofill suggestion. This typically requires a real keystroke.
      try {
        const cardInp = await page.$('input[name="cardnumber"], input[placeholder*="card" i], input[autocomplete="cc-number"]');
        if (cardInp) {
          await cardInp.focus();
          await page.waitForTimeout(1500);
        }
      } catch {}
      await tgSend('Card field focused. If Chrome autofill suggestion appeared, tap it. Reply "submit" when card + ZIP are populated.');
      await tgWaitForReply(null, 5 * 60 * 1000);
    } else {
      // Treat reply as the card number (digits + maybe exp + cvc)
      // Heath might paste "4242424242424242 12/27 123 78230" or similar.
      const digits = reply.replace(/[^0-9 /]/g, '').trim();
      log(`Card-ish input received (${digits.replace(/./g, '*').length} chars).`);

      // Best-effort parse: card 12-19 digits, then exp MM/YY or MMYY, then CVC 3-4, then maybe ZIP 5
      const m = digits.match(/(\d{12,19})[\s/-]*(\d{2})[\s/-]*(\d{2,4})[\s/-]*(\d{3,4})(?:[\s/-]*(\d{5}))?/);
      let card, mm, yy, cvc, zip;
      if (m) {
        [, card, mm, yy, cvc, zip] = m;
      } else {
        // Maybe just the card number
        const onlyDigits = digits.replace(/\D/g, '');
        if (onlyDigits.length >= 12) card = onlyDigits;
      }

      if (card) {
        try {
          // Stripe checkout uses iframes for card fields.
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
            await tgSend('⚠️ Could not find card field in any iframe. Type the card number directly in the Playwright window.');
            await tgWaitForReply(null, 5 * 60 * 1000);
          }
        } catch (e) {
          log(`Card-fill error: ${e.message}`);
        }
      }
    }

    // Submit Stripe checkout
    await page.waitForTimeout(2000);
    try {
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const m = buttons.find((b) => /subscribe|pay|complete|start subscription|confirm/i.test((b.innerText || '').trim()));
        if (m) m.click();
      });
    } catch {}
    log('Stripe submit clicked. Waiting for confirmation...');
    await page.waitForTimeout(8000);
    await snap(page, 'playht-after-checkout-submit');

    // Wait up to 2min for Stripe to redirect back to playht.com
    let backOnPlayHT = false;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(2000);
      const url = page.url();
      if (url.includes('playht.com') && !url.includes('stripe.com')) { backOnPlayHT = true; break; }
    }
    if (!backOnPlayHT) {
      await tgSend('⚠️ Stripe didn\'t redirect back to playht.com in 2min. Check the window. Reply "done" once you\'re back on playht.com.');
      await tgWaitForReply(null, 10 * 60 * 1000);
    }
  }

  // Step 6 — navigate to API access and capture keys
  await page.goto('https://playht.com/app/api-access', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4000);
  await snap(page, 'playht-api-access');
  checkStopped();

  const apiCreds = await extractPlayHTCreds(page);
  log(`PlayHT user_id: ${apiCreds.user_id ? apiCreds.user_id.slice(0, 6) + '...' : '(missing)'}`);
  log(`PlayHT api_secret: ${apiCreds.api_secret ? '[present, ' + apiCreds.api_secret.length + ' chars]' : '(missing)'}`);

  if (!apiCreds.user_id || !apiCreds.api_secret) {
    log('Auto-extract missed PlayHT keys — pinging Heath.');
    const photo = path.join(LOG_DIR, `playht-key-help-${Date.now()}.png`);
    await page.screenshot({ path: photo });
    await tgSendPhoto(photo, '⚠️ Atlas could not read PlayHT user_id / secret automatically. Reply with: "userid=<value> secret=<value>"');
    const reply = await tgWaitForReply(null, 5 * 60 * 1000);
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
  log('FLOW 2 complete.');
  return apiCreds;
}

async function extractPlayHTCreds(page) {
  await page.waitForTimeout(2000);
  let result = { user_id: null, api_secret: null };
  try {
    result = await page.evaluate(() => {
      const out = { user_id: null, api_secret: null };

      // Look for labeled blocks
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const text = (el.innerText || '').trim();
        if (!text) continue;

        // User ID block
        if (/user\s*id/i.test(text) && text.length < 200) {
          // Look at next sibling input / code / span
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
        // API secret / key block
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

      // Fallback: any input[readonly] values
      if (!out.user_id || !out.api_secret) {
        const inputs = Array.from(document.querySelectorAll('input[readonly], input[type=text][readonly], input[type=password][readonly]'));
        const values = inputs.map((i) => i.value).filter((v) => v && v.length >= 6);
        // Heuristic: longer one = secret, shorter = user_id
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
  log(`Atlas run ${RUN_ID} starting. dry_run=${DRY_RUN} skip_reddit=${SKIP_REDDIT} skip_playht=${SKIP_PLAYHT}`);
  await tgSend(`🚀 Atlas starting Reddit + PlayHT flow. Run id: <code>${RUN_ID}</code>\nReply STOP to abort at any time.`);

  // Start kill switch poller in background
  tgPollForStop().catch(() => {});

  const { context, tempDir } = await newBrowser();
  const page = await context.newPage();

  const summary = { reddit: null, playht: null, errors: [] };

  try {
    if (!SKIP_REDDIT) {
      try {
        summary.reddit = await flowReddit(page);
      } catch (e) {
        log(`FLOW 1 failed: ${e.stack || e.message}`);
        summary.errors.push(`reddit: ${e.message}`);
        await tgSend(`❌ Reddit flow failed: ${e.message}`);
      }
    } else {
      log('Skipping Reddit flow.');
    }

    if (STOPPED) throw new Error('Aborted');

    if (!SKIP_PLAYHT) {
      try {
        summary.playht = await flowPlayHT(page);
      } catch (e) {
        log(`FLOW 2 failed: ${e.stack || e.message}`);
        summary.errors.push(`playht: ${e.message}`);
        await tgSend(`❌ PlayHT flow failed: ${e.message}`);
      }
    } else {
      log('Skipping PlayHT flow.');
    }

    // Final summary to Heath
    if (summary.errors.length === 0) {
      await tgSend(
        `✅ Both done. Reddit OAuth credentials wired. PlayHT account live, keys wired. Carter can now finish item #1 Phase D (skit voice test). Total clicks Heath did: 0 (just typed card # if autofill didn't work).`
      );
    } else {
      await tgSend(`⚠️ Atlas run finished with ${summary.errors.length} error(s):\n${summary.errors.join('\n')}\nLogs: ${LOG_DIR}`);
    }
  } finally {
    STOPPED = true; // stop the poller
    log('Closing browser in 5s...');
    await page.waitForTimeout(5000);
    try { await context.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    log(`Run ${RUN_ID} complete. Log dir: ${LOG_DIR}`);
    process.exit(summary.errors.length === 0 ? 0 : 1);
  }
})().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
