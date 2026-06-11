'use strict';
// Quick probe: launch mobile-viewport Chromium against meetdossie.com/app, log in,
// then dump every visible interactive element so we can see what the mobile nav
// actually exposes (text labels vs aria-labels vs icons).

const path = require('path');
const fs = require('fs');

(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[k]) process.env[k] = v;
  }
})();

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';

(async () => {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);

  // Login
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill('demo@meetdossie.com');
    await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  }
  await page.waitForTimeout(3000);

  // Dump all visible interactive elements
  const visible = await page.evaluate(() => {
    const out = [];
    const sel = 'button, a, [role="button"], [role="tab"], [role="menuitem"]';
    document.querySelectorAll(sel).forEach((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0) return;
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      // Only elements actually in viewport
      if (r.bottom < 0 || r.top > window.innerHeight + 200) return;
      out.push({
        tag: el.tagName,
        text: (el.innerText || '').slice(0, 50).replace(/\s+/g, ' ').trim(),
        aria: el.getAttribute('aria-label') || '',
        title: el.getAttribute('title') || '',
        bottom: Math.round(r.bottom),
        top: Math.round(r.top),
        w: Math.round(r.width),
      });
    });
    return out.sort((a, b) => b.bottom - a.bottom);
  });

  console.log('VISIBLE INTERACTIVE ELEMENTS (sorted bottom-up):');
  visible.forEach((v) => console.log(JSON.stringify(v)));

  // Dump where "Pipeline" text appears
  const pipelineLocations = await page.evaluate(() => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (n.textContent && /pipeline|settings/i.test(n.textContent)) {
        const el = n.parentElement;
        if (!el) continue;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.push({
          text: n.textContent.trim().slice(0, 40),
          parent: el.tagName,
          visible: r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden',
          bottom: Math.round(r.bottom),
          top: Math.round(r.top),
          display: cs.display,
        });
      }
    }
    return out;
  });
  console.log('\nPIPELINE/SETTINGS TEXT LOCATIONS:');
  pipelineLocations.forEach((p) => console.log(JSON.stringify(p)));

  await page.screenshot({ path: path.join(__dirname, '..', 'Media', 'tutorial-videos', 'mobile-probe.png'), fullPage: false });
  console.log('\nScreenshot saved.');

  await browser.close();
})();
