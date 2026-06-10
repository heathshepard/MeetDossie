'use strict';

// scripts/sage-fb-scan-mission.js
//
// One-shot mission scanner used by Sage. Scans a curated list of high-value FB
// groups (Ginger Unger first, then Texas RE agent groups) using the DossieBot
// persistent Chrome profile. Pulls ALL recent posts with text >= 60 chars
// (broader than the keyword-only commenter) and writes results to a JSON file
// so Sage can pick the best target post manually.
//
// Why a custom script:
//   - fb-lead-scraper.js / fb-group-commenter.js only match narrow TC keywords.
//   - Mission needs ANY high-leverage post (deal stress, contract questions,
//     deadline confusion, TC pain, anything Dossie helps with).
//   - This script casts a wider net; Sage filters intelligence-side.
//
// Usage:
//   node scripts/sage-fb-scan-mission.js
//
// Output:
//   scripts/.sage-fb-mission-results.json  (array of {group, author, text,
//   url, len, score})
//
// Profile: requires DossieBot Chrome profile (Profile 4) NOT to be open.

const path = require('path');
const os = require('os');
const fs = require('fs');

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
} catch (e) { /* non-fatal */ }

// Use isolated copy of DossieBot profile so we don't collide with Heath's
// running Chrome (which locks the main User Data dir).
const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.SAGE_PROFILE_NAME || 'Default';

const RESULTS_FILE = path.join(__dirname, '.sage-fb-mission-results.json');

// Ordered by leverage: Ginger first (highest), then Texas RE agent groups.
const GROUPS = [
  { name: 'Ginger Unger - Real Estate Instructor', url: 'https://www.facebook.com/groups/gingerungerinstructor/', priority: 10 },
  { name: 'Texas Realtors & Lenders', url: 'https://www.facebook.com/groups/texasrealtorsandlenders/', priority: 8 },
  { name: 'San Antonio Real Estate Agent Forum', url: 'https://www.facebook.com/groups/sanantoniorealestateforum/', priority: 8 },
  { name: 'Real Estate Agents Mastermind Group', url: 'https://www.facebook.com/groups/realestateagentsmastermind/', priority: 7 },
  { name: 'The Giving Agents - Referral Network and Mastermind', url: 'https://www.facebook.com/groups/thegivingagents/', priority: 7 },
  { name: 'Greater Houston Area Realtors', url: 'https://www.facebook.com/groups/houstonarearealtors/', priority: 6 },
];

// Signal keywords (broad — agent pain, transactions, deadlines, contracts, TC).
const SIGNAL_KEYWORDS = [
  // Direct TC pain
  'transaction coordinator', ' tc ', 'my tc', 'tc quit', 'looking for a tc', 'hire a tc', 'need a tc',
  // Deal/file overwhelm
  'overwhelmed', 'too many files', 'behind on paperwork', "can't keep up", 'juggling',
  // Deadline/contract pain
  'option period', 'option fee', 'option deadline', 'trec form', 'trec deadline', 'effective date',
  'amendment', 'addendum', 'termination', 'execute the contract', 'executed contract',
  // Title/escrow/follow-up
  'title company', 'escrow', 'follow up', 'follow-up', 'reminders', 'follow ups',
  // Process/system pain
  'system for', 'how do you', 'how do y\'all', 'how do you all', 'what do you use', 'recommend a',
  'best app for', 'best tool for', 'best system for', 'workflow', 'transaction management',
  'fell through', 'lost a deal', 'almost missed', 'forgot to', 'dropped the ball',
  // Texas-specific
  'trec', 'texas realtor', 'tx realtor', 'texas agent',
];

function scorePost(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of SIGNAL_KEYWORDS) {
    if (lower.includes(kw)) score += 1;
  }
  // Bonus for length (longer post = more context = better target)
  if (text.length > 200) score += 1;
  if (text.length > 400) score += 1;
  // Bonus for question marks (asking for help)
  if (text.includes('?')) score += 2;
  return score;
}

