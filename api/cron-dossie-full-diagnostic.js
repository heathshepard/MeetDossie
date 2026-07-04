// api/cron-dossie-full-diagnostic.js
// ============================================================================
// SV-ENG-RIDGE-DIAGNOSTIC-001 (ridge_1, 2026-06-20)
//
// DAILY FULL-SYSTEM DOSSIE DIAGNOSTIC.
//
// Runs every day at 5 AM CST (10:00 UTC). Heath can also trigger manually
// via api/system-diagnostics-trigger or directly with CRON_SECRET.
//
// Five phases:
//   1. PLAYWRIGHT FRONT-END SWEEP — every customer-facing URL, sign in,
//      tap primary CTA, capture console errors + slow requests + broken
//      images + broken links. Screenshot each.
//   2. API HEALTH PROBE — GET/POST every public endpoint with appropriate
//      auth; verify 200 + schema-ish shape. Flag 5xx + unexpected payloads.
//   3. CRON HEARTBEAT AUDIT — for every cron in vercel.json's `crons` list,
//      look up its last cron_runs row and flag any whose silence exceeds
//      its expected interval × 2.
//   4. CUSTOMER DATA HEALTH — MRR claim vs active subscriptions; founding
//      apps pending >24h; email_queue stuck items; sage_inbox stalls.
//   5. IMPROVEMENT OPPORTUNITIES — synthesize 3-5 specific upgrade ideas
//      from the data collected (slow pages, fat payloads, silent crons).
//
// Output: one row in system_diagnostics + N rows in system_diagnostic_checks.
// Powers the DOSSIE HEALTH panel in the Jarvis HUD via api/system-diagnostics-latest.
//
// SAFETY:
//   - Read-only on customer data (uses SUPABASE_SERVICE_ROLE_KEY).
//   - Front-end runs in a fresh Chromium headless context against PROD
//     (https://meetdossie.com). Sign in as the demo account ONLY.
//   - All API probes use safe GET endpoints + the demo JWT (never mutates).
//
// Schedule: vercel.json "0 10 * * *" (5 AM CST). maxDuration=300.
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron header.
//
// Tenant model: diagnostic data is tenant-scoped. The cron runs against
// Heath's tenant (TENANT_DOSSIE_DEFAULT) by default; future Zenith customers
// will get their own diagnostic of their own deployment via a per-tenant
// config row (RIDGE_DIAGNOSTIC_CONFIGS — out of scope here, day-1 only ships
// the Dossie diagnostic).
// ============================================================================

