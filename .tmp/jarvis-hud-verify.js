const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SESSION_PATH = path.join(__dirname, 'jarvis-hud-audit', 'heath-session.json');
const OUT_DIR = __dirname;
const PROD_URL = 'https://meetdossie.com/jarvis-pwa.html';

async function main() {
  const raw = fs.readFileSync(SESSION_PATH, 'utf-8');
  const session = JSON.parse(raw);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  await context.addInitScript((sess) => {
    try {
      const key = 'sb-pgwoitbdiyugjugwufhk-auth-token'; // will be overwritten if wrong
    } catch {}
  }, session);

  // Set localStorage by visiting the base URL first
  const page = await context.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[ERR] ${msg.text()}`);
  });

  // Load a lightweight page to establish origin, then inject session, then reload
  await page.goto('https://meetdossie.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.evaluate((sess) => {
    // Real ref is pgwoitbdiyubjugwufhk
    const key = 'sb-pgwoitbdiyubjugwufhk-auth-token';
    const payload = {
      access_token: sess.access_token,
      token_type: sess.token_type || 'bearer',
      expires_in: sess.expires_in || 3600,
      expires_at: sess.expires_at,
      refresh_token: sess.refresh_token,
      user: sess.user,
    };
    window.localStorage.setItem(key, JSON.stringify(payload));
  }, session);

  await page.goto(PROD_URL, { waitUntil: 'networkidle', timeout: 30000 });

  // Wait for signed-in state
  const authed = await page.waitForFunction(() => {
    const el = document.getElementById('tenant-display');
    return el && el.textContent && el.textContent.length > 5 && !el.textContent.includes('UNASSIGNED') && el.textContent !== 'tenant · —';
  }, { timeout: 25000 }).then(() => true).catch(() => false);

  console.log('authed=', authed);

  // Force-hydrate all panels: wait extra for polls
  await page.waitForTimeout(8000);

  const tenantText = await page.$eval('#tenant-display', el => el.textContent).catch(() => 'MISSING');
  console.log('tenant-display:', tenantText);

  const p1 = path.join(OUT_DIR, 'hud-verify-desktop.png');
  await page.screenshot({ path: p1, fullPage: false });
  console.log('desktop screenshot:', p1);

  // Scroll down to reveal Actions For You, Money Pulse, Agent Status, etc.
  await page.evaluate(() => window.scrollTo(0, 900));
  await page.waitForTimeout(1000);
  const p1b = path.join(OUT_DIR, 'hud-verify-desktop-2.png');
  await page.screenshot({ path: p1b, fullPage: false });
  console.log('desktop scroll1:', p1b);

  await page.evaluate(() => window.scrollTo(0, 1800));
  await page.waitForTimeout(1000);
  const p1c = path.join(OUT_DIR, 'hud-verify-desktop-3.png');
  await page.screenshot({ path: p1c, fullPage: false });
  console.log('desktop scroll2:', p1c);

  await page.evaluate(() => window.scrollTo(0, 2700));
  await page.waitForTimeout(1000);
  const p1d = path.join(OUT_DIR, 'hud-verify-desktop-4.png');
  await page.screenshot({ path: p1d, fullPage: false });
  console.log('desktop scroll3:', p1d);

  await page.evaluate(() => window.scrollTo(0, 3600));
  await page.waitForTimeout(1000);
  const p1e = path.join(OUT_DIR, 'hud-verify-desktop-5.png');
  await page.screenshot({ path: p1e, fullPage: false });
  console.log('desktop scroll4:', p1e);

  await page.evaluate(() => window.scrollTo(0, 4800));
  await page.waitForTimeout(1000);
  const p1f = path.join(OUT_DIR, 'hud-verify-desktop-6.png');
  await page.screenshot({ path: p1f, fullPage: false });
  console.log('desktop scroll5:', p1f);

  await page.evaluate(() => window.scrollTo(0, 6000));
  await page.waitForTimeout(1000);
  const p1g = path.join(OUT_DIR, 'hud-verify-desktop-7.png');
  await page.screenshot({ path: p1g, fullPage: false });
  console.log('desktop scroll6:', p1g);

  await page.evaluate(() => window.scrollTo(0, 7200));
  await page.waitForTimeout(1000);
  const p1h = path.join(OUT_DIR, 'hud-verify-desktop-8.png');
  await page.screenshot({ path: p1h, fullPage: false });
  console.log('desktop scroll7:', p1h);

  await page.evaluate(() => window.scrollTo(0, 8400));
  await page.waitForTimeout(1000);
  const p1i = path.join(OUT_DIR, 'hud-verify-desktop-9.png');
  await page.screenshot({ path: p1i, fullPage: false });
  console.log('desktop scroll8:', p1i);

  await page.evaluate(() => window.scrollTo(0, 9600));
  await page.waitForTimeout(1000);
  const p1j = path.join(OUT_DIR, 'hud-verify-desktop-10.png');
  await page.screenshot({ path: p1j, fullPage: false });
  console.log('desktop scroll9:', p1j);

  // Projects Ledger scroll
  await page.evaluate(() => window.scrollTo(0, 5400));
  await page.waitForTimeout(1000);
  const pLedger = path.join(OUT_DIR, 'hud-verify-desktop-projects.png');
  await page.screenshot({ path: pLedger, fullPage: false });
  console.log('projects ledger:', pLedger);

  // Merge Queue is near top — scroll to y=200
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.waitForTimeout(1000);
  const pMQ = path.join(OUT_DIR, 'hud-verify-desktop-merge-queue.png');
  await page.screenshot({ path: pMQ, fullPage: false });
  console.log('merge queue:', pMQ);

  // Reset scroll for mobile
  await page.evaluate(() => window.scrollTo(0, 0));

  // Also capture the sidebar (right column) at 1x pixel density by clipping
  const sidebarBox = await page.$eval('#pending-panel', el => {
    // Find right column: walk up to sidebar container
    let cur = el;
    while (cur && !cur.classList.contains('right-col') && cur.parentElement) cur = cur.parentElement;
    const r = cur.getBoundingClientRect();
    return { x: Math.max(0, r.left), y: Math.max(0, r.top), w: r.width, h: r.height };
  }).catch(() => null);
  console.log('sidebar box:', sidebarBox);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(2000);
  const p2 = path.join(OUT_DIR, 'hud-verify-mobile.png');
  await page.screenshot({ path: p2, fullPage: false });
  console.log('mobile screenshot:', p2);

  // Scroll to reveal panels below the fold on mobile and re-capture
  await page.evaluate(() => window.scrollTo(0, 1200));
  await page.waitForTimeout(1000);
  const p3 = path.join(OUT_DIR, 'hud-verify-mobile-scroll1.png');
  await page.screenshot({ path: p3, fullPage: false });
  console.log('mobile scroll1:', p3);

  await browser.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
