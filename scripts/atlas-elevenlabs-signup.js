// ElevenLabs new-account signup automation
// Owner: Atlas (SV-VOICE-001, Mission 1)
// Date: 2026-06-10
//
// Goal: register a fresh ElevenLabs account on heathshepard@meetdossie.com,
// verify the email (which forwards through ImprovMX to Heath's gmail),
// confirm Luna + Bill voice access, generate API key, return key as JSON to stdout.
//
// Email verification: ImprovMX forwards heathshepard@meetdossie.com → heath.shepard@gmail.com.
// We poll Gmail via IMAP? No — Heath has Gmail MCP at claude.ai but NOT here.
// Strategy: open the link by polling the verification page or — fallback — keep the
// browser open and ask Heath to click the link in his Gmail (single tap).
//
// Usage: node signup.js --email <e> --password <p> [--headed]
//
// Output (stdout, JSON on a line starting with `RESULT_JSON:`):
//   { ok: true, api_key: "sk_...", credits: 10000, voices_ok: { luna: true, bill: true } }

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const args = (() => {
  const out = { headed: true };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--email') out.email = a[++i];
    else if (a[i] === '--password') out.password = a[++i];
    else if (a[i] === '--headed') out.headed = true;
    else if (a[i] === '--headless') out.headed = false;
  }
  return out;
})();

if (!args.email || !args.password) {
  console.error('Usage: node signup.js --email <e> --password <p>');
  process.exit(2);
}

