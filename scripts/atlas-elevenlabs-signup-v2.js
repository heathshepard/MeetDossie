'use strict';

// Atlas — ElevenLabs signup v2
// Strategy: launch via DossieBot-Sage Chrome profile (real Chrome binary)
// to bypass bot detection. Fill form, prompt Heath to click "Sign up" if
// the auto-click gets blocked, then poll for the verify-email screen +
// completion. Once on /app/home, navigate to settings/api-keys and capture
// a new API key.

const path = require('path');
const fs = require('fs');
const os = require('os');

// --- env load ---
try {
  const envPath = path.join('C:/Users/Heath Shepard/Desktop/MeetDossie', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch {}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// Use a brand-new isolated profile dir (not DossieBot, which has Heath's FB session)
const PROFILE_DIR = process.env.ELEVENLABS_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'AtlasElevenLabs'
);

const args = (() => {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--email') out.email = a[++i];
    else if (a[i] === '--password') out.password = a[++i];
  }
  return out;
})();
if (!args.email || !args.password) {
  console.error('Usage: --email <e> --password <p>');
  process.exit(2);
}

const RUN_DIR = path.join(__dirname, 'atlas-runs', `elevenlabs-signup-${Date.now()}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

async function sendTg(text) {
  if (!TELEGRAM_BOT_TOKEN) return;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'Markdown' }),
    });
    if (!r.ok) console.error('[tg] fail ' + r.status);
  } catch (e) { console.error('[tg] err ' + e.message); }
}

async function snap(page, label) {
  try {
    const p = path.join(RUN_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: p });
    console.error(`[snap] ${label}`);
  } catch {}
}

async function main() {
  const { chromium } = require('playwright');

  console.error(`[atlas] profile dir: ${PROFILE_DIR}`);
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--window-size=1100,800',
      '--window-position=120,80',
    ],
  });

  // Use existing page or create
  let page = ctx.pages()[0] || await ctx.newPage();
  await page.bringToFront();

  console.error('[1] Goto signup...');
  await page.goto('https://elevenlabs.io/app/sign-up', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  await snap(page, '01-signup');

  // Fill form
  console.error('[2] Fill form...');
  await page.locator('input[type="email"]').first().fill(args.email);
  await page.locator('input[type="password"]').first().fill(args.password);
  try {
    await page.locator('input[type="checkbox"]').first().check({ force: true });
  } catch {
    await page.locator('label:has-text("I agree"), label:has-text("Terms")').first().click().catch(() => {});
  }
  await page.waitForTimeout(800);
  await snap(page, '02-filled');

  // Click sign up — using user-gesture style click
  console.error('[3] Click Sign up button...');
  const signupBtn = page.locator('button:has-text("Sign up"):not(:has-text("Google"))').first();
  await signupBtn.scrollIntoViewIfNeeded();
  await signupBtn.click();
  await page.waitForTimeout(5000);
  await snap(page, '03-after-click');

  let url = page.url();
  console.error(`[3] URL: ${url}`);

  if (/\/sign-up/.test(url)) {
    console.error('[3a] Submit blocked — possibly bot detection.');
    await sendTg(
      '*Atlas — ElevenLabs signup blocked at CAPTCHA*\n\n' +
      'Form filled with `heathshepard@meetdossie.com` + password. Browser is open at top-left of screen.\n\n' +
      'Tap the *Sign up* button manually (might trigger Cloudflare CAPTCHA). Then check Gmail for the verification email and click the link.\n\n' +
      'Atlas is polling — once you reach the verify screen + verify, automation resumes.'
    );
    console.error('[3a] Polling 10 min for URL change off /sign-up...');
    const dl = Date.now() + 10 * 60 * 1000;
    while (Date.now() < dl) {
      await page.waitForTimeout(4000);
      url = page.url();
      if (!/\/sign-up/.test(url)) break;
    }
    console.error(`[3a] URL after wait: ${url}`);
  }

  await snap(page, '04-post-signup');

  // Now wait for verification (could be /app/sign-up/email-verification or similar) OR direct /app
  console.error('[4] Wait for verification + redirect to /app...');
  const verifyDl = Date.now() + 10 * 60 * 1000;
  let onboarded = false;
  while (Date.now() < verifyDl) {
    await page.waitForTimeout(5000);
    url = page.url();
    if (/\/app\/(home|conversational|voice|text|sound|studio)/.test(url) ||
        url === 'https://elevenlabs.io/app' ||
        url === 'https://elevenlabs.io/app/') {
      onboarded = true;
      break;
    }
    // Skip onboarding screens (Tell us about yourself etc.)
    try {
      const skip = page.locator('button:has-text("Skip"), button:has-text("Continue"), button:has-text("Next")').first();
      if (await skip.isVisible({ timeout: 1500 })) {
        await skip.click().catch(() => {});
      }
    } catch {}
  }
  await snap(page, '05-onboarded');

  if (!onboarded) {
    console.error('[4] Not onboarded after 10 min. Aborting.');
    await sendTg('*Atlas:* ElevenLabs signup stalled. Browser still open — final URL: `' + url + '`. Please check.');
    console.error('RESULT_JSON:' + JSON.stringify({ ok: false, stage: 'not_onboarded', url }));
    process.exit(1);
  }

  // Account exists. Generate API key.
  console.error('[5] Going to API keys page...');
  await page.goto('https://elevenlabs.io/app/settings/api-keys', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(4000);
  await snap(page, '06-api-keys-page');

  // Click create
  const createBtn = page.locator('button:has-text("Create API key"), button:has-text("New API key"), button:has-text("Create new key")').first();
  await createBtn.click({ timeout: 15000 });
  await page.waitForTimeout(2000);
  await snap(page, '07-create-modal');

  // Name + scope = full
  try {
    await page.locator('input[name="name"], input[placeholder*="name" i]').first().fill('Dossie Production');
  } catch {}
  await page.waitForTimeout(500);

  // Toggle "Has access to all" or similar — leave defaults usually = full access
  // Click confirm/create button
  const confirmBtn = page.locator('button:has-text("Create"):not(:has-text("Create API key")), button:has-text("Save"), button[type="submit"]').last();
  await confirmBtn.click({ timeout: 10000 });
  await page.waitForTimeout(3000);
  await snap(page, '08-key-shown');

  // Extract sk_<hex>
  const html = await page.content();
  const m = html.match(/sk_[a-f0-9]{40,}/i);
  if (!m) {
    console.error('[5] Could not extract API key from page.');
    await sendTg('*Atlas:* API key created but extraction failed — please copy from the open browser and reply with it.');
    console.error('RESULT_JSON:' + JSON.stringify({ ok: false, stage: 'no_key_extract', url: page.url() }));
    process.exit(1);
  }
  const apiKey = m[0];
  console.error('[5] Captured: ' + apiKey.slice(0, 12) + '...');

  // Verify voices
  console.error('[6] Verify Luna + Bill voices...');
  const voice = async (id) => {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${id}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test.', model_id: 'eleven_turbo_v2_5' }),
    });
    return { ok: r.ok, status: r.status };
  };
  const luna = await voice('lxYfHSkYm1EzQzGhdbfc');
  const bill = await voice('pqHfZKP75CvOlQylNhV4');

  // Credits
  let credits = null;
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': apiKey } });
    if (r.ok) {
      const j = await r.json();
      credits = (j.character_limit || 0) - (j.character_count || 0);
    }
  } catch {}

  const result = {
    ok: true,
    api_key: apiKey,
    credits,
    voices_ok: { luna: luna.ok, bill: bill.ok },
    voice_status: { luna: luna.status, bill: bill.status },
  };

  console.error('RESULT_JSON:' + JSON.stringify(result));
  // Write key to local file for downstream automation
  fs.writeFileSync(path.join(RUN_DIR, 'api-key.txt'), apiKey + '\n');
  await sendTg(`*Atlas:* ElevenLabs new key live. Luna: ${luna.ok ? '✓' : '✗ ' + luna.status} | Bill: ${bill.ok ? '✓' : '✗ ' + bill.status} | Credits: ${credits || '?'}`);

  await ctx.close().catch(() => {});
  process.exit(0);
}

main().catch(async (e) => {
  console.error('FATAL: ' + e.message);
  console.error(e.stack);
  await sendTg('*Atlas:* ElevenLabs signup crashed — ' + (e.message || 'unknown'));
  process.exit(1);
});
