/**
 * guided-key-capture.js
 * Atlas — 2026-06-08
 *
 * Guided key capture: opens a visible browser for each service.
 * Heath logs in via Google/Passkey/SSO, the script waits for the dashboard to load,
 * then auto-extracts the key and writes it to .env.local.
 *
 * Run: node scripts/guided-key-capture.js
 * Uses a fresh temporary profile (no Chrome conflicts).
 * Heath only needs to log in ONCE per service — sessions persist in the temp profile.
 *
 * Services covered (in order):
 *   1. Anthropic  → ANTHROPIC_API_KEY
 *   2. Stripe     → STRIPE_WEBHOOK_SECRET, STRIPE_SECRET_KEY, STRIPE_FOUNDING_PAYMENT_LINK
 *   3. HCTI       → HCTI_USER_ID, HCTI_API_KEY
 *   4. Resend     → RESEND_API_KEY
 *   5. Supabase   → SUPABASE_JWT_SECRET, POSTGRES_PASSWORD, POSTGRES_URL, POSTGRES_URL_NON_POOLING, POSTGRES_PRISMA_URL
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ENV_FILE = path.join(__dirname, '..', '.env.local');
// Use a temp profile that persists across the session but starts fresh
const TEMP_PROFILE = path.join(os.tmpdir(), 'dossie-key-capture-profile');

// ── Env helpers ──────────────────────────────────────────────────────────────

function readEnv() { return fs.readFileSync(ENV_FILE, 'utf8'); }

function writeEnvVar(name, value) {
  let content = readEnv();
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
  if (!replaced) content += `\n${name}="${value}"`;
  fs.writeFileSync(ENV_FILE, content, 'utf8');
  console.log(`  >> .env.local updated: ${name} = [${value.length} chars]`);
}

function getEnvVar(name) {
  const content = readEnv();
  const m = content.match(new RegExp(`^${name}=["']?([^"'\\n]+)["']?\\s*$`, 'm'));
  return m ? m[1].trim() : '';
}

function isAlreadyFilled(name) { return getEnvVar(name).length > 4; }

// ── Wait helpers ─────────────────────────────────────────────────────────────

async function waitForLogin(page, successCheck, serviceName, maxWaitMs = 120000) {
  console.log(`  Waiting for you to log in to ${serviceName}...`);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    await page.waitForTimeout(2000);
    try {
      if (await successCheck(page)) return true;
    } catch (_) {}
  }
  console.log(`  Timeout waiting for ${serviceName} login.`);
  return false;
}

async function bodyText(page) {
  return page.evaluate(() => document.body ? document.body.innerText : '').catch(() => '');
}

// ── Service extractors ────────────────────────────────────────────────────────

async function captureAnthropic(ctx) {
  if (isAlreadyFilled('ANTHROPIC_API_KEY')) {
    console.log('  [SKIP] ANTHROPIC_API_KEY already filled');
    return;
  }
  console.log('\n[1/5] ANTHROPIC — console.anthropic.com');
  const page = await ctx.newPage();
  await page.goto('https://console.anthropic.com/settings/keys', { waitUntil: 'domcontentloaded' });

  // Wait for login to complete (page will show "Create Key" button when authenticated)
  const loggedIn = await waitForLogin(page,
    async (p) => {
      const t = await bodyText(p);
      return t.includes('Create Key') || t.includes('API Keys') || t.includes('sk-ant-');
    },
    'Anthropic Console (use "Continue with Google" with heath.shepard@kw.com or heath.shepard@gmail.com)'
  );

  if (!loggedIn) {
    console.log('  [SKIP] Anthropic — login timed out');
    await page.close();
    return;
  }

  // Navigate to keys page if redirected elsewhere after login
  const url = page.url();
  if (!url.includes('/keys')) {
    await page.goto('https://console.anthropic.com/settings/keys', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
  }

  // Click "Create Key"
  const createBtn = page.locator('button', { hasText: /create key/i }).first();
  if (await createBtn.isVisible({ timeout: 8000 }).catch(() => false)) {
    await createBtn.click();
    await page.waitForTimeout(1500);

    // Fill name
    const nameInput = page.locator('input[placeholder*="Key name" i], input[type="text"]').first();
    if (await nameInput.isVisible({ timeout: 4000 }).catch(() => false)) {
      await nameInput.fill('local-dev');
    }

    // Confirm
    const confirm = page.locator('button', { hasText: /create key|create|confirm/i }).last();
    if (await confirm.isVisible({ timeout: 3000 }).catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(3000);
    }

    // Grab the one-time key from the dialog/page
    const afterText = await bodyText(page);
    const keyMatch = afterText.match(/sk-ant-[A-Za-z0-9\-_]{20,}/);
    if (keyMatch) {
      writeEnvVar('ANTHROPIC_API_KEY', keyMatch[0]);
    } else {
      // Try code/input elements
      const inputs = page.locator('code, input[readonly], input[type="text"]');
      let found = false;
      for (let i = 0; i < await inputs.count(); i++) {
        const val = await inputs.nth(i).evaluate(e => (e.value || e.textContent || '').trim()).catch(() => '');
        if (val.startsWith('sk-ant-')) {
          writeEnvVar('ANTHROPIC_API_KEY', val);
          found = true;
          break;
        }
      }
      if (!found) {
        console.log('  [FAIL] Key not found after dialog — check debug screenshot: scripts/.debug-anthropic-guided.png');
        await page.screenshot({ path: 'scripts/.debug-anthropic-guided.png' });
      }
    }
  } else {
    console.log('  [FAIL] "Create Key" button not visible after login');
    await page.screenshot({ path: 'scripts/.debug-anthropic-guided.png' });
  }

  await page.close();
}

async function captureStripe(ctx) {
  const needWebhook = !isAlreadyFilled('STRIPE_WEBHOOK_SECRET');
  const needSecret = !isAlreadyFilled('STRIPE_SECRET_KEY');
  const needPayLink = !isAlreadyFilled('STRIPE_FOUNDING_PAYMENT_LINK');

  if (!needWebhook && !needSecret && !needPayLink) {
    console.log('  [SKIP] All Stripe vars already filled');
    return;
  }

  console.log('\n[2/5] STRIPE — dashboard.stripe.com');
  const page = await ctx.newPage();
  await page.goto('https://dashboard.stripe.com/webhooks', { waitUntil: 'domcontentloaded' });

  // Wait for Stripe dashboard to load (login via Google or Passkey)
  const loggedIn = await waitForLogin(page,
    async (p) => {
      const t = await bodyText(p);
      return t.includes('Webhooks') && !t.includes('Sign in to your account');
    },
    'Stripe (sign in with Google or email — use heath.shepard@gmail.com)'
  );

  if (!loggedIn) {
    console.log('  [SKIP] Stripe — login timed out');
    await page.close();
    return;
  }

  // --- Webhook secret ---
  if (needWebhook) {
    // Try direct link to known webhook endpoint
    await page.goto('https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/workbench/webhooks/we_1TS0IlL920SKTEEizvDzz7op', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // Reveal signing secret
    const revealBtn = page.locator('button', { hasText: /reveal/i }).first();
    if (await revealBtn.isVisible({ timeout: 6000 }).catch(() => false)) {
      await revealBtn.click();
      await page.waitForTimeout(1500);
    }
    let t = await bodyText(page);
    const whsec = t.match(/whsec_[A-Za-z0-9+/=]{20,}/);
    if (whsec) {
      writeEnvVar('STRIPE_WEBHOOK_SECRET', whsec[0]);
    } else {
      // Try base webhooks page, click first endpoint
      await page.goto('https://dashboard.stripe.com/webhooks', { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);
      const firstRow = page.locator('a[href*="we_"], tr').first();
      if (await firstRow.isVisible({ timeout: 4000 }).catch(() => false)) {
        await firstRow.click();
        await page.waitForTimeout(2000);
        const revealBtn2 = page.locator('button', { hasText: /reveal/i }).first();
        if (await revealBtn2.isVisible({ timeout: 4000 }).catch(() => false)) {
          await revealBtn2.click();
          await page.waitForTimeout(1500);
        }
        t = await bodyText(page);
        const whsec2 = t.match(/whsec_[A-Za-z0-9+/=]{20,}/);
        if (whsec2) writeEnvVar('STRIPE_WEBHOOK_SECRET', whsec2[0]);
        else {
          console.log('  [FAIL] whsec_ not found');
          await page.screenshot({ path: 'scripts/.debug-stripe-guided.png' });
        }
      }
    }
  }

  // --- Secret key ---
  if (needSecret) {
    await page.goto('https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/apikeys', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    // Click create restricted/secret key
    const createBtn = page.locator('button', { hasText: /create.*secret|create.*key|add.*key/i }).first();
    if (await createBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1200);

      const nameInput = page.locator('input[placeholder*="My key" i], input[placeholder*="name" i], input[type="text"]').first();
      if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        await nameInput.fill('local-dev');
      }

      // "Powering an integration you built" option
      const intOpt = page.locator('text=integration you built, label', { hasText: /integration you built/i }).first();
      if (await intOpt.isVisible({ timeout: 2000 }).catch(() => false)) {
        await intOpt.click();
        await page.waitForTimeout(300);
      }

      const continueBtn = page.locator('button', { hasText: /continue|next|create/i }).last();
      if (await continueBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await continueBtn.click();
        await page.waitForTimeout(2500);
      }

      const t2 = await bodyText(page);
      const skMatch = t2.match(/sk_live_[A-Za-z0-9]{20,}/);
      if (skMatch) {
        writeEnvVar('STRIPE_SECRET_KEY', skMatch[0]);
        const doneBtn = page.locator('button', { hasText: /done|close/i }).first();
        await doneBtn.click().catch(() => {});
      } else {
        // Check input fields in modal
        const inputs = page.locator('input[value*="sk_live_"], input[readonly]');
        let found = false;
        for (let i = 0; i < await inputs.count(); i++) {
          const val = await inputs.nth(i).inputValue().catch(() => '');
          if (val.startsWith('sk_live_')) { writeEnvVar('STRIPE_SECRET_KEY', val); found = true; break; }
        }
        if (!found) {
          console.log('  [FAIL] sk_live_ not found in modal');
          await page.screenshot({ path: 'scripts/.debug-stripe-key-guided.png' });
        }
      }
    } else {
      // No create button — look for existing key on page
      const t3 = await bodyText(page);
      const skM = t3.match(/sk_live_[A-Za-z0-9]{20,}/);
      if (skM) writeEnvVar('STRIPE_SECRET_KEY', skM[0]);
      else {
        console.log('  [FAIL] No create button and no sk_live_ visible');
        await page.screenshot({ path: 'scripts/.debug-stripe-key-guided.png' });
      }
    }
  }

  // --- Payment link ---
  if (needPayLink) {
    await page.goto('https://dashboard.stripe.com/acct_1TKRFBL920SKTEEi/payment-links', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);

    const html = await page.content();
    const t4 = await bodyText(page);
    const linkMatch = (t4 + html).match(/buy\.stripe\.com\/[A-Za-z0-9_\-]+/);
    if (linkMatch) {
      writeEnvVar('STRIPE_FOUNDING_PAYMENT_LINK', 'https://' + linkMatch[0].replace(/["'<>].*/, ''));
    } else {
      // Click first row if list
      const row = page.locator('tr, [class*="row"], a[href*="plink_"]').first();
      if (await row.isVisible({ timeout: 3000 }).catch(() => false)) {
        await row.click();
        await page.waitForTimeout(2000);
        const t5 = await bodyText(page);
        const lm2 = t5.match(/buy\.stripe\.com\/[A-Za-z0-9_\-]+/);
        if (lm2) writeEnvVar('STRIPE_FOUNDING_PAYMENT_LINK', 'https://' + lm2[0]);
        else console.log('  [FAIL] No buy.stripe.com link found — payment link may not exist yet');
      } else {
        console.log('  [FAIL] No payment links in list');
      }
    }
  }

  await page.close();
}

