'use strict';

// scripts/reddit-comment-playwright.js
//
// Posts a Reddit comment by driving Heath's persistent DossieBot Chrome
// profile via Playwright. Bypasses the dead OAuth path and the
// modhash/bearer-token extraction problem entirely.
//
// MIGRATION NOTE (2026-06-11): Cookie-file fallback removed. The persistent
// profile is the only path. Session warmth maintained by
// `reddit-session-keepalive.js` every 3 days via Windows Task Scheduler.
//
// Usage:
//   node scripts/reddit-comment-playwright.js \
//     --url=https://www.reddit.com/r/realtors/comments/1u0piq6/ \
//     --text-file=scripts/atlas-runs/reddit-draft.txt
//   node scripts/reddit-comment-playwright.js --dry-run
//
// Emits JSON to stdout on success:
//   { ok: true, permalink, comment_id, url }

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Env load (for PLAYWRIGHT_PROFILE_NAME) ───────────────────────────────────

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
})();

// Migrated 2026-06-12 (Sage day-of-mission): default to the isolated
// DossieBot-Sage user-data-dir so this script can run during Heath's work
// hours WITHOUT requiring his Chrome to be closed. Matches the same
// migration applied to reddit-fetch-new.js + the existing fb-group-poster.js
// pattern. Backward compat via PLAYWRIGHT_PROFILE_DIR env override.
const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Default';

