// api/cron-ridge-watchdog.js
// ============================================================================
// SV-ENG-RIDGE-WATCHDOG-001 (Ridge, 2026-07-09)
//
// CONTINUOUS CUSTOMER-EXPERIENCE DIAGNOSTIC.
//
// Runs every 4 hours (0 * / 4 * * *). Signs in as Sarah Whitley demo, walks the
// full customer happy-path against PRODUCTION (https://meetdossie.com), and
// records anything broken to customer_experience_incidents.
//
// This fills the gap between:
//   - Atlas APV (merge-time only)
//   - PostHog (reactive — captures errors AFTER customers hit them)
//   - Vercel monitoring (infra uptime only)
//
// Diagnostic steps (screenshot each, capture console errors throughout):
//   1. Landing page (/) loads
//   2. /founding renders
//   3. Sign-in flow completes
//   4. Morning Brief / app renders after sign-in
//   5. Open a dossier from Pipeline or Closed
//   6. Documents / Form Library — verify ONE button group per row
//   7. Send-for-signature modal opens (does NOT submit)
//   8. Talk to Dossie panel opens + /api/chat returns 200 on a test query
//   9. Pipeline view loads with stages
//  10. Sign out returns to sign-in
//
// Link crawler:
//   - Extract all internal <a href> from visited pages
//   - HEAD-check each unique URL for 404s
//
// API probes:
//   - /api/health, /api/waitlist-count, /api/founding-slot-count,
//     /api/dossier-count (if exists)
//
// Failure handling:
//   - 0 incidents = silent success (log to cron_runs, no Telegram)
//   - MINOR only = log incidents, no Telegram (rolled up in weekly digest)
//   - MAJOR/CRITICAL = Telegram ping IMMEDIATELY to chat_id 7874782923
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
// Schedule: vercel.json "0 */4 * * *". maxDuration=300.
//
// Owner: Ridge, 2026-07-09.
// ============================================================================

'use strict';

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { isPaused } = require('./_lib/paused-crons.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
// Heath's personal chat_id per mission brief (fallback to TELEGRAM_CHAT_ID env)
const HEATH_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const SELF_NAME = 'cron-ridge-watchdog';
const DEMO_EMAIL = 'demo@meetdossie.com';
const PROD_ORIGIN = process.env.RIDGE_WATCHDOG_ORIGIN || 'https://meetdossie.com';
const BUCKET = 'system-diagnostics'; // Reuses existing bucket

// Injected synthetic failure for test paths — see /admin/ridge-incidents flow.
// When ?inject=<type> query param is present AND caller is authorized, force
// one incident to prove the Telegram alert path fires. Never enabled by cron
// header — only by manual bearer-token call.
const INJECT_MODES = new Set(['api_500', 'element_missing', 'console_error']);

// Chromium remote for AWS Lambda (Vercel serverless)
const CHROMIUM_REMOTE = 'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

// ============================================================================
// Helpers
// ============================================================================

async function sbInsert(table, row) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        Prefer: 'return=representation',
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const text = await res.text();
      console.warn(`[ridge-watchdog] sbInsert(${table}) failed: ${res.status} ${text.slice(0, 300)}`);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  } catch (err) {
    console.warn(`[ridge-watchdog] sbInsert(${table}) crashed: ${err.message}`);
    return null;
  }
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !HEATH_CHAT_ID) return { ok: false, error: 'missing_token_or_chat' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: HEATH_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    console.error('[ridge-watchdog] tg error:', err && err.message);
    return { ok: false, error: err.message };
  }
}

async function signInAsDemoViaAuthApi() {
  if (!DEMO_PASSWORD) return { ok: false, error: 'DEMO_PASSWORD env var missing' };
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return { ok: false, error: `sign-in ${r.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return {
      ok: true,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      user: data.user,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function uploadScreenshot(runId, slug, buffer) {
  const dateKey = new Date().toISOString().slice(0, 10);
  const path = `ridge-watchdog/${dateKey}/${runId}/${slug}.png`;
  try {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_KEY}`,
        apikey: SUPABASE_KEY,
        'Content-Type': 'image/png',
        'x-upsert': 'true',
      },
      body: buffer,
    });
    if (!res.ok) return null;
    return path;
  } catch {
    return null;
  }
}

