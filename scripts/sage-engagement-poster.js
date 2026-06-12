'use strict';

// scripts/sage-engagement-poster.js
//
// SV-SOCIAL-ENGAGEMENT-POSTER (Sage, 2026-06-12 day-of-mission)
//
// Posts approved rows from public.engagement_candidates as comments on the
// target FB / IG / LinkedIn / Reddit post. Drives the DossieBot Chrome
// profile via Playwright launchPersistentContext (NOT PyAutoGUI on Heath's
// real Chrome). Safe to run during Heath's work hours — opens its own
// browser window in the DossieBot profile.
//
// Why this script exists:
//   Sage's existing flow has been:
//     scanner (sage-fb-comment-scanner.js) -> engagement_candidates row
//     -> cron-sage-draft-engagements drafts a Heath-voice reply
//     -> Sage / Heath approves via DossieMarketingBot OR auto-veto-approves
//     -> ... and then nothing.
//   The unified-scanner Python poster (post_via_chrome.py) hijacks Heath's
//   real Chrome via PyAutoGUI, which is unacceptable during business hours.
//   This JS poster mirrors fb-reply-poster.js's pattern (Playwright +
//   DossieBot profile + profile-unlock pre-flight) for engagement_candidates.
//
// Usage:
//   node scripts/sage-engagement-poster.js                # auto-ship oldest approved
//   node scripts/sage-engagement-poster.js --id 29        # ship specific candidate id
//   node scripts/sage-engagement-poster.js --max 3        # ship up to 3 approved in one run
//   node scripts/sage-engagement-poster.js --dry-run      # log + navigate but do not type
//
// Env vars required:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN  (Claudy for posted confirmations)
//   TELEGRAM_CHAT_ID
//
// Per-platform support:
//   facebook  : navigates to post_url (m.facebook.com), focuses comment box,
//               types comment_draft, submits via Enter
//   instagram : navigates to post_url, focuses comment box, types, submits
//   linkedin  : navigates to post_url, focuses comment box, types, submits
//   reddit    : delegates to scripts/reddit-comment-playwright.js (which
//               already exists and uses the DossieBot profile)
//
// Safety rails:
//   - MAX_PER_RUN cap (default 5) prevents runaway shipping
//   - COOLDOWN_MS between successive posts (60s) avoids rapid-fire spam
//   - profile-unlock pre-flight kills stale DossieBot Chrome processes
//   - kill-switch check via desktop_actions table (planned; currently noop)
//   - never posts if last_error suggests a layout change (post_attempt_count > 2)

const path = require('path');
const os = require('os');
const fs = require('fs');

// Load .env.local
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
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('[engagement-poster] FATAL: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.');
  process.exit(1);
}

// Use the DossieBot-Sage isolated user-data-dir so we never collide with
// Heath's running Chrome (which locks the main User Data dir). Matches the
// pattern in fb-group-poster.js, sage-fb-scan-mission.js, fb-lead-scraper.js.
const CHROME_PROFILE_PATH = process.env.SAGE_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage',
);
const PLAYWRIGHT_PROFILE_NAME = process.env.SAGE_PROFILE_NAME || 'Default';

const MAX_PER_RUN_DEFAULT = 5;
const COOLDOWN_MS = 60_000;
const MAX_POST_ATTEMPTS = 2;

// ─── CLI ──────────────────────────────────────────────────────────────────────

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const CANDIDATE_ID = arg('id', null);
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

async function fetchCandidate(id) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

async function fetchNextApproved(max) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/engagement_candidates?status=eq.approved&post_attempt_count=lt.${MAX_POST_ATTEMPTS}&order=approved_at.asc&limit=${max}`,
  );
  if (!ok || !Array.isArray(data)) return [];
  return data;
}

async function markPosted(id, permalink) {
  const body = {
    status: 'posted',
    posted_comment_url: permalink || null,
    updated_at: new Date().toISOString(),
  };
  await supabaseFetch(`/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(body),
  });
}