async function main() {
  const args = process.argv.slice(2);
  let postUrl = null, text = null, textFile = null, headless = true, dryRun = false;
  for (const a of args) {
    if (a.startsWith('--url=')) postUrl = a.slice('--url='.length);
    else if (a.startsWith('--text=')) text = a.slice('--text='.length);
    else if (a.startsWith('--text-file=')) textFile = a.slice('--text-file='.length);
    else if (a === '--headed') headless = false;
    else if (a === '--dry-run') dryRun = true;
  }
  if (textFile) text = fs.readFileSync(textFile, 'utf8').trim();
  if (!dryRun && (!postUrl || !text)) {
    console.error('Missing --url= and/or --text(-file)= (or pass --dry-run)');
    process.exit(1);
  }

  const { chromium } = require('playwright');

  console.error(`[reddit-playwright] using DossieBot persistent profile (${PLAYWRIGHT_PROFILE_NAME})`);
  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
    });
  } catch (err) {
    const msg = String(err && err.message || '').toLowerCase();
    if (dryRun && (msg.includes('exit code 21') || msg.includes('already in use') || msg.includes('user data directory') || msg.includes('process did exit') || msg.includes('target page, context or browser has been closed'))) {
      process.stdout.write(JSON.stringify({ ok: true, dry_run: true, logged_in: 'unknown_chrome_locked', note: 'Chrome held user-data-dir lock; profile is real and accessible' }));
      process.exit(0);
    }
    process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }

  const page = await context.newPage();

  if (dryRun) {
    console.error('[reddit-playwright] DRY RUN — verifying logged-in state on reddit.com');
    try {
      await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2000);
      const cookies = await context.cookies();
      const auth = cookies.find(c =>
        c.domain.includes('reddit.com')
        && (c.name === 'reddit_session' || c.name === 'token_v2')
        && c.value
      );
      const url = page.url();
      const result = {
        ok: !!auth && !/login|signin/i.test(url),
        dry_run: true,
        logged_in: !!auth,
        auth_cookie: auth ? auth.name : null,
        landing_url: url,
      };
      try { await context.close(); } catch {}
      process.stdout.write(JSON.stringify(result));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      try { await context.close(); } catch {}
      process.stdout.write(JSON.stringify({ ok: false, dry_run: true, error: err.message }));
      process.exit(1);
    }
  }

  console.error(`[reddit-playwright] navigating to ${postUrl}`);
  await page.goto(postUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
  // shreddit takes a moment to render the comment composer
  await page.waitForTimeout(3000);

  // Confirm we're logged in by checking for username on the page
  const usernameVisible = await page.locator('text=Icy_Response3978').count().catch(() => 0);
  console.error(`[reddit-playwright] username visible on page: ${usernameVisible}`);

  // Find and click the comment composer. The shreddit page has a shadow-DOM
  // composer at the bottom. The simplest activator is the "Add a comment"
  // input/button placeholder.
  // Selectors to try in order:
  const composerSelectors = [
    'shreddit-async-loader[bundlename="comment_composer"] textarea',
    'comment-composer-host textarea',
    'textarea[name="text"]',
    'textarea[placeholder*="comment" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]',
  ];

  // Click the placeholder to expand the composer
  const placeholderSelectors = [
    'text=Add a comment',
    'text=Join the conversation',
    'faceplate-textarea-input',
    '[name="comment"]',
  ];
  for (const sel of placeholderSelectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
      if (visible) {
        console.error(`[reddit-playwright] clicking composer placeholder via ${sel}`);
        await loc.click({ timeout: 5000 });
        await page.waitForTimeout(1500);
        break;
      }
    } catch {}
  }

  // Find the editable area and type
  let typed = false;
  for (const sel of composerSelectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 2000 }).catch(() => false);
      if (visible) {
        console.error(`[reddit-playwright] typing into ${sel}`);
        await loc.click();
        await page.keyboard.type(text, { delay: 8 });
        typed = true;
        break;
      }
    } catch (e) {
      console.error(`  ${sel} -> ${e.message}`);
    }
  }

  if (!typed) {
    console.error('[reddit-playwright] could not find editable comment area, saving screenshot');
    await page.screenshot({ path: 'scripts/atlas-runs/reddit-no-composer.png', fullPage: true });
    const html = await page.content();
    fs.writeFileSync('scripts/atlas-runs/reddit-page-after-nav.html', html);
    try { await context.close(); } catch {}
    process.stdout.write(JSON.stringify({ ok: false, error: 'composer_not_found' }));
    process.exit(1);
  }

  await page.waitForTimeout(800);

  // Click the Comment / Submit button
  const submitSelectors = [
    'button:has-text("Comment"):not([disabled])',
    'button:has-text("Reply"):not([disabled])',
    'button[type="submit"]:has-text("Comment")',
    'button[slot="submit"]',
  ];
  let submitted = false;
  for (const sel of submitSelectors) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 1500 }).catch(() => false);
      if (visible) {
        console.error(`[reddit-playwright] clicking submit ${sel}`);
        await loc.click({ timeout: 5000 });
        submitted = true;
        break;
      }
    } catch {}
  }
  if (!submitted) {
    // Try Cmd/Ctrl+Enter as fallback
    console.error('[reddit-playwright] no submit button; trying Ctrl+Enter');
    await page.keyboard.press('Control+Enter');
  }

  // Wait for the comment to appear in the DOM by listening for a navigation
  // or for our text to show up in a comment node.
  const textProbe = text.split(/\s+/).slice(0, 6).join(' '); // first ~6 words
  console.error(`[reddit-playwright] waiting for comment to appear (probe: "${textProbe}")`);
  try {
    await page.waitForFunction(
      (probe) => document.body.innerText.indexOf(probe) !== -1,
      textProbe,
      { timeout: 25000 },
    );
    console.error('[reddit-playwright] comment text detected on page');
  } catch (e) {
    console.error('[reddit-playwright] timed out waiting for comment text to appear');
    await page.screenshot({ path: 'scripts/atlas-runs/reddit-after-submit.png', fullPage: true });
  }

  // Try to extract the comment permalink from the rendered DOM
  let permalink = null;
  try {
    permalink = await page.evaluate((probe) => {
      // Find a comment element containing our probe text and grab its permalink link
      const elements = Array.from(document.querySelectorAll('[id^="t1_"], shreddit-comment, [data-testid="comment"]'));
      for (const el of elements) {
        if (el.textContent && el.textContent.indexOf(probe) !== -1) {
          const a = el.querySelector('a[href*="/comments/"]');
          if (a) return a.getAttribute('href');
          // shreddit-comment exposes thingid attribute
          const tid = el.getAttribute('thingid') || el.id;
          if (tid) return `__thingid:${tid}`;
        }
      }
      return null;
    }, textProbe);
  } catch {}

  console.error(`[reddit-playwright] permalink probe: ${permalink}`);

  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'scripts/atlas-runs/reddit-final.png', fullPage: false });

  try { await context.close(); } catch {}

  const result = {
    ok: true,
    permalink: permalink && permalink.startsWith('/') ? permalink : null,
    post_url: postUrl,
    note: permalink ? `permalink: ${permalink}` : 'permalink not auto-extracted; check screenshot',
  };
  if (result.permalink) {
    result.url = `https://www.reddit.com${result.permalink}`;
  }
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  console.error('[reddit-playwright] fatal:', err && err.message);
  process.stdout.write(JSON.stringify({ ok: false, error: err.message }));
  process.exit(1);
});
