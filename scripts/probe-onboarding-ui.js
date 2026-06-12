'use strict';

// scripts/probe-onboarding-ui.js
//
// Atlas probe: logs into demo accounts, dumps the Supabase auth storage key,
// and inventories the actual UI elements on Settings + a buyer-side dossier
// detail + a seller-side dossier detail. Used to build accurate Playwright
// step lists for the v3 onboarding bites.
//
// Usage:
//   node scripts/probe-onboarding-ui.js

const fs = require('fs');
const path = require('path');

(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '..', '.env.local');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  } catch {}
})();

const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'DossieDemo-VaIiAt6Bab';
const DEMO2_EMAIL = 'demo2@meetdossie.com';
const DEMO2_PASSWORD = process.env.DEMO2_PASSWORD || 'DossieDemo2-John2026';

const OUT_DIR = path.join(__dirname, '..', '.tmp-qc', 'probe-onboarding');

async function login(page, email, password) {
  await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const emailInput = page.locator('input[type="email"]').first();
  if (await emailInput.isVisible({ timeout: 4000 }).catch(() => false)) {
    await emailInput.fill(email);
    await page.locator('input[type="password"]').first().fill(password);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2500);
  }
}

async function dumpStorage(page, label) {
  const data = await page.evaluate(() => {
    const out = { localStorage: {}, sessionStorage: {}, cookies: document.cookie };
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = localStorage.getItem(k);
      out.localStorage[k] = v && v.length > 4000 ? v.slice(0, 4000) + '...' : v;
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      const v = sessionStorage.getItem(k);
      out.sessionStorage[k] = v && v.length > 4000 ? v.slice(0, 4000) + '...' : v;
    }
    return out;
  });
  fs.writeFileSync(path.join(OUT_DIR, `storage-${label}.json`), JSON.stringify(data, null, 2));
  console.log(`[probe] storage-${label}.json written.`);
  return data;
}

