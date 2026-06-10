'use strict';

// Fetch the OP body from Reddit using the saved session.
const path = require('path');
const fs = require('fs');

(async () => {
  const { chromium } = require('playwright');
  const sessionPath = path.join(__dirname, '..', '..', 'sessions', 'reddit.json');
  const state = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: state,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  });

  const page = await context.newPage();
  const url = 'https://www.reddit.com/r/realtors/comments/1u0piq6/why_am_i_losing_leads_clients/';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wait for the post element
  await page.waitForTimeout(3000);

  const data = await page.evaluate(() => {
    const post = document.querySelector('shreddit-post');
    if (!post) return { err: 'no shreddit-post element' };

    const title = post.getAttribute('post-title') || document.title;
    const author = post.getAttribute('author');
    const subreddit = post.getAttribute('subreddit-name');
    const score = post.getAttribute('score');
    const num_comments = post.getAttribute('comment-count');
    const created = post.getAttribute('created-timestamp');

    // Body text — try multiple selectors
    let body = '';
    const tm = post.querySelector('[slot="text-body"]') || post.querySelector('.md, [data-post-click-location="text-body"]');
    if (tm) body = tm.innerText.trim();

    return { title, author, subreddit, score, num_comments, created, body };
  });

  console.log(JSON.stringify(data, null, 2));

  fs.writeFileSync(path.join(__dirname, 'op-content.json'), JSON.stringify(data, null, 2));

  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
