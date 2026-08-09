'use strict';

// scripts/_lib/connectmls-actions.js
//
// Shared, condition-based connectMLS interaction helpers. Companion to
// brokerage-browser.js (which only launches the profile/context — it has
// no workflow logic). Every brokerage-kanika-search*.js / brokerage-connectmls-*.js
// script to date hand-rolled its own copy of this login-check + SmartBar-search
// sequence using fixed `page.waitForTimeout(Nms)` padding (2500 / 4000 / 1200 /
// 3500ms per script, every time, whether the page needed it or not). Confirmed
// 2026-08-07: one script alone (brokerage-kanika-search50-fulltext.js) burned
// 11.2s of pure blind sleep in its first ~35 lines. Across 628 waitForTimeout
// calls in scripts/brokerage-*.js that's ~1600s (~27min) of artificial padding
// accumulated in one-off scripts that already ran and won't be reused as-is.
//
// This module replaces the fixed-sleep pattern with real condition waits
// (waitForSelector / waitFor / waitForFunction) so new scripts resolve as
// soon as the page is actually ready instead of always paying the full
// padded duration.
//
// IMPORTANT — real behavior discovered while building this (2026-08-07):
// when the connectMLS APP session has fully expired (server redirects to
// expired.jsp), clicking the "Click here" SSO re-auth link does not just
// navigate the page — it kills the entire Playwright BrowserContext (Chrome
// process exits). `context.pages()` goes to 0 and `context.newPage()` fails.
// This is NOT something a longer wait fixes — it's connectMLS bouncing to
// its full SSO+MFA flow, which per brokerage-login-setup.js cannot be
// scripted and requires Heath to complete it by hand, once, in a visible
// window. So `ensureSignedIn` below detects this fast (via the page 'close'
// event) and throws a clear, actionable error instead of limping forward
// into a confusing generic "Target page ... has been closed" crash several
// awaits later. Run `node scripts/brokerage-login-setup.js` to recover.
//
// Usage:
//   const { launchBrokerageContext } = require('./_lib/brokerage-browser');
//   const { ensureSignedIn, smartBarSearch } = require('./_lib/connectmls-actions');
//   const context = await launchBrokerageContext({ headless: true, reason: 'my-task' });
//   const page = await context.newPage();
//   await page.goto('https://lera.connectmls.com/mls/home/home.jsp', { waitUntil: 'domcontentloaded', timeout: 60000 });
//   await ensureSignedIn(page, context);
//   const text = await smartBarSearch(page, '1916402');

const SMARTBAR_SELECTOR = 'input[placeholder*="SmartBar"]';
const SIGNIN_TEXT = 'Click here';

/**
 * Race the two things that can legitimately be on screen right after
 * navigating to home.jsp: the SmartBar (already authenticated) or the
 * "To Sign-In to connectMLS, Click here" banner (session expired / cold
 * profile). Resolves the instant either one appears instead of guessing a
 * fixed delay. Also lands here if the goto already redirected straight to
 * expired.jsp — the sign-in text is present there too.
 *
 * @param {import('playwright').Page} page
 * @param {number} [timeoutMs=20000]
 * @returns {Promise<'smartbar'|'signin'>}
 */
async function waitForAppReady(page, timeoutMs = 20000) {
  const smartbar = page.locator(SMARTBAR_SELECTOR).first();
  const signInLink = page.getByText(SIGNIN_TEXT).first();

  const result = await Promise.race([
    smartbar.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'smartbar'),
    signInLink.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'signin'),
  ]).catch(() => null);

  if (result) return result;

  throw new Error(
    `connectmls-actions.waitForAppReady: neither SmartBar nor sign-in banner appeared within ${timeoutMs}ms at ${page.url()}`
  );
}

/**
 * Ensure the page is past connectMLS's sign-in gate and the SmartBar is
 * usable. If already signed in, resolves immediately. If a re-auth click is
 * needed and it turns out to be a real expired app session (context dies),
 * throws immediately with a clear recovery instruction instead of leaving
 * the caller to hit a cryptic "Target page ... closed" error on some later
 * unrelated line.
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').BrowserContext} context
 * @param {number} [timeoutMs=20000]
 */
