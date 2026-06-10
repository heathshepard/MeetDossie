'use strict';

// V3 — broader probe + click into the visible composer (which can be a plain
// input field saying "Add a comment" that EXPANDS into a rich editor when clicked).

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

  console.log('[v3] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  // Scroll down a bit — the "Add a comment" composer is below the post body
  await page.evaluate(() => window.scrollTo(0, 700));
  await page.waitForTimeout(1500);

  await page.screenshot({ path: path.join(__dirname, 'v3post-step1.png'), fullPage: false });

  // Probe ALL text-input-like elements with their visible placeholder/aria
  const probe = await page.evaluate(() => {
    const out = [];
    function walk(root, depth = 0) {
      if (depth > 6 || !root) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (tag === 'textarea' || tag === 'input' ||
              (el.getAttribute && el.getAttribute('contenteditable') === 'true') ||
              (el.getAttribute && el.getAttribute('role') === 'textbox')) {
            const r = el.getBoundingClientRect();
            const placeholder = el.getAttribute('placeholder') || el.getAttribute('aria-label') || '';
            const innerText = (el.innerText || '').slice(0, 50);
            const nameAttr = el.getAttribute('name') || '';
            out.push({
              tag, name: nameAttr, placeholder, innerText,
              rect: { x: r.x, y: r.y, w: r.width, h: r.height },
              visible: r.width > 50 && r.height > 15,
            });
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(document);
    return out;
  });
  console.log('[v3] Inputs probe (' + probe.length + ' total):');
  for (const p of probe) {
    if (p.visible) console.log('  VISIBLE:', JSON.stringify(p));
  }

  // Prefer one matching "comment" or "conversation" keyword
  const matches = probe.filter(p => p.visible);
  const commentCandidate = matches.find(p => /comment|conversation|thoughts|reply/i.test(p.placeholder + ' ' + p.innerText + ' ' + p.name)) || matches[0];

  if (!commentCandidate) {
    console.error('[v3] FAIL: no visible inputs at all.');
    await page.screenshot({ path: path.join(__dirname, 'v3post-fail.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: no inline composer detected.`);
    process.exit(2);
  }

  console.log('[v3] Picked composer:', JSON.stringify(commentCandidate));
  await page.mouse.click(
    commentCandidate.rect.x + commentCandidate.rect.w / 2,
    commentCandidate.rect.y + commentCandidate.rect.h / 2
  );
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, 'v3post-step2.png'), fullPage: false });

  // After click, re-find the active focused editor
  const focused = await page.evaluate(() => {
    const f = document.activeElement;
    if (!f) return null;
    const r = f.getBoundingClientRect();
    return {
      tag: f.tagName.toLowerCase(),
      placeholder: f.getAttribute('placeholder') || f.getAttribute('aria-label') || '',
      editable: f.getAttribute('contenteditable'),
      rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    };
  });
  console.log('[v3] Focused after click:', JSON.stringify(focused));

  // Type the draft
  console.log('[v3] Typing draft (' + FINAL_DRAFT.length + ' chars)...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v3post-step3-typed.png'), fullPage: false });

  // Submit
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
  console.log('[v3] Submits:', JSON.stringify(submits));

  // Prefer "Comment" labels first (avoid "Post" which is the create-post page)
  const commentBtn = submits.find(b => !b.disabled && /^comment$/i.test(b.txt)) ||
                     submits.find(b => !b.disabled && /^reply$/i.test(b.txt)) ||
                     submits.find(b => !b.disabled);

  if (!commentBtn) {
    console.error('[v3] FAIL: no enabled submit. Buttons:', submits);
    await page.screenshot({ path: path.join(__dirname, 'v3post-fail-no-submit.png'), fullPage: true });
    await browser.close();
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: typed but Comment button disabled.`);
    process.exit(3);
  }

  console.log('[v3] Clicking submit:', commentBtn.txt, 'at', commentBtn.rect);
  await page.mouse.click(commentBtn.rect.x + commentBtn.rect.w / 2, commentBtn.rect.y + commentBtn.rect.h / 2);
  await page.waitForTimeout(6000);
  await page.screenshot({ path: path.join(__dirname, 'v3post-step4-submitted.png'), fullPage: false });

  // Reload + verify
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
      body_snippet: (newest.innerText || '').slice(0, 250),
    };
  });
  console.log('[v3] Found after reload:', JSON.stringify(found));
  await page.screenshot({ path: path.join(__dirname, 'v3post-step5-final.png'), fullPage: false });
  await browser.close();

  if (!found || !found.thingid) {
    await patchRow({ status: 'failed' });
    await sendTelegram(`Reddit repost FAILED: submit clicked but no Icy_Response3978 comment found on reload.`);
    process.exit(4);
  }

  // Verify body contains a recognizable substring
  const sample = 'CRM that leads closed';
  const matches2 = found.body_snippet.includes(sample);

  const permalink = found.permalink
    ? (found.permalink.startsWith('http') ? found.permalink : `https://www.reddit.com${found.permalink}`)
    : POST_URL;

  await patchRow({
    status: 'posted',
    posted_at: new Date().toISOString(),
    permalink: found.permalink || null,
  });

  fs.writeFileSync(path.join(__dirname, 'v3-result.json'), JSON.stringify({
    outcome: 'posted',
    permalink, thingid: found.thingid,
    body_snippet_match: matches2,
    body_snippet: found.body_snippet,
    posted_at: new Date().toISOString(),
  }, null, 2));

  await sendTelegram(`Reposted via Sage: ${permalink}`);
  console.log('[v3] DONE:', permalink);
})().catch(async e => {
  console.error('FATAL', e.stack || e.message);
  await patchRow({ status: 'failed' });
  await sendTelegram(`Reddit repost crashed: ${(e.message || e).toString().slice(0, 150)}`);
  process.exit(1);
});