'use strict';

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { isPaused, pauseReason } = require('./_lib/paused-crons.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const DEMO_PASSWORD = process.env.DEMO_PASSWORD;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const SELF_NAME = 'cron-dossie-full-diagnostic';

// Heath's tenant id (a9a4c3aa-7278-4f42-ad71-e2e899671fab). Out-of-band
// configurable via env so test envs can swap.
const TENANT_DOSSIE_DEFAULT = process.env.RIDGE_DOSSIE_TENANT_ID
  || 'a9a4c3aa-7278-4f42-ad71-e2e899671fab';

// Demo account used for sign-in flow. Excluded from analytics via is_demo=true.
const DEMO_EMAIL = 'demo@meetdossie.com';

const PROD_ORIGIN = process.env.RIDGE_DIAGNOSTIC_ORIGIN || 'https://meetdossie.com';

const BUCKET = 'system-diagnostics';

// ----- URLs swept on the front-end pass ------------------------------------
// Each URL: a primary CTA the diagnostic taps + a sentinel selector that must
// exist or the page is considered broken. signed_in = should this be tested
// inside a logged-in session?
const FRONTEND_URLS = [
  { slug: 'home',         url: PROD_ORIGIN + '/',             signed_in: false, primary_selector: 'a[href*="founding"], a[href*="/app"]', cta: null },
  { slug: 'founding',     url: PROD_ORIGIN + '/founding',     signed_in: false, primary_selector: 'h1, button, a[href*="founding"]', cta: null },
  { slug: 'agents',       url: PROD_ORIGIN + '/agents',       signed_in: false, primary_selector: 'h1, h2',                    cta: null },
  { slug: 'coordinators', url: PROD_ORIGIN + '/coordinators', signed_in: false, primary_selector: 'h1, h2',                    cta: null },
  { slug: 'calculator',   url: PROD_ORIGIN + '/calculator',   signed_in: false, primary_selector: 'input[type="date"], input[type="number"]', cta: null },
  { slug: 'guides',       url: PROD_ORIGIN + '/guides/',      signed_in: false, primary_selector: 'a, h1, h2',                 cta: null },
  { slug: 'answers',      url: PROD_ORIGIN + '/answers/',     signed_in: false, primary_selector: 'a, h1, h2',                 cta: null },
  // pricing slug removed 2026-06-25 — duplicate of /founding (no separate /pricing page exists)
  // Auth-gated pages — signed in as demo
  { slug: 'app',          url: PROD_ORIGIN + '/app',          signed_in: true,  primary_selector: '#app, [data-testid], body', cta: null },
  { slug: 'workspace',    url: PROD_ORIGIN + '/workspace',    signed_in: true,  primary_selector: '#app, [data-testid], body', cta: null },
];

// ----- API endpoints probed ------------------------------------------------
// Public read-only endpoints. We don't mutate. Each probe asserts a status
// code (200/2xx) and a minimum response shape. Endpoints verified live
// against meetdossie.com on 2026-06-20.
const API_PROBES = [
  // Public
  { slug: 'health',                path: '/api/health',                method: 'GET', auth: 'none', expect_keys: ['status'] },
  { slug: 'get-supabase-config',   path: '/api/get-supabase-public-config', method: 'GET', auth: 'none', expect_keys: ['url'] },
  { slug: 'config',                path: '/api/config',                method: 'GET', auth: 'none' },
  // Authed (demo JWT) — read-only
  { slug: 'documents',             path: '/api/documents',             method: 'GET', auth: 'demo' },
  { slug: 'action-items',          path: '/api/action-items',          method: 'GET', auth: 'demo' },
  { slug: 'jarvis-tickers',        path: '/api/jarvis-tickers',        method: 'GET', auth: 'demo' },
];

// ----- Crons that should fire at least every N minutes ---------------------
// Pulled live from cron_runs at runtime; this object is just the SLA.
// business_hours_only=true means the cron is scheduled only during 14-23 UTC
// (9 AM – 6 PM CDT) and silence outside that window is expected.
const CRON_SLA_MIN = {
  // Critical 24/7 ops
  'cron-mission-watchdog':        { sla: 90 },
  'cron-publish-approved':        { sla: 60 },
  'cron-send-outbound-emails':    { sla: 10 },
  'cron-money-pulse-snapshot':    { sla: 15 },
  'cron-agent-queue-tick':        { sla: 10 },
  // Frequent
  'cron-staging-watcher':         { sla: 15 },
  'cron-verify-zernio-deliveries': { sla: 90 },
  'cron-engagement-veto-mode':    { sla: 90 },
  'cron-sage-autonomous-review':  { sla: 90 },
  'cron-sage-regenerate':         { sla: 90 },
  'cron-sage-first-comment':      { sla: 60 },
  'cron-auto-approve':            { sla: 30 },
  'cron-verify-posts':            { sla: 120 },
  // Business-hours-only — schedule "0 14-23/2 * * *"
  'cron-platform-health-checker': { sla: 4 * 60, business_hours_only: true },
  'cron-account-session-monitor': { sla: 8 * 60 },
  // Daily-ish (alert if no run in 36h)
  'cron-heath-publish-digest':    { sla: 36 * 60 },
  'cron-morning-brief':           { sla: 36 * 60 },
  'cron-customer-morning-brief':  { sla: 36 * 60 },
  'cron-kpi-drift-detector':      { sla: 36 * 60 },
  'cron-pull-post-analytics':     { sla: 36 * 60 },
  'cron-daily-debrief':           { sla: 36 * 60 },
  'cron-daily-platform-health':   { sla: 36 * 60 },
  'cron-elevenlabs-monitor':      { sla: 36 * 60 },
  'cron-affiliate-qualify-referrals': { sla: 36 * 60 },
  'cron-generate-posts':          { sla: 36 * 60 },
  'cron-render-videos':           { sla: 36 * 60 },
  // Weekly
  'cron-weekly-newsletter':       { sla: 9 * 24 * 60 },
  'cron-weekly-scorecard':        { sla: 9 * 24 * 60 },
  'cron-customer-view-digest':    { sla: 9 * 24 * 60 },
};

// Returns true if the current UTC hour is INSIDE the business window for a
// business-hours-only cron. (14-23 UTC = 9 AM – 6 PM CDT.)
function inBusinessHoursUTC() {
  const h = new Date().getUTCHours();
  return h >= 14 && h <= 23;
}

// ============================================================================
// Helpers
// ============================================================================

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[diagnostic] tg error:', err && err.message);
  }
}

