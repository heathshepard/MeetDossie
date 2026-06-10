'use strict';

// V3 — deep menu inspection with full shadow-tree text search.

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

  page.on('dialog', async (dialog) => {
    console.log('[delete] Native dialog:', dialog.type(), dialog.message());
    await dialog.accept();
  });

  await page.goto(COMMENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Scroll to the target
  await page.evaluate((id) => {
    const c = document.querySelector(`shreddit-comment[thingid="${id}"]`);
    if (c) c.scrollIntoView({ block: 'center' });
  }, COMMENT_FULLNAME);
  await page.waitForTimeout(1200);

  // Click overflow menu inside this specific comment
  const probe = await page.evaluate((id) => {
    const c = document.querySelector(`shreddit-comment[thingid="${id}"]`);
    if (!c) return { err: 'no comment' };
    const overflow = c.querySelector('shreddit-overflow-menu');
    if (!overflow) return { err: 'no overflow' };
    const r = overflow.getBoundingClientRect();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
  }, COMMENT_FULLNAME);

  if (probe.err) {
    console.error('[delete] FAIL', probe.err);
    await browser.close();
    process.exit(2);
  }

  // Click using coordinates
  await page.mouse.click(probe.rect.x + probe.rect.w / 2, probe.rect.y + probe.rect.h / 2);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v3-step2-menu.png'), fullPage: false });

  // Find Delete in any visible menu item — walk ALL shadow roots, find ALL text
  const deleteInfo = await page.evaluate(() => {
    const visible = [];
    function walk(root, depth = 0) {
      if (depth > 8 || !root) return;
      const items = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of items) {
        try {
          const txt = (el.textContent || '').trim();
          const r = el.getBoundingClientRect();
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          if (r.width > 5 && r.height > 5 && /^delete$|^delete comment$|^delete\.\.\.$/i.test(txt) &&
              (tag === 'button' || tag === 'li' || tag === 'a' || el.getAttribute('role') === 'menuitem' ||
               tag.startsWith('faceplate'))) {
            visible.push({
              tag, txt, role: el.getAttribute('role') || null,
              rect: { x: r.x, y: r.y, w: r.width, h: r.height },
            });
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(document);
    return visible;
  });
  console.log('[delete] Delete candidates count:', deleteInfo.length);
  console.log('[delete] First 5:', JSON.stringify(deleteInfo.slice(0, 5), null, 2));

  if (deleteInfo.length === 0) {
    // Fallback: dump ALL menuitems
    const allMenu = await page.evaluate(() => {
      const items = [];
      function walk(root, depth = 0) {
        if (depth > 8 || !root) return;
        const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
        for (const el of all) {
          try {
            const r = el.getBoundingClientRect();
            const tag = el.tagName ? el.tagName.toLowerCase() : '';
            const role = el.getAttribute && el.getAttribute('role');
            if (r.width > 5 && r.height > 5 &&
                (role === 'menuitem' || tag === 'faceplate-menu-item' || tag === 'faceplate-tracker' ||
                 (tag === 'li' && el.parentElement && (el.parentElement.tagName || '').toLowerCase().includes('menu')))) {
              const txt = (el.textContent || '').trim().slice(0, 80);
              items.push({ tag, txt, role, rect: { x: r.x, y: r.y, w: r.width, h: r.height } });
            }
            if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
          } catch {}
        }
      }
      walk(document);
      return items;
    });
    console.log('[delete] All menu items in DOM:', JSON.stringify(allMenu, null, 2));
    await page.screenshot({ path: path.join(__dirname, 'v3-fail-no-delete.png'), fullPage: true });
    await browser.close();
    process.exit(3);
  }

  // Click the Delete item with the smallest y > overflow y (i.e. closest beneath the overflow)
  const candidates = deleteInfo.filter(d => d.rect.y > probe.rect.y - 100);
  const target = (candidates[0] || deleteInfo[0]);
  const dx = target.rect.x + target.rect.w / 2;
  const dy = target.rect.y + target.rect.h / 2;
  console.log('[delete] Clicking Delete at', dx, dy);
  await page.mouse.click(dx, dy);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(__dirname, 'v3-step3-confirm.png'), fullPage: false });

  // Confirm dialog discovery
  const dialogs = await page.evaluate(() => {
    const out = [];
    function walk(root, depth = 0) {
      if (depth > 6 || !root) return;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        try {
          const tag = el.tagName ? el.tagName.toLowerCase() : '';
          const role = el.getAttribute && el.getAttribute('role');
          if (role === 'dialog' || role === 'alertdialog' || tag === 'shreddit-modal' ||
              tag === 'faceplate-dialog' || tag.includes('modal') || tag.includes('dialog')) {
            const r = el.getBoundingClientRect();
            if (r.width > 50) {
              // Find buttons inside
              const btns = [];
              const subBtns = el.querySelectorAll('button, [role="button"], faceplate-button');
              for (const b of subBtns) {
                const t = (b.textContent || '').trim();
                const br = b.getBoundingClientRect();
                if (br.width > 0 && br.height > 0) {
                  btns.push({ tag: b.tagName.toLowerCase(), txt: t.slice(0, 40), rect: { x: br.x, y: br.y, w: br.width, h: br.height } });
                }
              }
              out.push({ tag, role, rect: { x: r.x, y: r.y, w: r.width, h: r.height }, buttons: btns });
            }
          }
          if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
        } catch {}
      }
    }
    walk(document);
    return out;
  });
  console.log('[delete] Dialogs:', JSON.stringify(dialogs, null, 2).slice(0, 2000));

  // Find a confirm button
  let confirmBtn = null;
  for (const d of dialogs) {
    for (const b of d.buttons) {
      if (/^delete$/i.test(b.txt) || /^yes$/i.test(b.txt) || /^confirm$/i.test(b.txt)) {
        confirmBtn = b;
        break;
      }
    }
    if (confirmBtn) break;
  }

  if (confirmBtn) {
    const bx = confirmBtn.rect.x + confirmBtn.rect.w / 2;
    const by = confirmBtn.rect.y + confirmBtn.rect.h / 2;
    console.log('[delete] Confirm click at', bx, by, 'text=', confirmBtn.txt);
    await page.mouse.click(bx, by);
  } else if (dialogs.length === 0) {
    // Reddit may not show a confirm dialog at all on new UI — deletion may happen on click
    console.log('[delete] No dialog appeared — assuming delete fired immediately');
  } else {
    console.log('[delete] Dialog appeared but no confirm button matched. Pressing Enter as fallback.');
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(__dirname, 'v3-step4-after.png'), fullPage: false });

  // Verify via reload
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

  await page.screenshot({ path: path.join(__dirname, 'v3-step5-final.png'), fullPage: false });
  await browser.close();

  const deleted = !finalState.exists ||
                  finalState.author === '[deleted]' ||
                  /\[deleted\]|\[removed\]/i.test(finalState.body_snippet);

  fs.writeFileSync(path.join(__dirname, 'delete-result-v3.json'), JSON.stringify({
    deleted, finalState, ts: new Date().toISOString(),
  }, null, 2));

  if (!deleted) {
    console.error('[delete] FAIL');
    process.exit(5);
  }
  console.log('[delete] SUCCESS');
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
