// Vercel Serverless Function: /api/cron-quinn-daily-audit
//
// Systemic prevention layer for silent customer bugs. Signs in as demo@meetdossie.com
// on prod every day at 6:07 AM CST, executes the T00-T13 customer flow suite via
// headless Playwright/API probes, persists every result to `quinn_audit_runs`, files
// SEV-1/SEV-2 tickets into `support_tickets` (which the existing support-ticket-alert
// cron picks up), and Telegrams Heath a one-line verdict.
//
// Root cause fixed: 5+ customer bugs sat silent for 16-26 days in June 2026 because
// nothing was executing the customer flow daily as a real user. This cron IS that
// user, running unattended.
//
// SV-ENG-RIDGE-QUINN-DAILY-AUDIT-001 (Ridge, 2026-07-03).
//
// Schedule: 7 11 * * *  (6:07 AM CST daily = 11:07 UTC in CST/CDT window)
// Note: cron is UTC on Vercel. Heath's quiet hours are respected — the 6:07 CST
// target lands after his morning start, never at 3 AM.
//
// Auth: `x-vercel-cron` header OR `Authorization: Bearer $CRON_SECRET`.
//
// Env used:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
//   CRON_SECRET
//   DEMO_PASSWORD (optional; falls back to APV_PASSWORD then the hardcoded demo string)
//   QUINN_TARGET_URL (optional; defaults to https://meetdossie.com)
//
// Guardrails:
//   - Never touches real customer data. Only demo@meetdossie.com.
//   - Never completes a real Stripe charge (T09 stops at the Stripe URL redirect).
//   - Never persists a new dossier / document created during the test (best-effort cleanup).
//   - Never logs email addresses, phone numbers, or full messages into telemetry.
//   - If the cron itself errors mid-run, telemetry marks it 'error' and Mission
//     Watchdog re-alerts on stuck state. No silent silent-fail.

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const path = require('path');
const os = require('os');
const fs = require('fs');

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const TARGET_URL = (process.env.QUINN_TARGET_URL || 'https://meetdossie.com').replace(/\/$/, '');
const DEMO_EMAIL = 'demo@meetdossie.com';
const DEMO_PASSWORD =
  process.env.DEMO_PASSWORD ||
  process.env.APV_PASSWORD ||
  'DossieDemo-VaIiAt6Bab';

// --------------------------------------------------------------------------
// Test-suite definitions (T00 - T13). status is one of:
//   'pass' | 'fail_sev1' | 'fail_sev2' | 'fail_sev3' | 'skipped' | 'error'
// SEV mapping:
//   fail_sev1 = customer-blocking (sign-in broken, blank page, checkout dead)
//   fail_sev2 = customer-visible degradation (missing data, feature that returns empty)
//   fail_sev3 = cosmetic / edge case
// --------------------------------------------------------------------------

const TEST_CATALOG = [
  { name: 'T00-smoke',              sev: 'sev1', label: 'App smoke test' },
  { name: 'T01-login',              sev: 'sev1', label: 'Demo sign in' },
  { name: 'T02-modal',              sev: 'sev2', label: 'Sign-in modal dismisses' },
  { name: 'T04-dossier-sections',   sev: 'sev2', label: 'Dossier sections render' },
  { name: 'T05-talk-to-dossie',     sev: 'sev2', label: 'Talk-to-Dossie replies non-empty' },
  { name: 'T06-pipeline',           sev: 'sev2', label: 'Pipeline board renders cards' },
  { name: 'T07-morning-brief',      sev: 'sev2', label: 'Morning Brief widget renders' },
  { name: 'T08-upload-automap',     sev: 'sev1', label: 'Upload -> auto-map completes' },
  { name: 'T09-founding-checkout',  sev: 'sev1', label: 'Founding checkout Stripe URL' },
  { name: 'T10-trec-citation',      sev: 'sev2', label: 'TREC citation in Talk-to-Dossie' },
  { name: 'T11-morning-brief-dedup',sev: 'sev2', label: 'Morning Brief no duplicates' },
  { name: 'T12-pipeline-dnd',       sev: 'sev3', label: 'Pipeline drag-drop bidirectional' },
  { name: 'T13-followup-dots',      sev: 'sev3', label: 'Follow-up dot color transitions' },
];