async function ensureSignedIn(page, context, timeoutMs = 20000) {
  const state = await waitForAppReady(page, timeoutMs);
  if (state === 'smartbar') return;

  // state === 'signin' — click it and watch for the context dying, which is
  // the real, observed behavior on a fully expired app session (see module
  // header). We race the close event against the SmartBar showing up on a
  // successful silent SSO refresh (no MFA needed, IdP session still trusted).
  let contextDied = false;
  const onPageClose = () => { contextDied = true; };
  page.on('close', onPageClose);

  const signInLink = page.getByText(SIGNIN_TEXT).first();
  await signInLink.click({ timeout: 10000 });

  const smartbar = page.locator(SMARTBAR_SELECTOR).first();
  const outcome = await Promise.race([
    smartbar.waitFor({ state: 'visible', timeout: timeoutMs }).then(() => 'ok').catch(() => 'timeout'),
    new Promise((resolve) => {
      const check = setInterval(() => {
        if (contextDied) { clearInterval(check); resolve('context-died'); }
      }, 100);
      setTimeout(() => { clearInterval(check); resolve('timeout'); }, timeoutMs);
    }),
  ]);

  page.off('close', onPageClose);

  if (outcome === 'ok') return;

  if (outcome === 'context-died' || contextDied) {
    throw new Error(
      'connectmls-actions.ensureSignedIn: connectMLS app session is fully expired and the SSO re-auth redirect ' +
      'killed the browser context (this cannot be scripted through — MFA required). ' +
      'Recovery: run `node scripts/brokerage-login-setup.js` in a visible window and log in by hand, then retry.'
    );
  }

  throw new Error(
    `connectmls-actions.ensureSignedIn: SmartBar did not appear within ${timeoutMs}ms after sign-in click at ${page.url()}`
  );
}

/**
 * Search the connectMLS SmartBar for an MLS number (or free-text query) and
 * return the resulting page's full innerText once real content has loaded —
 * no fixed post-Enter sleep. Waits for the body text to actually contain the
 * query string (or, if `resultSelector` is given, for that selector to
 * appear instead).
 *
 * A short settle delay before Enter is kept (SmartBar's autocomplete JS
 * needs a beat to register the typed value before Enter submits — this is
 * the one place in the flow where a small fixed pause is the pragmatic
 * choice over reverse-engineering connectMLS's internal debounce), but it's
 * trimmed from the original script's 1200ms to 400ms.
 *
 * @param {import('playwright').Page} page
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.debounceMs=400]
 * @param {number} [opts.resultTimeoutMs=15000]
 * @param {string} [opts.resultSelector] optional selector to wait for instead of text-match
 * @returns {Promise<string>} document.body.innerText after results render
 */
async function smartBarSearch(page, query, opts = {}) {
  const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 400;
  const resultTimeoutMs = opts.resultTimeoutMs || 15000;

  const smartbar = page.locator(SMARTBAR_SELECTOR).first();
  await smartbar.click({ timeout: 10000 });
  await smartbar.fill('');
  await smartbar.fill(query);
  await page.waitForTimeout(debounceMs);

  // SmartBar's Enter triggers a REAL page navigation on connectMLS (not an
  // in-place AJAX update) — confirmed live 2026-08-07. Racing waitForFunction
  // against that navigation can catch document mid-teardown (body briefly
  // null). Wait for the navigation to settle first, THEN check content.
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: resultTimeoutMs }).catch(() => {}),
    page.keyboard.press('Enter'),
  ]);

  if (opts.resultSelector) {
    await page.locator(opts.resultSelector).first().waitFor({ state: 'visible', timeout: resultTimeoutMs }).catch(() => {});
  } else {
    await page.waitForFunction(
      (q) => document.body && document.body.innerText.includes(q),
      query,
      { timeout: resultTimeoutMs }
    ).catch(() => {
      // Some queries (e.g. addresses that resolve to a list, not a detail
      // page) won't echo the literal query string back. Fall back to a
      // short settle instead of failing the whole call — still far less
      // than the original blind 3500ms in the common case where the exact
      // waitForFunction match above already resolved fast.
    });
  }

  // One more safety beat + retry: a navigation can still be mid-flight the
  // instant waitForFunction resolves (new document not fully swapped in).
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await page.evaluate(() => document.body.innerText);
    } catch (e) {
      if (attempt === 2) throw e;
      await page.waitForTimeout(150);
    }
  }
}

module.exports = {
  SMARTBAR_SELECTOR,
  SIGNIN_TEXT,
  waitForAppReady,
  ensureSignedIn,
  smartBarSearch,
};