async function captureHCTI(ctx) {
  if (isAlreadyFilled('HCTI_USER_ID') && isAlreadyFilled('HCTI_API_KEY')) {
    console.log('  [SKIP] HCTI already filled');
    return;
  }
  console.log('\n[3/5] HCTI — htmlcsstoimage.com/dashboard/api-keys');
  const page = await ctx.newPage();
  await page.goto('https://htmlcsstoimage.com/dashboard/api-keys', { waitUntil: 'domcontentloaded' });

  const loggedIn = await waitForLogin(page,
    async (p) => {
      const t = await bodyText(p);
      return t.includes('API Key') && !t.includes('Sign in') && !t.includes('Login');
    },
    'HCTI — htmlcsstoimage.com (log in with Google or email)'
  );

  if (!loggedIn) {
    // Try /dashboard as fallback
    await page.goto('https://htmlcsstoimage.com/dashboard', { waitUntil: 'domcontentloaded' });
    const t2 = await bodyText(page);
    if (!t2.includes('API') || t2.includes('Login')) {
      console.log('  [SKIP] HCTI — login timed out');
      await page.close();
      return;
    }
  }

  await page.waitForTimeout(2000);

  // HCTI shows User ID (UUID) and API Key on the api-keys page
  const inputs = page.locator('input[readonly], input[type="text"], code, [class*="key"], [class*="token"]');
  let userId = '', apiKey = '';
  const count = await inputs.count();
  for (let i = 0; i < count; i++) {
    const val = await inputs.nth(i).evaluate(e => (e.value || e.textContent || '').trim()).catch(() => '');
    if (!val) continue;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val) && !userId) {
      userId = val;
    } else if (val.length >= 20 && val.length <= 80 && !val.startsWith('eyJ') && !/^[0-9a-f-]{36}$/.test(val) && !apiKey) {
      apiKey = val;
    }
  }

  // Text scan fallback
  if (!userId || !apiKey) {
    const t = await bodyText(page);
    if (!userId) {
      const m = t.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (m) userId = m[0];
    }
  }

  // HTML source scan for API key value
  if (!apiKey) {
    const html = await page.content();
    // Look for value="<alphanumeric 20-60 chars>" in inputs
    const vm = html.match(/value="([A-Za-z0-9]{20,60})"/g);
    if (vm) {
      for (const match of vm) {
        const val = match.replace(/value="|"/g, '');
        if (!val.startsWith('eyJ') && val.length >= 20) { apiKey = val; break; }
      }
    }
  }

  if (userId && !isAlreadyFilled('HCTI_USER_ID')) writeEnvVar('HCTI_USER_ID', userId);
  else if (!userId) { console.log('  [FAIL] HCTI_USER_ID not found'); await page.screenshot({ path: 'scripts/.debug-hcti-guided.png' }); }

  if (apiKey && !isAlreadyFilled('HCTI_API_KEY')) writeEnvVar('HCTI_API_KEY', apiKey);
  else if (!apiKey) { console.log('  [FAIL] HCTI_API_KEY not found'); await page.screenshot({ path: 'scripts/.debug-hcti-guided.png' }); }

  await page.close();
}

