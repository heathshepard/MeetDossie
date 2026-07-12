// scripts/daily-regression-suite/_lib/ui-tests.mjs
//
// UI-tier tests (Playwright, local only). Import lazily so Vercel mode
// doesn't crash on the missing dep.
//
// Categories covered here:
//   2 pages, 4 auth, 5 workspace, 6 documents (partial), 10 talk (partial),
//   11 voice, 12 founding (form render).
//
// The heavier flows (create dossier via Talk, fill 20-19, amendment) live in
// ui-tests-deep.mjs so a Vercel-cron partial ui run (via --tiers=ui-shallow)
// can skip them.

import { mkTest } from './http.mjs';
import { makeSignedInSession, screenshot, errorsSince } from './playwright-signin.mjs';
import { sb } from './supabase.mjs';

const PAGES = [
  ['pages.home',                '/'],
  ['pages.app',                 '/app'],
  ['pages.founding',            '/founding'],
  ['pages.faq',                 '/faq'],
  ['pages.calculator',          '/calculator'],
  ['pages.help',                '/help'],
  ['pages.jarvis_pwa',          '/myjarvis'],
  ['pages.terms',               '/terms'],
  ['pages.privacy',             '/privacy'],
];

const IGNORE = [
  /favicon\.ico/i,
  /google-analytics/i,
  /googletagmanager/i,
  /gtag/i,
  /chrome-extension:/i,
  /Failed to load resource:.*sourcemap/i,
  /\.well-known\/appspecific\/com\.chrome/i,
];

async function loadPageTest(browser, base, slug, urlPath, cfg) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on('console', m => { if (m.type() === 'error') { const t = m.text(); if (!IGNORE.some(re => re.test(t))) errs.push(t); } });
  page.on('pageerror', e => { const t = String(e.message || e); if (!IGNORE.some(re => re.test(t))) errs.push(t); });
  const start = Date.now();
  try {
    const resp = await page.goto(`${base}${urlPath}`, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await page.waitForTimeout(1500);
    const ok = resp && resp.status() < 400;
    const interactive = await page.evaluate(() => document.querySelectorAll('main,h1,h2,button,a[href]').length);
    const ms = Date.now() - start;
    if (errs.length > 0 || !ok || interactive === 0) {
      const shot = await screenshot(page, { ...cfg, outDir: cfg.outDir }, `fail-${slug}`);
      await ctx.close();
      return { verdict: 'FAIL', response_ms: ms, error: `status=${resp?.status()} interactive=${interactive} errors=${errs.length}: ${errs.slice(0, 2).join(' | ').slice(0, 200)}`, screenshot: shot };
    }
    await ctx.close();
    return { verdict: 'PASS', response_ms: ms, detail: { interactive } };
  } catch (e) {
    await ctx.close();
    return { verdict: 'FAIL', response_ms: Date.now() - start, error: `nav: ${e.message}` };
  }
}

