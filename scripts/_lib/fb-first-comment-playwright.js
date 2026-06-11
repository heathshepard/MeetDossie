'use strict';

/*
 * scripts/_lib/fb-first-comment-playwright.js
 *
 * Playwright-based first-comment attacher. Called as a subprocess from
 * scripts/atlas-fb-first-comment-v2.py (which is the entry point the
 * auto-attach scheduled task / atlas-fb-first-comments-blitz-v2.js expect).
 *
 * Why Playwright + DossieBot-Sage profile instead of PyAutoGUI on Heath's
 * main Chrome (the prior strategy)?
 *
 *   - Heath's main Chrome is NOT logged into Facebook (confirmed 2026-06-11
 *     via screenshot: every previous run hit FB's "See more on Facebook"
 *     login wall and failed at needle-search).
 *   - DossieBot-Sage profile IS logged in (it's the profile fb-group-poster.js
 *     uses to publish the parent posts in the first place).
 *   - Playwright with persistent context gives us reliable DOM access for
 *     `[role="article"]` scanning, which is more reliable than UIA on the
 *     blurry FB DOM.
 *
 * CLI:
 *   node scripts/_lib/fb-first-comment-playwright.js \
 *     --group-url <url> --needle <substr> --comment-file <path> \
 *     --post-id <uuid> --label <label> --run-dir <abs path>
 *
 * Output: single line `PWFC_RESULT_JSON:{...}` on stdout.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2);
      out[k] = a[i + 1];
      i++;
    }
  }
  return out;
}

async function snap(page, runDir, name) {
  try {
    await page.screenshot({ path: path.join(runDir, name), fullPage: false });
  } catch {}
}

async function locatePost(page, needle) {
  // FB posts are role=article. Look for one whose text contains the needle.
  // We do this with page.evaluate so we don't pay locator round-trip cost
  // per article.
  return await page.evaluate((n) => {
    const articles = Array.from(document.querySelectorAll('[role="article"]'));
    const needleLower = n.toLowerCase();
    for (let i = 0; i < articles.length; i++) {
      const txt = (articles[i].innerText || '').toLowerCase();
      if (txt.includes(needleLower)) {
        const r = articles[i].getBoundingClientRect();
        // Tag the matching article with a data attr so the locator can grab it
        articles[i].setAttribute('data-atlas-first-comment-target', '1');
        return {
          index: i,
          totalArticles: articles.length,
          rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        };
      }
    }
    return { index: -1, totalArticles: articles.length, rect: null };
  }, needle);
}

async function scrollAndLocate(page, needle, maxSteps = 25) {
  for (let step = 0; step <= maxSteps; step++) {
    const hit = await locatePost(page, needle);
    console.log(`[pwfc] step ${step}: needle '${needle.slice(0, 40)}' -> ${hit.totalArticles} articles, match=${hit.index >= 0}`);
    if (hit.index >= 0) return hit;
    // Scroll the window down a chunk to load more articles.
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
    await page.waitForTimeout(900);
  }
  return { index: -1, totalArticles: -1, rect: null };
}

async function clickCommentButton(page) {
  // The matched article has data-atlas-first-comment-target=1. Find a
  // Comment button (FB renders aria-label="Comment" or aria-label="Leave a
  // comment" depending on locale and feed type) inside it. Fall back to a
  // role=button with text "Comment".
  const clicked = await page.evaluate(() => {
    const post = document.querySelector('[data-atlas-first-comment-target="1"]');
    if (!post) return { ok: false, reason: 'no_post_marker' };

    // Scroll the post into view so the Comment button is clickable.
    post.scrollIntoView({ block: 'center', behavior: 'instant' });

    const candidates = post.querySelectorAll(
      '[aria-label="Comment"],[aria-label="Leave a comment"],[role="button"][aria-label*="omment"]'
    );
    for (const c of candidates) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        c.click();
        return { ok: true, label: c.getAttribute('aria-label') || c.innerText.slice(0, 40) };
      }
    }
    // Fallback: scan for role=button with text "Comment"
    const btns = post.querySelectorAll('[role="button"]');
    for (const b of btns) {
      const t = (b.innerText || '').trim();
      if (t === 'Comment' || t === 'Comments') {
        b.click();
        return { ok: true, label: t };
      }
    }
    return { ok: false, reason: 'no_comment_button' };
  });
  return clicked;
}

async function typeAndSubmit(page, body) {
  // After clicking Comment, FB renders an inline contenteditable composer
  // somewhere in the DOM. Find a visible contenteditable inside or near the
  // target post and type into it.
  const composer = await page.evaluate(() => {
    const post = document.querySelector('[data-atlas-first-comment-target="1"]');
    let candidates = [];
    if (post) {
      candidates = Array.from(post.querySelectorAll('[contenteditable="true"][role="textbox"]'));
    }
    if (!candidates.length) {
      candidates = Array.from(document.querySelectorAll('[contenteditable="true"][role="textbox"]'));
    }
    for (const c of candidates) {
      const r = c.getBoundingClientRect();
      if (r.width > 100 && r.height > 10) {
        c.setAttribute('data-atlas-composer', '1');
        return { ok: true, rect: { x: r.x, y: r.y, w: r.width, h: r.height } };
      }
    }
    return { ok: false };
  });
  if (!composer.ok) return { ok: false, stage: 'composer_unclickable' };

  const composerEl = page.locator('[data-atlas-composer="1"]').first();
  try {
    await composerEl.click({ timeout: 5000 });
  } catch (e) {
    return { ok: false, stage: 'composer_unclickable', err: e.message };
  }

  // Type the body. Use keyboard.type so FB's React listeners fire (insertText
  // events). insertText keeps newlines without submitting.
  // For multi-line bodies, replace newlines with Shift+Enter so Enter at end
  // still submits.
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      await page.keyboard.down('Shift');
      await page.keyboard.press('Enter');
      await page.keyboard.up('Shift');
    }
    await page.keyboard.type(lines[i], { delay: 8 });
  }
  await page.waitForTimeout(800);

  // Verify text landed in composer
  const composerText = await composerEl.evaluate((el) => (el.innerText || '').trim());
  const head = body.trim().slice(0, 40).toLowerCase();
  if (!composerText.toLowerCase().includes(head.slice(0, 25))) {
    return { ok: false, stage: 'paste_failed', composerText: composerText.slice(0, 80) };
  }

  // Submit with Enter (FB inline comment composer submits on plain Enter;
  // Shift+Enter inserts newline, which we already handled above).
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3500);

  // Verify submission: composer should be reset (empty or placeholder).
  const afterText = await composerEl.evaluate((el) => (el.innerText || '').trim());
  if (afterText.length < 30) {
    return { ok: true, how: 'enter' };
  }

  // Fallback: Ctrl+Enter
  await page.keyboard.press('Control+Enter');
  await page.waitForTimeout(3500);
  const after2 = await composerEl.evaluate((el) => (el.innerText || '').trim());
  if (after2.length < 30) {
    return { ok: true, how: 'ctrl_enter' };
  }
  return { ok: false, stage: 'submit_failed', residual: after2.slice(0, 80) };
}

async function findCommentPermalink(page) {
  // After submit, the just-posted comment's permalink appears as a link with
  // text like "Just now" or "1m". Try to grab the first such href.
  return await page.evaluate(() => {
    const post = document.querySelector('[data-atlas-first-comment-target="1"]');
    if (!post) return null;
    const anchors = post.querySelectorAll('a[href*="comment_id="]');
    for (const a of anchors) {
      if (a.href) return a.href;
    }
    return null;
  });
}

async function main() {
  const args = parseArgs();
  const groupUrl = args['group-url'];
  const needle = args['needle'];
  const commentFile = args['comment-file'];
  const postId = args['post-id'];
  const label = args['label'] || 'first-comment';
  const runDir = args['run-dir'];
  if (!groupUrl || !needle || !commentFile || !runDir) {
    console.error('Missing required args');
    process.exit(2);
  }

  const body = fs.readFileSync(commentFile, 'utf8');
  const chronoUrl = groupUrl.replace(/\/$/, '') + '/?sorting_setting=CHRONOLOGICAL';
  const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-Sage');

  const result = {
    ts: new Date().toISOString(),
    group_url: groupUrl,
    needle,
    post_id: postId,
    label,
    run_dir: runDir,
    steps: [],
    outcome: null,
    reason: null,
    comment_preview: body.slice(0, 120),
  };

  function finish(outcome, reason) {
    result.outcome = outcome;
    result.reason = reason || null;
    try {
      fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
    } catch {}
    console.log('PWFC_RESULT_JSON:' + JSON.stringify(result));
    process.exit(0);
  }

  let context;
  try {
    const { chromium } = require('playwright');
    context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      channel: 'chrome',
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
      ],
      viewport: { width: 1280, height: 900 },
    });
    result.steps.push('context_launched');

    const page = await context.newPage();

    // Strategy: navigate directly to Heath's posts within this group. FB has
    // a stable URL pattern: groups/<slug>/user/<userId>/ that shows only
    // posts authored by user <userId>. This is FAR more reliable than:
    //   - /search/posts/?q=... (404s - not a public route)
    //   - /search/?q=... (FB search rarely indexes new posts)
    //   - chronological feed (FB reorders, buries posts >1h old)
    //
    // We then scroll until we find the article whose text contains the
    // needle from Sage's needle map.
    const HEATH_FB_USER_ID = process.env.HEATH_FB_USER_ID || '100013958371623';
    const userPostsUrl = groupUrl.replace(/\/$/, '') + `/user/${HEATH_FB_USER_ID}/`;
    console.log(`[pwfc] nav user posts: ${userPostsUrl}`);
    await page.goto(userPostsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);
    result.steps.push('nav_user_posts');

    let url = page.url();
    if (url.includes('login') || url.includes('checkpoint')) {
      await snap(page, runDir, '02-login-wall.png');
      finish('login_required', `DossieBot-Sage profile redirected to login: ${url}`);
    }
    try { await page.keyboard.press('Escape'); } catch {}
    await snap(page, runDir, '02-user-posts-loaded.png');

    let hit = await scrollAndLocate(page, needle, 15);

    if (hit.index < 0) {
      console.log('[pwfc] user-posts view returned no match, falling back to chronological feed');
      await page.goto(chronoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      result.steps.push('nav_chronological');
      try { await page.keyboard.press('Escape'); } catch {}
      await snap(page, runDir, '02b-chrono-loaded.png');
      hit = await scrollAndLocate(page, needle, 30);
    }
    if (hit.index < 0) {
      await snap(page, runDir, '03-not-found.png');
      finish('needle_not_found',
        `needle not found in ${hit.totalArticles} articles after scrolls`);
    }
    result.steps.push(`post_index=${hit.index}/${hit.totalArticles}`);
    await snap(page, runDir, '03-found.png');

    const clicked = await clickCommentButton(page);
    if (!clicked.ok) {
      await snap(page, runDir, '04-no-comment-btn.png');
      finish('comment_button_missing', clicked.reason || 'no_button');
    }
    result.steps.push(`clicked_comment=${clicked.label || ''}`);
    await page.waitForTimeout(1500);
    await snap(page, runDir, '04-after-comment-click.png');

    const submitted = await typeAndSubmit(page, body);
    if (!submitted.ok) {
      await snap(page, runDir, '07-submit-failed.png');
      finish(submitted.stage || 'submit_failed', JSON.stringify(submitted));
    }
    result.steps.push(`submitted_via=${submitted.how}`);
    await snap(page, runDir, '07-after-submit.png');

    const permalink = await findCommentPermalink(page);
    if (permalink) {
      result.first_comment_url = permalink;
      result.steps.push('permalink_captured');
    }

    await page.waitForTimeout(1500);
    await snap(page, runDir, '08-final.png');
    finish('posted');
  } catch (e) {
    result.steps.push(`exception=${e.message}`);
    finish('exception', e.stack || e.message);
  } finally {
    try { if (context) await context.close(); } catch {}
  }
}

main();
