'use strict';

// Step 1: Delete the existing Reddit comment by navigating Heath's saved
// authenticated Reddit session (which IS his real Chrome login) and clicking
// the "..." menu -> Delete -> confirm.
//
// Comment URL: https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/oqp0xm5/
// Account: Icy_Response3978

const path = require('path');
const fs = require('fs');

const COMMENT_URL = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/oqp0xm5/';

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
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  console.log('[delete] Navigating to comment...');
  await page.goto(COMMENT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  // Confirm we're logged in as Icy_Response3978
  const loggedInAs = await page.evaluate(() => {
    const u = document.querySelector('[data-testid="user-drawer-button"]') ||
              document.querySelector('a[href*="/user/"]');
    return u ? u.getAttribute('href') || u.textContent : null;
  });
  console.log('[delete] Logged-in element:', loggedInAs);

  await page.screenshot({ path: path.join(__dirname, 'delete-step1-loaded.png'), fullPage: false });

  // Find the comment by id oqp0xm5
  // shreddit-comment has thingid attr like "t1_oqp0xm5"
  const commentExists = await page.evaluate(() => {
    const c = document.querySelector('shreddit-comment[thingid="t1_oqp0xm5"]');
    return !!c;
  });
  console.log('[delete] Comment present in DOM:', commentExists);

  if (!commentExists) {
    console.error('[delete] FAIL: comment not in DOM. Maybe wrong URL or filtered.');
    await page.screenshot({ path: path.join(__dirname, 'delete-fail-no-comment.png'), fullPage: true });
    await browser.close();
    process.exit(2);
  }

  // Scroll the comment into view
  await page.evaluate(() => {
    const c = document.querySelector('shreddit-comment[thingid="t1_oqp0xm5"]');
    if (c) c.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(1500);

  // Click the "..." overflow / share-and-actions menu inside the comment.
  // New Reddit shadow DOM — overflow button is inside shreddit-comment-action-row
  console.log('[delete] Looking for overflow menu...');

  const clicked = await page.evaluate(() => {
    const c = document.querySelector('shreddit-comment[thingid="t1_oqp0xm5"]');
    if (!c) return { ok: false, reason: 'no comment' };

    // Drill into shadow trees
    function findButton(root) {
      if (!root) return null;
      const candidates = ['shreddit-overflow-menu', 'button[aria-label*="more options" i]', 'button[aria-label*="overflow" i]', 'faceplate-dropdown-menu button', 'button[aria-haspopup="menu"]'];
      for (const sel of candidates) {
        try {
          const el = root.querySelector(sel);
          if (el) return el;
        } catch {}
      }
      // Recurse into shadow roots
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          const found = findButton(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    }

    const btn = findButton(c);
    if (!btn) return { ok: false, reason: 'overflow button not found' };
    btn.click();
    return { ok: true, tag: btn.tagName, aria: btn.getAttribute('aria-label') };
  });
  console.log('[delete] Overflow click result:', JSON.stringify(clicked));

  if (!clicked.ok) {
    await page.screenshot({ path: path.join(__dirname, 'delete-fail-no-overflow.png'), fullPage: true });
    await browser.close();
    process.exit(3);
  }

  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'delete-step2-menu-open.png'), fullPage: false });

  // Click the Delete menu item
  const deleteClicked = await page.evaluate(() => {
    // Search ALL menu/listbox items including shadow roots
    function findDelete(root) {
      if (!root) return null;
      const items = root.querySelectorAll('button, a, [role="menuitem"], li');
      for (const el of items) {
        const txt = (el.textContent || '').trim().toLowerCase();
        if (txt === 'delete' || txt.startsWith('delete')) {
          // Make sure it's not "Delete drafts" or other
          if (txt === 'delete' || txt === 'delete comment' || txt === 'delete…') {
            return el;
          }
        }
      }
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          const f = findDelete(el.shadowRoot);
          if (f) return f;
        }
      }
      return null;
    }
    const d = findDelete(document);
    if (!d) return { ok: false };
    d.click();
    return { ok: true, txt: d.textContent.trim() };
  });
  console.log('[delete] Delete click result:', JSON.stringify(deleteClicked));

  if (!deleteClicked.ok) {
    await page.screenshot({ path: path.join(__dirname, 'delete-fail-no-delete-item.png'), fullPage: true });
    await browser.close();
    process.exit(4);
  }

  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(__dirname, 'delete-step3-confirm.png'), fullPage: false });

  // Confirm dialog: click "Delete" or "Yes" or confirm button
  const confirmClicked = await page.evaluate(() => {
    function findConfirm(root) {
      if (!root) return null;
      const buttons = root.querySelectorAll('button, [role="button"]');
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'delete' || t === 'yes' || t === 'confirm' || t === 'delete comment') {
          // Heuristic: must be inside a dialog/modal — body has aria-hidden or role=dialog ancestor
          let p = b.parentElement;
          let inDialog = false;
          while (p) {
            const role = (p.getAttribute && p.getAttribute('role')) || '';
            if (role === 'dialog' || role === 'alertdialog' || (p.tagName && p.tagName.toLowerCase().includes('modal'))) {
              inDialog = true; break;
            }
            p = p.parentElement;
          }
          if (inDialog) return b;
        }
      }
      const all = root.querySelectorAll('*');
      for (const el of all) {
        if (el.shadowRoot) {
          const f = findConfirm(el.shadowRoot);
          if (f) return f;
        }
      }
      return null;
    }
    const c = findConfirm(document);
    if (!c) return { ok: false };
    c.click();
    return { ok: true, txt: c.textContent.trim() };
  });
  console.log('[delete] Confirm click result:', JSON.stringify(confirmClicked));

  if (!confirmClicked.ok) {
    // Some Reddit flows auto-confirm — try keyboard Enter as fallback
    console.log('[delete] No confirm dialog found, pressing Enter as fallback...');
    await page.keyboard.press('Enter');
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(__dirname, 'delete-step4-after.png'), fullPage: false });

  // Verify: reload, check if comment shows "[deleted]" or vanished
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  const afterState = await page.evaluate(() => {
    const c = document.querySelector('shreddit-comment[thingid="t1_oqp0xm5"]');
    if (!c) return { exists: false };
    const author = c.getAttribute('author') || '';
    const body = c.innerText || '';
    return { exists: true, author, body_snippet: body.slice(0, 200) };
  });
  console.log('[delete] Final state:', JSON.stringify(afterState));

  await page.screenshot({ path: path.join(__dirname, 'delete-step5-verified.png'), fullPage: false });

  await browser.close();

  // Success criteria: comment still exists but author is empty/[deleted] OR body says [removed]/[deleted]
  const deleted = !afterState.exists ||
                  afterState.author === '[deleted]' ||
                  /\[deleted\]|\[removed\]/i.test(afterState.body_snippet);

  fs.writeFileSync(path.join(__dirname, 'delete-result.json'), JSON.stringify({
    deleted, afterState, deleted_at: new Date().toISOString(),
  }, null, 2));

  if (!deleted) {
    console.error('[delete] FAIL: comment not deleted');
    process.exit(5);
  }
  console.log('[delete] SUCCESS');
})().catch(e => { console.error('FATAL', e.stack || e.message); process.exit(1); });
