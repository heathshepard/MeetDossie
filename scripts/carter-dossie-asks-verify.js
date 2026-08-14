'use strict';

// scripts/carter-dossie-asks-verify.js
//
// Real-browser verification of the "Dossie asks" card feed on /app.
// Per the standing rule, a UI change is not "done" until it has been loaded
// signed-in, clicked as the user would, and confirmed to persist.
//
// SAFETY — read before editing:
//   * This runs against Heath's REAL signed-in session (Quinn profile), on
//     his REAL live deals. assertSignedInAs is a hard gate; do not catch it.
//   * All state-changing clicks are scoped BY ASK ID to a throwaway QA row
//     (source='qa:throwaway-dossie-asks'). The real 104 Wild Cherry card is
//     read and screenshotted only — never clicked, resolved, or replied to.
//     Selecting by data-ask-id (not by button text or position) is what makes
//     that guarantee hold even if card order changes.
//   * Nothing in the DossieAsks component sends email or triggers an external
//     action, so there is no destructive-button risk on this surface. Do not
//     add clicks outside [data-testid="dossie-asks"] to this script.
//
// Usage: node scripts/carter-dossie-asks-verify.js [base-url]

const fs = require('fs');
const path = require('path');
const {
  launchQuinnContext,
  VIEWPORTS,
  assertSignedInAs,
} = require('./_lib/quinn-browser');

const DEFAULT_BASE = 'https://meet-dossie-git-staging-heathshepard-6590s-projects.vercel.app';
const EXPECTED_EMAIL = 'heath.shepard@kw.com';
const THROWAWAY_TITLE = 'QA throwaway';

const OUT_DIR = path.join(__dirname, 'atlas-runs', `carter-dossie-asks-${Date.now()}`);

function log(...a) {
  console.log('[dossie-asks-verify]', ...a);
}

async function readFeed(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="dossie-asks"]');
    if (!root) return { present: false };
    const cards = [...root.querySelectorAll('[data-testid="dossie-ask-card"]')].map((el) => ({
      id: el.getAttribute('data-ask-id'),
      text: el.innerText.replace(/\s+/g, ' ').trim(),
    }));
    const more = root.querySelector('[data-testid="dossie-asks-more"]');
    const empty = root.querySelector('[data-testid="dossie-asks-empty"]');
    const count = root.querySelector('[data-testid="dossie-asks-count"]');
    return {
      present: true,
      cards,
      moreLabel: more ? more.innerText.trim() : null,
      emptyText: empty ? empty.innerText.replace(/\s+/g, ' ').trim() : null,
      countLabel: count ? count.innerText.trim() : null,
    };
  });
}

// NOTE (2026-08-14): assertSignedInAs alone is NOT sufficient here. It reads
// the email out of the persisted localStorage auth token, which survives after
// the session itself has expired — so it passed cleanly while the app was
// actually rendering the sign-in screen. Always confirm the app chrome
// rendered too, not just that a token blob exists.
async function ensureSignedIn(page) {
  const signInBtn = page.locator('button:has-text("Sign In")').first();
  if (await signInBtn.isVisible().catch(() => false)) {
    log('session lapsed — signing in with the profile\'s saved credential');
    // Chrome autofills this profile's stored meetdossie.com credential. We
    // submit it without ever reading it; no secret is handled by this script.
    const email = page.locator('input[type="email"]').first();
    if (await email.isVisible().catch(() => false)) {
      const val = await email.inputValue().catch(() => '');
      if (!val) await email.fill(EXPECTED_EMAIL);
    }
    await signInBtn.click();
    await page.waitForTimeout(6000);
  }
}

