'use strict';

// scripts/sage-engagement-queue-poster.js
//
// Posts approved rows from public.engagement_queue as a real Facebook reply
// on the specific comment thread named by `permalink`. Built 2026-08-17
// (Sage) to close the gap between the Telegram approve/reject flow (which
// only flips engagement_queue.status -> 'approved') and an actual posted
// comment. Mirrors fb-reply-poster.js's reply-to-specific-comment logic and
// sage-engagement-poster.js's isolated DossieBot-Sage profile pattern.
//
// Usage:
//   node scripts/sage-engagement-queue-poster.js                # ship all approved+unposted (cap MAX_RUNS)
//   node scripts/sage-engagement-queue-poster.js --id [uuid]    # ship one specific row
//   node scripts/sage-engagement-queue-poster.js --dry-run      # navigate + locate the comment, do not type/submit
//
// Idempotency / safety:
//   - Only ever selects rows where status='approved' AND posted_at IS NULL.
//   - Never touches any row with a different status (pending/rejected/etc).
//   - Re-running after a successful post is a no-op (posted_at already set,
//     row falls out of the WHERE clause).
//   - On failure, leaves status='approved' (so it can be retried) and never
//     stamps posted_at.
//
// Env vars required:
//   SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) / SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (optional, for posted confirmation)

const path = require('path');
const os = require('os');
const fs = require('fs');

// ─── Load .env.local ────────────────────────────────────────────────────────
// NOTE: this file has known duplicate/placeholder lines (SUPABASE_URL is
// "[SENSITIVE]" the first time it appears, real the second/third time). Take
// the LAST non-placeholder value for each key, not the first.
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      if (val === '[SENSITIVE]') continue;
      process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[engagement-queue-poster] FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
  process.exit(1);
}

// Real, currently-logged-in DossieBot Chrome profile. Confirmed 2026-08-17
// via .env.local (PLAYWRIGHT_PROFILE_DIR/PLAYWRIGHT_PROFILE_NAME) and a live
// screenshot -- this is the profile fb-lead-scraper.js / fb-engagement-scraper.js
// use, NOT the empty "DossieBot-Sage" dir (that one is unauthenticated and
// only shows FB's logged-out "See more on Facebook" modal). Close all Chrome
// windows (including any DossieBot window) before running this script.
const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'DossieBot',
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || process.env.SAGE_PROFILE_NAME || 'Default';

const MAX_PER_RUN_DEFAULT = 5;
const COOLDOWN_MS = 60_000;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const ROW_ID = arg('id', null);
const MAX_RUNS = Number(arg('max', MAX_PER_RUN_DEFAULT)) || MAX_PER_RUN_DEFAULT;
const DRY_RUN = !!arg('dry-run', false);

// ─── Supabase ─────────────────────────────────────────────────────────────────

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function fetchRow(id) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/engagement_queue?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

// Idempotency guard lives in this WHERE clause: status=approved AND
// posted_at IS NULL. A row that already posted, or that isn't approved,
// never comes back out of this query.
async function fetchNextApproved(max) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/engagement_queue?status=eq.approved&posted_at=is.null&order=reviewed_at.asc&limit=${max}`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function markPosted(id) {
  await supabaseFetch(`/rest/v1/engagement_queue?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      posted_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
}

