'use strict';
// Read-only mobile layout measurement for the Dossie asks card. No clicks.
const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const BASE = (process.argv[2] || 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app').replace(/\/$/, '');
const EXPECTED_EMAIL = 'heath.shepard@kw.com';

(async () => {
  const context = await launchQuinnContext({ headless: true, viewport: VIEWPORTS.mobile, reason: 'carter-dossie-asks-measure' });
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2500);
    const btn = page.locator('button:has-text("Sign In")').first();
    if (await btn.isVisible().catch(() => false)) {
      const email = page.locator('input[type="email"]').first();
      if (await email.isVisible().catch(() => false)) {
        const v = await email.inputValue().catch(() => '');
        if (!v) await email.fill(EXPECTED_EMAIL);
      }
      await btn.click();
      await page.waitForTimeout(6000);
    }
    await assertSignedInAs(page, EXPECTED_EMAIL, { label: 'measure' });
    await page.waitForSelector('[data-testid="dossie-ask-card"]', { timeout: 30000 });
    await page.waitForTimeout(1000);

    const info = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="dossie-ask-card"]');
      const out = { cardWidth: card.getBoundingClientRect().width, items: [] };
      const probe = (el, tag) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        out.items.push({
          tag,
          text: (el.innerText || el.placeholder || '').slice(0, 24),
          w: Math.round(r.width),
          display: cs.display,
          flexGrow: cs.flexGrow,
          flexBasis: cs.flexBasis,
          width: cs.width,
          minWidth: cs.minWidth,
          maxWidth: cs.maxWidth,
        });
      };
      card.querySelectorAll('button').forEach((b) => probe(b, 'button'));
      card.querySelectorAll('input').forEach((i) => probe(i, 'input'));
      const rows = card.querySelectorAll('div');
      rows.forEach((d) => {
        const cs = getComputedStyle(d);
        if (cs.display === 'flex') {
          out.items.push({ tag: 'flexrow', text: d.innerText.slice(0, 20).replace(/\s+/g, ' '), w: Math.round(d.getBoundingClientRect().width), display: cs.display, flexWrap: cs.flexWrap });
        }
      });
      return out;
    });
    console.log(JSON.stringify(info, null, 2));
  } finally {
    await context.close();
  }
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
