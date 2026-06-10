'use strict';

// V7 — proven v3 path (textarea-click → rich editor focus → type) + FIXED
// submit using element.click() inside page.evaluate (bypasses viewport coords).

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

  console.log('[v7] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);
  // Initial scroll (v3 worked WITHOUT this — v4 broke with it).
  // Don't scroll yet — let v3 path run as-is.

  await page.screenshot({ path: path.join(__dirname, 'v7-step1.png'), fullPage: false });

  // v3 exact composer probe — walked all and picked the visible textarea matching keywords
  const composer = await page.evaluate(() => {
    function walk(root, depth = 0) {
      if (depth > 6 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'textarea') {
            const r = el.getBoundingClientRect();
            const ph = el.getAttribute('placeholder') || '';
            if (r.width > 100 && r.height > 15 && /conversation|comment|thoughts/i.test(ph)) {
              return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placeholder: ph };
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
  console.log('[v7] Composer:', JSON.stringify(composer));

  if (!composer) {
    console.error('[v7] FAIL: no composer');
    await page.screenshot({ path: path.join(__dirname, 'v7-fail-1.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v7: no composer`);
    process.exit(2);
  }

  await page.mouse.click(
    composer.rect.x + composer.rect.w / 2,
    composer.rect.y + composer.rect.h / 2
  );
  await page.waitForTimeout(2000);

  console.log('[v7] Typing draft...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v7-step3-typed.png'), fullPage: false });

  // FIX: Use page.evaluate to scroll the Comment button into view, then call .click() on the element directly.
  const submitRes = await page.evaluate(() => {
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'button' || tag === 'faceplate-button') {
            const t = (el.textContent || '').trim();
            if (/^comment$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) {
                return el;
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
    const btn = walk(document);
    if (!btn) return { ok: false, reason: 'no enabled button' };
    btn.scrollIntoView({ block: 'center', behavior: 'instant' });
    return { ok: true, tag: btn.tagName.toLowerCase(), text: (btn.textContent || '').trim() };
  });
  console.log('[v7] Submit prep:', JSON.stringify(submitRes));

  if (!submitRes.ok) {
    console.error('[v7] FAIL submit prep');
    await page.screenshot({ path: path.join(__dirname, 'v7-fail-2.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v7: ${submitRes.reason}`);
    process.exit(3);
  }

  await page.waitForTimeout(1200); // let scroll settle

  // Now re-find the button (after scroll its coordinates changed) and click via coords
  const finalSubmit = await page.evaluate(() => {
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'button' || tag === 'faceplate-button') {
            const t = (el.textContent || '').trim();
            if (/^comment$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) {
                const r = el.getBoundingClientRect();
                return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
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
  console.log('[v7] Final submit coords:', JSON.stringify(finalSubmit));

  if (!finalSubmit) {
    await page.screenshot({ path: path.join(__dirname, 'v7-fail-3.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v7: button vanished after scroll`);
    process.exit(4);
  }

  await page.screenshot({ path: path.join(__dirname, 'v7-step4-pre-submit.png'), fullPage: false });

  // Use mouse coords now that button is in view
  await page.mouse.click(
    finalSubmit.rect.x + finalSubmit.rect.w / 2,
    finalSubmit.rect.y + finalSubmit.rect.h / 2
  );
  console.log('[v7] Submit clicked');
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(__dirname, 'v7-step5-submitted.png'), fullPage: false });

  // Verify
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
  console.log('[v7] Verify:', JSON.stringify(verify, null, 2));
  await page.screenshot({ path: path.join(__dirname, 'v7-step6-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v7: submitted but not found on reload.`);
    process.exit(5);
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

  fs.writeFileSync(path.join(__dirname, 'v7-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v7] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed v7: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
