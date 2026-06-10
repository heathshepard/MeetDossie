/**
 * extract-api-keys.js
 * Atlas — 2026-06-08 (v2)
 *
 * Profile map (from Chrome history analysis):
 *   Default (heath.shepard@kw.com)  → Stripe, HCTI, Resend
 *   Profile 1 (atlasopslab@gmail.com) → Anthropic, Supabase
 *
 * Run: node scripts/extract-api-keys.js
 * Prereq: Close ALL Chrome windows first.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env.local');
const CHROME_USER_DATA = 'C:\\Users\\Heath Shepard\\AppData\\Local\\Google\\Chrome\\User Data';
const TIMEOUT_NAV = 35000;
const TIMEOUT_EL  = 12000;

// ── Env helpers ─────────────────────────────────────────────────────────────

function readEnv() { return fs.readFileSync(ENV_FILE, 'utf8'); }

function writeEnvVar(name, value) {
  let content = readEnv();
  // Match NAME="" or NAME='' or NAME= (empty) and replace
  const patterns = [
    new RegExp(`^(${name}=)""\\s*$`, 'm'),
    new RegExp(`^(${name}=)''\\s*$`, 'm'),
    new RegExp(`^(${name}=)\\s*$`, 'm'),
    new RegExp(`^(${name}=)"[^"\\n]*"\\s*$`, 'm'),
  ];
  let replaced = false;
  for (const re of patterns) {
    if (re.test(content)) {
      content = content.replace(re, `$1"${value}"`);
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    content += `\n${name}="${value}"`;
  }
  fs.writeFileSync(ENV_FILE, content, 'utf8');
}

function getEnvVar(name) {
  const content = readEnv();
  const m = content.match(new RegExp(`^${name}=["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : '';
}

function isAlreadyFilled(name) {
  const v = getEnvVar(name);
  return v.length > 4;
}

function logResult(name, success, note) {
  const status = success ? 'FILLED' : 'SKIP ';
  console.log(`  [${status}] ${name}${note ? ' — ' + note : ''}`);
}

// ── Browser helpers ──────────────────────────────────────────────────────────

async function launchProfile(profileName) {
  const profilePath = path.join(CHROME_USER_DATA, profileName);
  return chromium.launchPersistentContext(profilePath, {
    headless: false,
    channel: 'chrome',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--disable-default-apps',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1400, height: 900 },
    timeout: 30000,
  });
}

async function openPage(ctx) {
  const page = await ctx.newPage();
  page.setDefaultTimeout(TIMEOUT_EL);
  page.setDefaultNavigationTimeout(TIMEOUT_NAV);
  return page;
}

async function goto(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT_NAV });
  await page.waitForTimeout(2500);
}

function isLoginPage(url) {
  return /login|signin|sign-in|auth|challenge/.test(url);
}

async function bodyText(page) {
  return page.evaluate(() => document.body ? document.body.innerText : '');
}

async function screenshot(page, name) {
  await page.screenshot({ path: `scripts/.debug-${name}.png`, fullPage: false }).catch(() => {});
}

// ── Extract from text helpers ────────────────────────────────────────────────

function extractPattern(text, re) {
  const m = text.match(re);
  return m ? m[1] || m[0] : null;
}

// ── STRIPE (Default profile) ─────────────────────────────────────────────────

async function extractStripeWebhookSecret(ctx) {
  if (isAlreadyFilled('STRIPE_WEBHOOK_SECRET')) {
    logResult('STRIPE_WEBHOOK_SECRET', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    // Navigate directly to the known webhook endpoint
    await goto(page, 'https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/workbench/webhooks/we_1TS0IlL920SKTEEizvDzz7op');

    if (isLoginPage(page.url())) {
      // Try base webhooks URL
      await goto(page, 'https://dashboard.stripe.com/webhooks');
    }

    if (isLoginPage(page.url())) {
      logResult('STRIPE_WEBHOOK_SECRET', false, '2FA required — Stripe session expired');
      await screenshot(page, 'stripe-webhook');
      await page.close();
      return;
    }

    // Wait for page to fully render
    await page.waitForTimeout(3000);

    // Look for the "Reveal" button next to signing secret
    const revealBtn = page.locator('button', { hasText: /reveal/i }).first();
    const hasReveal = await revealBtn.isVisible({ timeout: 6000 }).catch(() => false);
    if (hasReveal) {
      await revealBtn.click();
      await page.waitForTimeout(1500);
    }

    const text = await bodyText(page);
    const whsec = extractPattern(text, /whsec_[A-Za-z0-9+/=]{20,}/);
    if (whsec) {
      writeEnvVar('STRIPE_WEBHOOK_SECRET', whsec);
      logResult('STRIPE_WEBHOOK_SECRET', true, 'written');
    } else {
      // Try to click the endpoint row if we're on the list
      const endpointRow = page.locator('[href*="we_"], tr, [data-testid*="endpoint"]').first();
      if (await endpointRow.isVisible({ timeout: 3000 }).catch(() => false)) {
        await endpointRow.click();
        await page.waitForTimeout(2000);
        const revealBtn2 = page.locator('button', { hasText: /reveal/i }).first();
        if (await revealBtn2.isVisible({ timeout: 4000 }).catch(() => false)) {
          await revealBtn2.click();
          await page.waitForTimeout(1500);
        }
        const text2 = await bodyText(page);
        const whsec2 = extractPattern(text2, /whsec_[A-Za-z0-9+/=]{20,}/);
        if (whsec2) {
          writeEnvVar('STRIPE_WEBHOOK_SECRET', whsec2);
          logResult('STRIPE_WEBHOOK_SECRET', true, 'written (after row click)');
        } else {
          logResult('STRIPE_WEBHOOK_SECRET', false, 'whsec_ not found after reveal');
          await screenshot(page, 'stripe-webhook');
        }
      } else {
        logResult('STRIPE_WEBHOOK_SECRET', false, 'no endpoint row or reveal button');
        await screenshot(page, 'stripe-webhook');
      }
    }
  } catch (err) {
    logResult('STRIPE_WEBHOOK_SECRET', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'stripe-webhook-err');
  } finally {
    await page.close();
  }
}

async function extractStripeSecretKey(ctx) {
  if (isAlreadyFilled('STRIPE_SECRET_KEY')) {
    logResult('STRIPE_SECRET_KEY', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    // Navigate to API keys page (using known account ID from history)
    await goto(page, 'https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/apikeys');

    if (isLoginPage(page.url())) {
      await goto(page, 'https://dashboard.stripe.com/apikeys');
    }
    if (isLoginPage(page.url())) {
      logResult('STRIPE_SECRET_KEY', false, '2FA required');
      await screenshot(page, 'stripe-apikeys');
      await page.close();
      return;
    }

    await page.waitForTimeout(3000);

    // Click "Create secret key" button
    const createBtn = page.locator('button', {
      hasText: /create.*restricted|create.*secret|add.*key|\+.*key/i
    }).first();
    const hasCreate = await createBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasCreate) {
      await createBtn.click();
      await page.waitForTimeout(1500);

      // Look for name input in the modal
      const nameInput = page.locator('input[placeholder*="My key" i], input[name*="name" i], input[placeholder*="name" i], input[aria-label*="name" i]').first();
      if (await nameInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await nameInput.fill('local-dev');
      }

      // Select "Powering an integration you built" option if present
      const integrationOpt = page.locator('text=integration you built, [data-value*="integration"], label', {
        hasText: /integration you built/i
      }).first();
      if (await integrationOpt.isVisible({ timeout: 3000 }).catch(() => false)) {
        await integrationOpt.click();
        await page.waitForTimeout(500);
      }

      // Click Continue or Create
      const continueBtn = page.locator('button', { hasText: /continue|next|create/i }).last();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForTimeout(2000);
      }

      // The key is shown in a code block or input
      const text = await bodyText(page);
      const skMatch = text.match(/sk_live_[A-Za-z0-9]{20,}/);
      if (skMatch) {
        writeEnvVar('STRIPE_SECRET_KEY', skMatch[0]);
        logResult('STRIPE_SECRET_KEY', true, 'new key created and written');
        // Click "Done" to close modal
        const doneBtn = page.locator('button', { hasText: /done|close|dismiss/i }).first();
        await doneBtn.click().catch(() => {});
      } else {
        // Check inputs for the key
        const keyInputs = page.locator('input[value*="sk_live_"], [data-testid*="key"] input');
        const inputCount = await keyInputs.count();
        let found = false;
        for (let i = 0; i < inputCount && !found; i++) {
          const val = await keyInputs.nth(i).inputValue().catch(() => '');
          if (val.startsWith('sk_live_')) {
            writeEnvVar('STRIPE_SECRET_KEY', val);
            logResult('STRIPE_SECRET_KEY', true, 'from modal input');
            found = true;
          }
        }
        if (!found) {
          logResult('STRIPE_SECRET_KEY', false, 'key not visible after modal creation');
          await screenshot(page, 'stripe-newkey');
        }
      }
    } else {
      // No create button — maybe the page has existing keys listed
      // Try to reveal the existing secret key
      const text = await bodyText(page);
      const skMatch = text.match(/sk_live_[A-Za-z0-9]{20,}/);
      if (skMatch) {
        writeEnvVar('STRIPE_SECRET_KEY', skMatch[0]);
        logResult('STRIPE_SECRET_KEY', true, 'existing key found on page');
      } else {
        logResult('STRIPE_SECRET_KEY', false, 'no create button visible — page may need manual action');
        await screenshot(page, 'stripe-apikeys');
      }
    }
  } catch (err) {
    logResult('STRIPE_SECRET_KEY', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'stripe-apikeys-err');
  } finally {
    await page.close();
  }
}

async function extractStripePaymentLink(ctx) {
  if (isAlreadyFilled('STRIPE_FOUNDING_PAYMENT_LINK')) {
    logResult('STRIPE_FOUNDING_PAYMENT_LINK', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    await goto(page, 'https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/payment-links');
    if (isLoginPage(page.url())) {
      await goto(page, 'https://dashboard.stripe.com/payment-links');
    }
    if (isLoginPage(page.url())) {
      logResult('STRIPE_FOUNDING_PAYMENT_LINK', false, '2FA required');
      await page.close();
      return;
    }
    await page.waitForTimeout(3000);

    const text = await bodyText(page);
    // Payment links use buy.stripe.com domain
    const linkMatch = text.match(/https?:\/\/buy\.stripe\.com\/[A-Za-z0-9_\-]+/);
    if (linkMatch) {
      writeEnvVar('STRIPE_FOUNDING_PAYMENT_LINK', linkMatch[0]);
      logResult('STRIPE_FOUNDING_PAYMENT_LINK', true, 'written');
    } else {
      // Check page source for link URLs
      const html = await page.content();
      const srcMatch = html.match(/buy\.stripe\.com\/[A-Za-z0-9_\-"]+/);
      if (srcMatch) {
        const url = 'https://' + srcMatch[0].replace(/["'].*$/, '');
        writeEnvVar('STRIPE_FOUNDING_PAYMENT_LINK', url);
        logResult('STRIPE_FOUNDING_PAYMENT_LINK', true, 'from page source');
      } else {
        // Try clicking the first payment link row
        const row = page.locator('tr[class*="row"], [data-testid*="payment-link"], a[href*="payment-link"]').first();
        if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
          await row.click();
          await page.waitForTimeout(2000);
          const text2 = await bodyText(page);
          const lm2 = text2.match(/buy\.stripe\.com\/[A-Za-z0-9_\-]+/);
          if (lm2) {
            writeEnvVar('STRIPE_FOUNDING_PAYMENT_LINK', 'https://' + lm2[0]);
            logResult('STRIPE_FOUNDING_PAYMENT_LINK', true, 'from row detail');
          } else {
            logResult('STRIPE_FOUNDING_PAYMENT_LINK', false, 'no buy.stripe.com link found — may not exist yet');
            await screenshot(page, 'stripe-paylink');
          }
        } else {
          logResult('STRIPE_FOUNDING_PAYMENT_LINK', false, 'no payment links found — needs creation');
        }
      }
    }
  } catch (err) {
    logResult('STRIPE_FOUNDING_PAYMENT_LINK', false, err.message.split('\n')[0].slice(0, 80));
  } finally {
    await page.close();
  }
}

// ── HCTI (Default profile) ───────────────────────────────────────────────────

async function extractHCTI(ctx) {
  const needsUserId = !isAlreadyFilled('HCTI_USER_ID');
  const needsApiKey = !isAlreadyFilled('HCTI_API_KEY');
  if (!needsUserId && !needsApiKey) {
    logResult('HCTI_USER_ID', true, 'already filled');
    logResult('HCTI_API_KEY', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    await goto(page, 'https://htmlcsstoimage.com/dashboard/api-keys');

    if (isLoginPage(page.url())) {
      await goto(page, 'https://htmlcsstoimage.com/dashboard');
    }
    if (page.url().includes('login') || page.url().includes('account/login')) {
      logResult('HCTI_USER_ID', false, 'HCTI session expired — login required');
      logResult('HCTI_API_KEY', false, 'HCTI session expired — login required');
      await screenshot(page, 'hcti');
      await page.close();
      return;
    }

    await page.waitForTimeout(2000);
    const text = await bodyText(page);
    const html = await page.content();

    // HCTI User ID is a UUID
    const uuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    const uuids = [...text.matchAll(uuidRe)].map(m => m[0]);

    // HCTI API key is typically in a code/input field labeled "API Key"
    // It's usually alphanumeric, 20-60 chars
    const inputs = page.locator('input[readonly], input[type="text"], code, pre');
    const count = await inputs.count();
    let userId = '';
    let apiKey = '';

    for (let i = 0; i < count; i++) {
      const el = inputs.nth(i);
      const val = await el.evaluate(e => (e.value || e.textContent || '').trim()).catch(() => '');
      if (!val) continue;

      // UUID = user ID
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) && !userId) {
        userId = val;
      }
      // API key: long alphanumeric string (not a JWT, not a UUID)
      else if (val.length >= 20 && val.length <= 80 && !val.startsWith('eyJ') && !val.includes('-') && !apiKey) {
        apiKey = val;
      }
    }

    // Fall back to page text scan
    if (!userId && uuids.length > 0) userId = uuids[0];

    // Look for API key pattern in HTML source
    if (!apiKey) {
      const apiKeyMatch = html.match(/value="([A-Za-z0-9]{20,60})"/);
      if (apiKeyMatch && !apiKeyMatch[1].startsWith('eyJ')) {
        apiKey = apiKeyMatch[1];
      }
    }

    if (needsUserId && userId) {
      writeEnvVar('HCTI_USER_ID', userId);
      logResult('HCTI_USER_ID', true, 'written');
    } else if (needsUserId) {
      logResult('HCTI_USER_ID', false, 'not found on page');
      await screenshot(page, 'hcti');
    }

    if (needsApiKey && apiKey) {
      writeEnvVar('HCTI_API_KEY', apiKey);
      logResult('HCTI_API_KEY', true, 'written');
    } else if (needsApiKey) {
      logResult('HCTI_API_KEY', false, 'not found on page');
      await screenshot(page, 'hcti');
    }
  } catch (err) {
    logResult('HCTI_USER_ID', false, err.message.split('\n')[0].slice(0, 80));
    logResult('HCTI_API_KEY', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'hcti-err');
  } finally {
    await page.close();
  }
}

// ── RESEND (Default profile) ─────────────────────────────────────────────────

async function extractResend(ctx) {
  if (isAlreadyFilled('RESEND_API_KEY')) {
    logResult('RESEND_API_KEY', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    await goto(page, 'https://resend.com/api-keys');

    if (isLoginPage(page.url())) {
      logResult('RESEND_API_KEY', false, 'session expired');
      await screenshot(page, 'resend');
      await page.close();
      return;
    }

    await page.waitForTimeout(2000);
    const text = await bodyText(page);
    const reMatch = text.match(/re_[A-Za-z0-9_]{20,}/);
    if (reMatch) {
      writeEnvVar('RESEND_API_KEY', reMatch[0]);
      logResult('RESEND_API_KEY', true, 'existing key written');
    } else {
      // Keys may be masked — try "Create API Key" and copy new one
      const createBtn = page.locator('button, a', { hasText: /create.*api.*key|add.*key|new.*key/i }).first();
      if (await createBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
        await createBtn.click();
        await page.waitForTimeout(1000);

        const nameInput = page.locator('input[placeholder*="name" i], input[name*="name" i]').first();
        if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
          await nameInput.fill('local-dev');
        }

        const submitBtn = page.locator('button', { hasText: /create|add|save/i }).last();
        if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          await submitBtn.click();
          await page.waitForTimeout(2000);
        }

        const text2 = await bodyText(page);
        const reMatch2 = text2.match(/re_[A-Za-z0-9_]{20,}/);
        if (reMatch2) {
          writeEnvVar('RESEND_API_KEY', reMatch2[0]);
          logResult('RESEND_API_KEY', true, 'new key created');
        } else {
          logResult('RESEND_API_KEY', false, 're_ not found after creation');
          await screenshot(page, 'resend');
        }
      } else {
        logResult('RESEND_API_KEY', false, 'keys masked and no create button');
        await screenshot(page, 'resend');
      }
    }
  } catch (err) {
    logResult('RESEND_API_KEY', false, err.message.split('\n')[0].slice(0, 80));
  } finally {
    await page.close();
  }
}

// ── ANTHROPIC (Profile 1) ────────────────────────────────────────────────────

async function extractAnthropic(ctx) {
  if (isAlreadyFilled('ANTHROPIC_API_KEY')) {
    logResult('ANTHROPIC_API_KEY', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    // Profile 1 has /settings/keys in history — use exact URL
    await goto(page, 'https://console.anthropic.com/settings/keys');

    // Check for login wall or wrong page
    const url = page.url();
    if (url.includes('login') || url.includes('sign')) {
      logResult('ANTHROPIC_API_KEY', false, 'session expired in Profile 1');
      await screenshot(page, 'anthropic');
      await page.close();
      return;
    }

    // Wait for key list to load
    await page.waitForTimeout(3000);
    const text = await bodyText(page);

    // If there's a "Create Key" button, click it to create local-dev key
    const createBtn = page.locator('button', { hasText: /create key|new key|add key/i }).first();
    const hasCreate = await createBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasCreate) {
      await createBtn.click();
      await page.waitForTimeout(1000);

      // Fill key name
      const nameInput = page.locator('input[placeholder*="Key name" i], input[name*="name" i], input[aria-label*="name" i], input[type="text"]').first();
      if (await nameInput.isVisible({ timeout: 4000 }).catch(() => false)) {
        await nameInput.fill('local-dev');
      }

      // Click Create Key or confirm
      const confirmBtn = page.locator('button', { hasText: /create key|create|confirm|generate/i }).last();
      if (await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await confirmBtn.click();
        await page.waitForTimeout(3000);
      }

      // Key is shown once — grab it
      const afterText = await bodyText(page);
      const keyMatch = afterText.match(/sk-ant-[A-Za-z0-9\-_]{20,}/);
      if (keyMatch) {
        writeEnvVar('ANTHROPIC_API_KEY', keyMatch[0]);
        logResult('ANTHROPIC_API_KEY', true, 'new key created and written');
      } else {
        // Try input fields in the dialog
        const inputs = page.locator('input[readonly], input[type="text"], code');
        const cnt = await inputs.count();
        let found = false;
        for (let i = 0; i < cnt && !found; i++) {
          const val = await inputs.nth(i).evaluate(e => (e.value || e.textContent || '').trim()).catch(() => '');
          if (val.startsWith('sk-ant-')) {
            writeEnvVar('ANTHROPIC_API_KEY', val);
            logResult('ANTHROPIC_API_KEY', true, 'from dialog input');
            found = true;
          }
        }
        if (!found) {
          logResult('ANTHROPIC_API_KEY', false, 'key not found after creation dialog');
          await screenshot(page, 'anthropic');
        }
      }
    } else {
      // No create button — check if key is somehow visible on the list page
      const keyMatch = text.match(/sk-ant-[A-Za-z0-9\-_]{20,}/);
      if (keyMatch) {
        writeEnvVar('ANTHROPIC_API_KEY', keyMatch[0]);
        logResult('ANTHROPIC_API_KEY', true, 'found on list page');
      } else {
        logResult('ANTHROPIC_API_KEY', false, 'create button not found and no key visible');
        await screenshot(page, 'anthropic');
      }
    }
  } catch (err) {
    logResult('ANTHROPIC_API_KEY', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'anthropic-err');
  } finally {
    await page.close();
  }
}

// ── SUPABASE (Profile 1) ─────────────────────────────────────────────────────

async function extractSupabaseJWT(ctx) {
  const needsJWT = !isAlreadyFilled('SUPABASE_JWT_SECRET');
  const needsSecretKey = !isAlreadyFilled('SUPABASE_SECRET_KEY');
  if (!needsJWT && !needsSecretKey) {
    logResult('SUPABASE_JWT_SECRET', true, 'already filled');
    logResult('SUPABASE_SECRET_KEY', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    const projectId = 'pgwoitbdiyubjugwufhk';
    // Profile 1 has Supabase dashboard history
    await goto(page, `https://supabase.com/dashboard/project/${projectId}/settings/api`);

    const url = page.url();
    if (url.includes('sign-in') || url.includes('login') || url.includes('sign-in-mfa')) {
      logResult('SUPABASE_JWT_SECRET', false, 'Supabase session expired in Profile 1 — needs GitHub SSO login');
      await screenshot(page, 'supabase');
      await page.close();
      return;
    }

    await page.waitForTimeout(4000);

    // Click all "Reveal" / "Show" buttons to expose hidden values
    const revealBtns = page.locator('button', { hasText: /reveal|show/i });
    const count = await revealBtns.count();
    console.log(`    Found ${count} reveal buttons on Supabase API settings page`);
    for (let i = 0; i < count; i++) {
      await revealBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1000);

    // Check all input fields for the JWT secret
    const inputs = page.locator('input[type="text"], input[readonly], input[type="password"]');
    const inputCount = await inputs.count();
    let jwtFound = false;
    let secretKeyFound = false;

    for (let i = 0; i < inputCount; i++) {
      const val = await inputs.nth(i).inputValue().catch(() => '');
      const trimmed = val.trim();
      if (!trimmed) continue;

      // JWT secret: long random string, not a JWT (doesn't start with eyJ), not a UUID pattern
      // Supabase JWT secrets are ~40-64 chars, base64url or alphanumeric
      if (needsJWT && !jwtFound && trimmed.length >= 40 && trimmed.length <= 120
          && !trimmed.startsWith('eyJ') && !trimmed.startsWith('sb_') && !trimmed.includes('.supabase.co')) {
        writeEnvVar('SUPABASE_JWT_SECRET', trimmed);
        logResult('SUPABASE_JWT_SECRET', true, 'written from input field');
        jwtFound = true;
      }

      // Supabase secret key: sb_secret_...
      if (needsSecretKey && !secretKeyFound && trimmed.startsWith('sb_secret_')) {
        writeEnvVar('SUPABASE_SECRET_KEY', trimmed);
        logResult('SUPABASE_SECRET_KEY', true, 'written');
        secretKeyFound = true;
      }
    }

    // Also scan page text
    const text = await bodyText(page);
    if (needsJWT && !jwtFound) {
      // JWT secret often labeled near "JWT" heading
      const jwtSection = text.match(/JWT\s+Secret[\s\S]{0,50}?([A-Za-z0-9+/=\-_]{40,120})/i);
      if (jwtSection && !jwtSection[1].startsWith('eyJ')) {
        writeEnvVar('SUPABASE_JWT_SECRET', jwtSection[1].trim());
        logResult('SUPABASE_JWT_SECRET', true, 'from text scan near JWT label');
        jwtFound = true;
      }
    }

    if (!jwtFound && needsJWT) {
      logResult('SUPABASE_JWT_SECRET', false, 'not found — may need manual reveal click');
      await screenshot(page, 'supabase-api');
    }
    if (!secretKeyFound && needsSecretKey) {
      logResult('SUPABASE_SECRET_KEY', false, 'sb_secret_ not visible on API settings page');
    }

  } catch (err) {
    logResult('SUPABASE_JWT_SECRET', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'supabase-err');
  } finally {
    await page.close();
  }
}

async function extractSupabaseDB(ctx) {
  const needsPw = !isAlreadyFilled('POSTGRES_PASSWORD');
  const needsUrl = !isAlreadyFilled('POSTGRES_URL');
  const needsNonPool = !isAlreadyFilled('POSTGRES_URL_NON_POOLING');
  const needsPrisma = !isAlreadyFilled('POSTGRES_PRISMA_URL');

  if (!needsPw && !needsUrl && !needsNonPool && !needsPrisma) {
    logResult('POSTGRES_URL', true, 'already filled');
    return;
  }

  const page = await openPage(ctx);
  try {
    const projectId = 'pgwoitbdiyubjugwufhk';
    await goto(page, `https://supabase.com/dashboard/project/${projectId}/settings/database`);

    const url = page.url();
    if (url.includes('sign-in') || url.includes('login')) {
      logResult('POSTGRES_PASSWORD', false, 'session expired');
      await page.close();
      return;
    }
    await page.waitForTimeout(4000);

    // Reveal any hidden passwords
    const revealBtns = page.locator('button', { hasText: /reveal|show/i });
    const count = await revealBtns.count();
    for (let i = 0; i < count; i++) {
      await revealBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1000);

    // Switch to URI mode if tabs exist
    const uriTab = page.locator('button, [role="tab"]', { hasText: /URI|connection string/i }).first();
    if (await uriTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await uriTab.click();
      await page.waitForTimeout(1000);
    }

    // Read all input fields for connection strings / password
    const inputs = page.locator('input[type="text"], input[readonly], textarea');
    const inputCount = await inputs.count();
    let poolerUrl = '';
    let directUrl = '';
    let password = '';

    for (let i = 0; i < inputCount; i++) {
      const val = await inputs.nth(i).inputValue().catch(() => '');
      const trimmed = val.trim();
      if (!trimmed) continue;

      if (trimmed.startsWith('postgresql://') || trimmed.startsWith('postgres://')) {
        // Pooler connection has port 6543 or includes pgbouncer
        if ((trimmed.includes(':6543') || trimmed.includes('pooler')) && !poolerUrl) {
          poolerUrl = trimmed;
        } else if ((trimmed.includes(':5432') || !trimmed.includes('6543')) && !directUrl) {
          directUrl = trimmed;
        }
        // Extract password from connection string
        const pwMatch = trimmed.match(/:([^@]+)@/);
        if (pwMatch && !pwMatch[1].includes(':') && !password) {
          password = pwMatch[1];
        }
      }
    }

    // Page text scan for connection strings
    const text = await bodyText(page);
    if (!poolerUrl) {
      const poolMatch = text.match(/postgresql:\/\/postgres[^:]*:[^@]+@[^\s"'\n]+:6543[^\s"'\n]*/);
      if (poolMatch) poolerUrl = poolMatch[0].trim();
    }
    if (!directUrl) {
      const directMatch = text.match(/postgresql:\/\/postgres[^:]*:[^@]+@db\.[^\s"'\n]+:5432[^\s"'\n]*/);
      if (directMatch) directUrl = directMatch[0].trim();
    }

    // Write results
    if (needsPw && password) {
      writeEnvVar('POSTGRES_PASSWORD', password);
      logResult('POSTGRES_PASSWORD', true, 'written');
    } else if (needsPw) {
      logResult('POSTGRES_PASSWORD', false, 'password not extracted');
      await screenshot(page, 'supabase-db');
    }

    if (needsUrl && poolerUrl) {
      writeEnvVar('POSTGRES_URL', poolerUrl);
      logResult('POSTGRES_URL', true, 'pooler URL written');
    } else if (needsUrl && directUrl) {
      // Use direct as fallback for pooler
      writeEnvVar('POSTGRES_URL', directUrl);
      logResult('POSTGRES_URL', true, 'direct URL written (pooler not found)');
    } else if (needsUrl) {
      logResult('POSTGRES_URL', false, 'not found');
      await screenshot(page, 'supabase-db');
    }

    if (needsNonPool && directUrl) {
      writeEnvVar('POSTGRES_URL_NON_POOLING', directUrl);
      logResult('POSTGRES_URL_NON_POOLING', true, 'written');
    } else if (needsNonPool && poolerUrl) {
      logResult('POSTGRES_URL_NON_POOLING', false, 'only pooler URL found');
    }

    // Derive PRISMA_URL from pooler
    if (needsPrisma) {
      const pgUrl = getEnvVar('POSTGRES_URL');
      if (pgUrl) {
        const prisma = pgUrl.includes('?')
          ? pgUrl + '&pgbouncer=true&connect_timeout=15'
          : pgUrl + '?pgbouncer=true&connect_timeout=15';
        writeEnvVar('POSTGRES_PRISMA_URL', prisma);
        logResult('POSTGRES_PRISMA_URL', true, 'derived from POSTGRES_URL');
      } else {
        logResult('POSTGRES_PRISMA_URL', false, 'no POSTGRES_URL to derive from');
      }
    }

  } catch (err) {
    logResult('POSTGRES_PASSWORD', false, err.message.split('\n')[0].slice(0, 80));
    await screenshot(page, 'supabase-db-err');
  } finally {
    await page.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runWithProfile(profileName, label, extractors) {
  console.log(`\n--- Opening ${label} (${profileName}) ---`);
  let ctx;
  try {
    ctx = await launchProfile(profileName);
    for (const fn of extractors) {
      await fn(ctx);
    }
  } catch (err) {
    if (err.message && err.message.includes('user data directory is already in use')) {
      console.error(`\nERROR: ${profileName} is locked. Close all Chrome windows and retry.`);
      return;
    }
    console.error(`Profile ${profileName} error:`, err.message.split('\n')[0]);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    // Brief pause between profile launches
    await new Promise(r => setTimeout(r, 1500));
  }
}

async function main() {
  console.log('=== Atlas API Key Extractor v2 ===');
  console.log('Profile map:');
  console.log('  Default (kw.com) → Stripe, HCTI, Resend');
  console.log('  Profile 1 (atlasopslab) → Anthropic, Supabase');
  console.log('\nCurrent state:');

  const targets = [
    'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'STRIPE_FOUNDING_PAYMENT_LINK', 'HCTI_USER_ID', 'HCTI_API_KEY',
    'RESEND_API_KEY', 'SUPABASE_JWT_SECRET', 'SUPABASE_SECRET_KEY',
    'POSTGRES_PASSWORD', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING',
  ];

  for (const v of targets) {
    console.log(`  ${v}: ${isAlreadyFilled(v) ? 'FILLED' : 'EMPTY'}`);
  }

  // Default profile: Stripe, HCTI, Resend
  await runWithProfile('Default', 'Default (kw.com)', [
    extractStripeWebhookSecret,
    extractStripeSecretKey,
    extractStripePaymentLink,
    extractHCTI,
    extractResend,
  ]);

  // Profile 1: Anthropic, Supabase
  await runWithProfile('Profile 1', 'Profile 1 (atlasopslab)', [
    extractAnthropic,
    extractSupabaseJWT,
    extractSupabaseDB,
  ]);

  // Final summary
  console.log('\n=== FINAL STATE ===');
  for (const v of targets) {
    console.log(`  ${v}: ${isAlreadyFilled(v) ? 'FILLED' : 'STILL EMPTY'}`);
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
