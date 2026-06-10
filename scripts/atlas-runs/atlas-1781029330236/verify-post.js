'use strict';

// Verify whether the new comment actually posted on Reddit.

const path = require('path');
const fs = require('fs');

(async () => {
  const { chromium } = require('playwright');
  const sessionPath = path.join(__dirname, '..', '..', 'sessions', 'reddit.json');
  const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();

  // Go to user's own profile -> overview/comments
  console.log('[verify] Loading user profile...');
  await page.goto('https://www.reddit.com/user/Icy_Response3978/comments/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4500);

  await page.screenshot({ path: path.join(__dirname, 'verify-profile.png'), fullPage: false });

  const recent = await page.evaluate(() => {
    // Find shreddit-profile-comment or comment links
    const out = [];
    const links = document.querySelectorAll('a[href*="/r/realtors/comments/"]');
    for (const a of links) {
      const href = a.getAttribute('href');
      if (href && href.includes('/comments/1u0piq6/')) {
        out.push({ href, text: (a.textContent || '').trim().slice(0, 100) });
      }
    }
    // Also try the new format
    const cards = document.querySelectorAll('shreddit-profile-comment, shreddit-post');
    const cardData = [];
    for (const c of cards) {
      cardData.push({
        tag: c.tagName.toLowerCase(),
        permalink: c.getAttribute('permalink') || null,
        body: (c.innerText || '').slice(0, 200),
      });
    }
    return { links: out.slice(0, 5), cards: cardData.slice(0, 5) };
  });
  console.log('[verify] Recent activity:', JSON.stringify(recent, null, 2));

  // Try the post page sorted by NEW
  await page.goto('https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/?sort=new', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(4500);

  const onPost = await page.evaluate(() => {
    // Find ALL comments, looking for our text
    const comments = document.querySelectorAll('shreddit-comment');
    const out = [];
    for (const c of comments) {
      const author = c.getAttribute('author');
      const thingid = c.getAttribute('thingid');
      const permalink = c.getAttribute('permalink');
      const body = (c.innerText || '').slice(0, 250);
      // Check if it's our comment
      if (body.includes('CRM that leads closed') || body.includes('part that hit me hardest')) {
        out.push({ author, thingid, permalink, body, MATCH: true });
      } else if (author === 'Icy_Response3978') {
        out.push({ author, thingid, permalink, body });
      }
    }
    return { count: comments.length, matches: out };
  });
  console.log('[verify] On post page (sort=new):', JSON.stringify(onPost, null, 2));

  await page.screenshot({ path: path.join(__dirname, 'verify-post-page-new.png'), fullPage: false });
  await browser.close();

  fs.writeFileSync(path.join(__dirname, 'verify-result.json'), JSON.stringify({
    profileActivity: recent, postPage: onPost,
  }, null, 2));
})().catch(e => { console.error('ERR', e.stack || e.message); process.exit(1); });
