'use strict';

// V9 — directly target comment-composer-host (the collapsed reply composer
// wrapper). Scroll it into viewport, click to expand, type, then click Comment.

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

  console.log('[v9] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // Step 1: scroll comment-composer-host into view
  const cchPos = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    cch.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = cch.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('[v9] comment-composer-host:', JSON.stringify(cchPos));

  if (!cchPos) {
    console.error('[v9] FAIL: no comment-composer-host');
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v9: no comment-composer-host`);
    process.exit(2);
  }

  await page.waitForTimeout(1500); // wait for lazy loaders + scroll settle
  await page.screenshot({ path: path.join(__dirname, 'v9-step1.png'), fullPage: false });

  // Step 2: probe what's actually rendered inside the host now
  const internal = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    const out = { textareas: [], inputs: [], editables: [], buttons: [], childTags: [] };

    function walk(root, depth = 0, parentInfo = []) {
      if (depth > 6 || !root) return;
      const children = root.children ? Array.from(root.children) : [];
      for (const el of children) {
        const tag = el.tagName.toLowerCase();
        out.childTags.push(tag);
        const r = el.getBoundingClientRect();
        if (tag === 'textarea') {
          out.textareas.push({ ph: el.placeholder, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        }
        if (tag === 'input') {
          out.inputs.push({ ph: el.placeholder, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        }
        if (el.getAttribute && el.getAttribute('contenteditable') === 'true') {
          out.editables.push({ rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        }
        if (tag === 'button' || tag === 'faceplate-button') {
          out.buttons.push({ text: el.textContent.trim(), rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
        }
        walk(el, depth + 1);
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    }
    walk(cch);
    return out;
  });
  console.log('[v9] Inside cch (scoped):', JSON.stringify(internal, null, 2).slice(0, 1500));

  // Click the host wrapper at center
  await page.mouse.click(cchPos.x + cchPos.w / 2, cchPos.y + cchPos.h / 2);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(__dirname, 'v9-step2-clicked.png'), fullPage: false });

  // Re-probe after click — composer should have expanded
  const after = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    const editables = [];
    const buttons = [];
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName.toLowerCase();
          const r = el.getBoundingClientRect();
          if (r.width > 50 && r.height > 15 && el.getAttribute('contenteditable') === 'true') {
            editables.push({ rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
          }
          if (tag === 'button' || tag === 'faceplate-button') {
            const t = el.textContent.trim();
            if (/^comment$/i.test(t) && r.width > 0) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              buttons.push({ text: t, disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(cch);
    const focused = document.activeElement;
    return {
      editables, buttons,
      focusedTag: focused ? focused.tagName.toLowerCase() : null,
      focusedEditable: focused ? focused.getAttribute('contenteditable') : null,
    };
  });
  console.log('[v9] After click (scoped):', JSON.stringify(after, null, 2));

  if (!after.editables || after.editables.length === 0) {
    console.error('[v9] FAIL: composer did not expand to editable');
    await page.screenshot({ path: path.join(__dirname, 'v9-fail-no-editable.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v9: composer did not expand`);
    process.exit(3);
  }

  // Focus the editable if not already focused
  if (after.focusedEditable !== 'true') {
    const ed = after.editables[0];
    await page.mouse.click(ed.rect.x + ed.rect.w / 2, ed.rect.y + ed.rect.h / 2);
    await page.waitForTimeout(700);
  }

  // Type the draft
  console.log('[v9] Typing draft (' + FINAL_DRAFT.length + ' chars)...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v9-step3-typed.png'), fullPage: false });

  // Find and click Comment button scoped to host
  const submit = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName.toLowerCase();
          if (tag === 'button' || tag === 'faceplate-button') {
            const t = el.textContent.trim();
            if (/^comment$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) {
                el.scrollIntoView({ block: 'center', behavior: 'instant' });
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
    return walk(cch);
  });
  console.log('[v9] Submit rect:', JSON.stringify(submit));

  if (!submit) {
    console.error('[v9] FAIL: no enabled Comment button');
    await page.screenshot({ path: path.join(__dirname, 'v9-fail-no-submit.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v9: no enabled Comment button`);
    process.exit(4);
  }

  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'v9-step4-pre-submit.png'), fullPage: false });

  // Re-locate after scroll
  const finalRect = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return null;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName.toLowerCase();
          if (tag === 'button' || tag === 'faceplate-button') {
            const t = el.textContent.trim();
            if (/^comment$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              if (!disabled) {
                const r = el.getBoundingClientRect();
                return { x: r.x, y: r.y, w: r.width, h: r.height };
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
    return walk(cch);
  });
  console.log('[v9] Final submit rect:', JSON.stringify(finalRect));

  await page.mouse.click(finalRect.x + finalRect.w / 2, finalRect.y + finalRect.h / 2);
  console.log('[v9] Submit clicked');
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(__dirname, 'v9-step5-submitted.png'), fullPage: false });

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
  console.log('[v9] Verify:', JSON.stringify(verify, null, 2));
  await page.screenshot({ path: path.join(__dirname, 'v9-step6-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v9: not found on reload`);
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

  fs.writeFileSync(path.join(__dirname, 'v9-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v9] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed v9: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
