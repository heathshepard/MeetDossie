'use strict';

// api/cron-account-session-monitor.js
//
// SV-ENG-RELIABILITY-003 (Atlas, 2026-06-11)
//
// ACCOUNT SESSION MONITOR. Runs every 6h. Validates the publishing-side
// account session:
//
//   - Publishing side (Zernio): probe https://zernio.com/api/v1/accounts
//     and verify our account_id is present + active.
//
// MIGRATION NOTE (2026-06-11 evening): The engagement-side check
// (reddit/instagram/linkedin session_health rows) is removed. Those
// platforms now run off Heath's persistent DossieBot Chrome profile and
// are kept warm by scripts/<platform>-session-keepalive.js on Windows
// Task Scheduler every 3 days. The local keepalive scripts ping Cole
// directly via Telegram if 3 consecutive runs fail — no Vercel side
// check needed. The cron-cookie-health-check.js cron has been removed.
//
// Action policy:
//   - Zernio account inactive → wall-log + Cole-only alert (no refresh path
//     from serverless — Heath must reconnect in Zernio dashboard).
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron.
// Schedule: vercel.json `0 */6 * * *`.

const { logWall, recordCronRun } = require('./_lib/wall-log.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const COLE_TELEGRAM_CHAT_ID = process.env.COLE_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

const SELF_NAME = 'cron-account-session-monitor';

const ZERNIO_ACCOUNTS = {
  facebook:  '69f253c3985e734bf3d8f9bc',
  instagram: '69f25431985e734bf3d8fcbe',
  twitter:   '69f255c6985e734bf3d90ba1',
  linkedin:  '69fccd7392b3d8e85f8f12be',
  tiktok:    '69f15791985e734bf3d13b89',
};

async function sb(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !COLE_TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: COLE_TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[session-monitor] tg error:', err && err.message);
  }
}

async function probeZernio() {
  if (!ZERNIO_API_KEY) return { ok: false, error: 'no-zernio-key' };
  try {
    const res = await fetch('https://zernio.com/api/v1/accounts', {
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    if (!Array.isArray(data.accounts)) return { ok: false, error: 'no-accounts-array' };
    return { ok: true, accounts: data.accounts };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

module.exports = async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const zernio = await probeZernio();
  const findings = [];
  const alerts = [];

  // ─── Publishing side (Zernio) ────────────────────────────────────────
  for (const [platform, accountId] of Object.entries(ZERNIO_ACCOUNTS)) {
    let status = 'unknown';
    let detail = {};
    if (zernio.ok) {
      const acc = (zernio.accounts || []).find((a) => (a._id || a.id) === accountId);
      if (acc && (acc.isActive || acc.is_active)) {
        status = 'active';
        detail = { account_name: acc.displayName || acc.name };
      } else if (acc) {
        status = 'inactive';
        detail = { account_name: acc.displayName || acc.name };
      } else {
        status = 'missing';
      }
    } else {
      status = 'probe-failed';
      detail = { error: zernio.error, http_status: zernio.status };
    }

    findings.push({ side: 'publish', platform, status, detail });

    if (status === 'inactive' || status === 'missing') {
      alerts.push(`📴 <b>Zernio ${platform}</b>: ${status}. Heath must reconnect at zernio.com.`);
      await logWall({
        wall_id: `WALL-ZERNIO-${platform.toUpperCase()}-${status.toUpperCase()}`,
        title: `Zernio ${platform} account ${status}`,
        what_broke: `${platform} not active in Zernio account list`,
        detected_by: SELF_NAME,
        root_cause: status === 'missing'
          ? 'Account removed from Zernio (token revoked, platform disconnect)'
          : 'Account flagged inactive in Zernio (auth expired or platform-side rate-limit lock)',
        route_around: 'Cole alert sent; no automated refresh path from Vercel for Zernio',
        permanent_fix: `Heath reconnects ${platform} via zernio.com dashboard`,
        resolved_by: SELF_NAME,
        reoccurrence_guard: `${SELF_NAME} re-checks every 6h; cron-platform-health-checker also pauses publishing within 1h`,
        metadata: { platform, status, detail },
      });
    }
  }

  // ─── Engagement side ────────────────────────────────────────────────
  // Reddit / Instagram / LinkedIn now run off Heath's persistent DossieBot
  // Chrome profile. Local Windows scheduled tasks
  // (scripts/<platform>-session-keepalive.js) check session warmth every 3
  // days and ping Cole directly if 3 consecutive runs fail. No Vercel-side
  // check is needed or possible (no access to the local Chrome profile).
  // See: feedback_pyautogui_not_playwright.md / SV-ENG-COOKIE-MIGRATION-2026-06-11.

  if (alerts.length > 0) {
    const lines = ['🔐 <b>SESSION MONITOR</b>', '', ...alerts];
    await tg(lines.join('\n'));
  }

  await recordCronRun(SELF_NAME, alerts.length > 0 ? 'recovered' : 'ok');

  return res.status(200).json({
    ok: true,
    zernio_probe_ok: !!zernio.ok,
    findings,
    alerts_sent: alerts.length,
  });
};