async function scanGroup(page, group, allResults) {
  console.log(`[sage-fb-scan] Scanning ${group.name}`);
  try {
    await page.goto(group.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
  } catch (e) {
    console.warn(`[sage-fb-scan] Navigation failed: ${e.message}`);
    return;
  }

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    console.warn(`[sage-fb-scan] LOGIN WALL on ${group.name} — DossieBot profile not logged in?`);
    return;
  }

  // Wait a bit for posts to populate
  await page.waitForTimeout(3000);

  // Scroll to load more posts
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => window.scrollBy(0, 1500));
    await page.waitForTimeout(1500);
  }

  // Extract all posts on the page
  const posts = await page.evaluate(() => {
    const results = [];
    const articles = document.querySelectorAll('div[role="article"]');
    for (const article of articles) {
      const text = (article.innerText || '').trim();
      if (text.length < 60) continue;

      let postUrl = null;
      const links = article.querySelectorAll('a[href*="/groups/"]');
      for (const link of links) {
        const href = link.getAttribute('href');
        if (href && /\/groups\/[^/]+\/posts\/\d+/.test(href)) {
          postUrl = href.startsWith('http') ? href : `https://www.facebook.com${href}`;
          postUrl = postUrl.split('?')[0];
          break;
        }
      }

      let authorName = '';
      const nameEl = article.querySelector('h3 a, h4 a, strong a');
      if (nameEl) authorName = (nameEl.innerText || '').trim();

      results.push({
        text: text.slice(0, 1500),
        url: postUrl,
        author: authorName,
      });
    }
    return results;
  });

  console.log(`[sage-fb-scan] Found ${posts.length} posts in ${group.name}`);

  // Dedupe within this scan, score, push to results
  const seen = new Set();
  for (const post of posts) {
    const key = post.url || post.text.slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);

    const score = scorePost(post.text);
    allResults.push({
      group: group.name,
      groupPriority: group.priority,
      author: post.author,
      text: post.text,
      url: post.url,
      length: post.text.length,
      score,
    });
  }
}

async function main() {
  console.log('[sage-fb-scan] Mission start — scanning high-leverage FB groups');

  const { chromium } = require('playwright');
  console.log(`[sage-fb-scan] Launching DossieBot profile (${PLAYWRIGHT_PROFILE_NAME})`);

  let context;
  try {
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-blink-features=AutomationControlled',
        `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
      ],
      viewport: { width: 1280, height: 900 },
      channel: 'chrome',
    });
  } catch (e) {
    console.error(`[sage-fb-scan] FAILED to launch persistent context: ${e.message}`);
    console.error('[sage-fb-scan] Likely cause: DossieBot Chrome window is open. Close it and re-run.');
    process.exit(1);
  }

  const page = await context.newPage();
  const allResults = [];

  try {
    for (const group of GROUPS) {
      try {
        await scanGroup(page, group, allResults);
      } catch (err) {
        console.warn(`[sage-fb-scan] Error scanning ${group.name}: ${err.message}`);
      }
      // Pause between groups so we don't look bot-like
      await page.waitForTimeout(2500);
    }
  } finally {
    try { await context.close(); } catch { /* ignore */ }
  }

  // Sort by score * groupPriority (highest leverage first)
  allResults.sort((a, b) => (b.score * (b.groupPriority || 1)) - (a.score * (a.groupPriority || 1)));

  // Filter out anything score 0 (no signal at all)
  const scored = allResults.filter(r => r.score > 0);

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(allResults, null, 2), 'utf8');

  console.log(`\n[sage-fb-scan] Scanned ${GROUPS.length} groups, captured ${allResults.length} posts, ${scored.length} with signal.`);
  console.log(`[sage-fb-scan] Results written to ${RESULTS_FILE}`);

  if (scored.length === 0) {
    console.log('[sage-fb-scan] NO SIGNAL POSTS FOUND. Top 5 posts by raw priority follow for manual review:\n');
    allResults.slice(0, 5).forEach((r, i) => {
      console.log(`--- #${i + 1} (group=${r.group}, score=${r.score}, len=${r.length}) ---`);
      console.log(`Author: ${r.author}`);
      console.log(`URL: ${r.url || '(no URL)'}`);
      console.log(`Text: ${r.text.slice(0, 400)}`);
      console.log('');
    });
  } else {
    console.log('\n[sage-fb-scan] TOP 10 SIGNAL POSTS:\n');
    scored.slice(0, 10).forEach((r, i) => {
      console.log(`--- #${i + 1} score=${r.score} group=${r.group} ---`);
      console.log(`Author: ${r.author}`);
      console.log(`URL: ${r.url || '(no URL)'}`);
      console.log(`Text: ${r.text.slice(0, 500)}`);
      console.log('');
    });
  }
}

main().catch(err => {
  console.error('[sage-fb-scan] FATAL:', err.message);
  process.exit(1);
});
