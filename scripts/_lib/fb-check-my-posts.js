'use strict';

/*
 * Quick check: for each of the 4 failed first-comment groups, navigate to
 * Heath's posts-in-group page and screenshot the result. Tells us whether
 * the parent post actually went live or was silently rejected by FB.
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const TARGETS = [
  { label: 'texas-real-estate-agents', groupUrl: 'https://www.facebook.com/groups/texasusarealestateagents/' },
  { label: 'texas-real-estate-network', groupUrl: 'https://www.facebook.com/groups/texasrealestategroup/' },
  { label: 'all-about-real-estate-houston', groupUrl: 'https://www.facebook.com/groups/1649764785300053/' },
  { label: 'realtors-san-antonio-boerne', groupUrl: 'https://www.facebook.com/groups/752142151598217/' },
];

const HEATH = '100013958371623';
const OUT_DIR = path.join(__dirname, '..', 'atlas-runs', 'first-comment-retry-2026-06-11');
fs.mkdirSync(OUT_DIR, { recursive: true });

(async () => {
  const { chromium } = require('playwright');
  const profileDir = path.join(os.homedir(), 'AppData', 'Local', 'DossieBot-Sage');
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
  });
  const findings = [];
  try {
    for (const t of TARGETS) {
      const page = await ctx.newPage();
      const url = t.groupUrl.replace(/\/$/, '') + `/user/${HEATH}/`;
      console.log(`\n${t.label}: ${url}`);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(4500);
        await page.keyboard.press('Escape').catch(() => {});
        const shotPath = path.join(OUT_DIR, `${t.label}-my-posts.png`);
        await page.screenshot({ path: shotPath, fullPage: false });
        const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000));
        const hasNoNewPosts = bodyText.includes('No new posts') || bodyText.includes("hasn't posted anything");
        const finding = {
          label: t.label,
          group_url: t.groupUrl,
          probe_url: url,
          screenshot: shotPath,
          has_no_new_posts_message: hasNoNewPosts,
          body_excerpt: bodyText.slice(0, 400).replace(/\s+/g, ' '),
        };
        findings.push(finding);
        console.log(`  has_no_new_posts=${hasNoNewPosts}`);
      } catch (e) {
        console.log(`  ERROR: ${e.message}`);
        findings.push({ label: t.label, error: e.message });
      } finally {
        await page.close();
      }
    }
    fs.writeFileSync(path.join(OUT_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
    console.log('\nFindings:', JSON.stringify(findings, null, 2));
  } finally {
    await ctx.close();
  }
})();