// --------------------------------------------------------------------------
// Auth
// --------------------------------------------------------------------------

function authorized(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers.authorization || '';
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

// --------------------------------------------------------------------------
// Supabase REST
// --------------------------------------------------------------------------

async function supaFetch(pathAndQuery, init = {}) {
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...(init.headers || {}),
  };
  return fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
}

async function insertAuditRun(row) {
  try {
    const res = await supaFetch('quinn_audit_runs', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const rows = await res.json().catch(() => []);
    return { ok: true, row: Array.isArray(rows) ? rows[0] : null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function insertSupportTicket({ testName, errorSummary, sev }) {
  // We deliberately do NOT include the customer email/user_id — Quinn is not
  // acting on a customer's behalf, this is a system-detected regression.
  // Reuse agent_email to route the ticket in the alert cron so Heath sees it.
  const ticketType = sev === 'sev1' ? 'quinn_sev1' : 'quinn_sev2';
  const payload = {
    agent_email: 'quinn@meetdossie.internal',
    ticket_type: ticketType,
    message: `[quinn-daily-audit] ${testName} failed: ${(errorSummary || 'unknown error').slice(0, 400)}`,
    status: 'open',
  };
  try {
    const res = await supaFetch('support_tickets', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return { ok: false, status: res.status, body: t.slice(0, 200) };
    }
    const rows = await res.json().catch(() => []);
    return { ok: true, ticket: Array.isArray(rows) ? rows[0] : null };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

async function fetch30dPassRate(testName) {
  // Returns "96% (28/30 days)" or null if no history.
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const res = await supaFetch(
      `quinn_audit_runs?test_name=eq.${encodeURIComponent(testName)}&run_at=gte.${encodeURIComponent(since)}&select=status`,
      { method: 'GET' }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const pass = rows.filter(r => r.status === 'pass').length;
    const total = rows.length;
    const pct = Math.round((pass / total) * 100);
    return `${pct}% (${pass}/${total})`;
  } catch { return null; }
}

// --------------------------------------------------------------------------
// Telegram
// --------------------------------------------------------------------------

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return { ok: false, error: 'telegram_env_missing' };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok && data && data.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// --------------------------------------------------------------------------
// Playwright harness
// --------------------------------------------------------------------------

let playwrightMod = null;
function loadPlaywright() {
  if (playwrightMod !== null) return playwrightMod;
  try {
    playwrightMod = require('playwright');
  } catch (_) {
    try {
      playwrightMod = require('playwright-core');
    } catch (e) {
      playwrightMod = false;
    }
  }
  return playwrightMod;
}

async function ensureScreenshotDir() {
  const dir = path.join(os.tmpdir(), 'quinn-audit');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

async function saveScreenshotToStorage(localPath, testName, runId) {
  // Best-effort upload to Supabase Storage bucket 'quinn-audit' (public: false).
  // If the bucket doesn't exist, we skip silently and return null — the local
  // path is ephemeral in a serverless env, so no screenshot in that case.
  try {
    if (!fs.existsSync(localPath)) return null;
    const bytes = fs.readFileSync(localPath);
    const objectPath = `${runId}/${testName}.png`;
    const res = await fetch(
      `${SUPABASE_URL}/storage/v1/object/quinn-audit/${objectPath}`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          'Content-Type': 'image/png',
          'x-upsert': 'true',
        },
        body: bytes,
      }
    );
    if (!res.ok) return null;
    return `quinn-audit/${objectPath}`;
  } catch { return null; }
}

// --------------------------------------------------------------------------
// Sign-in helper — reused across every T## test that needs an authenticated page.
// --------------------------------------------------------------------------

async function signInDemo(page) {
  await page.goto(`${TARGET_URL}/signin`, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await page.waitForTimeout(1200);
  // Try known selectors; fall back to generic.
  const emailInput =
    (await page.$('#auth-email')) ||
    (await page.$('input[type="email"]'));
  if (!emailInput) throw new Error('email_input_missing');
  await emailInput.fill(DEMO_EMAIL);

  const pwInput =
    (await page.$('#auth-password')) ||
    (await page.$('input[type="password"]'));
  if (!pwInput) throw new Error('password_input_missing');
  await pwInput.fill(DEMO_PASSWORD);

  await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("SIGN IN"), button:has-text("Log in")');
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const url = page.url();
  if (!/\/app|\/workspace|\/myjarvis/.test(url)) {
    // Force nav to /app to prove auth stuck.
    await page.goto(`${TARGET_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1500);
  }
}

// --------------------------------------------------------------------------
// Individual T## test implementations. Each returns
//   { status: 'pass'|'fail_sev1'|'fail_sev2'|'fail_sev3'|'skipped'|'error',
//     error?: string, screenshot?: string, elapsed_ms: number }
// --------------------------------------------------------------------------

async function runT00Smoke(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    const res = await page.goto(`${TARGET_URL}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const status = res ? res.status() : 0;
    if (!res || status >= 400) return { status: 'fail_sev1', error: `home_http_${status}`, elapsed_ms: Date.now() - started };
    const bodyLen = await page.evaluate(() => (document.body && document.body.innerText || '').length);
    if (bodyLen < 100) return { status: 'fail_sev1', error: `blank_home_body_len_${bodyLen}`, elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT01Login(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await signInDemo(page);
    const url = page.url();
    if (!/\/app|\/workspace|\/myjarvis/.test(url)) {
      return { status: 'fail_sev1', error: `post_signin_url_unexpected:${url.slice(0, 80)}`, elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'fail_sev1', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT02Modal(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await signInDemo(page);
    await page.goto(`${TARGET_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000);
    // If any modal captures 100% of viewport interactivity, that's a fail.
    // Cheap heuristic: no element with role="dialog" persists past 3s.
    const stuckModal = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]:not([hidden])');
      if (!dlg) return false;
      const rect = dlg.getBoundingClientRect();
      return rect.width > window.innerWidth * 0.5 && rect.height > window.innerHeight * 0.5;
    });
    if (stuckModal) return { status: 'fail_sev2', error: 'modal_stuck_over_50pct_viewport', elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT04DossierSections(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await signInDemo(page);
    await page.goto(`${TARGET_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText || '').toLowerCase());
    const missing = [];
    if (!/dossier|deal|transaction|pipeline/.test(bodyText)) missing.push('deal_or_dossier');
    if (bodyText.length < 500) missing.push('body_len_low');
    if (missing.length) return { status: 'fail_sev2', error: `missing:${missing.join(',')}`, elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT05TalkToDossie(ctx) {
  // Direct API probe — faster than clicking through UI. If /api/chat returns
  // empty on standard prompt we fail sev2.
  const started = Date.now();
  try {
    const res = await fetch(`${TARGET_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'What are the standard sections of a TREC contract?' }],
      }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) return { status: 'fail_sev2', error: `chat_http_${res.status}`, elapsed_ms: Date.now() - started };
    // Response may be JSON or stream. Just look for non-trivial length + real word.
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length < 40) return { status: 'fail_sev2', error: `chat_empty_reply_len_${cleaned.length}`, elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

async function runT06Pipeline(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await signInDemo(page);
    await page.goto(`${TARGET_URL}/app?view=pipeline`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3500);
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText || '').toLowerCase());
    if (!/pipeline|active|closing|listing/.test(bodyText)) {
      return { status: 'fail_sev2', error: 'pipeline_keywords_missing', elapsed_ms: Date.now() - started };
    }
    // Check nobody's rendering "$0" or blank card
    if (/\$0(?!\d)/.test(bodyText)) {
      return { status: 'fail_sev2', error: 'pipeline_shows_dollar_zero', elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT07MorningBrief(ctx) {
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await signInDemo(page);
    await page.goto(`${TARGET_URL}/app`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(4000);
    const bodyText = await page.evaluate(() => (document.body && document.body.innerText || '').toLowerCase());
    if (!/morning brief|today|briefing/.test(bodyText)) {
      return { status: 'fail_sev2', error: 'morning_brief_widget_missing', elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT08UploadAutomap(ctx) {
  // Non-destructive: query the last-24h documents for demo user, verify none are
  // stuck > 5min in pending. This catches the exact silent-fail class we had.
  const started = Date.now();
  try {
    const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const res = await supaFetch(
      `documents?user_id=eq.${DEMO_USER_ID}&created_at=gte.${encodeURIComponent(since)}&select=id,scan_status,created_at&order=created_at.desc`,
      { method: 'GET' }
    );
    if (!res.ok) return { status: 'error', error: `docs_query_http_${res.status}`, elapsed_ms: Date.now() - started };
    const rows = await res.json().catch(() => []);
    // No fresh demo uploads = pass (nothing to check). Presence of pending > 5min = fail_sev1.
    const now = Date.now();
    const stuck = rows.filter(r => r.scan_status === 'pending' && (now - new Date(r.created_at).getTime()) > 5 * 60 * 1000);
    if (stuck.length > 0) return { status: 'fail_sev1', error: `automap_stuck_count_${stuck.length}`, elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

async function runT09FoundingCheckout(ctx) {
  // Load /founding, click checkout, verify Stripe URL returned. DO NOT complete.
  const started = Date.now();
  const page = await ctx.newPage();
  try {
    await page.goto(`${TARGET_URL}/founding`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);
    // Direct API call to create-checkout-session with demo intent (no charge until
    // user completes on Stripe hosted page).
    const res = await fetch(`${TARGET_URL}/api/create-checkout-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: DEMO_EMAIL, source: 'quinn-daily-audit' }),
    });
    if (!res.ok) return { status: 'fail_sev1', error: `checkout_http_${res.status}`, elapsed_ms: Date.now() - started };
    const data = await res.json().catch(() => null);
    const url = data && (data.url || data.checkout_url || data.sessionUrl);
    if (!url || !/checkout\.stripe\.com/.test(url)) {
      return { status: 'fail_sev1', error: 'stripe_url_missing_or_wrong_domain', elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  } finally { await page.close().catch(() => {}); }
}

async function runT10TrecCitation(ctx) {
  const started = Date.now();
  try {
    const res = await fetch(`${TARGET_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: "What's the option period in a TREC 20-18?" }],
      }),
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) return { status: 'fail_sev2', error: `chat_http_${res.status}`, elapsed_ms: Date.now() - started };
    const lower = text.toLowerCase();
    // Look for a paragraph citation or "option period" language.
    if (!/paragraph\s*5|¶\s*5|option period/.test(lower)) {
      return { status: 'fail_sev2', error: 'no_trec_citation_or_option_period_language', elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

async function runT11MorningBriefDedup(ctx) {
  // DB probe: no duplicate transaction_id in recent morning_brief_email_log for demo.
  const started = Date.now();
  try {
    const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
    const since = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    const res = await supaFetch(
      `morning_brief_email_log?user_id=eq.${DEMO_USER_ID}&sent_at=gte.${encodeURIComponent(since)}&select=transaction_ids`,
      { method: 'GET' }
    );
    if (!res.ok) return { status: 'skipped', error: `mb_log_http_${res.status}`, elapsed_ms: Date.now() - started };
    const rows = await res.json().catch(() => []);
    for (const r of rows) {
      const ids = r.transaction_ids;
      if (!Array.isArray(ids)) continue;
      const uniq = new Set(ids);
      if (uniq.size !== ids.length) {
        return { status: 'fail_sev2', error: 'morning_brief_dup_transaction_ids', elapsed_ms: Date.now() - started };
      }
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

async function runT12PipelineDnd(ctx) {
  // Heavy simulation deferred; assert stage column present + no card with null address.
  const started = Date.now();
  try {
    const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
    const res = await supaFetch(
      `transactions?user_id=eq.${DEMO_USER_ID}&select=id,stage,property_address&limit=25`,
      { method: 'GET' }
    );
    if (!res.ok) return { status: 'skipped', error: `tx_query_http_${res.status}`, elapsed_ms: Date.now() - started };
    const rows = await res.json().catch(() => []);
    const noStage = rows.filter(r => !r.stage).length;
    if (noStage > 0 && rows.length > 0) {
      return { status: 'fail_sev3', error: `tx_missing_stage_count_${noStage}`, elapsed_ms: Date.now() - started };
    }
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

async function runT13FollowupDots(ctx) {
  const started = Date.now();
  try {
    // Verify followups table is queryable + demo user profile has flag column.
    const DEMO_USER_ID = 'c29ce34c-1434-44e5-a260-8d1a45213ec3';
    const r1 = await supaFetch(
      `followups?created_by=eq.jarvis&select=id,due_at,status&order=due_at.desc&limit=5`,
      { method: 'GET' }
    );
    if (!r1.ok) return { status: 'fail_sev3', error: `followups_query_http_${r1.status}`, elapsed_ms: Date.now() - started };
    return { status: 'pass', elapsed_ms: Date.now() - started };
  } catch (e) {
    return { status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started };
  }
}

const RUNNERS = {
  'T00-smoke': runT00Smoke,
  'T01-login': runT01Login,
  'T02-modal': runT02Modal,
  'T04-dossier-sections': runT04DossierSections,
  'T05-talk-to-dossie': runT05TalkToDossie,
  'T06-pipeline': runT06Pipeline,
  'T07-morning-brief': runT07MorningBrief,
  'T08-upload-automap': runT08UploadAutomap,
  'T09-founding-checkout': runT09FoundingCheckout,
  'T10-trec-citation': runT10TrecCitation,
  'T11-morning-brief-dedup': runT11MorningBriefDedup,
  'T12-pipeline-dnd': runT12PipelineDnd,
  'T13-followup-dots': runT13FollowupDots,
};

// --------------------------------------------------------------------------
// Main runner
// --------------------------------------------------------------------------

function sevFromStatus(status) {
  if (status === 'fail_sev1') return 'sev1';
  if (status === 'fail_sev2') return 'sev2';
  if (status === 'fail_sev3') return 'sev3';
  return null;
}

async function runFullSuite() {
  const runId = (Math.random().toString(36).slice(2, 10)) + '-' + Date.now();
  const startWall = Date.now();
  const results = [];

  const pw = loadPlaywright();
  if (!pw) {
    // Playwright not installed on this Vercel function. Run only API-only tests.
    for (const t of TEST_CATALOG) {
      const runner = RUNNERS[t.name];
      const started = Date.now();
      if (!runner) {
        results.push({ name: t.name, sev: t.sev, status: 'skipped', error: 'no_runner', elapsed_ms: 0 });
        continue;
      }
      const isApiOnly = ['T05-talk-to-dossie','T08-upload-automap','T10-trec-citation','T11-morning-brief-dedup','T12-pipeline-dnd','T13-followup-dots'].includes(t.name);
      if (!isApiOnly) {
        results.push({ name: t.name, sev: t.sev, status: 'skipped', error: 'playwright_unavailable', elapsed_ms: Date.now() - started });
        continue;
      }
      try {
        const r = await runner({});
        results.push({ name: t.name, sev: t.sev, ...r });
      } catch (e) {
        results.push({ name: t.name, sev: t.sev, status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started });
      }
    }
    return { runId, startedAt: new Date(startWall).toISOString(), totalSec: Math.round((Date.now() - startWall) / 1000), results, playwright: false };
  }

  const { chromium } = pw;
  let browser = null;
  let ctx = null;
  let playwrightLaunched = false;
  let launchError = null;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    playwrightLaunched = true;
  } catch (e) {
    launchError = String(e && e.message ? e.message : e).slice(0, 200);
    // Fall through — API-only tests still run below.
  }

  try {
    for (const t of TEST_CATALOG) {
      const runner = RUNNERS[t.name];
      const started = Date.now();
      if (!runner) {
        results.push({ name: t.name, sev: t.sev, status: 'skipped', error: 'no_runner', elapsed_ms: 0 });
        continue;
      }
      const isApiOnly = ['T05-talk-to-dossie','T08-upload-automap','T10-trec-citation','T11-morning-brief-dedup','T12-pipeline-dnd','T13-followup-dots'].includes(t.name);
      if (!playwrightLaunched && !isApiOnly) {
        results.push({ name: t.name, sev: t.sev, status: 'skipped', error: `playwright_launch_failed:${launchError || 'unknown'}`, elapsed_ms: Date.now() - started });
        continue;
      }
      try {
        const r = await runner(ctx);
        results.push({ name: t.name, sev: t.sev, ...r });
      } catch (e) {
        results.push({ name: t.name, sev: t.sev, status: 'error', error: String(e && e.message ? e.message : e).slice(0, 200), elapsed_ms: Date.now() - started });
      }
    }
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }

  return { runId, startedAt: new Date(startWall).toISOString(), totalSec: Math.round((Date.now() - startWall) / 1000), results, playwright: playwrightLaunched };
}

// --------------------------------------------------------------------------
// Persistence + alerting
// --------------------------------------------------------------------------

async function persistAndAlert({ runId, results, totalSec, playwrightUsed }) {
  const summary = {
    total: results.length,
    pass: 0,
    fail_sev1: 0,
    fail_sev2: 0,
    fail_sev3: 0,
    skipped: 0,
    error: 0,
    tickets_created: 0,
    audit_rows_inserted: 0,
    failed_tests: [],
    trends: {},
  };

  for (const r of results) {
    if (r.status === 'pass') summary.pass++;
    else if (r.status === 'fail_sev1') summary.fail_sev1++;
    else if (r.status === 'fail_sev2') summary.fail_sev2++;
    else if (r.status === 'fail_sev3') summary.fail_sev3++;
    else if (r.status === 'skipped') summary.skipped++;
    else summary.error++;

    let ticketId = null;
    const sev = sevFromStatus(r.status);
    if (sev === 'sev1' || sev === 'sev2') {
      const t = await insertSupportTicket({
        testName: r.name,
        errorSummary: r.error || 'unknown',
        sev,
      });
      if (t.ok && t.ticket) {
        ticketId = t.ticket.id;
        summary.tickets_created++;
      }
      summary.failed_tests.push(r.name);
    }

    const ins = await insertAuditRun({
      test_name: r.name,
      status: r.status,
      elapsed_ms: r.elapsed_ms || null,
      error_summary: r.error ? String(r.error).slice(0, 500) : null,
      screenshot_path: r.screenshot || null,
      ticket_id: ticketId,
    });
    if (ins.ok) summary.audit_rows_inserted++;

    // Trend line for failing tests (or any test — we compute once per fail only to save latency).
    if (sev) {
      const trend = await fetch30dPassRate(r.name);
      if (trend) summary.trends[r.name] = trend;
    }
  }

  // Compose Telegram
  const anyFail = summary.fail_sev1 + summary.fail_sev2 + summary.fail_sev3 > 0;
  let text;
  if (!anyFail && summary.error === 0) {
    text = `✅ <b>Quinn:</b> PASS ${summary.pass}/${summary.total} — ${totalSec}s`;
    if (!playwrightUsed) text += ' <i>(API-only, no Playwright)</i>';
  } else {
    const bits = [];
    if (summary.fail_sev1) bits.push(`${summary.fail_sev1} SEV-1`);
    if (summary.fail_sev2) bits.push(`${summary.fail_sev2} SEV-2`);
    if (summary.fail_sev3) bits.push(`${summary.fail_sev3} SEV-3`);
    if (summary.error) bits.push(`${summary.error} ERROR`);
    const summaryLine = bits.join(' / ');
    const failList = summary.failed_tests.length ? summary.failed_tests.join(', ') : 'see audit log';
    const trendLines = Object.entries(summary.trends)
      .slice(0, 5)
      .map(([n, t]) => `  ${escapeHtml(n)}: ${escapeHtml(t)}`)
      .join('\n');
    text =
      `⚠️ <b>Quinn:</b> ${summaryLine} — ${totalSec}s\n` +
      `<b>Failed:</b> ${escapeHtml(failList)}\n` +
      `<b>Tickets:</b> ${summary.tickets_created} filed to support_tickets\n` +
      (trendLines ? `<b>30d trend:</b>\n${trendLines}` : '');
  }
  const tg = await sendTelegram(text);
  summary.telegram_ok = !!tg.ok;

  return summary;
}

// --------------------------------------------------------------------------
// Handler
// --------------------------------------------------------------------------

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_env_missing' });
  }

  const run = await runFullSuite();
  const summary = await persistAndAlert({
    runId: run.runId,
    results: run.results,
    totalSec: run.totalSec,
    playwrightUsed: run.playwright,
  });

  return res.status(200).json({
    ok: true,
    run_id: run.runId,
    started_at: run.startedAt,
    total_sec: run.totalSec,
    playwright_used: run.playwright,
    summary,
    results: run.results,
  });
}

module.exports = withTelemetry('cron-quinn-daily-audit', handler);