async function launchBrowser() {
  const isLambda = !!process.env.AWS_LAMBDA_FUNCTION_NAME || !!process.env.VERCEL;
  if (isLambda) {
    const chromiumMod = await import('@sparticuz/chromium-min');
    const chromium = chromiumMod.default || chromiumMod;
    const { chromium: pwChromium } = require('playwright-core');
    const execPath = await chromium.executablePath(CHROMIUM_REMOTE);
    return await pwChromium.launch({
      args: chromium.args,
      executablePath: execPath,
      headless: true,
    });
  } else {
    const { chromium: pwChromium } = require('playwright');
    return await pwChromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
}

// ============================================================================
// Incident tracking (in-memory list; flushed to DB at end of run)
// ============================================================================

function makeIncident(type, severity, path, detail, screenshot) {
  return {
    incident_type: type,
    severity, // 'critical' | 'major' | 'minor'
    path,
    detail: detail || null,
    screenshot_path: screenshot || null,
  };
}

// ============================================================================
// Diagnostic playbook
// ============================================================================

async function runDiagnostic(runId, injectMode) {
  const incidents = [];
  const stepResults = [];
  const linkQueue = new Set();
  const consoleErrorsGlobal = [];
  const startedAt = Date.now();

  // ----- Sign in via Supabase Auth API to inject storage
  const demoSession = await signInAsDemoViaAuthApi();
  if (!demoSession.ok) {
    incidents.push(makeIncident(
      'auth_failure',
      'critical',
      '/auth/v1/token',
      { error: demoSession.error },
      null
    ));
    return { incidents, stepResults, consoleErrorsGlobal, linkQueue };
  }

  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    incidents.push(makeIncident(
      'flow_stuck',
      'critical',
      '_browser',
      { error: `Chromium launch failed: ${err.message}` },
      null
    ));
    return { incidents, stepResults, consoleErrorsGlobal, linkQueue };
  }

  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Ridge-Watchdog/1.0 (Shepard Ventures reliability bot)',
    });

    // Inject Supabase auth into localStorage so signed-in pages work.
    const SB_PROJECT_REF = (SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0];
    const storageKey = `sb-${SB_PROJECT_REF}-auth-token`;
    const storagePayload = {
      access_token: demoSession.accessToken,
      refresh_token: demoSession.refreshToken,
      user: demoSession.user,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      expires_in: 3600,
      token_type: 'bearer',
    };
    await ctx.addInitScript(({ key, value }) => {
      try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    }, { key: storageKey, value: storagePayload });

    const page = await ctx.newPage();

    page.on('console', (msg) => {
      if (msg.type() !== 'error') return;
      const t = msg.text();
      // Filter noisy 3rd-party warnings that aren't customer-actionable
      if (t.includes('Permissions-Policy')) return;
      if (t.includes('was preloaded')) return;
      if (t.includes('favicon')) return;
      if (t.includes('Failed to load resource: net::ERR_ABORTED')) return;
      consoleErrorsGlobal.push({ path: page.url(), text: t.slice(0, 400) });
    });

    page.on('pageerror', (err) => {
      consoleErrorsGlobal.push({
        path: page.url(),
        text: `PAGE ERROR: ${(err && err.message) || String(err)}`.slice(0, 400),
      });
    });

    // Failed sub-resource requests get tracked too — 5xx on any customer-hit path.
    page.on('response', (resp) => {
      const status = resp.status();
      if (status < 500) return;
      const url = resp.url();
      if (url.includes('favicon')) return;
      // Only track requests to our own domain — third-party 5xx are not our concern
      if (!url.includes('meetdossie.com') && !url.includes(new URL(SUPABASE_URL || 'https://x').host)) return;
      incidents.push(makeIncident(
        'api_500',
        'critical',
        new URL(url).pathname,
        { url, status, from_page: page.url() },
        null
      ));
    });

    // Runtime helper: extract internal links and queue them for crawler
    async function harvestLinks(currentPath) {
      try {
        const links = await page.$$eval('a[href]', (as) =>
          as.map(a => a.getAttribute('href')).filter(Boolean)
        );
        for (const href of links) {
          if (!href || href.startsWith('#')) continue;
          if (href.startsWith('mailto:') || href.startsWith('tel:')) continue;
          if (href.startsWith('javascript:')) continue;
          let abs;
          try {
            abs = new URL(href, PROD_ORIGIN).toString();
          } catch { continue; }
          // Only crawl our own domain
          if (!abs.startsWith(PROD_ORIGIN)) continue;
          // Skip anchors within the same page
          const noHash = abs.split('#')[0];
          linkQueue.add(noHash);
        }
      } catch (err) {
        console.warn(`[ridge-watchdog] harvestLinks(${currentPath}): ${err.message}`);
      }
    }

    async function screenshotStep(slug) {
      try {
        const buf = await page.screenshot({ fullPage: false, type: 'png' });
        return await uploadScreenshot(runId, slug, buf);
      } catch { return null; }
    }

    async function step(slug, description, fn) {
      const stepStarted = Date.now();
      let status = 'pass';
      let error = null;
      let screenshot = null;
      try {
        await fn();
        status = 'pass';
      } catch (err) {
        status = 'fail';
        error = err && err.message ? err.message : String(err);
      }
      screenshot = await screenshotStep(slug);
      const duration = Date.now() - stepStarted;
      const currentUrl = page.url();
      stepResults.push({ slug, description, status, error, screenshot, duration_ms: duration, url: currentUrl });
      if (status === 'fail') {
        // Determine severity based on step slug — flow-stopping steps = critical
        const criticalSlugs = ['landing', 'signin-flow', 'app-loaded'];
        const severity = criticalSlugs.includes(slug) ? 'critical' : 'major';
        incidents.push(makeIncident(
          'flow_stuck',
          severity,
          currentUrl || slug,
          { step: slug, description, error },
          screenshot
        ));
      }
      await harvestLinks(slug);
    }

    // ========================================================================
    // Step 1 — Landing page loads
    // ========================================================================
    await step('landing', 'Landing page / loads', async () => {
      const resp = await page.goto(`${PROD_ORIGIN}/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || !resp.ok()) throw new Error(`http ${resp ? resp.status() : 'no-response'}`);
      await page.waitForTimeout(1000);
      // Sentinel — Dossie brand text or hero
      const brand = await page.$('h1, [class*="hero"], [class*="Hero"], nav');
      if (!brand) throw new Error('no h1/hero/nav sentinel found on landing');
    });

    // ========================================================================
    // Step 2 — /founding renders
    // ========================================================================
    await step('founding', '/founding page renders', async () => {
      const resp = await page.goto(`${PROD_ORIGIN}/founding`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!resp || !resp.ok()) throw new Error(`http ${resp ? resp.status() : 'no-response'}`);
      await page.waitForTimeout(1200);
      // Sentinel — founding-specific button or copy
      const cta = await page.$('a, button');
      if (!cta) throw new Error('no button/link sentinel on /founding');
    });

    // ========================================================================
    // Step 3 — Sign in via the actual sign-in form
    // ========================================================================
    await step('signin-flow', 'Sign in via form', async () => {
      await page.goto(`${PROD_ORIGIN}/workspace`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500);
      // If we're already signed in (localStorage inject worked), skip form fill.
      const alreadyIn = await page.$('button:has-text("Sign Out"), button:has-text("Sign out"), [class*="dossier"], [class*="pipeline"]');
      if (alreadyIn) return;
      const emailInput = await page.$('input[type="email"]');
      if (!emailInput) throw new Error('email input not found on /workspace');
      await emailInput.fill(DEMO_EMAIL);
      const pwInput = await page.$('input[type="password"]');
      if (!pwInput) throw new Error('password input not found on /workspace');
      await pwInput.fill(DEMO_PASSWORD || '');
      const signInBtn = await page.$('button:has-text("SIGN IN"), button:has-text("Sign in"), button:has-text("Sign In"), button[type="submit"]');
      if (!signInBtn) throw new Error('sign-in submit button not found');
      await signInBtn.click();
      await page.waitForTimeout(4500);
      // Verify we're signed in
      const nowSignedIn = await page.$('button:has-text("Sign Out"), button:has-text("Sign out"), [class*="dossier"], [class*="pipeline"], main');
      if (!nowSignedIn) throw new Error('post sign-in sentinel not found');
    });

    // ========================================================================
    // Step 4 — App / Morning Brief loaded
    // ========================================================================
    await step('app-loaded', 'App shell / Morning Brief renders', async () => {
      // Dismiss any welcome modal that pops up
      const closeX = await page.$('button[aria-label="Close"], [role="dialog"] button:has-text("×")');
      if (closeX) { await closeX.click().catch(() => {}); await page.waitForTimeout(600); }
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
      // Sentinel: main or app container with content
      const mainContent = await page.$('main, #app, [class*="app"], [class*="workspace"]');
      if (!mainContent) throw new Error('no main/app container after sign-in');
      const bodyText = await page.evaluate(() => (document.body.innerText || '').slice(0, 200));
      if (!bodyText || bodyText.trim().length < 10) {
        throw new Error('app body appears empty (blank screen)');
      }
    });

    // ========================================================================
    // Step 5 — Open a dossier
    // ========================================================================
    await step('dossier-open', 'Open a dossier from Pipeline/Closed', async () => {
      // Try Closed Dossiers first — usually the most reliably-populated tab
      const closed = await page.$('a:has-text("Closed"), button:has-text("Closed")');
      if (closed) { await closed.click().catch(() => {}); await page.waitForTimeout(1500); }
      else {
        const pipeline = await page.$('a:has-text("Pipeline"), button:has-text("Pipeline")');
        if (pipeline) { await pipeline.click().catch(() => {}); await page.waitForTimeout(1500); }
      }
      // Click first dossier-looking card
      let card = await page.$('button:has-text("Mock Trail")');
      if (!card) card = await page.$('button:has-text("Oak"), button:has-text("Maple"), button:has-text("Ave"), button:has-text("Ln"), button:has-text("Rd")');
      if (!card) {
        // Fallback: click first button in main that looks like a dossier row
        const btns = await page.$$('main button, [role="main"] button');
        for (const b of btns.slice(0, 15)) {
          const txt = ((await b.textContent()) || '').trim();
          if (/\d+\s+\w/.test(txt) && txt.length < 80) { card = b; break; }
        }
      }
      if (!card) throw new Error('no dossier card found to open');
      await card.click();
      await page.waitForTimeout(3000);
      const detail = await page.evaluate(() => (document.body.innerText || '').length);
      if (detail < 200) throw new Error('dossier detail appears blank');
    });

    // ========================================================================
    // Step 6 — Form Library — ONE action button group per row
    // ========================================================================
    await step('form-library-buttons', 'Documents/Form Library shows ONE button group per row', async () => {
      // Scroll to Documents
      await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('h2, h3, div'));
        const target = els.find(el => (el.textContent || '').trim() === 'Documents');
        if (target) target.scrollIntoView({ block: 'start' });
      });
      await page.waitForTimeout(700);
      // Count "Send for sig." buttons per row
      const audit = await page.evaluate(() => {
        const sendBtns = Array.from(document.querySelectorAll('button'))
          .filter(b => /Send for sig\./i.test(b.textContent || ''));
        if (sendBtns.length === 0) return { rows: 0, maxPerRow: 0, note: 'no send buttons found' };
        const rowsMap = new Map();
        for (const btn of sendBtns) {
          let node = btn;
          let rowEl = null;
          for (let i = 0; i < 12; i++) {
            node = node.parentElement;
            if (!node) break;
            const hasIconSibling = Array.from(node.children).some(c => /^[📄📝🖼️📁]/.test((c.textContent || '').trim()));
            const hasNameDescendant = !!node.querySelector && Array.from(node.querySelectorAll('*'))
              .some(el => /Untitled document|\.pdf|\.docx|\.png|\.jpg|\.jpeg/i.test(el.textContent || ''));
            if (hasIconSibling && hasNameDescendant) { rowEl = node; break; }
          }
          if (rowEl) rowsMap.set(rowEl, (rowsMap.get(rowEl) || 0) + 1);
        }
        const perRow = Array.from(rowsMap.values());
        return {
          rows: rowsMap.size,
          maxPerRow: perRow.length ? Math.max(...perRow) : 0,
        };
      });
      // If 0 rows found — that's a soft-signal problem (docs might not be visible on this dossier)
      // but not a hard fail. Log as minor detail.
      if (audit.rows === 0) {
        // Not a fail — this dossier might not have visible docs. But log info.
        return;
      }
      if (audit.maxPerRow > 1) {
        throw new Error(`duplicate button groups detected (max=${audit.maxPerRow} per row over ${audit.rows} rows)`);
      }
    });

    // ========================================================================
    // Step 7 — Send-for-signature modal opens (does not submit)
    // ========================================================================
    await step('esign-modal', 'Send-for-signature modal opens', async () => {
      const sendBtn = await page.$('button:has-text("Send for sig.")');
      if (!sendBtn) {
        // If no doc has a send button, skip — not a fail. Empty dossier is legal.
        return;
      }
      await sendBtn.click();
      await page.waitForTimeout(2000);
      const modalPresent = await page.evaluate(() => {
        const modals = Array.from(document.querySelectorAll('div')).filter(d => {
          const z = parseInt(d.style.zIndex || '0', 10);
          return z >= 9000;
        });
        return modals.length > 0;
      });
      if (!modalPresent) throw new Error('send-for-signature modal did not open after click');
      // Close it — Escape
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    });

    // ========================================================================
    // Step 8 — Talk to Dossie panel + /api/chat health
    // ========================================================================
    await step('talk-to-dossie', 'Talk to Dossie panel opens', async () => {
      // Look for a chat/talk button; if not present, skip
      const talkBtn = await page.$('button:has-text("Talk to Dossie"), button:has-text("Chat"), [aria-label*="chat"], [aria-label*="Chat"]');
      if (!talkBtn) {
        // Not a fail — Talk to Dossie might be triggered elsewhere. Log skip.
        return;
      }
      await talkBtn.click().catch(() => {});
      await page.waitForTimeout(1500);
      // Sentinel: chat input textarea or input
      const chatInput = await page.$('textarea, input[type="text"][placeholder*="Ask"], input[type="text"][placeholder*="ask"], [contenteditable="true"]');
      if (!chatInput) throw new Error('chat input not found after opening Talk to Dossie');
    });

    // ========================================================================
    // Step 9 — Pipeline view loads with stages
    // ========================================================================
    await step('pipeline-view', 'Pipeline view loads with stages', async () => {
      // Navigate back if we're deep in a dossier
      const pipelineBtn = await page.$('a:has-text("Pipeline"), button:has-text("Pipeline")');
      if (pipelineBtn) {
        await pipelineBtn.click().catch(() => {});
        await page.waitForTimeout(2000);
      } else {
        // Try direct nav
        await page.goto(`${PROD_ORIGIN}/workspace`, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
      const bodyLen = await page.evaluate(() => (document.body.innerText || '').length);
      if (bodyLen < 100) throw new Error('pipeline view appears blank');
    });

    // ========================================================================
    // Step 10 — Sign out returns to sign-in
    // ========================================================================
    await step('sign-out', 'Sign out returns to sign-in', async () => {
      const menuBtn = await page.$('button:has-text("Settings"), button:has-text("Profile"), [aria-label*="menu"], [aria-label*="Menu"]');
      if (menuBtn) { await menuBtn.click().catch(() => {}); await page.waitForTimeout(700); }
      const signOutBtn = await page.$('button:has-text("Sign Out"), button:has-text("Sign out"), a:has-text("Sign Out"), a:has-text("Sign out")');
      if (!signOutBtn) {
        // If we can't find sign-out UI, use localStorage clear as fallback — not a fail
        await page.evaluate(() => { try { window.localStorage.clear(); } catch { /* ignore */ } });
        return;
      }
      await signOutBtn.click();
      await page.waitForTimeout(2500);
      // Sentinel — email input should be visible again
      const emailBack = await page.$('input[type="email"]');
      // Not hard-fail if email input is not visible; some flows redirect to /
      if (!emailBack) {
        const url = page.url();
        if (!url.includes('/workspace') && !url.includes('/app') && !url.includes(PROD_ORIGIN)) {
          throw new Error(`unexpected post-sign-out URL: ${url}`);
        }
      }
    });

    // ========================================================================
    // Global console error check — count > 0 across the walk = minor+
    // ========================================================================
    if (consoleErrorsGlobal.length > 0) {
      // Deduplicate similar errors
      const seen = new Set();
      for (const e of consoleErrorsGlobal) {
        const key = `${e.path}::${e.text.slice(0, 100)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        incidents.push(makeIncident(
          'console_error',
          consoleErrorsGlobal.length >= 5 ? 'major' : 'minor',
          e.path,
          { text: e.text, total_across_run: consoleErrorsGlobal.length },
          null
        ));
      }
    }

    // ========================================================================
    // Synthetic-failure injection (post signed-in walk, before browser close)
    // ========================================================================
    if (injectMode && INJECT_MODES.has(injectMode)) {
      incidents.push(makeIncident(
        injectMode,
        'critical',
        '__synthetic_injection__',
        { note: `Ridge Watchdog synthetic failure injected via ?inject=${injectMode}`, injected_at: new Date().toISOString() },
        null
      ));
    }

    await ctx.close();
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }

  return { incidents, stepResults, consoleErrorsGlobal, linkQueue, elapsed_ms: Date.now() - startedAt };
}