async function inventoryPage(page, label) {
  // Capture visible buttons + headings + clickable text on the current view.
  const out = await page.evaluate(() => {
    function isVisible(el) {
      const r = el.getBoundingClientRect();
      const s = window.getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
    }
    const headings = [];
    document.querySelectorAll('h1, h2, h3, h4, [role="heading"]').forEach(el => {
      if (isVisible(el)) headings.push({ tag: el.tagName, text: (el.innerText || '').trim().slice(0, 120) });
    });
    const buttons = [];
    document.querySelectorAll('button, [role="button"], a[href]').forEach(el => {
      if (!isVisible(el)) return;
      const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
      const aria = el.getAttribute('aria-label') || '';
      if (!text && !aria) return;
      buttons.push({ tag: el.tagName, text, aria });
    });
    const inputs = [];
    document.querySelectorAll('input, textarea, select').forEach(el => {
      if (!isVisible(el)) return;
      inputs.push({
        tag: el.tagName,
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        value: (el.value || '').toString().slice(0, 80),
      });
    });
    return {
      url: location.href,
      title: document.title,
      headings,
      buttons: buttons.slice(0, 200),
      inputs: inputs.slice(0, 100),
    };
  });
  fs.writeFileSync(path.join(OUT_DIR, `inventory-${label}.json`), JSON.stringify(out, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, `screen-${label}.png`), fullPage: true });
  console.log(`[probe] inventory-${label}.json + screen-${label}.png (${out.buttons.length} btns, ${out.inputs.length} inputs)`);
  return out;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  });
  const page = await ctx.newPage();

  try {
    // ─── 1. Demo 1 (Sarah Whitley) — seller-heavy account ─────────────────
    console.log('[probe] Logging into demo@meetdossie.com...');
    await login(page, DEMO_EMAIL, DEMO_PASSWORD);
    await dumpStorage(page, 'demo1-post-login');

    // Pipeline / home
    await inventoryPage(page, 'demo1-home');

    // Tap Settings via aria
    const settingsAria = page.locator('[aria-label="Settings"]').first();
    if (await settingsAria.isVisible({ timeout: 3000 }).catch(() => false)) {
      await settingsAria.click();
      await page.waitForTimeout(2500);
      await inventoryPage(page, 'demo1-settings-top');
      // Scroll to see all sections
      await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'instant' }));
      await page.waitForTimeout(600);
      await inventoryPage(page, 'demo1-settings-mid');
      await page.evaluate(() => window.scrollBy({ top: 600, behavior: 'instant' }));
      await page.waitForTimeout(600);
      await inventoryPage(page, 'demo1-settings-bot');
      // Look for Team Members text
      const teamSec = await page.evaluate(() => {
        const text = document.body.innerText || '';
        const has = /team\s*members?/i.test(text);
        const idx = text.search(/team\s*members?/i);
        return { has, snippet: idx >= 0 ? text.slice(Math.max(0, idx - 80), idx + 200) : null };
      });
      fs.writeFileSync(path.join(OUT_DIR, 'demo1-settings-team-check.json'), JSON.stringify(teamSec, null, 2));
      console.log('[probe] Team Members in Settings:', teamSec.has);
    }

    // Back to Pipeline
    await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const pipelineAria = page.locator('[aria-label="Pipeline"]').first();
    if (await pipelineAria.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pipelineAria.click();
      await page.waitForTimeout(2000);
    }
    await inventoryPage(page, 'demo1-pipeline');

    // Look for a seller-side card (Sandra Martinez Pre-Listing) and click it
    const sandra = page.getByText(/sandra martinez/i).first();
    if (await sandra.isVisible({ timeout: 3000 }).catch(() => false)) {
      await sandra.click();
      await page.waitForTimeout(2500);
      await inventoryPage(page, 'demo1-sandra-dossier');
      // Try scroll to find invite/contacts section
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
      await page.waitForTimeout(500);
      await inventoryPage(page, 'demo1-sandra-dossier-scroll1');
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
      await page.waitForTimeout(500);
      await inventoryPage(page, 'demo1-sandra-dossier-scroll2');
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
      await page.waitForTimeout(500);
      await inventoryPage(page, 'demo1-sandra-dossier-scroll3');
    } else {
      console.log('[probe] Sandra Martinez not visible on demo1 pipeline.');
    }

    // ─── 2. Demo 2 (John Smith) — buyer-heavy account ─────────────────────
    console.log('[probe] Logging into demo2@meetdossie.com...');
    await ctx.clearCookies();
    await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
    await login(page, DEMO2_EMAIL, DEMO2_PASSWORD);
    await dumpStorage(page, 'demo2-post-login');
    await inventoryPage(page, 'demo2-home');

    // Pipeline
    await page.goto('https://meetdossie.com/app', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const pipelineAria2 = page.locator('[aria-label="Pipeline"]').first();
    if (await pipelineAria2.isVisible({ timeout: 3000 }).catch(() => false)) {
      await pipelineAria2.click();
      await page.waitForTimeout(2000);
    }
    await inventoryPage(page, 'demo2-pipeline');

    // Look for the buyer-side seed: 123 Main / Joe Shmoe or similar
    const buyerCard = page.getByText(/joe shmoe|123 main|buyer/i).first();
    if (await buyerCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await buyerCard.click();
      await page.waitForTimeout(2500);
      await inventoryPage(page, 'demo2-buyer-dossier');
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
      await page.waitForTimeout(500);
      await inventoryPage(page, 'demo2-buyer-dossier-scroll1');
      await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
      await page.waitForTimeout(500);
      await inventoryPage(page, 'demo2-buyer-dossier-scroll2');
    } else {
      console.log('[probe] No buyer-text card found on demo2 pipeline. Trying first card.');
      // Click first dossier card we can find
      const firstCard = page.locator('button, [role="button"], a').filter({ hasText: /pre-contract|under contract|active|pre-listing/i }).first();
      if (await firstCard.isVisible({ timeout: 3000 }).catch(() => false)) {
        await firstCard.click();
        await page.waitForTimeout(2500);
        await inventoryPage(page, 'demo2-first-dossier');
        await page.evaluate(() => window.scrollBy({ top: 500, behavior: 'instant' }));
        await page.waitForTimeout(500);
        await inventoryPage(page, 'demo2-first-dossier-scroll1');
      }
    }
  } catch (err) {
    console.error('[probe] FAILED:', err.message);
    fs.writeFileSync(path.join(OUT_DIR, 'error.txt'), err.stack || err.message);
  } finally {
    await ctx.close();
    await browser.close();
  }
}

main().then(() => console.log('[probe] Done.')).catch(e => { console.error(e); process.exit(1); });
