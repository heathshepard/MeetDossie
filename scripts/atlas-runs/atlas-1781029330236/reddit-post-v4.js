'use strict';

// V4 — same flow but scroll-into-view + element.click() for submit.

const path = require('path');
const fs = require('fs');

const POST_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';

const FINAL_DRAFT = fs.readFileSync(path.join(__dirname, 'sage-draft.txt'), 'utf8')
  .trim()
  .replace(/—/g, ' - ')
  .replace(/–/g, '-')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .split('\n').map(l => l.replace(/  +/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim();

try {
  const envPath = path.join(__dirname, '..', '..', '..', '.env.local');
  if (fs.existsSync(envPath)) {
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
  }
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';
const DRAFT_ID = '718ef571-d6fe-48d7-9da0-33548df59381';

async function patchRow(patch) {
  await fetch(
    `${SUPABASE_URL}/rest/v1/reddit_engagements?id=eq.${encodeURIComponent(DRAFT_ID)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }
  );
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
  });
}

(async () => {
  const { chromium } = require('playwright');
  const sessionPath = path.join(__dirname, '..', '..', 'sessions', 'reddit.json');
  const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // Larger viewport so the Comment button sits inside the visible area after typing
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1500, height: 1200 },
  });
  const page = await context.newPage();

  console.log('[v4] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // Scroll to where composer lives
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(1200);

  await page.screenshot({ path: path.join(__dirname, 'v4-step1.png'), fullPage: false });

  // Find textarea
  const composerInfo = await page.evaluate(() => {
    const ta = document.querySelector('textarea[placeholder*="conversation" i]');
    if (!ta) return null;
    const r = ta.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  });
  if (!composerInfo) {
    console.error('[v4] FAIL: no composer textarea');
    await page.screenshot({ path: path.join(__dirname, 'v4-fail-1.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: composer not found.`);
    process.exit(2);
  }

  // Click composer to expand
  await page.mouse.click(
    composerInfo.rect.x + composerInfo.rect.w / 2,
    composerInfo.rect.y + composerInfo.rect.h / 2
  );
  await page.waitForTimeout(2000);

  // Type with paragraph splits
  console.log('[v4] Typing...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 5 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2000);

  // Now scroll to bring the Comment button into view, then click it via element.click()
  const submitInfo = await page.evaluate(() => {
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const role = el.getAttribute && el.getAttribute('role');
          if (tag === 'button' || tag === 'faceplate-button' || role === 'button') {
            const t = (el.textContent || '').trim();
            if (/^comment$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) {
                // Stash element on window for next call
                window.__submitBtn = el;
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
                const r = el.getBoundingClientRect();
                return { found: true, txt: t, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
              }
            }
          }
          if (el.shadowRoot) {
            const sub = walk(el.shadowRoot, depth + 1);
            if (sub) return sub;
          }
        } catch {}
      }
      return null;
    }
    return walk(document);
  });
  console.log('[v4] Submit found:', JSON.stringify(submitInfo));

  if (!submitInfo || !submitInfo.found) {
    console.error('[v4] FAIL: no Comment button');
    await page.screenshot({ path: path.join(__dirname, 'v4-fail-2.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: Comment button not enabled after typing.`);
    process.exit(3);
  }

  // Wait for scrollIntoView to settle
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'v4-step2-pre-submit.png'), fullPage: false });

  // Click element directly inside page context (bypasses viewport-coord issues)
  const clickRes = await page.evaluate(() => {
    if (!window.__submitBtn) return { ok: false, reason: 'no __submitBtn cached' };
    try {
      // Trigger as user click event
      window.__submitBtn.click();
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  });
  console.log('[v4] Click result:', JSON.stringify(clickRes));
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(__dirname, 'v4-step3-submitted.png'), fullPage: false });

  // Reload and verify — sort by new
  await page.goto(POST_URL + '?sort=new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5000);

  const verify = await page.evaluate(() => {
    const comments = document.querySelectorAll('shreddit-comment');
    const out = [];
    for (const c of comments) {
      const body = (c.innerText || '').slice(0, 250);
      if (body.includes('CRM that leads closed') || body.includes('part that hit me hardest')) {
        out.push({
          author: c.getAttribute('author'),
          thingid: c.getAttribute('thingid'),
          permalink: c.getAttribute('permalink'),
          body: body,
        });
      }
    }
    return { total: comments.length, matches: out };
  });
  console.log('[v4] Verify:', JSON.stringify(verify, null, 2));

  await page.screenshot({ path: path.join(__dirname, 'v4-step4-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: comment did not post after submit click.`);
    process.exit(4);
  }

  const m = verify.matches[0];
  const permalink = m.permalink
    ? (m.permalink.startsWith('http') ? m.permalink : `https://www.reddit.com${m.permalink}`)
    : POST_URL;

  await patchRow({
    status: 'posted',
    posted_at: new Date().toISOString(),
    permalink: m.permalink || null,
  });

  fs.writeFileSync(path.join(__dirname, 'v4-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v4] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