async function markFailed(id, reason, attemptCount) {
  await supabaseFetch(`/rest/v1/engagement_candidates?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      last_error: (reason || '').slice(0, 800),
      post_attempt_count: (attemptCount || 0) + 1,
      updated_at: new Date().toISOString(),
    }),
  });
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
    console.warn('[engagement-poster] telegram noop:', e.message);
  }
}

// ─── Posting helpers ──────────────────────────────────────────────────────────

async function postFacebookComment(page, candidate) {
  // Normalise post_url: prefer mobile site for the comment box reliability
  let url = candidate.post_url;
  if (url && !url.includes('m.facebook.com') && url.includes('facebook.com')) {
    url = url.replace('www.facebook.com', 'm.facebook.com');
  }

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const cur = page.url();
  if (cur.includes('login') || cur.includes('checkpoint') || cur.includes('login_modal')) {
    throw new Error('FB redirected to login. DossieBot profile may need re-login.');
  }

  // m.facebook.com uses a basic textarea/contenteditable. Look for both.
  const candidates = [
    'textarea[name="comment_text"]',
    'textarea[placeholder*="Write a comment" i]',
    'div[contenteditable="true"][aria-label*="comment" i]',
    'div[role="textbox"][aria-label*="comment" i]',
    'div[contenteditable="true"]',
  ];

  let box = null;
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible({ timeout: 1500 }).catch(() => false)) {
      box = el; break;
    }
  }
  if (!box) throw new Error('No FB comment box located');

  await box.click({ timeout: 4000 });
  await page.waitForTimeout(700);
  await page.keyboard.type(candidate.comment_draft, { delay: 25 });
  await page.waitForTimeout(800);

  if (DRY_RUN) { console.log('[engagement-poster] DRY-RUN: skipping submit'); return null; }

  // Try Ctrl+Enter (FB common), then Enter, then a Post button click.
  await page.keyboard.press('Control+Enter').catch(() => {});
  await page.waitForTimeout(1500);

  // If composer still has our text, fall back to Enter / button click
  const remaining = await box.evaluate(el => el.innerText || el.value || '').catch(() => '');
  if (remaining && remaining.trim().length > 10) {
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(1500);
  }

  const postBtn = page.locator('button:has-text("Post"), button:has-text("Comment"), input[type="submit"][value*="Post" i]').first();
  if (await postBtn.count() && await postBtn.isVisible().catch(() => false)) {
    await postBtn.click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  return cur; // best-effort permalink — same as post_url
}

async function postInstagramComment(page, candidate) {
  await page.goto(candidate.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3500);

  const cur = page.url();
  if (cur.includes('accounts/login')) throw new Error('IG redirected to login.');

  const box = page.locator('textarea[aria-label*="comment" i], textarea[placeholder*="comment" i]').first();
  if (!await box.count() || !await box.isVisible({ timeout: 3000 }).catch(() => false)) {
    throw new Error('No IG comment textarea located');
  }

  await box.click({ timeout: 4000 });
  await page.keyboard.type(candidate.comment_draft, { delay: 25 });
  await page.waitForTimeout(800);

  if (DRY_RUN) { console.log('[engagement-poster] DRY-RUN: skipping submit'); return null; }

  const postBtn = page.locator('div[role="button"]:has-text("Post"), button:has-text("Post")').first();
  if (await postBtn.count() && await postBtn.isVisible().catch(() => false)) {
    await postBtn.click();
    await page.waitForTimeout(2000);
  } else {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);
  }
  return cur;
}

async function postLinkedInComment(page, candidate) {
  await page.goto(candidate.post_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(4000);

  const cur = page.url();
  if (cur.includes('/login') || cur.includes('/uas/login')) throw new Error('LinkedIn redirected to login.');

  // LinkedIn comment composer is a contenteditable inside a specific aria-label
  const candidates = [
    'div.comments-comment-box__form div[contenteditable="true"]',
    'div[aria-label*="comment" i][contenteditable="true"]',
    'div[role="textbox"][aria-label*="comment" i]',
  ];
  let box = null;
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (await el.count() && await el.isVisible({ timeout: 2000 }).catch(() => false)) {
      box = el; break;
    }
  }
  if (!box) throw new Error('No LinkedIn comment box located');

  await box.click({ timeout: 4000 });
  await page.waitForTimeout(600);
  await page.keyboard.type(candidate.comment_draft, { delay: 25 });
  await page.waitForTimeout(800);

  if (DRY_RUN) { console.log('[engagement-poster] DRY-RUN: skipping submit'); return null; }

  const postBtn = page.locator('button.comments-comment-box__submit-button, button:has-text("Post")').first();
  if (await postBtn.count() && await postBtn.isVisible().catch(() => false)) {
    await postBtn.click();
    await page.waitForTimeout(2500);
  } else {
    await page.keyboard.press('Control+Enter').catch(() => {});
    await page.waitForTimeout(2500);
  }
  return cur;
}

async function postRedditComment(candidate) {
  // Delegate to the existing reddit-comment-playwright.js script which
  // already handles persistent profile + composer location for new Reddit.
  const { spawn } = require('child_process');
  return await new Promise((resolve, reject) => {
    const child = spawn('node', [
      path.join(__dirname, 'reddit-comment-playwright.js'),
      `--url=${candidate.post_url}`,
      `--text=${candidate.comment_draft}`,
    ], { cwd: path.join(__dirname, '..') });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      if (code !== 0) return reject(new Error(`reddit poster exit ${code}: ${stderr.slice(0, 400)}`));
      try {
        const payload = JSON.parse(stdout.trim().split('\n').pop());
        if (!payload.ok) return reject(new Error(`reddit poster: ${JSON.stringify(payload)}`));
        resolve(payload.url || payload.permalink || candidate.post_url);
      } catch (e) {
        reject(new Error(`reddit poster bad stdout: ${stdout.slice(0, 200)}`));
      }
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function postOne(context, candidate) {
  const platform = (candidate.platform || '').toLowerCase();
  console.log(`[engagement-poster] posting ${platform} id=${candidate.id}`);

  let permalink = null;

  if (platform === 'reddit') {
    permalink = await postRedditComment(candidate);
  } else {
    const page = await context.newPage();
    try {
      if (platform === 'facebook')  permalink = await postFacebookComment(page, candidate);
      else if (platform === 'instagram') permalink = await postInstagramComment(page, candidate);
      else if (platform === 'linkedin')  permalink = await postLinkedInComment(page, candidate);
      else throw new Error(`Unsupported platform: ${platform}`);
    } finally {
      await page.close().catch(() => {});
    }
  }
  return permalink;
}

async function main() {
  // Collect work
  let queue = [];
  if (CANDIDATE_ID) {
    const c = await fetchCandidate(CANDIDATE_ID);
    if (!c) { console.error('[engagement-poster] candidate not found:', CANDIDATE_ID); process.exit(1); }
    if (c.status !== 'approved') {
      console.error(`[engagement-poster] candidate ${CANDIDATE_ID} status=${c.status}; refusing`); process.exit(1);
    }
    queue = [c];
  } else {
    queue = await fetchNextApproved(MAX_RUNS);
  }

  if (!queue.length) { console.log('[engagement-poster] no approved candidates to ship'); return; }
  console.log(`[engagement-poster] queue size: ${queue.length} (max=${MAX_RUNS})`);

  // Profile unlock pre-flight
  try {
    const { unlockProfile } = require('./_lib/chrome-profile-unlock');
    const r = await unlockProfile({ profileDir: CHROME_PROFILE_PATH, reason: 'sage-engagement-poster' });
    if (r.killed > 0) console.log(`[engagement-poster] unlocked profile (killed ${r.killed} chrome procs)`);
  } catch (e) {
    console.warn('[engagement-poster] profile-unlock non-fatal:', e.message);
  }

  // Skip Reddit-only payloads for the Chromium launch (Reddit goes via its own subprocess)
  const needsBrowser = queue.some(c => (c.platform || '').toLowerCase() !== 'reddit');

  let context = null;
  if (needsBrowser) {
    const { chromium } = require('playwright');
    context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
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
  }

  const results = { posted: 0, failed: 0, ids: [] };
  try {
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      try {
        const permalink = await postOne(context, c);
        if (DRY_RUN) {
          console.log(`[engagement-poster] DRY-RUN: would mark posted id=${c.id}`);
        } else {
          await markPosted(c.id, permalink);
          await telegram(`Sage posted ${c.platform} comment (id=${c.id}):\n\n"${(c.comment_draft || '').slice(0, 200)}"`);
        }
        results.posted++;
        results.ids.push({ id: c.id, platform: c.platform, status: 'posted' });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        console.error(`[engagement-poster] FAILED id=${c.id}:`, msg);
        await markFailed(c.id, msg, c.post_attempt_count || 0);
        await telegram(`Sage engagement-poster FAILED id=${c.id} (${c.platform}): ${msg.slice(0, 300)}`);
        results.failed++;
        results.ids.push({ id: c.id, platform: c.platform, status: 'failed', error: msg });
      }
      if (i < queue.length - 1) await new Promise(r => setTimeout(r, COOLDOWN_MS));
    }
  } finally {
    if (context) await context.close().catch(() => {});
  }

  console.log('[engagement-poster] DONE:', JSON.stringify(results, null, 2));
}

main().catch(err => {
  console.error('[engagement-poster] fatal:', err && err.message);
  process.exit(1);
});
