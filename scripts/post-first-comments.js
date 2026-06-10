'use strict';

// Post first_comment_body as comments on group_posts that have been posted
// but don't have first comments yet.
//
// Usage:
//   node scripts/post-first-comments.js
//
// Queries group_posts where status='posted' and first_comment_body IS NOT NULL
// and first_comment_url IS NULL. For each, navigates to the group, finds the
// most recent post, and posts the first comment.

const path = require('path');
const os = require('os');
const fs = require('fs');
const { chromium } = require('playwright');

// Load .env.local
try {
  const envPath = path.join(__dirname, '..', '.env.local');
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
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHROME_PROFILE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-Sage');
const PLAYWRIGHT_PROFILE_NAME = 'Default';

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchPostsNeedingComments() {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?status=eq.posted&first_comment_body=not.is.null&first_comment_url=is.null&select=id,group_url,first_comment_body,posted_at&order=posted_at.desc`
  );
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function postComment(page, commentBody) {
  // Wait for page load
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // Click on comment input or use the visible comment composer
  try {
    const commentBox = await page.locator('[contenteditable="true"]').first();
    if (commentBox) {
      await commentBox.click();
      await page.keyboard.type(commentBody, { delay: 20 });
    }
  } catch (e) {
    console.log('  Could not find comment box via contenteditable, trying alternative...');
    // Fallback: find comment input by aria-label
    try {
      const writeCommentBtn = await page.locator('button:has-text("Comment")').first();
      if (writeCommentBtn) {
        await writeCommentBtn.click();
        await page.waitForTimeout(500);
        const input = await page.locator('textarea').first();
        await input.fill(commentBody);
      }
    } catch (e2) {
      console.log('  Failed to post comment:', e2.message);
      return false;
    }
  }

  // Submit comment
  try {
    const submitBtn = await page.locator('button:has-text("Post")').first();
    if (submitBtn) {
      await submitBtn.click();
      await page.waitForTimeout(2000);
      return true;
    }
  } catch (e) {
    console.log('  Could not find submit button');
    return false;
  }
  
  return false;
}

async function main() {
  const posts = await fetchPostsNeedingComments();
  
  if (!posts.length) {
    console.log('✅ No posts need first comments.');
    process.exit(0);
  }

  console.log(`Found ${posts.length} post(s) needing first comments.\n`);

  let browser;
  try {
    browser = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    for (const post of posts) {
      console.log(`Posting comment on ${post.group_url}`);
      const page = await browser.newPage();
      
      try {
        await page.goto(post.group_url, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(1000);

        // Scroll down to find the most recent post
        await page.evaluate(() => {
          window.scrollBy(0, window.innerHeight);
        });
        await page.waitForTimeout(1000);

        // Try to post the comment
        const success = await postComment(page, post.first_comment_body);
        
        if (success) {
          console.log(`  ✓ Comment posted`);
          // Update DB
          await supabaseFetch(`/rest/v1/group_posts?id=eq.${post.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ first_comment_posted_at: new Date().toISOString() }),
          });
        } else {
          console.log(`  ✗ Failed to post comment`);
        }
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n✅ Done');
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
