'use strict';

// scripts/carter-dossie-asks-verify2.js
//
// Second verification pass for the "Dossie asks" feed:
//   A. Free-text reply actually routes into the chat backend and Dossie's
//      answer renders in the card (i.e. the reply box is not a dead input).
//   B. The empty state renders correctly.
//
// SAFETY:
//   * Part A types into the THROWAWAY QA card only, selected by ask id.
//     Heath's real Wild Cherry card is never typed into or clicked.
//   * Part B does NOT resolve Heath's real asks to force an empty feed. It
//     stubs the GET response instead — a read-only render check.
//
// INTERCEPTION IS VERIFIED, NOT ASSUMED (standing rule). This app is a PWA
// with a service worker, and a service worker answering a fetch before
// Playwright's route hook sees it has previously caused a request to escape
// interception entirely. So Part B fires a DECOY request through the exact
// same route pattern first and asserts the hook actually fired and actually
// supplied the body. If the decoy is not intercepted, Part B aborts rather
// than reporting a false pass.
//
// Usage: node scripts/carter-dossie-asks-verify2.js [base-url]

const fs = require('fs');
const path = require('path');
const { launchQuinnContext, VIEWPORTS, assertSignedInAs } = require('./_lib/quinn-browser');

const DEFAULT_BASE = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';
const EXPECTED_EMAIL = 'heath.shepard@kw.com';
const THROWAWAY_TITLE = 'QA throwaway';
const OUT_DIR = path.join(__dirname, 'atlas-runs', `carter-dossie-asks2-${Date.now()}`);

function log(...a) {
  console.log('[dossie-asks-verify2]', ...a);
}

async function ensureSignedIn(page) {
  const btn = page.locator('button:has-text("Sign In")').first();
  if (await btn.isVisible().catch(() => false)) {
    log('session lapsed — signing in with the profile saved credential');
    const email = page.locator('input[type="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      const v = await email.inputValue().catch(() => '');
      if (!v) await email.fill(EXPECTED_EMAIL);
    }
    await btn.click();
    await page.waitForTimeout(6000);
  }
}

async function gotoApp(page, base) {
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await ensureSignedIn(page);
  await assertSignedInAs(page, EXPECTED_EMAIL, { label: 'carter-dossie-asks-verify2' });
  await page
    .waitForSelector('[data-testid="dossie-asks"]', { timeout: 30000 })
    .catch(() => log('WARN: feed root did not appear'));
  await page.waitForTimeout(1200);
}

async function readCards(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="dossie-asks"]');
    if (!root) return [];
    return [...root.querySelectorAll('[data-testid="dossie-ask-card"]')].map((el) => ({
      id: el.getAttribute('data-ask-id'),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
      reply: (() => {
        const r = el.querySelector('[data-testid="dossie-ask-reply"]');
        return r ? r.innerText.trim() : null;
      })(),
    }));
  });
}

async function main() {
  const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log('base:', base);

  const context = await launchQuinnContext({
    headless: true,
    viewport: VIEWPORTS.laptop,
    reason: 'carter-dossie-asks-verify2',
  });
  const page = await context.newPage();
  const results = [];

  try {
    // ===================== PART A — free-text reply =====================
    await gotoApp(page, base);
    let cards = await readCards(page);
    const target = cards.find((c) => c.text.includes(THROWAWAY_TITLE));
    if (!target) {
      results.push(['throwaway card present for reply test', false]);
    } else {
      const scope = `[data-ask-id="${target.id}"]`;
      const question = 'what should I say to them?';
      log('typing free text into THROWAWAY card', target.id);
      await page.locator(`${scope} [data-testid="dossie-ask-input"]`).fill(question);
      await page.locator(`${scope} button:has-text("Send")`).click();

      // Chat round-trip through Anthropic — allow real latency.
      await page
        .waitForSelector(`${scope} [data-testid="dossie-ask-reply"]`, { timeout: 60000 })
        .catch(() => null);
      await page.waitForTimeout(1500);

      cards = await readCards(page);
      const after = cards.find((c) => c.id === target.id);
      const reply = after && after.reply;
      log('dossie reply rendered:', reply ? `"${reply.slice(0, 160)}"` : 'NONE');

      results.push(['free-text reply produces a Dossie answer', Boolean(reply && reply.length > 10)]);
      results.push(['card stays open after a question (not wrongly resolved)', Boolean(after)]);

      await page.screenshot({ path: path.join(OUT_DIR, '01-free-text-reply.png') });

      // Reply must persist — it is stored on the ask's thread, not in memory.
      await gotoApp(page, base);
      const reloaded = (await readCards(page)).find((c) => c.id === target.id);
      log('after reload, reply still shown:', Boolean(reloaded && reloaded.reply));
      results.push(['reply persists across reload', Boolean(reloaded && reloaded.reply)]);
    }

    // ===================== PART B — empty state =====================
    // Step 1: prove interception actually works before trusting it.
    let hookFired = 0;
    await page.route('**/api/dossie-asks*', async (route) => {
      hookFired++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          asks: [],
          visibleLimit: 4,
          activeDeals: [
            { id: '1', label: '104 WILD CHERRY LN', address: '104 Wild Cherry Ln' },
            { id: '2', label: '23 NOPALITO', address: '23 Nopalito' },
            { id: '3', label: '130 SENISA DR', address: '130 Senisa Dr' },
          ],
          activeDealCount: 3,
        }),
      });
    });

    const decoy = await page.evaluate(async () => {
      try {
        const r = await fetch('/api/dossie-asks?decoy=1', { headers: { 'x-decoy': '1' } });
        const j = await r.json();
        return { ok: true, asksLen: Array.isArray(j.asks) ? j.asks.length : -1, deals: j.activeDealCount };
      } catch (e) {
        return { ok: false, err: String(e) };
      }
    });

    const intercepted = hookFired > 0 && decoy.ok && decoy.asksLen === 0 && decoy.deals === 3;
    log(`decoy: hookFired=${hookFired} body=${JSON.stringify(decoy)} -> intercepted=${intercepted}`);
    results.push(['interception verified by decoy before use', intercepted]);

    if (!intercepted) {
      log('ABORTING empty-state check — interception is NOT catching requests.');
      results.push(['empty state renders', false]);
    } else {
      const before = hookFired;
      await gotoApp(page, base);
      log('empty-state load: hook fired', hookFired - before, 'more time(s)');
      const empty = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dossie-asks-empty"]');
        return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
      });
      log('empty state text:', empty);
      results.push(['empty state renders', Boolean(empty)]);
      results.push([
        'empty state names the real deals (teaching surface)',
        Boolean(empty) && /WILD CHERRY/i.test(empty) && /NOPALITO/i.test(empty),
      ]);
      results.push([
        'empty state teaches the paste-to-file capability',
        Boolean(empty) && /paste it here/i.test(empty),
      ]);
      await page.screenshot({ path: path.join(OUT_DIR, '02-empty-state.png') });
    }
  } finally {
    await context.close();
  }

  console.log('\n================ RESULTS ================');
  let failed = 0;
  for (const [n, p] of results) {
    if (!p) failed++;
    console.log(`${p ? 'PASS' : 'FAIL'}  ${n}`);
  }
  console.log('=========================================');
  console.log(`${results.length - failed}/${results.length} passed`);
  console.log(`screenshots: ${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[dossie-asks-verify2] FATAL', e);
  process.exit(1);
});