async function gotoApp(page, base) {
  await page.goto(`${base}/app`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
  await ensureSignedIn(page);
  await assertSignedInAs(page, EXPECTED_EMAIL, { label: 'carter-dossie-asks-verify' });
  const stillOnLogin = await page
    .locator('button:has-text("Sign In")')
    .first()
    .isVisible()
    .catch(() => false);
  if (stillOnLogin) {
    throw new Error(
      'Still on the sign-in screen after attempting login. The Quinn profile session has ' +
        'lapsed and no usable saved credential is present — re-run scripts/quinn-login-setup.js.',
    );
  }
  // Feed renders nothing at all until its first fetch resolves.
  await page
    .waitForSelector('[data-testid="dossie-asks"]', { timeout: 30000 })
    .catch(() => log('WARN: feed root did not appear'));
  await page.waitForTimeout(1200);
}

async function main() {
  const base = (process.argv[2] || DEFAULT_BASE).replace(/\/$/, '');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log('base:', base);
  log('out :', OUT_DIR);

  const context = await launchQuinnContext({
    headless: true,
    viewport: VIEWPORTS.laptop,
    reason: 'carter-dossie-asks-verify',
  });
  const page = await context.newPage();
  const results = [];

  try {
    // --- 1. Load signed in, feed renders -----------------------------------
    await gotoApp(page, base);
    const first = await readFeed(page);
    log('feed present:', first.present, '| cards:', first.cards && first.cards.length);
    log('count pill  :', first.countLabel, '| more:', first.moreLabel);
    results.push(['feed renders', first.present && first.cards.length > 0]);

    await page.screenshot({ path: path.join(OUT_DIR, '01-feed.png'), fullPage: false });

    // --- 2. The real Wild Cherry card is present, first, and correct -------
    const wild = (first.cards || []).find((c) => /WILD CHERRY/i.test(c.text));
    log('wild cherry card:', wild ? wild.text.slice(0, 220) : 'NOT FOUND');
    results.push(['wild cherry card present', Boolean(wild)]);
    results.push([
      'wild cherry ranked first (consequence+clock, not recency)',
      Boolean(wild) && first.cards[0].id === wild.id,
    ]);
    results.push([
      'ask states the consequence, not just the fact',
      Boolean(wild) && /can still walk/i.test(wild.text),
    ]);
    results.push([
      'deadline + countdown shown',
      Boolean(wild) && /option ends 5:00 PM/i.test(wild.text) && /(in |overdue by )/i.test(wild.text),
    ]);
    results.push([
      'quick actions rendered',
      Boolean(wild) && /Draft it/.test(wild.text) && /I'll call them|I’ll call them/.test(wild.text),
    ]);
    results.push(['free-text reply box present', await page.locator('[data-testid="dossie-ask-input"]').first().isVisible()]);

    if (wild) {
      const card = page.locator(`[data-ask-id="${wild.id}"]`);
      await card.screenshot({ path: path.join(OUT_DIR, '02-wild-cherry-card.png') });
    }

    // --- 3. Volume cap ------------------------------------------------------
    const visibleCount = (first.cards || []).length;
    results.push(['volume cap respected (<=5 visible)', visibleCount <= 5]);

    // --- 4. Quick action changes state, on the THROWAWAY card only ---------
    let target = (first.cards || []).find((c) => c.text.includes(THROWAWAY_TITLE));
    if (!target && first.moreLabel) {
      log('throwaway not in the visible set — expanding "N more"');
      await page.locator('[data-testid="dossie-asks-more"]').click();
      await page.waitForTimeout(600);
      const expanded = await readFeed(page);
      log('after expand, cards:', expanded.cards.length);
      results.push(['"N more" expands the collapsed set', expanded.cards.length > visibleCount]);
      target = expanded.cards.find((c) => c.text.includes(THROWAWAY_TITLE));
    }

    if (!target) {
      results.push(['throwaway card available for click test', false]);
    } else {
      log('clicking "Already done" on THROWAWAY card', target.id);
      // Scoped by ask id — cannot hit the real Wild Cherry card.
      const btn = page.locator(`[data-ask-id="${target.id}"] [data-testid="dossie-ask-action-qa-done"]`);
      await btn.click();
      await page.waitForTimeout(2500);

      const afterClick = await readFeed(page);
      const goneNow = !afterClick.cards.some((c) => c.id === target.id);
      log('throwaway gone from feed after click:', goneNow);
      results.push(['quick action removes card immediately', goneNow]);

      await page.screenshot({ path: path.join(OUT_DIR, '03-after-resolve.png') });

      // --- 5. Persistence across a full reload ---------------------------
      await gotoApp(page, base);
      const afterReload = await readFeed(page);
      const stillGone = !afterReload.cards.some((c) => c.id === target.id);
      const wildStillThere = afterReload.cards.some((c) => /WILD CHERRY/i.test(c.text));
      log('after reload — throwaway gone:', stillGone, '| wild cherry still open:', wildStillThere);
      results.push(['resolution persists across reload', stillGone]);
      results.push(['unrelated real card untouched by the test', wildStillThere]);

      await page.screenshot({ path: path.join(OUT_DIR, '04-after-reload.png'), fullPage: false });
    }

    // --- 6. Mobile render ---------------------------------------------------
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT_DIR, '05-mobile.png'), fullPage: false });
    log('mobile screenshot captured');
  } finally {
    await context.close();
  }

  console.log('\n================ RESULTS ================');
  let failed = 0;
  for (const [name, pass] of results) {
    if (!pass) failed++;
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}`);
  }
  console.log('=========================================');
  console.log(`${results.length - failed}/${results.length} passed`);
  console.log(`screenshots: ${OUT_DIR}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[dossie-asks-verify] FATAL', e);
  process.exit(1);
});