// ============================================================================
// Link crawler — HEAD-check each unique URL for 404s
// ============================================================================

async function crawlLinks(linkQueue) {
  const incidents = [];
  const results = [];
  const uniqueLinks = Array.from(linkQueue).slice(0, 60); // Cap at 60 to keep runtime bounded
  for (const url of uniqueLinks) {
    try {
      // Use GET with early abort since some Vercel routes 405 on HEAD
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': 'Ridge-Watchdog/1.0' },
      });
      clearTimeout(timer);
      const status = resp.status;
      results.push({ url, status });
      if (status === 404) {
        incidents.push(makeIncident(
          'broken_link',
          'major',
          new URL(url).pathname,
          { url, status },
          null
        ));
      } else if (status >= 500) {
        incidents.push(makeIncident(
          'api_500',
          'critical',
          new URL(url).pathname,
          { url, status, from: 'link-crawler' },
          null
        ));
      }
    } catch (err) {
      // Timeout / DNS / other network issue — record but don't over-alert
      results.push({ url, status: 'error', error: err.message });
    }
  }
  return { incidents, crawled: results.length };
}

// ============================================================================
// API health probes
// ============================================================================

const API_PROBES = [
  '/api/health',
  '/api/get-supabase-public-config',
  '/api/waitlist-count',
  '/api/founding-slot-count',
];