async function captureResend(ctx) {
  if (isAlreadyFilled('RESEND_API_KEY')) {
    console.log('  [SKIP] RESEND_API_KEY already filled');
    return;
  }
  console.log('\n[4/5] RESEND — resend.com/api-keys');
  const page = await ctx.newPage();
  await page.goto('https://resend.com/api-keys', { waitUntil: 'domcontentloaded' });

  const loggedIn = await waitForLogin(page,
    async (p) => {
      const t = await bodyText(p);
      return t.includes('API Keys') && !t.includes('Sign in') && !t.includes('Log in');
    },
    'Resend — resend.com (log in with GitHub or email)'
  );

  if (!loggedIn) {
    console.log('  [SKIP] Resend — login timed out');
    await page.close();
    return;
  }

  await page.waitForTimeout(2000);
  const t = await bodyText(page);
  const reMatch = t.match(/re_[A-Za-z0-9_]{20,}/);
  if (reMatch) {
    writeEnvVar('RESEND_API_KEY', reMatch[0]);
  } else {
    // Keys may be masked — create a new one
    const createBtn = page.locator('button, a', { hasText: /create.*api.*key|add.*key|new.*key/i }).first();
    if (await createBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
      await createBtn.click();
      await page.waitForTimeout(1000);
      const nameInput = page.locator('input[placeholder*="name" i]').first();
      if (await nameInput.isVisible({ timeout: 3000 }).catch(() => false)) await nameInput.fill('local-dev');
      const submitBtn = page.locator('button', { hasText: /create|add|save/i }).last();
      if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await submitBtn.click();
        await page.waitForTimeout(2500);
      }
      const t2 = await bodyText(page);
      const reM2 = t2.match(/re_[A-Za-z0-9_]{20,}/);
      if (reM2) writeEnvVar('RESEND_API_KEY', reM2[0]);
      else { console.log('  [FAIL] re_ key not found after creation'); await page.screenshot({ path: 'scripts/.debug-resend-guided.png' }); }
    } else {
      console.log('  [FAIL] Keys masked and no create button found');
      await page.screenshot({ path: 'scripts/.debug-resend-guided.png' });
    }
  }

  await page.close();
}

