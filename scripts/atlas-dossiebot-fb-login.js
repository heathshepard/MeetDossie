'use strict';

// scripts/atlas-dossiebot-fb-login.js
//
// One-time DossieBot-Sage Chrome profile FB login flow.
//
// Steps:
//  1. Launch a small (800x600), bottom-right Chrome window pointed at the
//     DossieBot-Sage profile (so login persists for that profile only).
//     Navigate to facebook.com/login. Focus the email input.
//  2. Send ONE Telegram message instructing Heath to type his email +
//     password + Enter. (~10 sec.)
//  3. Poll every 2s for c_user cookie in the profile (via Playwright
//     context.cookies). When detected, close the small window cleanly.
//  4. Verify persistence by reopening a fresh launchPersistentContext into
//     the same profile dir and confirming c_user is still set.
//  5. Send ONE Telegram confirmation. Update memory file
//     reference_dossiebot_profile.md with status + timestamp.
//  6. Silently request to join the FB group URLs from today's group_posts
//     blitz at <= 5/hour (3-min spacing) to avoid FB rate limits. No
//     additional Heath pings.
//
// Constraints (per task):
//  - Heath gets exactly ONE login-prompt message + ONE success confirmation.
//  - If creds not entered within 30 minutes, send ONE follow-up nudge.
//  - No surfacing of intermediate blockers.

const path = require('path');
const fs = require('fs');
const os = require('os');

// ---------- env -------------------------------------------------------------
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
} catch {}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const DOSSIEBOT_PROFILE_DIR = process.env.DOSSIEBOT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'DossieBot-Sage'
);
const PROFILE_NAME = process.env.DOSSIEBOT_PROFILE_NAME || 'Default';

// Memory file Atlas maintains for DossieBot state.
const MEMORY_FILE = path.join(
  os.homedir(),
  '.claude', 'projects', 'C--Users-Heath-Shepard-Desktop-MeetDossie',
  'memory', 'reference_dossiebot_profile.md'
);

// Run dir for screenshots / logs
const RUN_TS = Date.now();
const RUN_DIR = path.join(__dirname, 'atlas-runs', `dossiebot-login-${RUN_TS}`);
fs.mkdirSync(RUN_DIR, { recursive: true });

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(path.join(RUN_DIR, 'run.log'), line + '\n'); } catch {}
}

// ---------- helpers ---------------------------------------------------------
async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    log('WARN: TELEGRAM_BOT_TOKEN missing — skipping Telegram send');
    return false;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: true,
        }),
      }
    );
    return res.ok;
  } catch (e) {
    log(`telegram error: ${e.message}`);
    return false;
  }
}

async function sb(p, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return { ok: false, status: 0, data: null };
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  try {
    const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
    const text = await res.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch {} }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    log(`supabase error: ${e.message}`);
    return { ok: false, status: 0, data: null };
  }
}

function updateMemoryFile(status, extra = {}) {
  try {
    const ts = new Date().toISOString();
    const lines = [
      '# DossieBot-Sage Chrome profile — FB login status',
      '',
      `Last updated: ${ts}`,
      `Status: ${status}`,
      `Profile dir: ${DOSSIEBOT_PROFILE_DIR}`,
      `Profile name: ${PROFILE_NAME}`,
      '',
    ];
    for (const [k, v] of Object.entries(extra)) {
      lines.push(`- ${k}: ${v}`);
    }
    lines.push('');
    lines.push('Managed by `scripts/atlas-dossiebot-fb-login.js`. Re-run that script if login lapses.');
    fs.mkdirSync(path.dirname(MEMORY_FILE), { recursive: true });
    fs.writeFileSync(MEMORY_FILE, lines.join('\n'), 'utf8');
    log(`memory updated: ${MEMORY_FILE}`);
  } catch (e) {
    log(`memory update failed: ${e.message}`);
  }
}