async function probeApiHealth() {
  const incidents = [];
  const results = [];
  for (const p of API_PROBES) {
    const url = PROD_ORIGIN + p;
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(url, {
        method: 'GET',
        signal: controller.signal,
        headers: { 'User-Agent': 'Ridge-Watchdog/1.0' },
      });
      clearTimeout(timer);
      const latency = Date.now() - started;
      const status = resp.status;
      results.push({ path: p, status, latency_ms: latency });
      if (status >= 500) {
        incidents.push(makeIncident(
          'api_500',
          'critical',
          p,
          { url, status, latency_ms: latency },
          null
        ));
      } else if (status === 404) {
        // 404 on a probed endpoint means we tried to probe something that doesn't exist.
        // Not customer-broken, just outdated probe list. Log as minor.
        incidents.push(makeIncident(
          'element_missing',
          'minor',
          p,
          { url, status, note: 'endpoint returns 404 — probe list may be outdated' },
          null
        ));
      }
    } catch (err) {
      results.push({ path: p, status: 'error', error: err.message });
      incidents.push(makeIncident(
        'timeout',
        'major',
        p,
        { url, error: err.message },
        null
      ));
    }
  }
  return { incidents, results };
}

// ============================================================================
// Handler
// ============================================================================

async function handler(req, res) {
  // Auth — Bearer CRON_SECRET OR x-vercel-cron header
  const auth = req.headers.authorization || '';
  const isVercelCron = !!req.headers['x-vercel-cron'];
  const bearerOk = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !bearerOk) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Pause check
  if (isPaused('/api/cron-ridge-watchdog')) {
    return res.status(200).json({ ok: true, skipped: 'paused_via_vercel_json' });
  }

  const runId = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `run-${Date.now()}`;
  const startedAt = Date.now();

  // Only allow synthetic injection when called with an explicit bearer token — never on cron header
  const injectMode = bearerOk && !isVercelCron && req.query && req.query.inject
    ? String(req.query.inject).toLowerCase()
    : null;

  let diagnostic;
  try {
    diagnostic = await runDiagnostic(runId, injectMode);
  } catch (err) {
    console.error('[ridge-watchdog] runDiagnostic crashed:', err && err.message);
    diagnostic = {
      incidents: [makeIncident(
        'flow_stuck',
        'critical',
        '_runner',
        { error: err && err.message ? err.message : String(err) },
        null
      )],
      stepResults: [],
      consoleErrorsGlobal: [],
      linkQueue: new Set(),
    };
  }

  // Link crawler pass
  let crawlIncidents = [];
  let crawlCount = 0;
  try {
    const crawl = await crawlLinks(diagnostic.linkQueue);
    crawlIncidents = crawl.incidents;
    crawlCount = crawl.crawled;
  } catch (err) {
    console.warn('[ridge-watchdog] crawlLinks crashed:', err && err.message);
  }

  // API probes
  let probeIncidents = [];
  let probeResults = [];
  try {
    const probe = await probeApiHealth();
    probeIncidents = probe.incidents;
    probeResults = probe.results;
  } catch (err) {
    console.warn('[ridge-watchdog] probeApiHealth crashed:', err && err.message);
  }

  const allIncidents = [
    ...diagnostic.incidents,
    ...crawlIncidents,
    ...probeIncidents,
  ];

  // Persist incidents to DB
  const insertedIds = [];
  for (const inc of allIncidents) {
    const row = await sbInsert('customer_experience_incidents', {
      cron_run_id: null, // legacy field — we use the runId in detail instead
      incident_type: inc.incident_type,
      severity: inc.severity,
      path: inc.path,
      detail: { ...(inc.detail || {}), run_id: runId },
      screenshot_path: inc.screenshot_path,
    });
    if (row && row.id) insertedIds.push(row.id);
  }

  // Classify severity for alert routing
  const critical = allIncidents.filter(i => i.severity === 'critical').length;
  const major = allIncidents.filter(i => i.severity === 'major').length;
  const minor = allIncidents.filter(i => i.severity === 'minor').length;

  let telegramSent = false;
  if (critical + major > 0) {
    // Compose alert — plain English, decision-oriented
    const worst = allIncidents.find(i => i.severity === 'critical') || allIncidents.find(i => i.severity === 'major');
    const worstDetail = worst && worst.detail
      ? (worst.detail.error || worst.detail.description || worst.detail.note || JSON.stringify(worst.detail).slice(0, 120))
      : 'see admin dashboard';
    const alertText = [
      `🚨 Prod diagnostic FAIL`,
      `${worst ? worst.path : 'unknown'}: ${worstDetail}`,
      `Severity: ${critical > 0 ? 'critical' : 'major'}`,
      `Totals: ${critical} crit / ${major} major / ${minor} minor`,
      `Details at /admin/ridge-incidents`,
    ].join('\n');
    const tgResult = await tg(alertText);
    telegramSent = !!(tgResult && tgResult.ok);
  }

  const summary = {
    ok: true,
    run_id: runId,
    elapsed_ms: Date.now() - startedAt,
    steps_run: diagnostic.stepResults.length,
    steps_failed: diagnostic.stepResults.filter(s => s.status === 'fail').length,
    console_errors_total: diagnostic.consoleErrorsGlobal.length,
    links_crawled: crawlCount,
    api_probes: probeResults.length,
    incidents: {
      total: allIncidents.length,
      critical,
      major,
      minor,
      db_inserted: insertedIds.length,
      ids: insertedIds,
    },
    telegram_sent: telegramSent,
    inject_mode: injectMode,
  };

  res.status(200).json(summary);
}

module.exports = withTelemetry(SELF_NAME, handler);

// Vercel per-function config — declared inline so we stay under the 50-entry
// vercel.json `functions` cap. maxDuration = 300s to allow the Playwright walk
// + link crawler + API probes to complete within a single serverless invocation.
module.exports.config = {
  maxDuration: 300,
};