const RUN_DIR = path.join(__dirname, 'runs', `signup-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

async function snap(page, label) {
  try {
    const p = path.join(RUN_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: p, fullPage: false });
    console.error(`[snap] ${label} -> ${p}`);
  } catch (_) {}
}

async function main() {
  const browser = await chromium.launch({
    headless: !args.headed,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await ctx.newPage();

  console.error('[1] Navigate to ElevenLabs signup...');
  await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await snap(page, '01-signup-page');

  // Look for email + password fields. ElevenLabs uses Auth0-ish auth.
  console.error('[2] Fill email + password...');
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passwordInput = page.locator('input[type="password"], input[name="password"]').first();

  await emailInput.waitFor({ timeout: 15000 });
  await emailInput.fill(args.email);
  await passwordInput.fill(args.password);
  await snap(page, '02-form-filled');

  // Look for terms checkbox if present — ElevenLabs hides input behind label.
  try {
    const checkbox = page.locator('input[type="checkbox"]').first();
    await checkbox.check({ force: true, timeout: 3000 });
    console.error('[2a] Terms checkbox checked.');
  } catch (e) {
    try {
      const label = page.locator('label:has-text("I agree"), label:has-text("Terms")').first();
      await label.click({ timeout: 2000 });
      console.error('[2a] Terms label clicked (fallback).');
    } catch (_) {
      console.error('[2a] WARN: no terms checkbox found.');
    }
  }
  await page.waitForTimeout(500);
  await snap(page, '02b-checkbox-checked');

  // Submit
  console.error('[3] Submit signup form...');
  const submitBtn = page.locator('button[type="submit"], button:has-text("Sign up"), button:has-text("Create account"), button:has-text("Continue")').first();
  await submitBtn.click();
  await page.waitForTimeout(4000);
  await snap(page, '03-after-submit');

  // Common follow-ups:
  // - "Tell us about yourself" — name fields
  // - Email verification screen
  // - CAPTCHA

  // Try filling name if asked
  try {
    const firstName = page.locator('input[name="first_name"], input[placeholder*="First" i], input[autocomplete="given-name"]').first();
    if (await firstName.isVisible({ timeout: 3000 })) {
      console.error('[3a] Name fields present, filling...');
      await firstName.fill('Heath');
      const lastName = page.locator('input[name="last_name"], input[placeholder*="Last" i], input[autocomplete="family-name"]').first();
      if (await lastName.isVisible({ timeout: 1500 })) {
        await lastName.fill('Shepard');
      }
      await snap(page, '03b-name-filled');
      const next = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Next")').first();
      await next.click();
      await page.waitForTimeout(3000);
      await snap(page, '03c-after-name');
    }
  } catch (_) {}

  // If we hit a verification screen, mark and pause for Heath to click the link.
  await snap(page, '04-pre-verify-check');
  const url = page.url();
  console.error(`[4] Current URL: ${url}`);

  const bodyText = (await page.textContent('body').catch(() => '')) || '';
  const stillOnSignup = /\/sign-up/.test(url);
  if (stillOnSignup) {
    console.error('[4a] Still on /sign-up after submit — likely CAPTCHA / hCaptcha / Cloudflare challenge.');
    console.error('[4a] Pausing 4 min for human-in-loop (Heath to solve CAPTCHA + click Sign up).');
    // Poll for URL change
    const dl = Date.now() + 4 * 60 * 1000;
    while (Date.now() < dl) {
      await page.waitForTimeout(3000);
      if (!/\/sign-up/.test(page.url())) {
        console.error('[4a] URL changed off /sign-up: ' + page.url());
        break;
      }
    }
  }
  const url2 = page.url();
  const body2 = (await page.textContent('body').catch(() => '')) || '';
  const needsVerify = /verify your email|verification|check your inbox|confirm your email|sent you an email/i.test(body2 + bodyText) || /\/verify/.test(url2);

  if (needsVerify) {
    console.error('[5] Email verification required.');
    console.error('[5] Atlas signaling: Heath please click the verification link Gmail received from ElevenLabs.');
    console.error('[5] Polling current page for redirect to /app...');

    // Poll up to 8 minutes for the page to redirect to the home/dashboard
    const deadline = Date.now() + 8 * 60 * 1000;
    let verified = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(5000);
      const u = page.url();
      const b = (await page.textContent('body').catch(() => '')) || '';
      if (/\/app\/?$/.test(u) || /\/app\/(home|dashboard|voice)/.test(u) || /welcome to elevenlabs/i.test(b)) {
        verified = true;
        console.error('[5] Verified — redirected to ' + u);
        break;
      }
      // Heath may have to open the link in a separate browser/tab. The signup-tab itself
      // sometimes detects verification automatically. If not, we'll try to navigate.
      if (Math.floor((Date.now() - (deadline - 8 * 60 * 1000)) / 30000) % 4 === 0) {
        try { await page.goto('https://elevenlabs.io/app/home', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch (_) {}
      }
    }
    if (!verified) {
      await snap(page, '05-verify-timeout');
      console.error('[5] Verification did not complete within 8 minutes. Atlas aborting.');
      console.error('RESULT_JSON:' + JSON.stringify({ ok: false, stage: 'verify_timeout', url: page.url() }));
      await browser.close();
      process.exit(1);
    }
  } else {
    console.error('[4] No verification screen detected — proceeding.');
  }

  // Wait for app to settle
  await page.waitForTimeout(3000);
  await snap(page, '06-app-home');

  // Navigate to API keys page
  console.error('[6] Navigating to API keys...');
  // Direct routes that have worked historically:
  const apiKeyRoutes = [
    'https://elevenlabs.io/app/settings/api-keys',
    'https://elevenlabs.io/app/account/api-keys',
    'https://elevenlabs.io/app/settings/account',
  ];

  let apiKey = null;
  for (const route of apiKeyRoutes) {
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(3000);
      await snap(page, `07-route-${route.split('/').pop()}`);

      // Look for "Create API key" button
      const createBtn = page.locator('button:has-text("Create API key"), button:has-text("New API key"), button:has-text("Create"), a:has-text("Create API key")').first();
      if (await createBtn.isVisible({ timeout: 5000 })) {
        await createBtn.click();
        await page.waitForTimeout(2000);
        await snap(page, '08-create-modal');

        // Name field
        try {
          const nameField = page.locator('input[placeholder*="name" i], input[name="name"]').first();
          if (await nameField.isVisible({ timeout: 3000 })) {
            await nameField.fill('Dossie Production');
          }
        } catch (_) {}

        // Confirm/Create
        const confirmBtn = page.locator('button:has-text("Create"):not(:has-text("Create API key")), button:has-text("Confirm"), button:has-text("Generate"), button[type="submit"]').last();
        await confirmBtn.click();
        await page.waitForTimeout(3000);
        await snap(page, '09-key-created');

        // Find the key — usually shown once in a modal
        const keyText = await page.evaluate(() => {
          // Look for anything matching sk_<hex>
          const html = document.body.innerText;
          const m = html.match(/sk_[a-f0-9]{40,}/i);
          return m ? m[0] : null;
        });
        if (keyText) {
          apiKey = keyText;
          console.error('[7] API key captured: ' + apiKey.slice(0, 12) + '...');
          break;
        }
      }
    } catch (e) {
      console.error(`[7] Route ${route} failed: ${e.message}`);
    }
  }

  if (!apiKey) {
    await snap(page, '99-no-key');
    console.error('[7] Could not auto-create API key.');
    console.error('RESULT_JSON:' + JSON.stringify({ ok: false, stage: 'no_api_key', url: page.url() }));
    await browser.close();
    process.exit(1);
  }

  // Verify Luna + Bill voice IDs are accessible
  console.error('[8] Verifying voice access via the captured key...');
  const fetch = (await import('node-fetch')).default;
  const voiceCheck = async (voiceId, label) => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test.', model_id: 'eleven_turbo_v2_5' }),
    });
    return { label, voiceId, status: r.status, ok: r.ok };
  };
  let voices_ok = {};
  try {
    voices_ok.luna = (await voiceCheck('lxYfHSkYm1EzQzGhdbfc', 'luna')).ok;
    voices_ok.bill = (await voiceCheck('pqHfZKP75CvOlQylNhV4', 'bill')).ok;
  } catch (e) {
    console.error('[8] Voice check failed: ' + e.message);
  }

  // Try to read credit balance
  let credits = null;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
      headers: { 'xi-api-key': apiKey },
    });
    if (r.ok) {
      const j = await r.json();
      credits = (j.character_limit || 0) - (j.character_count || 0);
    }
  } catch (_) {}

  console.error('RESULT_JSON:' + JSON.stringify({ ok: true, api_key: apiKey, credits, voices_ok }));
  await browser.close();
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL: ' + e.message);
  console.error(e.stack);
  console.error('RESULT_JSON:' + JSON.stringify({ ok: false, stage: 'crash', error: e.message }));
  process.exit(1);
});