async function captureSupabase(ctx) {
  const needJWT = !isAlreadyFilled('SUPABASE_JWT_SECRET');
  const needPw = !isAlreadyFilled('POSTGRES_PASSWORD');
  const needUrl = !isAlreadyFilled('POSTGRES_URL');
  const needNonPool = !isAlreadyFilled('POSTGRES_URL_NON_POOLING');
  const needPrisma = !isAlreadyFilled('POSTGRES_PRISMA_URL');
  const needSecKey = !isAlreadyFilled('SUPABASE_SECRET_KEY');

  if (!needJWT && !needPw && !needUrl && !needNonPool && !needPrisma && !needSecKey) {
    console.log('  [SKIP] All Supabase vars already filled');
    return;
  }

  const projectId = 'pgwoitbdiyubjugwufhk';
  console.log('\n[5/5] SUPABASE — supabase.com/dashboard');
  const page = await ctx.newPage();
  await page.goto(`https://supabase.com/dashboard/project/${projectId}/settings/api`, { waitUntil: 'domcontentloaded' });

  const loggedIn = await waitForLogin(page,
    async (p) => {
      const t = await bodyText(p);
      const url = p.url();
      return url.includes('/settings/') && !url.includes('sign-in') && !t.includes('Welcome back');
    },
    'Supabase (Continue with GitHub using heath.shepard@kw.com)'
  );

  if (!loggedIn) {
    console.log('  [SKIP] Supabase — login timed out');
    await page.close();
    return;
  }

  // -- JWT Secret (API settings page) --
  if (needJWT || needSecKey) {
    // Make sure we're on API settings
    if (!page.url().includes('/settings/api')) {
      await page.goto(`https://supabase.com/dashboard/project/${projectId}/settings/api`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
    }

    // Click all Reveal buttons
    const revealBtns = page.locator('button', { hasText: /reveal|show/i });
    for (let i = 0; i < await revealBtns.count(); i++) {
      await revealBtns.nth(i).click().catch(() => {});
      await page.waitForTimeout(400);
    }
    await page.waitForTimeout(1000);

    const inputs = page.locator('input[type="text"], input[readonly], input[type="password"]');
    for (let i = 0; i < await inputs.count(); i++) {
      const val = await inputs.nth(i).inputValue().catch(() => '');
      if (!val.trim()) continue;
      // JWT secret: 40-64 chars, not starting eyJ, not sb_*, not a URL
      if (needJWT && val.length >= 40 && val.length <= 120
          && !val.startsWith('eyJ') && !val.startsWith('sb_')
          && !val.includes('.supabase.co') && !val.includes('://')) {
        writeEnvVar('SUPABASE_JWT_SECRET', val.trim());
        needJWT = false;
      }
      if (needSecKey && val.startsWith('sb_secret_')) {
        writeEnvVar('SUPABASE_SECRET_KEY', val.trim());
        needSecKey = false;
      }
    }
    if (needJWT) { console.log('  [FAIL] SUPABASE_JWT_SECRET not found on API settings page'); await page.screenshot({ path: 'scripts/.debug-supabase-guided.png' }); }
  }

  // -- DB password + connection strings --
  if (needPw || needUrl || needNonPool) {
    await page.goto(`https://supabase.com/dashboard/project/${projectId}/settings/database`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4000);

    // Reveal
    const revealBtns2 = page.locator('button', { hasText: /reveal|show/i });
    for (let i = 0; i < await revealBtns2.count(); i++) {
      await revealBtns2.nth(i).click().catch(() => {});
      await page.waitForTimeout(400);
    }

    // Switch to URI/Connection String tab
    const uriTab = page.locator('button, [role="tab"]', { hasText: /URI|connection string/i }).first();
    if (await uriTab.isVisible({ timeout: 3000 }).catch(() => false)) {
      await uriTab.click();
      await page.waitForTimeout(1000);
    }

    const inputs2 = page.locator('input[type="text"], input[readonly], textarea');
    let poolerUrl = '', directUrl = '';
    for (let i = 0; i < await inputs2.count(); i++) {
      const val = await inputs2.nth(i).inputValue().catch(() => '');
      if (!val.startsWith('postgres')) continue;
      if (val.includes(':6543') || val.includes('pooler')) {
        if (!poolerUrl) poolerUrl = val;
      } else if (val.includes(':5432') || val.includes('db.pgwoitbdiyubjugwufhk')) {
        if (!directUrl) directUrl = val;
      }
    }

    if (poolerUrl) {
      const pwMatch = poolerUrl.match(/:([^@]+)@/);
      if (needPw && pwMatch && !pwMatch[1].includes(':')) writeEnvVar('POSTGRES_PASSWORD', pwMatch[1]);
      if (needUrl) writeEnvVar('POSTGRES_URL', poolerUrl);
    }
    if (directUrl && needNonPool) writeEnvVar('POSTGRES_URL_NON_POOLING', directUrl);

    // Derive PRISMA URL
    if (needPrisma) {
      const pgUrl = getEnvVar('POSTGRES_URL');
      if (pgUrl) {
        const prisma = pgUrl.includes('?') ? pgUrl + '&pgbouncer=true&connect_timeout=15' : pgUrl + '?pgbouncer=true&connect_timeout=15';
        writeEnvVar('POSTGRES_PRISMA_URL', prisma);
      }
    }

    if (!poolerUrl && !directUrl) {
      console.log('  [FAIL] No connection strings found on DB settings page');
      await page.screenshot({ path: 'scripts/.debug-supabase-db-guided.png' });
    }
  }

  await page.close();
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Atlas Guided Key Capture ===');
  console.log('This will open a browser window. Log in to each service when prompted.');
  console.log('You have 2 minutes per service. Keys are saved immediately after capture.\n');

  console.log('Current state:');
  const targets = [
    'ANTHROPIC_API_KEY', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET',
    'STRIPE_FOUNDING_PAYMENT_LINK', 'HCTI_USER_ID', 'HCTI_API_KEY',
    'RESEND_API_KEY', 'SUPABASE_JWT_SECRET', 'SUPABASE_SECRET_KEY',
    'POSTGRES_PASSWORD', 'POSTGRES_URL', 'POSTGRES_PRISMA_URL', 'POSTGRES_URL_NON_POOLING',
  ];
  for (const v of targets) console.log(`  ${v}: ${isAlreadyFilled(v) ? 'FILLED' : 'EMPTY'}`);
  console.log('');

  const ctx = await chromium.launchPersistentContext(TEMP_PROFILE, {
    headless: false,
    channel: 'chrome',
    args: [
      '--no-first-run',
      '--disable-default-apps',
      '--disable-blink-features=AutomationControlled',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1400, height: 900 },
  });

  try {
    await captureAnthropic(ctx);
    await captureStripe(ctx);
    await captureHCTI(ctx);
    await captureResend(ctx);
    await captureSupabase(ctx);
  } finally {
    await ctx.close().catch(() => {});
  }

  console.log('\n=== FINAL STATE ===');
  for (const v of targets) console.log(`  ${v}: ${isAlreadyFilled(v) ? 'FILLED' : 'STILL EMPTY'}`);
  console.log('\nDone. Clean up temp profile if no longer needed:');
  console.log(`  rmdir /s /q "${TEMP_PROFILE}"`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
