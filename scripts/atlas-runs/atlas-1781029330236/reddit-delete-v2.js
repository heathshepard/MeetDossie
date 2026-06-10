'use strict';

// V2 of Reddit comment delete. Precise scoping to the Icy_Response3978 comment,
// proper confirm-dialog handling.

const path = require('path');
const fs = require('fs');

const COMMENT_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/oqp0xm5/?context=1';
const COMMENT_FULLNAME = 't1_oqp0xm5';

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

  // Catch confirm dialogs (Reddit sometimes uses window.confirm for delete)
  page.on('dialog', async (dialog) => {
    console.log('[delete] Native dialog appeared:', dialog.type(), dialog.message());
    await dialog.accept();
  });

  console.log('[delete] Navigating to comment permalink...');
  await page.goto(COMMENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Scroll to target comment first
  await page.evaluate((id) => {
    const c = document.querySelector(`shreddit-comment[thingid="${id}"]`);
    if (c) c.scrollIntoView({ block: 'center' });
  }, COMMENT_FULLNAME);
  await page.waitForTimeout(1500);

  await page.screenshot({ path: path.join(__dirname, 'v2-step1-loaded.png'), fullPage: false });

  // Inspect shadow tree to understand structure
  const probe = await page.evaluate((id) => {
    const c = document.querySelector(`shreddit-comment[thingid="${id}"]`);
    if (!c) return { err: 'not found' };

    function describe(el, depth = 0) {
      if (depth > 4) return null;
      const out = { tag: el.tagName, id: el.id || null, classes: el.className || null };
      if (el.shadowRoot) out._shadow = true;
      return out;
    }

    // Find ALL elements within this comment that look like overflow buttons
    const candidates = [];
    function walk(root, depth = 0) {
      if (depth > 5) return;
      const all = root.querySelectorAll('*');
      for (const el of all) {
        const tag = el.tagName.toLowerCase();
        const aria = (el.getAttribute && el.getAttribute('aria-label')) || '';
        if (tag === 'shreddit-overflow-menu' ||
            tag === 'shreddit-async-loader' && el.id && el.id.includes('overflow') ||
            (tag === 'button' && /more|overflow|options/i.test(aria))) {
          const r = el.getBoundingClientRect();
          candidates.push({
            tag,
            id: el.id || null,
            aria,
            rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            visible: r.width > 0 && r.height > 0,
          });
        }
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
      }
    }
    walk(c);
    return { commentRect: c.getBoundingClientRect(), candidates };
  }, COMMENT_FULLNAME);

  console.log('[delete] Probe:', JSON.stringify(probe, null, 2).slice(0, 1500));

  // Pick the visible overflow button scoped to this comment
  const target = probe.candidates && probe.candidates.find(c => c.visible);
  if (!target) {
    console.error('[delete] No visible overflow inside the target comment.');
    await page.screenshot({ path: path.join(__dirname, 'v2-fail-noprobe.png'), fullPage: true });
    await browser.close();
    process.exit(2);
  }
  console.log('[delete] Will click overflow at', target.rect);

  // Click by coordinates
  const cx = target.rect.x + target.rect.w / 2;
  const cy = target.rect.y + target.rect.h / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(__dirname, 'v2-step2-menu.png'), fullPage: false });

  // Find Delete option — but ONLY in a menu that just opened (popper/menu visible)
  const deleteResult = await page.evaluate(() => {
    // Look for menu items in the most recently opened menu — they're usually inside a faceplate-menu/popper
    const allItems = document.querySelectorAll('[role="menuitem"], faceplate-menu-item, li button, faceplate-menu a, faceplate-menu button');
    const candidates = [];
    for (const el of allItems) {
      const r = el.getBoundingClientRect();
      const t = (el.textContent || '').trim().toLowerCase();
      if (r.width > 0 && r.height > 0 && (t === 'delete' || t === 'delete comment')) {
        candidates.push({ tag: el.tagName, text: t, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
      }
    }
    return { count: candidates.length, candidates };
  });
  console.log('[delete] Delete candidates:', JSON.stringify(deleteResult));

  if (!deleteResult.candidates.length) {
    console.error('[delete] No Delete menu item visible.');
    await page.screenshot({ path: path.join(__dirname, 'v2-fail-nodelete.png'), fullPage: true });
    await browser.close();
    process.exit(3);
  }

  // Pick the LAST one (the menu that opened most recently — closest to the clicked overflow)
  const delItem = deleteResult.candidates[deleteResult.candidates.length - 1];
  const dx = delItem.rect.x + delItem.rect.w / 2;
  const dy = delItem.rect.y + delItem.rect.h / 2;
  console.log('[delete] Clicking Delete at', dx, dy);
  await page.mouse.click(dx, dy);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v2-step3-confirm.png'), fullPage: false });

  // Confirm dialog: look for the modal/dialog with a Delete button
  const confirmResult = await page.evaluate(() => {
    // New Reddit uses faceplate-dialog or shreddit-modal
    const dialogs = document.querySelectorAll('shreddit-modal, faceplate-dialog, [role="dialog"], [role="alertdialog"]');
    const out = [];
    for (const d of dialogs) {
      const r = d.getBoundingClientRect();
      if (r.width <= 0) continue;
      const buttons = d.querySelectorAll('button');
      for (const b of buttons) {
        const t = (b.textContent || '').trim();
        const br = b.getBoundingClientRect();
        out.push({ dialogTag: d.tagName, text: t, rect: { x: br.x, y: br.y, w: br.width, h: br.height } });
      }
    }
    return out;
  });
  console.log('[delete] Dialog buttons:', JSON.stringify(confirmResult));

  // Find a button whose text is exactly "Delete" or "Yes" inside one of those dialogs
  const confirmBtn = confirmResult.find(b => /^delete$/i.test(b.text)) ||
                     confirmResult.find(b => /^yes$/i.test(b.text)) ||
                     confirmResult.find(b => /delete/i.test(b.text) && !/cancel/i.test(b.text));

  if (confirmBtn) {
    const bx = confirmBtn.rect.x + confirmBtn.rect.w / 2;
    const by = confirmBtn.rect.y + confirmBtn.rect.h / 2;
    console.log('[delete] Clicking confirm at', bx, by, 'text=', confirmBtn.text);
    await page.mouse.click(bx, by);
  } else {
    console.log('[delete] No dialog confirm found; trying Enter');
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(3500);
  await page.screenshot({ path: path.join(__dirname, 'v2-step4-after.png'), fullPage: false });

  // Reload and verify
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);

  const finalState = await page.evaluate((id) => {
    const c = document.querySelector(`shreddit-comment[thingid="${id}"]`);
    if (!c) return { exists: false };
    const author = c.getAttribute('author') || '';
    const body = c.innerText || '';
    return { exists: true, author, body_snippet: body.slice(0, 250) };
  }, COMMENT_FULLNAME);
  console.log('[delete] Final state:', JSON.stringify(finalState));

  await page.screenshot({ path: path.join(__dirname, 'v2-step5-final.png'), fullPage: false });
  await browser.close();

  const deleted = !finalState.exists ||
                  finalState.author === '[deleted]' ||
                  /\[deleted\]|\[removed\]/i.test(finalState.body_snippet);

  fs.writeFileSync(path.join(__dirname, 'delete-result-v2.json'), JSON.stringify({
    deleted, finalState, ts: new Date().toISOString(),
  }, null, 2));

  if (!deleted) {
    console.error('[delete] FAIL — comment still present with original author');
    process.exit(5);
  }
  console.log('[delete] SUCCESS — comment deleted');
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
