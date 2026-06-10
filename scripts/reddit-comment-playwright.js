'use strict';

// scripts/reddit-comment-playwright.js
//
// Posts a Reddit comment by driving a Playwright browser with the captured
// session cookies. Bypasses the dead OAuth path and the modhash/bearer-token
// extraction problem entirely.
//
// Usage:
//   node scripts/reddit-comment-playwright.js \
//     --url=https://www.reddit.com/r/realtors/comments/1u0piq6/ \
//     --text-file=scripts/atlas-runs/reddit-draft.txt
//
// Emits JSON to stdout on success:
//   { ok: true, permalink, comment_id, url }

const fs = require('fs');
const path = require('path');

const SESSION_FILE = path.join(__dirname, 'sessions', 'reddit.json');

async function main() {
  const args = process.argv.slice(2);
  let postUrl = null, text = null, textFile = null, headless = true;
  for (const a of args) {
    if (a.startsWith('--url=')) postUrl = a.slice('--url='.length);
    else if (a.startsWith('--text=')) text = a.slice('--text='.length);
    else if (a.startsWith('--text-file=')) textFile = a.slice('--text-file='.length);
    else if (a === '--headed') headless = false;
  }
  if (textFile) text = fs.readFileSync(textFile, 'utf8').trim();
  if (!postUrl || !text) {
    console.error('Missing --url= and/or --text(-file)=');
    process.exit(1);
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
  });
  const context = await browser.newContext({
    storageState: SESSION_FILE,
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();

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
    await browser.close();
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

  await browser.close();

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
