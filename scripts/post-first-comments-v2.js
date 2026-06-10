'use strict';

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

const POSTS = [
  { id: 'b4aa1c2f-924b-4aa6-9330-373d897c1b36', group: 'Realtors San Antonio Boerne Bulverde New Braunfels' },
  { id: 'd68ce2f6-f3e9-4dbb-99d5-5f053cf4f315', group: 'Texas Hill Country Real Estate' },
  { id: 'd078e368-1738-4bdc-a2f5-fc1f0fe8399c', group: 'Dallas Texas Realtors' },
  { id: '37faa0aa-dce2-4dfe-bced-48e507eb2d2f', group: 'Texas Real Estate Network' },
];

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

async function fetchPost(postId) {
  const { ok, data } = await supabaseFetch(`/rest/v1/group_posts?id=eq.${postId}&select=id,group_url,first_comment_body`);
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function postComment(page, commentBody) {
  console.log('    Looking for comment input...');
  
  // First, try to find the most recent post on the page
  const posts = await page.locator('[role="article"]').count();
  console.log(`    Found ${posts} articles on page`);
  
  // Click on the first (most recent) post's comment area
  const firstPost = page.locator('[role="article"]').first();
  if (!firstPost) {
    console.log('    No post found');
    return false;
  }

  // Look for comment button or text like "Comment"
  try {
    const commentBtn = firstPost.locator('text="Comment"').first();
    if (await commentBtn.isVisible({ timeout: 5000 })) {
      await commentBtn.click();
      console.log('    Clicked Comment button');
      await page.waitForTimeout(1000);
    }
  } catch (e) {
    console.log('    Comment button not found via text, trying xpath');
  }

  // Now find the comment input box
  const commentBoxSelectors = [
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
    'textarea',
  ];

  let inputFound = false;
  for (const selector of commentBoxSelectors) {
    try {
      const input = page.locator(selector).first();
      if (await input.isVisible({ timeout: 3000 })) {
        console.log(`    Found input via: ${selector}`);
        await input.click();
        await input.fill(commentBody);
        inputFound = true;
        break;
      }
    } catch (e) {
      // Continue
    }
  }

  if (!inputFound) {
    console.log('    Could not find comment input');
    return false;
  }

  // Try to find and click the Post button
  try {
    await page.waitForTimeout(500);
    const postBtn = page.locator('button:has-text("Post")').first();
    if (await postBtn.isVisible({ timeout: 3000 })) {
      await postBtn.click();
      console.log('    Posted comment!');
      await page.waitForTimeout(2000);
      return true;
    }
  } catch (e) {
    console.log('    Post button not found');
    return false;
  }

  return false;
}

async function main() {
  const CHROME_PROFILE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-FirstComments');

  console.log('Starting comment posting...\n');

  let context;
  try {
    // Ensure the profile directory exists
    if (!fs.existsSync(CHROME_PROFILE_PATH)) {
      fs.mkdirSync(CHROME_PROFILE_PATH, { recursive: true });
    }

    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      channel: 'chrome',
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    for (const item of POSTS) {
      const post = await fetchPost(item.id);
      if (!post) {
        console.log(`✗ ${item.group} - post not found in DB`);
        continue;
      }

      console.log(`\nPosting to ${item.group}`);
      console.log(`  Comment: "${post.first_comment_body.substring(0, 60)}..."`);

      const page = await context.newPage();
      
      try {
        console.log(`  Navigating to ${post.group_url}`);
        await page.goto(post.group_url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(2000);

        // Dismiss any dialogs
        try {
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } catch {}

        const success = await postComment(page, post.first_comment_body);
        
        if (success) {
          // Update DB
          await supabaseFetch(`/rest/v1/group_posts?id=eq.${item.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ first_comment_posted_at: new Date().toISOString() }),
          });
          console.log(`  ✓ Database updated`);
        } else {
          console.log(`  ✗ Failed to post`);
        }
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (context) await context.close();
  }

  console.log('\n✅ Done');
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