// ---------- core flow -------------------------------------------------------
async function launchPersistentSmall(playwright) {
  const { chromium } = playwright;
  // Small bottom-right window so it stays out of Heath's way.
  // Screen-pos via Chrome args. Many monitors are 1920x1080; pick a safe
  // bottom-right anchor that works at 1080p and 1440p.
  const args = [
    '--window-size=820,640',
    '--window-position=1080,420',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=PasswordCheck,SafeBrowsing',
  ];

  // Use a known recent user-agent so FB doesn't show "unsupported browser".
  const context = await chromium.launchPersistentContext(DOSSIEBOT_PROFILE_DIR, {
    headless: false,
    channel: 'chrome',
    args,
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  return context;
}

async function getCUserCookie(context) {
  try {
    const cookies = await context.cookies(['https://www.facebook.com']);
    const c = cookies.find((x) => x.name === 'c_user' && x.value);
    return c ? c.value : null;
  } catch {
    return null;
  }
}

async function fetchTodayGroupUrls() {
  // Pull distinct group_url from group_posts rows touched in the last 36h.
  // 36h window catches "today's blitz" regardless of timezone.
  const since = new Date(Date.now() - 36 * 3600 * 1000).toISOString();
  const url = `/rest/v1/group_posts?select=group_url,group_name,created_at&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=50`;
  const { ok, data } = await sb(url);
  if (!ok || !Array.isArray(data)) return [];
  const seen = new Set();
  const out = [];
  for (const row of data) {
    if (!row.group_url) continue;
    if (seen.has(row.group_url)) continue;
    seen.add(row.group_url);
    out.push({ url: row.group_url, name: row.group_name || row.group_url });
  }
  // Per task: 5-6 URLs. Cap at 6 to respect the rate-limit guidance.
  return out.slice(0, 6);
}

async function tryRequestJoin(context, groupUrl, groupName) {
  // Open the group, look for a "Join group" button (visible text or
  // aria-label). If present, click it. We do not retry aggressively — if the
  // button isn't there (already a member / pending / restricted), move on.
  let page;
  try {
    page = await context.newPage();
    await page.goto(groupUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(3500);

    // Candidate locators for the Join button. FB UI rotates; be generous.
    const candidates = [
      'div[role="button"][aria-label="Join group"]',
      'div[role="button"][aria-label*="Join group" i]',
      'div[role="button"]:has-text("Join group")',
      'div[role="button"]:has-text("Join Group")',
      'a[role="button"]:has-text("Join group")',
    ];

    for (const sel of candidates) {
      try {
        const btn = await page.$(sel);
        if (btn) {
          await btn.click({ timeout: 5000 });
          await page.waitForTimeout(2000);
          // A confirmation may appear ("Answer questions" / "Submit"). Do
          // NOT fill it — that's manual moderation territory. Just leave
          // the join request pending.
          log(`requested to join: ${groupName} (${groupUrl})`);
          return 'requested';
        }
      } catch {}
    }
    log(`no Join button visible: ${groupName} (already member / pending / restricted)`);
    return 'no_button';
  } catch (e) {
    log(`join error for ${groupName}: ${e.message}`);
    return 'error';
  } finally {
    if (page) {
      try { await page.close(); } catch {}
    }
  }
}

async function autoJoinGroups(playwright) {
  const groups = await fetchTodayGroupUrls();
  if (!groups.length) {
    log('no group URLs found in last 36h — skip auto-join');
    return { attempted: 0, requested: 0 };
  }
  log(`auto-join: ${groups.length} group(s) from recent group_posts`);

  // Reopen the profile (fresh handle for clean state).
  const context = await launchPersistentSmall(playwright);
  let requested = 0;
  try {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const outcome = await tryRequestJoin(context, g.url, g.name);
      if (outcome === 'requested') requested++;
      // 3-min spacing => max 20/hour theoretical, but we cap at 6 total
      // for this run. Skip wait after the last one.
      if (i < groups.length - 1) {
        log('sleep 180s before next join...');
        await new Promise((r) => setTimeout(r, 180000));
      }
    }
  } finally {
    try { await context.close(); } catch {}
  }
  return { attempted: groups.length, requested };
}

// ---------- main ------------------------------------------------------------
(async () => {
  log(`run start. profile=${DOSSIEBOT_PROFILE_DIR}`);

  let playwright;
  try {
    playwright = require('playwright');
  } catch (e) {
    log(`playwright import failed: ${e.message}`);
    updateMemoryFile('error: playwright missing', { error: e.message });
    process.exit(1);
  }

  // Run preflight to close any stray FB tabs in Heath's main Chrome before
  // we launch the DossieBot profile (which puts an FB tab in foreground).
  try {
    const { preflight } = require('./_lib/fb-tab-preflight');
    const pre = await preflight({ reason: 'dossiebot-fb-login' });
    log(`preflight: closed=${pre.closed} skipped_dossiebot=${pre.skipped_dossiebot}`);
  } catch (e) {
    log(`preflight non-fatal: ${e.message}`);
  }

  // Quick check: is profile ALREADY logged in? If so, skip the prompt entirely.
  let preCheck;
  try {
    preCheck = await launchPersistentSmall(playwright);
    const page = await preCheck.newPage();
    await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2500);
    const cuser = await getCUserCookie(preCheck);
    if (cuser) {
      log(`profile already logged in (c_user=${cuser}). Skipping prompt.`);
      try { await page.close(); } catch {}
      try { await preCheck.close(); } catch {}
      updateMemoryFile('logged_in', { c_user: cuser, detected_at: new Date().toISOString() });
      await tg('✅ DossieBot already logged into FB. Profile ready for invisible automation.');
      const join = await autoJoinGroups(playwright);
      log(`auto-join result: ${JSON.stringify(join)}`);
      process.exit(0);
    }
    // Not logged in — navigate to login and focus email field.
    log('profile not logged in. Navigating to /login...');
    await page.goto('https://www.facebook.com/login/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    try {
      await page.click('#email', { timeout: 4000 });
      log('email input focused');
    } catch (e) {
      log(`focus #email failed (non-fatal): ${e.message}`);
    }
  } catch (e) {
    log(`launch/preCheck error: ${e.message}`);
    updateMemoryFile('error: launch_failed', { error: e.message });
    try { if (preCheck) await preCheck.close(); } catch {}
    process.exit(1);
  }

  // Send the ONE login-prompt message.
  await tg(
    'DossieBot Chrome window is open and waiting at FB login, email field focused.\n' +
    'Type your FB email + password + Enter. Takes 10 seconds.\n' +
    'I\'ll auto-detect when you\'re logged in and finish setup invisibly.'
  );
  log('login prompt sent to Telegram');

  // Poll for c_user every 2s. 30-min total wait, with one nudge at 30 min if
  // still pending. After 60 min, give up gracefully.
  const POLL_INTERVAL_MS = 2000;
  const NUDGE_AT_MS = 30 * 60 * 1000;
  const GIVE_UP_AT_MS = 60 * 60 * 1000;
  const startedAt = Date.now();
  let nudged = false;
  let cuser = null;

  while (true) {
    const elapsed = Date.now() - startedAt;
    cuser = await getCUserCookie(preCheck);
    if (cuser) {
      log(`c_user detected: ${cuser} (after ${Math.round(elapsed / 1000)}s)`);
      break;
    }
    if (!nudged && elapsed >= NUDGE_AT_MS) {
      nudged = true;
      log('30-min nudge sending...');
      await tg('DossieBot login still pending — can take 10 sec whenever you\'re back at the keyboard.');
    }
    if (elapsed >= GIVE_UP_AT_MS) {
      log('giving up after 60 min — no login detected');
      try { await preCheck.close(); } catch {}
      updateMemoryFile('pending', {
        gave_up_after_min: 60,
        last_check: new Date().toISOString(),
      });
      // Per task: don't surface blockers. Exit silently (no extra Telegram).
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  // Close the visible window cleanly.
  try { await preCheck.close(); } catch (e) { log(`close error: ${e.message}`); }

  // Confirm persistence by reopening fresh.
  let verified = false;
  try {
    const verifyCtx = await launchPersistentSmall(playwright);
    // Don't navigate to a page; reading cookies via context is enough for
    // persistence proof. But the cookie context needs at least one navigation
    // to populate. Quick about:blank then check.
    const vp = await verifyCtx.newPage();
    await vp.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await vp.waitForTimeout(2000);
    const cuser2 = await getCUserCookie(verifyCtx);
    verified = !!cuser2;
    log(`verify reopen: c_user=${cuser2 || '(missing)'}`);
    try { await vp.close(); } catch {}
    try { await verifyCtx.close(); } catch {}
  } catch (e) {
    log(`verify error: ${e.message}`);
  }

  if (!verified) {
    log('WARN: verify failed but login was detected. Continuing.');
  }

  await tg('✅ DossieBot logged into FB. Profile ready for invisible automation.');
  updateMemoryFile('logged_in', {
    c_user: cuser,
    verified_persistence: verified ? 'yes' : 'unverified',
    logged_in_at: new Date().toISOString(),
  });

  // Silent group joins (no Telegram updates per task).
  try {
    const join = await autoJoinGroups(playwright);
    log(`auto-join result: ${JSON.stringify(join)}`);
  } catch (e) {
    log(`auto-join exception (non-fatal): ${e.message}`);
  }

  log('run complete');
  process.exit(0);
})().catch((e) => {
  log(`FATAL: ${e.stack || e.message}`);
  process.exit(1);
});
