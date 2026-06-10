'use strict';

// V2 — find and use the INLINE comment composer on the post detail page,
// not the global "create post" composer.

const path = require('path');
const fs = require('fs');

const POST_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';
const POST_FULLNAME = 't3_1u0piq6';

const FINAL_DRAFT = fs.readFileSync(path.join(__dirname, 'sage-draft.txt'), 'utf8')
  .trim()
  .replace(/—/g, ' - ')
  .replace(/–/g, '-')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .split('\n').map(l => l.replace(/  +/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim();

// Load env
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
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
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

  console.log('[v2-post] Loading post page...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  await page.screenshot({ path: path.join(__dirname, 'v2post-step1.png'), fullPage: false });

  // The inline comment box is "comment-composer-host" / "Add a comment" textarea, NOT shreddit-composer (global)
  // Locate the inline comment composer
  const inline = await page.evaluate(() => {
    // Comment composer is typically <comment-composer-host> wrapping a faceplate-textarea-input
    // or a div with [contenteditable] inside a "Join the conversation" form.
    const candidates = [
      'comment-composer-host textarea',
      'faceplate-tracker[noun="comment"] textarea',
      'shreddit-async-loader textarea',
      'textarea[name="text"]',
      'textarea[placeholder*="conversation" i]',
      'textarea[placeholder*="thoughts" i]',
      'textarea[placeholder*="comment" i]',
      'div[contenteditable="true"][role="textbox"]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.width > 100) {
          return { sel, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placeholder: el.placeholder || el.getAttribute('aria-label') || '' };
        }
      }
    }
    // Walk all visible textareas + contenteditables
    const all = document.querySelectorAll('textarea, [contenteditable="true"]');
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 20) {
        return { sel: el.tagName.toLowerCase() + ' (fallback)', rect: { x: r.x, y: r.y, w: r.width, h: r.height }, placeholder: el.placeholder || el.getAttribute('aria-label') || '' };
      }
    }
    return null;
  });
  console.log('[v2-post] Inline composer probe:', JSON.stringify(inline));

  if (!inline) {
    console.error('[v2-post] FAIL: no inline composer found.');
    await page.screenshot({ path: path.join(__dirname, 'v2post-fail-no-inline.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: no inline composer found on post page.`);
    process.exit(2);
  }

  // Click the inline composer to focus
  console.log('[v2-post] Clicking inline composer at', inline.rect);
  await page.mouse.click(inline.rect.x + inline.rect.w / 2, inline.rect.y + inline.rect.h / 2);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(__dirname, 'v2post-step2-active.png'), fullPage: false });

  // After click, Reddit may swap textarea -> rich editor (contenteditable). Re-probe.
  const richProbe = await page.evaluate(() => {
    const all = document.querySelectorAll('[contenteditable="true"], textarea');
    const visible = [];
    for (const el of all) {
      const r = el.getBoundingClientRect();
      if (r.width > 100 && r.height > 20) {
        visible.push({
          tag: el.tagName.toLowerCase(),
          editable: el.getAttribute('contenteditable'),
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
          placeholder: el.placeholder || el.getAttribute('aria-label') || '',
          focused: document.activeElement === el,
        });
      }
    }
    return visible;
  });
  console.log('[v2-post] After click, all editors:', JSON.stringify(richProbe));

  // Type with keyboard (active element gets it)
  console.log('[v2-post] Typing draft (' + FINAL_DRAFT.length + ' chars)...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      // Reddit rich editor: Enter creates new paragraph
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, 'v2post-step3-typed.png'), fullPage: false });

  // Find the Comment submit button — should now be enabled
  const submits = await page.evaluate(() => {
    const out = [];
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const role = el.getAttribute && el.getAttribute('role');
          if (tag === 'button' || tag === 'faceplate-button' || role === 'button') {
            const t = (el.textContent || '').trim();
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && /^comment$|^post$|^reply$/i.test(t)) {
              const disabled = el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
              out.push({ tag, txt: t, disabled, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(document);
    return out;
  });
  console.log('[v2-post] Submits:', JSON.stringify(submits));

  // Prefer "Comment" labels
  const commentBtn = submits.find(b => !b.disabled && /^comment$/i.test(b.txt)) ||
                     submits.find(b => !b.disabled);

  if (!commentBtn) {
    console.error('[v2-post] FAIL: no enabled submit. Buttons:', submits);
    await page.screenshot({ path: path.join(__dirname, 'v2post-fail-no-submit.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: typed but no enabled Comment button (after veto window). Manual post needed.`);
    process.exit(3);
  }

  console.log('[v2-post] Clicking submit at', commentBtn.rect);
  await page.mouse.click(commentBtn.rect.x + commentBtn.rect.w / 2, commentBtn.rect.y + commentBtn.rect.h / 2);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(__dirname, 'v2post-step4-submitted.png'), fullPage: false });

  // Reload to confirm
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  const found = await page.evaluate(() => {
    const comments = document.querySelectorAll('shreddit-comment[author="Icy_Response3978"]');
    let newest = null;
    let newestTs = 0;
    for (const c of comments) {
      const ts = parseInt(c.getAttribute('created-timestamp-ms') || '0', 10) ||
                 Date.parse(c.getAttribute('created-timestamp') || '') || 0;
      if (ts > newestTs) {
        newestTs = ts;
        newest = c;
      }
    }
    if (!newest && comments.length > 0) newest = comments[0];
    if (!newest) return { count: comments.length };
    return {
      count: comments.length,
      thingid: newest.getAttribute('thingid'),
      permalink: newest.getAttribute('permalink'),
      created: newest.getAttribute('created-timestamp'),
      body_snippet: (newest.innerText || '').slice(0, 250),
    };
  });
  console.log('[v2-post] Found after post:', JSON.stringify(found));
  await page.screenshot({ path: path.join(__dirname, 'v2post-step5-verify.png'), fullPage: false });

  await browser.close();

  if (!found || !found.thingid) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: submit clicked but no Icy_Response3978 comment found on reload.`);
    process.exit(4);
  }

  // Sanity check: body of new comment includes a known substring of our draft
  const sample = 'CRM that leads closed';
  const matches = found.body_snippet.includes(sample);
  if (!matches) {
    console.warn('[v2-post] Newest comment body does not include sample - may be wrong comment');
  }

  const permalink = found.permalink
    ? (found.permalink.startsWith('http') ? found.permalink : `https://www.reddit.com${found.permalink}`)
    : POST_URL;

  await patchRow({
    status: 'posted',
    posted_at: new Date().toISOString(),
    permalink: permalink.replace('https://www.reddit.com', ''),
  });

  fs.writeFileSync(path.join(__dirname, 'v2-result.json'), JSON.stringify({
    outcome: 'posted',
    permalink,
    thingid: found.thingid,
    body_snippet_match: matches,
    body_snippet: found.body_snippet,
    posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v2-post] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