async function markFailed(id, reason) {
  // Leave status='approved' so the row is retried on the next run — do NOT
  // touch status here, only record the error for visibility.
  await supabaseFetch(`/rest/v1/engagement_queue?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      last_post_error: (reason || '').slice(0, 800),
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {}); // last_post_error column may not exist yet; non-fatal
  console.error('[engagement-queue-poster] failed:', reason);
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn('[engagement-queue-poster] telegram noop:', e.message);
  }
}

// ─── Playwright posting ────────────────────────────────────────────────────────

async function postReplyToComment(page, row) {
  await page.goto(row.permalink, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const currentUrl = page.url();
  if (currentUrl.includes('login') || currentUrl.includes('checkpoint')) {
    throw new Error('Facebook redirected to login/checkpoint. DossieBot-Sage profile may need re-login.');
  }

  const authorName = row.author_name || '';
  const authorFirstName = authorName.split(' ')[0];

  // Locate the specific commenter's comment block, then the Reply button
  // scoped to that block. Falls back to the first visible Reply button on
  // the page (best effort) if the specific author can't be isolated.
  let replyButton = null;
  const authorLocators = [authorName, authorFirstName].filter(Boolean);

  for (const name of authorLocators) {
    try {
      const authorEl = page.locator(`text="${name}"`).first();
      if (await authorEl.isVisible({ timeout: 3000 }).catch(() => false)) {
        const container = authorEl.locator('xpath=ancestor::div[@role="article" or @data-testid]').first();
        const replyInContainer = container.locator('text=/^Reply$/i').first();
        if (await replyInContainer.isVisible({ timeout: 2000 }).catch(() => false)) {
          replyButton = replyInContainer;
          break;
        }
      }
    } catch {
      continue;
    }
  }

  if (!replyButton) {
    const allReplyButtons = page.locator('text=/^Reply$/i');
    const count = await allReplyButtons.count();
    for (let i = 0; i < count; i++) {
      if (await allReplyButtons.nth(i).isVisible().catch(() => false)) {
        replyButton = allReplyButtons.nth(i);
        break;
      }
    }
  }

  if (!replyButton) {
    throw new Error(`Could not find Reply button for ${authorName}'s comment. Comment may be deleted or FB changed layout.`);
  }

  await replyButton.click();
  await page.waitForTimeout(1500);

  const replyBox = page.locator(
    '[role="textbox"][aria-label*="reply" i], [contenteditable="true"][aria-label*="reply" i], [placeholder*="Write a reply" i]',
  ).first();
  if (!(await replyBox.isVisible({ timeout: 5000 }).catch(() => false))) {
    throw new Error('Reply text box did not appear after clicking Reply');
  }

  await replyBox.click();

  if (DRY_RUN) {
    console.log('[engagement-queue-poster] DRY-RUN: located reply box, not typing/submitting');
    return;
  }

  await page.keyboard.type(row.drafted_reply, { delay: 30 });
  await page.waitForTimeout(1000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(3000);

  console.log('[engagement-queue-poster] reply posted successfully');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function postOne(context, row) {
  console.log(`[engagement-queue-poster] posting id=${row.id} in "${row.group_name}"`);
  console.log(`[engagement-queue-poster] in reply to ${row.author_name}: "${(row.original_text || '').slice(0, 80)}"`);
  console.log(`[engagement-queue-poster] draft: "${row.drafted_reply}"`);

  const page = await context.newPage();
  try {
    await postReplyToComment(page, row);
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  let queue = [];
  if (ROW_ID) {
    const row = await fetchRow(ROW_ID);
    if (!row) { console.error('[engagement-queue-poster] row not found:', ROW_ID); process.exit(1); }
    if (row.status !== 'approved') {
      console.error(`[engagement-queue-poster] row ${ROW_ID} status='${row.status}', expected 'approved'. Refusing.`);
      process.exit(1);
    }
    if (row.posted_at) {
      console.log(`[engagement-queue-poster] row ${ROW_ID} already posted at ${row.posted_at}. Nothing to do.`);
      return;
    }
    queue = [row];
  } else {
    queue = await fetchNextApproved(MAX_RUNS);
  }

  if (!queue.length) {
    console.log('[engagement-queue-poster] no approved+unposted rows to ship');
    return;
  }
  console.log(`[engagement-queue-poster] queue size: ${queue.length} (max=${MAX_RUNS})`);

  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const r = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'sage-engagement-queue-poster' });
    if (r.killed > 0) console.log(`[engagement-queue-poster] unlocked profile (killed ${r.killed} chrome procs)`);
  } catch (e) {
    console.warn('[engagement-queue-poster] profile-unlock non-fatal:', e.message);
  }

  const { chromium } = require('playwright');
  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const results = { posted: 0, failed: 0, ids: [] };
  try {
    for (let i = 0; i < queue.length; i++) {
      const row = queue[i];
      try {
        await postOne(context, row);
        if (DRY_RUN) {
          console.log(`[engagement-queue-poster] DRY-RUN: would mark posted id=${row.id}`);
        } else {
          await markPosted(row.id);
          await telegram(`Sage posted reply in "${row.group_name}":\n\n"${(row.drafted_reply || '').slice(0, 300)}"`);
        }
        results.posted++;
        results.ids.push({ id: row.id, status: 'posted' });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.error(`[engagement-queue-poster] FAILED id=${row.id}:`, msg);
        await markFailed(row.id, msg);
        await telegram(`Sage engagement-queue-poster FAILED id=${row.id} (${row.group_name}): ${msg.slice(0, 300)}`);
        results.failed++;
        results.ids.push({ id: row.id, status: 'failed', error: msg });
      }
      if (i < queue.length - 1) await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    }
  } finally {
    await context.close().catch(() => {});
  }

  console.log('[engagement-queue-poster] DONE:', JSON.stringify(results, null, 2));
}

main().catch((err) => {
  console.error('[engagement-queue-poster] fatal:', err && err.message);
  process.exit(1);
});