async function signInAsDemo() {
  if (!DEMO_PASSWORD) {
    return { ok: false, error: 'DEMO_PASSWORD env var missing' };
  }
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        // Anon key would normally be used here but service role also works for
        // the password grant. Keep service role since it's already loaded.
        Authorization: `Bearer ${SUPABASE_KEY}`,
      },
      body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
    });
    const data = await r.json();
    if (!r.ok || !data.access_token) {
      return { ok: false, error: `sign-in ${r.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return { ok: true, accessToken: data.access_token, refreshToken: data.refresh_token, user: data.user };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function uploadScreenshot(dateKey, runId, slug, buffer) {
  const path = `${dateKey}/${runId}/${slug}.png`;
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

// ============================================================================
// Phase 1: Playwright front-end sweep
// ============================================================================

const CHROMIUM_REMOTE = 'https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar';

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

async function runFrontendSweep(dateKey, runId, demoSession) {
  const checks = [];
  let browser;
  try {
    browser = await launchBrowser();
  } catch (err) {
    checks.push({
      category: 'frontend',
      check_key: 'frontend.browser-launch',
      label: 'Chromium browser launch',
      status: 'error',
      severity: 'critical',
      error_message: `Browser launch failed: ${err.message}`,
      evidence: { error: err.message },
    });
    return checks;
  }

  try {
    // Two contexts: anonymous + signed-in
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Ridge-FullDiagnostic/1.0 (Shepard Ventures reliability bot)',
    });

    // Inject Supabase token into localStorage for signed-in pages.
    if (demoSession && demoSession.ok) {
      const storagePayload = {
        access_token: demoSession.accessToken,
        refresh_token: demoSession.refreshToken,
        user: demoSession.user,
        // Mirror Supabase JS storage shape — expires_at is required for the
        // client to consider the session valid.
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        expires_in: 3600,
        token_type: 'bearer',
      };
      // Supabase JS uses sb-<projectref>-auth-token. Project ref = the hostname's
      // first segment. Hardcode pgwoitbdiyubjugwufhk for the only Supabase project.
      const SB_PROJECT_REF = (SUPABASE_URL || '').replace(/^https?:\/\//, '').split('.')[0];
      const storageKey = `sb-${SB_PROJECT_REF}-auth-token`;
      await ctx.addInitScript(({ key, value }) => {
        try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
      }, { key: storageKey, value: storagePayload });
    }

    for (const target of FRONTEND_URLS) {
      const startedAt = Date.now();
      const page = await ctx.newPage();
      const consoleErrors = [];
      const slowRequests = [];
      const failedRequests = [];
      const brokenImages = [];

      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const t = msg.text();
          // Filter noisy 3rd-party warnings that aren't actionable
          if (t.includes('Permissions-Policy') || t.includes('was preloaded')) return;
          consoleErrors.push(t.slice(0, 400));
        }
      });
      page.on('requestfinished', async (req) => {
        try {
          const resp = await req.response();
          if (!resp) return;
          const timing = req.timing();
          const dur = (timing && timing.responseEnd) || 0;
          if (dur > 3000) {
            slowRequests.push({ url: req.url().slice(0, 200), duration_ms: Math.round(dur), status: resp.status() });
          }
          const status = resp.status();
          if (status >= 400 && !req.url().includes('favicon')) {
            failedRequests.push({ url: req.url().slice(0, 200), status });
          }
        } catch { /* ignore */ }
      });

      let status = 'pass';
      let severity = 'info';
      let errorMessage = null;
      let httpStatus = null;
      let title = null;
      let ctaWorked = null;
      let screenshotPath = null;
      let loadTimeMs = null;

      try {
        if (target.signed_in && !(demoSession && demoSession.ok)) {
          status = 'skip';
          errorMessage = 'demo sign-in unavailable';
        } else {
          const resp = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          httpStatus = resp ? resp.status() : 0;
          await page.waitForTimeout(1500);
          // Network idle (best-effort)
          try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch { /* ignore */ }

          loadTimeMs = Date.now() - startedAt;
          title = await page.title();

          // Sentinel selector
          let sentinel = null;
          if (target.primary_selector) {
            try {
              sentinel = await page.$(target.primary_selector);
            } catch { sentinel = null; }
          }

          // Find broken images (naturalWidth === 0)
          try {
            const broken = await page.$$eval('img', (imgs) =>
              imgs.filter((i) => i.complete && i.naturalWidth === 0 && i.src && !i.src.startsWith('data:'))
                  .map((i) => i.src.slice(0, 200))
            );
            brokenImages.push(...broken.slice(0, 10));
          } catch { /* ignore */ }

          // Screenshot (top of page only — keep size bounded)
          try {
            const buf = await page.screenshot({ fullPage: false, type: 'png' });
            screenshotPath = await uploadScreenshot(dateKey, runId, target.slug, buf);
          } catch { /* ignore */ }

          // Status determination
          if (httpStatus >= 500) {
            status = 'fail';
            severity = 'critical';
            errorMessage = `http ${httpStatus}`;
          } else if (httpStatus >= 400) {
            status = 'fail';
            severity = 'critical';
            errorMessage = `http ${httpStatus}`;
          } else if (!sentinel) {
            status = 'fail';
            severity = 'critical';
            errorMessage = `sentinel selector "${target.primary_selector}" not found`;
          } else if (consoleErrors.length > 0) {
            status = 'warn';
            severity = 'warn';
            errorMessage = `${consoleErrors.length} console error(s)`;
          } else if (brokenImages.length > 0) {
            status = 'warn';
            severity = 'warn';
            errorMessage = `${brokenImages.length} broken image(s)`;
          } else if (loadTimeMs > 4000) {
            status = 'warn';
            severity = 'warn';
            errorMessage = `slow load ${loadTimeMs}ms`;
          }
        }
      } catch (err) {
        status = 'fail';
        severity = 'critical';
        errorMessage = err.message.slice(0, 300);
      } finally {
        try { await page.close(); } catch { /* ignore */ }
      }

      checks.push({
        category: 'frontend',
        check_key: `frontend.${target.slug}`,
        label: `Front-end: ${target.slug} (${target.url})`,
        status,
        severity,
        duration_ms: Date.now() - startedAt,
        evidence: {
          url: target.url,
          http_status: httpStatus,
          title,
          load_time_ms: loadTimeMs,
          console_errors: consoleErrors.slice(0, 10),
          slow_requests: slowRequests.slice(0, 5),
          failed_requests: failedRequests.slice(0, 5),
          broken_images: brokenImages.slice(0, 5),
          cta_worked: ctaWorked,
          screenshot_path: screenshotPath,
        },
        error_message: errorMessage,
        screenshot_path: screenshotPath,
      });
    }
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
  return checks;
}

// ============================================================================
// Phase 2: API health probe
// ============================================================================

async function runApiProbe(demoSession) {
  const checks = [];
  for (const probe of API_PROBES) {
    const startedAt = Date.now();
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    let httpStatus = null;
    let bodyShape = {};
    let bodySizeBytes = 0;

    try {
      const headers = {};
      if (probe.auth === 'demo') {
        if (!demoSession || !demoSession.ok) {
          checks.push({
            category: 'api',
            check_key: `api.${probe.slug}`,
            label: `API: ${probe.method} ${probe.path} (demo)`,
            status: 'skip',
            severity: 'info',
            duration_ms: 0,
            evidence: { path: probe.path, reason: 'no demo session' },
            error_message: 'demo session unavailable',
          });
          continue;
        }
        headers.Authorization = `Bearer ${demoSession.accessToken}`;
      }
      const url = PROD_ORIGIN + probe.path;
      const resp = await fetch(url, { method: probe.method, headers });
      httpStatus = resp.status;
      const text = await resp.text();
      bodySizeBytes = text.length;
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (parsed && typeof parsed === 'object') {
        bodyShape = { keys: Object.keys(parsed).slice(0, 20) };
      }

      if (httpStatus >= 500) {
        status = 'fail';
        severity = 'critical';
        errorMessage = `5xx http ${httpStatus}`;
      } else if (httpStatus >= 400 && httpStatus !== 401 && httpStatus !== 403) {
        status = 'fail';
        severity = 'critical';
        errorMessage = `4xx http ${httpStatus}`;
      } else if (probe.auth === 'none' && (httpStatus === 401 || httpStatus === 403)) {
        // Unauthenticated probe got blocked — that's a configuration regression
        status = 'fail';
        severity = 'critical';
        errorMessage = `public endpoint now requires auth (${httpStatus})`;
      } else if (probe.expect_keys && parsed) {
        const missing = probe.expect_keys.filter((k) => !(k in parsed));
        if (missing.length > 0) {
          status = 'warn';
          severity = 'warn';
          errorMessage = `missing keys: ${missing.join(',')}`;
        }
      }
      if (bodySizeBytes > 50_000 && probe.auth === 'none') {
        // Large public payload — flag for trimming
        if (status === 'pass') {
          status = 'warn';
          severity = 'info';
          errorMessage = `large payload ${bodySizeBytes}B (consider trimming)`;
        }
      }
    } catch (err) {
      status = 'error';
      severity = 'critical';
      errorMessage = err.message.slice(0, 300);
    }

    checks.push({
      category: 'api',
      check_key: `api.${probe.slug}`,
      label: `API: ${probe.method} ${probe.path}`,
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: {
        path: probe.path,
        method: probe.method,
        auth: probe.auth,
        http_status: httpStatus,
        body_size_bytes: bodySizeBytes,
        body_shape: bodyShape,
      },
      error_message: errorMessage,
    });
  }
  return checks;
}

// ============================================================================
// Phase 3: Cron heartbeat audit
// ============================================================================

async function runCronHeartbeat() {
  const checks = [];
  const res = await sb('/rest/v1/cron_runs?select=cron_name,last_run,last_status,last_meta&limit=500');
  if (!res.ok || !Array.isArray(res.data)) {
    checks.push({
      category: 'cron',
      check_key: 'cron.fetch-runs',
      label: 'Cron heartbeat: read cron_runs',
      status: 'error',
      severity: 'critical',
      duration_ms: 0,
      evidence: { http_status: res.status, raw: (res.raw || '').slice(0, 200) },
      error_message: 'Failed to read cron_runs',
    });
    return checks;
  }
  const byName = new Map();
  for (const row of res.data) byName.set(row.cron_name, row);

  const now = Date.now();
  const inBH = inBusinessHoursUTC();
  // For every cron we know the SLA for, evaluate
  for (const [cronName, cfg] of Object.entries(CRON_SLA_MIN)) {
    const slaMin = cfg.sla;
    const businessHoursOnly = !!cfg.business_hours_only;
    const row = byName.get(cronName);

    // 2026-07-04 (Atlas) — PAUSE-AWARE GUARD.
    // Cost-freeze crons live on schedule '0 0 1 1 *'. Silence is expected and
    // required. Without this guard the diagnostic marked them RED critical at
    // every 5 AM run, which (a) spammed Telegram and (b) suggested to reviewers
    // that the fix was to un-pause them — restarting the burn. isPaused()
    // reads vercel.json's crons list; if the target is frozen or unregistered
    // we skip the SLA check and record a 'skip' row instead of 'fail'.
    if (isPaused('/api/' + cronName)) {
      const reason = pauseReason('/api/' + cronName) || 'paused';
      checks.push({
        category: 'cron',
        check_key: `cron.${cronName}`,
        label: `Cron heartbeat: ${cronName}`,
        status: 'skip',
        severity: 'info',
        duration_ms: 0,
        evidence: {
          cron_name: cronName,
          last_run: row && row.last_run,
          last_status: row && row.last_status,
          sla_minutes: slaMin,
          pause_reason: reason,
        },
        error_message: `paused (${reason}) — cost-freeze, SLA check suppressed`,
      });
      continue;
    }

    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    let ageMin = null;

    if (!row || !row.last_run) {
      status = 'fail';
      severity = 'critical';
      errorMessage = 'never recorded a run';
    } else {
      const lastRunMs = new Date(row.last_run).getTime();
      ageMin = Math.round((now - lastRunMs) / 60000);
      if (row.last_status === 'error') {
        status = 'fail';
        severity = 'critical';
        const errBody = row.last_meta && row.last_meta.error
          ? String(row.last_meta.error).slice(0, 80)
          : '';
        errorMessage = `last run errored${errBody ? ': ' + errBody : ''} · ${ageMin}m ago`;
      } else if (businessHoursOnly && !inBH) {
        // Outside business hours — silence is expected. Pass.
        status = 'pass';
      } else if (ageMin > slaMin * 2) {
        status = 'fail';
        severity = 'critical';
        errorMessage = `silent ${ageMin}m (SLA ${slaMin}m × 2)`;
      } else if (ageMin > slaMin) {
        status = 'warn';
        severity = 'warn';
        errorMessage = `over SLA: ${ageMin}m > ${slaMin}m`;
      }
    }

    checks.push({
      category: 'cron',
      check_key: `cron.${cronName}`,
      label: `Cron heartbeat: ${cronName}`,
      status,
      severity,
      duration_ms: 0,
      evidence: {
        cron_name: cronName,
        last_run: row && row.last_run,
        last_status: row && row.last_status,
        last_meta: row && row.last_meta,
        age_minutes: ageMin,
        sla_minutes: slaMin,
        business_hours_only: businessHoursOnly,
      },
      error_message: errorMessage,
    });
  }
  return checks;
}

// ============================================================================
// Phase 4: Customer data health
// ============================================================================

async function runDataHealth() {
  const checks = [];

  // 4a: Active subscriptions count vs CLAUDE.md MRR claim
  // The subscriptions table stores plan name only (price stored in Stripe).
  // We infer MRR from the plan column: founding=$29, solo=$79, team=$199.
  {
    const startedAt = Date.now();
    const subRes = await sb(
      `/rest/v1/subscriptions?select=id,plan,status&status=eq.active&limit=200`
    );
    const PLAN_PRICE_DOLLARS = { founding: 29, solo: 79, team: 199, brokerage: 0 };
    let activeCount = 0;
    const byPlan = {};
    let mrrDollars = 0;
    if (subRes.ok && Array.isArray(subRes.data)) {
      activeCount = subRes.data.length;
      for (const s of subRes.data) {
        const p = s.plan || 'unknown';
        byPlan[p] = (byPlan[p] || 0) + 1;
        mrrDollars += PLAN_PRICE_DOLLARS[p] || 0;
      }
    }
    // CLAUDE.md claims $349 MRR (12 founding @ $29 + 1 friend @ $1).
    // Tolerate a $10 drift for the friend account etc.
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    if (!subRes.ok) {
      status = 'error';
      severity = 'critical';
      errorMessage = `subscriptions query failed: ${subRes.status}`;
    } else if (activeCount === 0) {
      status = 'warn';
      severity = 'warn';
      errorMessage = '0 active subscriptions';
    } else if (Math.abs(mrrDollars - 349) > 50) {
      status = 'warn';
      severity = 'warn';
      errorMessage = `MRR drift: calc=$${mrrDollars} vs CLAUDE.md=$349 (delta $${mrrDollars - 349})`;
    }
    checks.push({
      category: 'data',
      check_key: 'data.mrr-vs-subscriptions',
      label: 'Data: MRR claim vs active subscriptions',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: {
        active_subscriptions: activeCount,
        by_plan: byPlan,
        calculated_mrr_dollars: mrrDollars,
        claude_md_mrr_claim: 349,
        delta: mrrDollars - 349,
      },
      error_message: errorMessage,
    });
  }

  // 4b: Founding applications pending too long
  {
    const startedAt = Date.now();
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const appRes = await sb(
      `/rest/v1/founding_applications?select=id,status,created_at,email&status=eq.pending&created_at=lt.${cutoff}&limit=50`
    );
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    let count = 0;
    if (!appRes.ok) {
      status = 'error';
      severity = 'critical';
      errorMessage = `founding_applications query failed: ${appRes.status}`;
    } else if (Array.isArray(appRes.data)) {
      count = appRes.data.length;
      if (count > 0) {
        status = 'warn';
        severity = 'warn';
        errorMessage = `${count} pending founding application(s) >24h old`;
      }
    }
    checks.push({
      category: 'data',
      check_key: 'data.stale-founding-applications',
      label: 'Data: founding applications pending >24h',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: {
        stale_count: count,
        cutoff_iso: cutoff,
        sample: appRes.ok ? (appRes.data || []).slice(0, 3).map((a) => ({ id: a.id, email: a.email, created_at: a.created_at })) : [],
      },
      error_message: errorMessage,
    });
  }

  // 4c: Email queue stuck items
  {
    const startedAt = Date.now();
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const eq = await sb(
      `/rest/v1/email_queue?select=id,status,created_at&status=eq.pending&created_at=lt.${cutoff}&limit=50`
    );
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    let count = 0;
    if (eq.ok && Array.isArray(eq.data)) {
      count = eq.data.length;
      if (count > 0) {
        status = 'warn';
        severity = 'warn';
        errorMessage = `${count} pending email(s) >24h old`;
      }
    } else if (!eq.ok && eq.status !== 404) {
      // 404 if the table doesn't exist — non-fatal
      status = 'warn';
      severity = 'info';
      errorMessage = `email_queue query failed: ${eq.status}`;
    }
    checks.push({
      category: 'data',
      check_key: 'data.stuck-email-queue',
      label: 'Data: email_queue stuck >24h',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: { stuck_count: count, cutoff_iso: cutoff },
      error_message: errorMessage,
    });
  }

  // 4d: Social posts queue health
  {
    const startedAt = Date.now();
    const sp = await sb(
      `/rest/v1/social_posts?select=id,status&status=in.(draft,approved,publishing,pending_video)&limit=200`
    );
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    const counts = { draft: 0, approved: 0, publishing: 0, pending_video: 0 };
    if (sp.ok && Array.isArray(sp.data)) {
      for (const p of sp.data) counts[p.status] = (counts[p.status] || 0) + 1;
      if (counts.publishing > 5) {
        status = 'warn';
        severity = 'warn';
        errorMessage = `${counts.publishing} stuck in 'publishing' state`;
      }
    }
    checks.push({
      category: 'data',
      check_key: 'data.social-posts-pipeline',
      label: 'Data: social_posts pipeline health',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: { ...counts },
      error_message: errorMessage,
    });
  }

  // 4e: Social posts approved-but-unscheduled (cron-publish-approved silent fail)
  {
    const startedAt = Date.now();
    const sp = await sb(
      `/rest/v1/social_posts?select=id,platform,created_at,scheduled_for&status=eq.approved&scheduled_for=is.null&limit=20`
    );
    let status = 'pass';
    let severity = 'info';
    let errorMessage = null;
    let count = 0;
    let sample = [];
    if (sp.ok && Array.isArray(sp.data)) {
      count = sp.data.length;
      sample = sp.data.slice(0, 3).map((p) => ({ id: p.id, platform: p.platform, created_at: p.created_at }));
      if (count > 0) {
        status = 'fail';
        severity = 'critical';
        errorMessage = `${count} approved post(s) have scheduled_for=NULL — cron-publish-approved silently skips them`;
      }
    }
    checks.push({
      category: 'data',
      check_key: 'data.approved-no-schedule',
      label: 'Data: approved posts without scheduled_for',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: { count, sample },
      error_message: errorMessage,
    });
  }

  // 4f: Posts actually published in last 24h (sanity vs the pipeline)
  {
    const startedAt = Date.now();
    const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const sp = await sb(
      `/rest/v1/social_posts?select=id&status=eq.posted&posted_at=gt.${cutoff}&limit=200`
    );
    let count = 0;
    if (sp.ok && Array.isArray(sp.data)) count = sp.data.length;
    let status = count >= 1 ? 'pass' : 'warn';
    let severity = count === 0 ? 'warn' : 'info';
    let errorMessage = count === 0 ? '0 posts published in last 24h — pipeline likely stuck' : null;
    checks.push({
      category: 'data',
      check_key: 'data.posted-last-24h',
      label: 'Data: posts published in last 24h',
      status,
      severity,
      duration_ms: Date.now() - startedAt,
      evidence: { count_last_24h: count },
      error_message: errorMessage,
    });
  }

  return checks;
}

// ============================================================================
// Phase 5: Improvement opportunities
// ============================================================================

function deriveImprovements(allChecks) {
  const ideas = [];

  // Slow front-end pages
  const slowPages = allChecks.filter((c) =>
    c.category === 'frontend' && c.evidence && c.evidence.load_time_ms > 3000
  );
  for (const p of slowPages) {
    ideas.push({
      id: `slow-page-${p.evidence.url}`,
      title: `${p.evidence.url} loads in ${p.evidence.load_time_ms}ms — target <2000ms`,
      category: 'performance',
      severity: p.evidence.load_time_ms > 5000 ? 'critical' : 'warn',
      evidence: { url: p.evidence.url, load_time_ms: p.evidence.load_time_ms },
      suggested_owner: 'carter',
      suggested_action: 'Inspect Lighthouse, check bundle size + image weight + above-the-fold blocking JS.',
    });
  }

  // Console errors on customer-facing pages
  const consolePages = allChecks.filter((c) =>
    c.category === 'frontend' && c.evidence && Array.isArray(c.evidence.console_errors) && c.evidence.console_errors.length > 0
  );
  for (const p of consolePages.slice(0, 3)) {
    ideas.push({
      id: `console-errors-${p.check_key}`,
      title: `${p.evidence.url} has ${p.evidence.console_errors.length} console error(s) on load`,
      category: 'reliability',
      severity: 'warn',
      evidence: { url: p.evidence.url, errors: p.evidence.console_errors.slice(0, 3) },
      suggested_owner: 'carter',
      suggested_action: 'Open in DevTools and resolve — each error is a silent regression risk.',
    });
  }

  // Broken images
  const brokenImgPages = allChecks.filter((c) =>
    c.category === 'frontend' && c.evidence && Array.isArray(c.evidence.broken_images) && c.evidence.broken_images.length > 0
  );
  if (brokenImgPages.length > 0) {
    ideas.push({
      id: 'broken-images-customer-facing',
      title: `${brokenImgPages.length} page(s) have broken images`,
      category: 'polish',
      severity: 'warn',
      evidence: { pages: brokenImgPages.map((p) => ({ url: p.evidence.url, images: p.evidence.broken_images.slice(0, 3) })) },
      suggested_owner: 'carter',
      suggested_action: 'Replace or remove the broken sources before customers screenshot the gap.',
    });
  }

  // Silent crons — exclude paused rows (already filtered by status='skip' in
  // runCronHeartbeat, but double-check to be defensive).
  const silentCrons = allChecks.filter((c) =>
    c.category === 'cron' && c.status === 'fail' && c.error_message && c.error_message.includes('silent')
      && !(c.evidence && c.evidence.pause_reason)
  );
  for (const c of silentCrons.slice(0, 5)) {
    ideas.push({
      id: `silent-cron-${c.evidence.cron_name}`,
      title: `${c.evidence.cron_name} silent ${c.evidence.age_minutes}m (SLA ${c.evidence.sla_minutes}m)`,
      category: 'reliability',
      severity: 'critical',
      evidence: { cron_name: c.evidence.cron_name, age_minutes: c.evidence.age_minutes, last_status: c.evidence.last_status },
      suggested_owner: 'atlas',
      suggested_action: 'Check Vercel cron registration, then run the cron handler directly with CRON_SECRET to see if it crashes.',
    });
  }

  // Fat API payloads
  const fatApi = allChecks.filter((c) =>
    c.category === 'api' && c.evidence && c.evidence.body_size_bytes > 30000
  );
  for (const c of fatApi.slice(0, 3)) {
    ideas.push({
      id: `fat-api-${c.evidence.path}`,
      title: `${c.evidence.path} returns ${Math.round(c.evidence.body_size_bytes / 1024)}KB — trim payload`,
      category: 'performance',
      severity: 'info',
      evidence: { path: c.evidence.path, bytes: c.evidence.body_size_bytes, body_shape: c.evidence.body_shape },
      suggested_owner: 'carter',
      suggested_action: 'Add ?select= to limit columns or paginate.',
    });
  }

  // Stale founding applications
  const staleFA = allChecks.find((c) => c.check_key === 'data.stale-founding-applications');
  if (staleFA && staleFA.evidence && staleFA.evidence.stale_count > 0) {
    ideas.push({
      id: 'stale-founding-apps',
      title: `${staleFA.evidence.stale_count} founding application(s) sitting >24h unprocessed`,
      category: 'revenue',
      severity: 'warn',
      evidence: staleFA.evidence,
      suggested_owner: 'pierce',
      suggested_action: 'Auto-approve cron or manual review — these are potential founding members slipping.',
    });
  }

  return ideas.slice(0, 8);
}

// ============================================================================
// Diagnostic orchestrator
// ============================================================================

async function runDiagnostic(tenantId, triggerSource, triggeredBy) {
  const startedAtMs = Date.now();
  const dateKey = new Date().toISOString().slice(0, 10);

  // Create the diagnostic row up front so we can attach checks to it as we go.
  const createRes = await sb('/rest/v1/system_diagnostics', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: tenantId,
      surface: 'dossie',
      overall_status: 'running',
      trigger_source: triggerSource,
      triggered_by: triggeredBy || null,
    }),
  });
  if (!createRes.ok || !createRes.data || !createRes.data[0]) {
    return { ok: false, error: `failed to create diagnostic row: ${createRes.status} ${createRes.raw && createRes.raw.slice(0, 200)}` };
  }
  const diagnostic = createRes.data[0];
  const diagnosticId = diagnostic.id;

  // Sign in as demo for both signed-in frontend pages + authed API probes
  const demoSession = await signInAsDemo();

  // Run all phases
  const allChecks = [];
  let frontendErr = null;
  let apiErr = null;
  let cronErr = null;
  let dataErr = null;

  try {
    const fe = await runFrontendSweep(dateKey, diagnosticId, demoSession);
    allChecks.push(...fe);
  } catch (err) {
    frontendErr = err.message;
    allChecks.push({
      category: 'frontend',
      check_key: 'frontend.runtime',
      label: 'Frontend sweep crashed',
      status: 'error',
      severity: 'critical',
      duration_ms: 0,
      evidence: { error: err.message },
      error_message: err.message,
    });
  }

  try {
    const api = await runApiProbe(demoSession);
    allChecks.push(...api);
  } catch (err) {
    apiErr = err.message;
    allChecks.push({
      category: 'api',
      check_key: 'api.runtime',
      label: 'API probe crashed',
      status: 'error',
      severity: 'critical',
      duration_ms: 0,
      evidence: { error: err.message },
      error_message: err.message,
    });
  }

  try {
    const c = await runCronHeartbeat();
    allChecks.push(...c);
  } catch (err) {
    cronErr = err.message;
    allChecks.push({
      category: 'cron',
      check_key: 'cron.runtime',
      label: 'Cron heartbeat crashed',
      status: 'error',
      severity: 'critical',
      duration_ms: 0,
      evidence: { error: err.message },
      error_message: err.message,
    });
  }

  try {
    const d = await runDataHealth();
    allChecks.push(...d);
  } catch (err) {
    dataErr = err.message;
    allChecks.push({
      category: 'data',
      check_key: 'data.runtime',
      label: 'Data health crashed',
      status: 'error',
      severity: 'critical',
      duration_ms: 0,
      evidence: { error: err.message },
      error_message: err.message,
    });
  }

  // Insert all check rows (batched). PostgREST accepts an array.
  if (allChecks.length > 0) {
    const rows = allChecks.map((c) => ({
      diagnostic_id: diagnosticId,
      tenant_id: tenantId,
      category: c.category,
      check_key: c.check_key,
      label: c.label,
      status: c.status,
      severity: c.severity,
      duration_ms: c.duration_ms || null,
      evidence: c.evidence || {},
      error_message: c.error_message || null,
      screenshot_path: c.screenshot_path || null,
    }));
    await sb('/rest/v1/system_diagnostic_checks', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    });
  }

  // Derive improvements
  const improvements = deriveImprovements(allChecks);

  // Overall status: 'red' if any critical fail; 'yellow' if warns; 'green' otherwise
  const failCritical = allChecks.filter((c) => (c.status === 'fail' || c.status === 'error') && c.severity === 'critical');
  const warns = allChecks.filter((c) => c.status === 'warn' || (c.status === 'fail' && c.severity !== 'critical'));
  let overall = 'green';
  if (failCritical.length > 0) overall = 'red';
  else if (warns.length > 0) overall = 'yellow';

  // Totals per category
  const totals = {};
  for (const cat of ['frontend', 'api', 'cron', 'data']) {
    const subset = allChecks.filter((c) => c.category === cat);
    totals[cat] = {
      total: subset.length,
      pass: subset.filter((c) => c.status === 'pass').length,
      warn: subset.filter((c) => c.status === 'warn').length,
      fail: subset.filter((c) => c.status === 'fail' || c.status === 'error').length,
      skip: subset.filter((c) => c.status === 'skip').length,
    };
  }

  const durationMs = Date.now() - startedAtMs;

  // Patch the diagnostic row
  await sb(`/rest/v1/system_diagnostics?id=eq.${diagnosticId}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      completed_at: new Date().toISOString(),
      duration_ms: durationMs,
      overall_status: overall,
      totals,
      improvements,
      errors: (frontendErr || apiErr || cronErr || dataErr) ? {
        frontend: frontendErr, api: apiErr, cron: cronErr, data: dataErr,
      } : null,
    }),
  });

  // Prune old runs (keep 60d)
  try {
    await sb('/rest/v1/rpc/prune_system_diagnostics', {
      method: 'POST',
      body: JSON.stringify({ p_days: 60 }),
    });
  } catch { /* ignore */ }

  // Telegram ONLY when something needs attention
  if (overall === 'red') {
    const summary = failCritical.slice(0, 5).map((c) => `• <code>${c.check_key}</code>: ${c.error_message || c.status}`).join('\n');
    await tg(`🔴 <b>RIDGE — Dossie diagnostic RED</b>\n\n${failCritical.length} critical failure(s):\n${summary}\n\n${improvements.length} improvement(s) queued. View: <a href="${PROD_ORIGIN}/jarvis">DOSSIE HEALTH panel</a>`);
  }

  return {
    ok: true,
    diagnostic_id: diagnosticId,
    overall_status: overall,
    totals,
    duration_ms: durationMs,
    checks_total: allChecks.length,
    improvements_count: improvements.length,
  };
}

// ============================================================================
// Handler
// ============================================================================

module.exports = withTelemetry(SELF_NAME, async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Default to Heath's tenant unless a per-tenant override comes in via query.
  const q = req.query || {};
  const tenantId = (q.tenant_id && typeof q.tenant_id === 'string')
    ? q.tenant_id
    : TENANT_DOSSIE_DEFAULT;
  const triggerSource = isManualAuth ? 'manual' : 'cron';

  const result = await runDiagnostic(tenantId, triggerSource, null);
  if (!result.ok) {
    return res.status(500).json({ ok: false, error: result.error });
  }
  return res.status(200).json(result);
});
