'use strict';

// V10 — identical to V9 recipe, but reads sage-draft-v2.txt (the corrected
// honest version with no fabricated capabilities). Verifies the posted body
// matches a phrase from v2 that does NOT exist in v1 ("panic-attack couple"
// or "relationship-decay problem") before declaring success.

const path = require('path');
const fs = require('fs');

const POST_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';

const DRAFT_PATH = path.join(__dirname, 'sage-draft-v2.txt');
const FINAL_DRAFT = fs.readFileSync(DRAFT_PATH, 'utf8')
  .trim()
  .replace(/—/g, ' - ')
  .replace(/–/g, '-')
  .replace(/[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .split('\n').map(l => l.replace(/  +/g, ' ').trim()).join('\n')
  .replace(/\n{3,}/g, '\n\n').trim();

// Hard guard: refuse to post if any banned v1 phrase made it through.
const BANNED = [
  /buying signals/i,
  /lead nurture/i,
  /lead scoring/i,
  /buyer intent/i,
  /watches for buying/i,
  /before the close happens/i,
];
for (const re of BANNED) {
  if (re.test(FINAL_DRAFT)) {
    console.error('[v10] ABORT: banned phrase in draft:', re);
    process.exit(99);
  }
}

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

  console.log('[v10] Loading post...');
  await page.goto(POST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  const cchPos = await page.evaluate(() => {
    const cch = document.querySelector('comment-composer-host');
    if (!cch) return null;
    cch.scrollIntoView({ block: 'center', behavior: 'instant' });
    const r = cch.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  console.log('[v10] comment-composer-host:', JSON.stringify(cchPos));

  if (!cchPos) {
    console.error('[v10] FAIL: no comment-composer-host');
    await browser.close();
    process.exit(2);
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'v10-step1.png'), fullPage: false });

  await page.mouse.click(cchPos.x + cchPos.w / 2, cchPos.y + cchPos.h / 2);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(__dirname, 'v10-step2-clicked.png'), fullPage: false });

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
  console.log('[v10] After click (scoped):', JSON.stringify(after, null, 2).slice(0, 1000));

  if (!after.editables || after.editables.length === 0) {
    console.error('[v10] FAIL: composer did not expand to editable');
    await page.screenshot({ path: path.join(__dirname, 'v10-fail-no-editable.png'), fullPage: true });
    await browser.close();
    process.exit(3);
  }

  if (after.focusedEditable !== 'true') {
    const ed = after.editables[0];
    await page.mouse.click(ed.rect.x + ed.rect.w / 2, ed.rect.y + ed.rect.h / 2);
    await page.waitForTimeout(700);
  }

  console.log('[v10] Typing draft (' + FINAL_DRAFT.length + ' chars)...');
  const paragraphs = FINAL_DRAFT.split(/\n\n+/);
  for (let i = 0; i < paragraphs.length; i++) {
    await page.keyboard.type(paragraphs[i], { delay: 6 });
    if (i < paragraphs.length - 1) {
      await page.keyboard.press('Enter');
      await page.keyboard.press('Enter');
    }
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v10-step3-typed.png'), fullPage: false });

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
  console.log('[v10] Submit rect:', JSON.stringify(submit));

  if (!submit) {
    console.error('[v10] FAIL: no enabled Comment button');
    await page.screenshot({ path: path.join(__dirname, 'v10-fail-no-submit.png'), fullPage: true });
    await browser.close();
    process.exit(4);
  }

  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(__dirname, 'v10-step4-pre-submit.png'), fullPage: false });

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
  console.log('[v10] Final submit rect:', JSON.stringify(finalRect));

  await page.mouse.click(finalRect.x + finalRect.w / 2, finalRect.y + finalRect.h / 2);
  console.log('[v10] Submit clicked');
  await page.waitForTimeout(7000);
  await page.screenshot({ path: path.join(__dirname, 'v10-step5-submitted.png'), fullPage: false });

  await page.goto(POST_URL + '?sort=new', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(5500);

  // Verify with v2-only phrases (these do NOT exist in v1)
  const verify = await page.evaluate(() => {
    const comments = document.querySelectorAll('shreddit-comment');
    const out = [];
    for (const c of comments) {
      const body = (c.innerText || '');
      // v2-only phrases
      const isV2 = body.includes('panic-attack couple') ||
                   body.includes('relationship-decay problem') ||
                   body.includes('watches the title company inbox');
      if (isV2) {
        out.push({
          author: c.getAttribute('author'),
          thingid: c.getAttribute('thingid'),
          permalink: c.getAttribute('permalink'),
          body: body.slice(0, 500),
        });
      }
    }
    return { total: comments.length, matches: out };
  });
  console.log('[v10] Verify:', JSON.stringify(verify, null, 2));
  await page.screenshot({ path: path.join(__dirname, 'v10-step6-verify.png'), fullPage: false });
  await browser.close();

  if (!verify.matches || verify.matches.length === 0) {
    console.error('[v10] FAIL: v2 not found on reload');
    fs.writeFileSync(path.join(__dirname, 'v10-result.json'), JSON.stringify({
      outcome: 'failed', reason: 'v2 phrases not found on reload', ts: new Date().toISOString(),
    }, null, 2));
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

  fs.writeFileSync(path.join(__dirname, 'v10-result.json'), JSON.stringify({
    outcome: 'posted', permalink, thingid: m.thingid, author: m.author,
    body_snippet: m.body, posted_at: new Date().toISOString(),
  }, null, 2));

  console.log('[v10] DONE:', permalink);
})().catch(e => {
  console.error('FATAL', e.stack || e.message);
  fs.writeFileSync(path.join(__dirname, 'v10-result.json'), JSON.stringify({
    outcome: 'crashed', error: (e.message || String(e)).slice(0, 500), ts: new Date().toISOString(),
  }, null, 2));
  process.exit(1);
});
