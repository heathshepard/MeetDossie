const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const TARGETS = [
  // Texas RE GROUPS — try mobile to see if public posts come through
  { name: 'Ginger Unger - RE Instructor (group)', url: 'https://m.facebook.com/groups/gingerungerinstructor/' },
  { name: 'Texas Real Estate Agents', url: 'https://m.facebook.com/groups/texasusarealestateagents/' },
  { name: 'Texas Real Estate Network', url: 'https://m.facebook.com/groups/texasrealestategroup/' },
  { name: 'Dallas Texas Realtors', url: 'https://m.facebook.com/groups/dallasrealtors/' },
  { name: 'Real Estate Agents Mastermind', url: 'https://m.facebook.com/groups/152569472013647/' },
  { name: 'Shift Talk', url: 'https://m.facebook.com/groups/959497342026290/' },
  { name: 'Club Wealth Mastermind', url: 'https://m.facebook.com/groups/ClubWealth/' },
  // RE coaches/educators public pages
  { name: 'Hustle Humbly Podcast', url: 'https://m.facebook.com/hustlehumblypodcast/' },
  { name: 'Real Estate Rookie', url: 'https://m.facebook.com/realestaterookie/' },
  { name: 'Tom Ferry', url: 'https://m.facebook.com/CoachTomFerry/' },
  { name: 'NAR Realtors Association', url: 'https://m.facebook.com/narrealtor/' },
];

const OUT = path.join(__dirname, '.sage-mobile-groups.json');

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 896 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    isMobile: true,
  });
  const page = await ctx.newPage();

  const all = [];
  for (const t of TARGETS) {
    console.log(`[${t.name}]`);
    try {
      await page.goto(t.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await page.waitForTimeout(3000);

      const url = page.url();
      const title = await page.title();
      const bodyLen = await page.locator('body').innerText().then(t => t.length).catch(() => 0);
      console.log(`  url=${url.slice(0, 80)}`);
      console.log(`  title=${title}`);
      console.log(`  bodyLen=${bodyLen}`);

      // Scroll a few times
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollBy(0, 1500));
        await page.waitForTimeout(1500);
      }

      const body = await page.locator('body').innerText().catch(() => '');
      const isLoginWall = /You must log in/.test(body) || /Create new account/i.test(body) && bodyLen < 500;
      const isUnavailable = /content isn't available/i.test(body);

      all.push({ name: t.name, url, title, bodyLen: body.length, body: body.slice(0, 5000), isLoginWall, isUnavailable });
    } catch (e) {
      console.log(`  err: ${e.message}`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
  console.log(`\nWrote ${all.length} group probes to ${OUT}`);

  // Print which ones got content
  for (const r of all) {
    if (r.bodyLen > 1000 && !r.isLoginWall && !r.isUnavailable) {
      console.log(`\n=== ${r.name} (bodyLen=${r.bodyLen}) ===`);
      console.log(r.body.slice(0, 1500));
    } else {
      console.log(`-- ${r.name}: blocked (loginWall=${r.isLoginWall} unavail=${r.isUnavailable} len=${r.bodyLen})`);
    }
  }

  await browser.close();
})();
