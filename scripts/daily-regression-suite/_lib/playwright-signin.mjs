// scripts/daily-regression-suite/_lib/playwright-signin.mjs
//
// Signs in as demo@meetdossie.com. Returns the context/page and the
// live console-error stream so ui-tests can attribute errors.

import fs from 'node:fs';
import path from 'node:path';

const IGNORE_CONSOLE = [
  /favicon\.ico/i,
  /google-analytics/i,
  /googletagmanager/i,
  /gtag/i,
  /chrome-extension:/i,
  /Failed to load resource:.*sourcemap/i,
  /\.well-known\/appspecific\/com\.chrome/i,
];

export async function makeSignedInSession(cfg) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (e) {
    throw new Error(`playwright not installed: ${e.message}`);
  }
  const browser = await chromium.launch({ headless: cfg.headless });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const t = msg.text();
    if (IGNORE_CONSOLE.some(re => re.test(t))) return;
    consoleErrors.push({ t: Date.now(), text: t });
  });
  page.on('pageerror', err => {
    const t = String(err && err.message ? err.message : err);
    if (IGNORE_CONSOLE.some(re => re.test(t))) return;
    pageErrors.push({ t: Date.now(), text: t });
  });

  await page.goto(`${cfg.base}/workspace.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  const emailInput = await page.$('input[type="email"]');
  if (emailInput) await emailInput.fill(cfg.email);
  const pwInput = await page.$('input[type="password"]');
  if (pwInput && cfg.password) await pwInput.fill(cfg.password);
  const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In")');
  if (signInBtn) await signInBtn.click();
  await page.waitForTimeout(4500);

  // dismiss any welcome overlay
  const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
  if (closeX) { await closeX.click().catch(() => {}); await page.waitForTimeout(500); }
  await page.keyboard.press('Escape').catch(() => {});

  return { browser, ctx, page, consoleErrors, pageErrors };
}

export async function screenshot(page, cfg, name) {
  if (cfg.vercelMode) return null;
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const p = path.join(cfg.outDir, `${name}.png`);
  await page.screenshot({ path: p, fullPage: false }).catch(() => {});
  return p;
}

export function errorsSince(errList, ts) {
  return errList.filter(e => e.t >= ts).map(e => e.text);
}
