'use strict';

// V8 — scope composer search to shreddit-async-loader[bundlename="comment_composer"]
// or comment-composer-host. Avoid the global "Create post" composer.

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

  console.log('[v8] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // Dump DOM structure to find the inline composer container
  const structure = await page.evaluate(() => {
    const out = {};
    // Look for comment-composer-host
    const cch = document.querySelectorAll('comment-composer-host');
    out.commentComposerHost = [];
    for (const el of cch) {
      const r = el.getBoundingClientRect();
      out.commentComposerHost.push({ rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
    }
    // shreddit-async-loader with comment_composer bundle
    const sal = document.querySelectorAll('shreddit-async-loader');
    out.asyncLoaders = [];
    for (const el of sal) {
      const bn = el.getAttribute('bundlename') || '';
      if (/comment/i.test(bn)) {
        const r = el.getBoundingClientRect();
        out.asyncLoaders.push({ bundlename: bn, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
      }
    }
    // All textareas with their parent chain
    const tas = document.querySelectorAll('textarea[placeholder*="conversation" i]');
    out.matchingTextareas = [];
    for (const ta of tas) {
      const r = ta.getBoundingClientRect();
      let parentChain = [];
      let p = ta.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        parentChain.push(p.tagName.toLowerCase() + (p.id ? '#' + p.id : '') + (p.className ? '.' + String(p.className).slice(0, 40) : ''));
        p = p.parentElement;
      }
      out.matchingTextareas.push({
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        parentChain,
      });
    }
    return out;
  });
  console.log('[v8] Structure:', JSON.stringify(structure, null, 2));

  // Pick the textarea inside <comment-composer-host>
  const targetRect = await page.evaluate(() => {
    // 1) comment-composer-host textarea
    const cch = document.querySelector('comment-composer-host');
    if (cch) {
      const ta = cch.querySelector('textarea');
      if (ta) {
        ta.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = ta.getBoundingClientRect();
        return { src: 'cch', rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }
    }
    // 2) shreddit-async-loader with comment_composer bundle
    const sal = document.querySelectorAll('shreddit-async-loader');
    for (const el of sal) {
      const bn = (el.getAttribute('bundlename') || '').toLowerCase();
      if (bn.includes('comment') && !bn.includes('post')) {
        const ta = el.querySelector('textarea');
        if (ta) {
          ta.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = ta.getBoundingClientRect();
          return { src: 'sal:' + bn, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
        }
      }
    }
    // 3) textarea NOT inside shreddit-composer (which is the create-post composer)
    const allTas = document.querySelectorAll('textarea');
    for (const ta of allTas) {
      const ph = ta.getAttribute('placeholder') || '';
      if (!/conversation|comment|thoughts|join/i.test(ph)) continue;
      // Check parents for shreddit-composer (avoid)
      let p = ta.parentElement;
      let insideCreatePost = false;
      while (p) {
        if (p.tagName && p.tagName.toLowerCase() === 'shreddit-composer') {
          insideCreatePost = true;
          break;
        }
        p = p.parentElement;
      }
      if (!insideCreatePost) {
        ta.scrollIntoView({ block: 'center', behavior: 'instant' });
        const r = ta.getBoundingClientRect();
        return { src: 'no-composer-parent', rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }
    }
    return null;
  });

  console.log('[v8] Target rect:', JSON.stringify(targetRect));

  if (!targetRect) {
    console.error('[v8] FAIL: no inline composer found');
    await page.screenshot({ path: path.join(__dirname, 'v8-fail-no-composer.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v8: no inline composer`);
    process.exit(2);
  }

  await page.waitForTimeout(800); // scroll settle
  await page.screenshot({ path: path.join(__dirname, 'v8-step1-located.png'), fullPage: false });

  // Click the visible composer
  await page.mouse.click(
    targetRect.rect.x + targetRect.rect.w / 2,
    targetRect.rect.y + targetRect.rect.h / 2
  );
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v8-step2-expanded.png'), fullPage: false });

  const focused = await page.evaluate(() => {
    const f = document.activeElement;
    if (!f) return null;
    return {
      tag: f.tagName.toLowerCase(),
      editable: f.getAttribute('contenteditable'),
      placeholder: f.getAttribute('placeholder') || f.getAttribute('aria-label') || '',
    };
  });
  console.log('[v8] Focused:', JSON.stringify(focused));

  // Type the draft
  console.log('[v8] Typing draft (' + FINAL_DRAFT.length + ' chars)...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v8-step3-typed.png'), fullPage: false });

  // Now find Comment button scoped to the same composer host. Submit button is inside the same wrapper.
  const submit = await page.evaluate(() => {
    // Find the comment-composer-host (preferred), then look for Comment button INSIDE it.
    let scopeRoot = document.querySelector('comment-composer-host');
    if (!scopeRoot) {
      // Fall back to shreddit-async-loader[bundlename*=comment]
      const sal = document.querySelectorAll('shreddit-async-loader');
      for (const el of sal) {
        const bn = (el.getAttribute('bundlename') || '').toLowerCase();
        if (bn.includes('comment') && !bn.includes('post')) { scopeRoot = el; break; }
      }
    }
    if (!scopeRoot) return null;

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
              return { found: true, disabled, rect: el.getBoundingClientRect() };
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

    const btn = walk(scopeRoot);
    if (!btn) return null;
    return { found: true, disabled: btn.disabled, rect: { x: btn.rect.x, y: btn.rect.y, w: btn.rect.width, h: btn.rect.height } };
  });
  console.log('[v8] Scoped submit:', JSON.stringify(submit));

  // If not found via scope, fall back to global walk
  let submitRect = submit && !submit.disabled ? submit.rect : null;

  if (!submitRect) {
    const fallback = await page.evaluate(() => {
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
                  el.scrollIntoView({ block: 'center', behavior: 'instant' });
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
      return walk(document);
    });
    console.log('[v8] Global fallback submit:', JSON.stringify(fallback));
    submitRect = fallback;
  }

  if (!submitRect) {
    console.error('[v8] FAIL: no enabled Comment button');
    await page.screenshot({ path: path.join(__dirname, 'v8-fail-no-submit.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v8: no enabled Comment button`);
    process.exit(3);
  }

  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'v8-step4-pre-submit.png'), fullPage: false });

  await page.mouse.click(submitRect.x + submitRect.w / 2, submitRect.y + submitRect.h / 2);
  console.log('[v8] Submit clicked');
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(__dirname, 'v8-step5-submitted.png'), fullPage: false });

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
  console.log('[v8] Verify:', JSON.stringify(verify, null, 2));
  await page.screenshot({ path: path.join(__dirname, 'v8-step6-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED v8: not found on reload`);
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

  fs.writeFileSync(path.join(__dirname, 'v8-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v8] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed v8: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