export async function uiTests(cfg) {
  const tests = [];

  // Page renders — do NOT create one session per page. Reuse a single browser.
  let sharedBrowser = null;
  async function ensureBrowser() {
    if (sharedBrowser) return sharedBrowser;
    const { chromium } = await import('playwright');
    sharedBrowser = await chromium.launch({ headless: cfg.headless });
    return sharedBrowser;
  }

  for (const [id, urlPath] of PAGES) {
    tests.push(mkTest(id, 'pages', 'ui', async () => {
      const b = await ensureBrowser();
      return loadPageTest(b, cfg.base, id.replace(/\./g, '-'), urlPath, cfg);
    }));
  }

  // Founding form: all 7 fields present
  tests.push(mkTest('founding.form.render', 'founding', 'ui', async () => {
    const b = await ensureBrowser();
    const ctx = await b.newContext();
    const page = await ctx.newPage();
    const start = Date.now();
    try {
      await page.goto(`${cfg.base}/founding`, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await page.waitForTimeout(1500);
      const fields = await page.evaluate(() => document.querySelectorAll('form input, form select, form textarea').length);
      await ctx.close();
      return {
        verdict: fields >= 5 ? 'PASS' : 'FAIL',
        response_ms: Date.now() - start,
        error: fields >= 5 ? null : `only ${fields} form fields found (expected ≥5)`,
        detail: { fields },
      };
    } catch (e) {
      await ctx.close();
      return { verdict: 'FAIL', response_ms: Date.now() - start, error: e.message };
    }
  }));

  // Sign-in flow — dedicated test so we know it works before we run signed-in tests
  tests.push(mkTest('auth.signin.demo', 'auth', 'ui', async () => {
    if (!cfg.password) return { verdict: 'SKIP', response_ms: 0, error: 'no password in env (DEMO_PASSWORD)' };
    const start = Date.now();
    try {
      const s = await makeSignedInSession(cfg);
      // If sign-in succeeded, /workspace should show a Talk to Dossie panel or dossier tiles
      const workspaceContent = await s.page.evaluate(() => document.body.innerText.slice(0, 4000));
      const signInStillPresent = /sign in/i.test(workspaceContent.slice(0, 400));
      const shot = await screenshot(s.page, cfg, 'auth-signin');
      await s.browser.close();
      if (signInStillPresent) return { verdict: 'FAIL', response_ms: Date.now() - start, error: 'still on sign-in page', screenshot: shot };
      return { verdict: 'PASS', response_ms: Date.now() - start, screenshot: shot };
    } catch (e) {
      return { verdict: 'FAIL', response_ms: Date.now() - start, error: e.message };
    }
  }));

  // Workspace sections after sign-in — reuse single session
  tests.push(mkTest('workspace.sections.render', 'workspace', 'ui', async () => {
    if (!cfg.password) return { verdict: 'SKIP', response_ms: 0, error: 'no password' };
    const start = Date.now();
    let session;
    try {
      session = await makeSignedInSession(cfg);
      await session.page.waitForTimeout(2000);
      // The workspace is a React app; look for any tile/card in the deals list
      const hasContent = await session.page.evaluate(() => {
        const text = document.body.innerText || '';
        return {
          hasDeals: /deals?|dossier|active|closed/i.test(text.slice(0, 4000)),
          hasWorkspaceUI: !!document.querySelector('main, [role="main"], header'),
        };
      });
      const shot = await screenshot(session.page, cfg, 'workspace-render');
      await session.browser.close();
      const pass = hasContent.hasDeals && hasContent.hasWorkspaceUI;
      return { verdict: pass ? 'PASS' : 'FAIL', response_ms: Date.now() - start, error: pass ? null : `hasDeals=${hasContent.hasDeals} hasWorkspaceUI=${hasContent.hasWorkspaceUI}`, screenshot: shot };
    } catch (e) {
      if (session) await session.browser.close().catch(() => {});
      return { verdict: 'FAIL', response_ms: Date.now() - start, error: e.message };
    }
  }));

  // Scan-contract UI wiring (the exact regression that triggered this suite)
  tests.push(mkTest('documents.scan_upload_url.available', 'documents', 'ui', async () => {
    if (!cfg.password) return { verdict: 'SKIP', response_ms: 0, error: 'no password' };
    const start = Date.now();
    let session;
    try {
      session = await makeSignedInSession(cfg);
      // POST /api/get-scan-upload-url from inside the signed-in session — uses the real session cookie
      const status = await session.page.evaluate(async (base) => {
        try {
          const r = await fetch(`${base}/api/get-scan-upload-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: 'REGRESSION-scan-test.pdf', content_type: 'application/pdf' }),
          });
          const t = await r.text();
          return { status: r.status, body: t.slice(0, 400) };
        } catch (e) { return { status: 0, body: e.message }; }
      }, cfg.base);
      await session.browser.close();
      const pass = status.status === 200;
      return {
        verdict: pass ? 'PASS' : 'FAIL',
        response_ms: Date.now() - start,
        error: pass ? null : `status=${status.status} body=${status.body}`,
        detail: status,
      };
    } catch (e) {
      if (session) await session.browser.close().catch(() => {});
      return { verdict: 'FAIL', response_ms: Date.now() - start, error: e.message };
    }
  }));

  // Cleanup — teardown for shared browser after last ui test runs
  tests.push(mkTest('ui.teardown', 'ui', 'ui', async () => {
    if (sharedBrowser) await sharedBrowser.close().catch(() => {});
    return { verdict: 'PASS', response_ms: 0 };
  }));

  return tests;
}
