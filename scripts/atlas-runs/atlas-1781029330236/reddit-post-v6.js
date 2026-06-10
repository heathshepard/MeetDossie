'use strict';

// V6 — click the visible composer wrapper using text, then type via keyboard,
// then find Comment button.

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
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();

  console.log('[v6] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // Find the composer wrapper by its visible label text
  // It's the bordered box containing "Join the conversation"
  const composerCoords = await page.evaluate(() => {
    // Walk for elements whose textContent === "Join the conversation"
    // and that have a small height (label, not the whole page)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      const txt = (el.textContent || '').trim();
      if (txt === 'Join the conversation') {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.width < 1300) {
          return { x: r.x, y: r.y, w: r.width, h: r.height, tag: el.tagName };
        }
      }
    }
    return null;
  });
  console.log('[v6] Composer label coords:', JSON.stringify(composerCoords));

  if (!composerCoords) {
    console.error('[v6] FAIL: no composer label');
    await page.screenshot({ path: path.join(__dirname, 'v6-fail-1.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v6: no composer label`);
    process.exit(2);
  }

  // Scroll into view + click
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 200)), composerCoords.y);
  await page.waitForTimeout(800);

  // Re-probe after scroll
  const afterScroll = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if ((el.textContent || '').trim() === 'Join the conversation') {
        const r = el.getBoundingClientRect();
        if (r.width > 100 && r.width < 1300) {
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
    }
    return null;
  });
  console.log('[v6] After scroll:', JSON.stringify(afterScroll));

  await page.mouse.click(
    afterScroll.x + afterScroll.w / 2,
    afterScroll.y + afterScroll.h / 2
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v6-step2-clicked.png'), fullPage: false });

  // Check what's focused now
  const focused = await page.evaluate(() => {
    const f = document.activeElement;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return {
      tag: f.tagName.toLowerCase(),
      editable: f.getAttribute('contenteditable'),
      placeholder: f.getAttribute('placeholder') || f.getAttribute('aria-label') || '',
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
  console.log('[v6] Focused:', JSON.stringify(focused));

  // Type the draft
  console.log('[v6] Typing draft...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v6-step3-typed.png'), fullPage: false });

  // Find the Comment button — must be enabled (not disabled, not aria-disabled)
  // Use Playwright locator for built-in scroll-into-view + actionability
  const commentLocator = page.getByRole('button', { name: 'Comment', exact: true });
  const count = await commentLocator.count();
  console.log('[v6] Comment locator count:', count);

  let clicked = false;
  for (let i = 0; i < count; i++) {
    const btn = commentLocator.nth(i);
    const visible = await btn.isVisible();
    const enabled = await btn.isEnabled().catch(() => false);
    const ariaDisabled = await btn.getAttribute('aria-disabled');
    console.log(`[v6]   Btn ${i}: visible=${visible} enabled=${enabled} aria-disabled=${ariaDisabled}`);
    if (visible && enabled && ariaDisabled !== 'true') {
      await btn.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await btn.click({ timeout: 5000 });
      console.log('[v6] Clicked btn', i);
      clicked = true;
      break;
    }
  }

  if (!clicked) {
    console.error('[v6] FAIL: no enabled Comment button');
    await page.screenshot({ path: path.join(__dirname, 'v6-fail-no-submit.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v6: no enabled Comment button`);
    process.exit(3);
  }

  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(__dirname, 'v6-step4-submitted.png'), fullPage: false });

  // Verify on ?sort=new
  await page.goto(POST_URL + '?sort=new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5500);

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
  console.log('[v6] Verify:', JSON.stringify(verify, null, 2));
  await page.screenshot({ path: path.join(__dirname, 'v6-step5-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v6: submitted but not found on reload.`);
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

  fs.writeFileSync(path.join(__dirname, 'v6-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v6] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed v6: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
