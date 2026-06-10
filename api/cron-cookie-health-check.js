'use strict';

// api/cron-cookie-health-check.js
//
// Daily check (04:00 UTC / 11 PM CST) of every saved Playwright session file.
// Parses cookie expiry dates and flags sites with cookies expiring < 14 days.
//
// On flag: alerts Heath via Telegram with the exact renew command.
// All results upserted into public.session_health for dashboard visibility.
//
// NOTE: This runs on Vercel, but the session files live on Heath's local
// machine under scripts/sessions/. To make the cron useful in serverless,
// we read the session files committed to the repo (Vercel deploys include
// scripts/sessions/ unless gitignored). If sessions/ is gitignored, this
// cron will report "missing" — at which point Heath should also run the
// scripts/check-cookie-health.js local equivalent.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const SESSIONS_DIR = path.join(process.cwd(), 'scripts', 'sessions');
const RENEW_THRESHOLD_DAYS = 14;

// Sites we care about. We always upsert these; if file missing, status=missing.
// 2026-06-10: Facebook removed — fb-group-poster + fb-group-watcher now use
// Heath's persistent Chrome profile (launchPersistentContext), which has no
// cookie-expiry to track. Other FB scripts (fb-group-commenter,
// fb-reply-poster, fb-comment-monitor) already use the persistent profile.
// Heath should never get pinged to renew the Facebook session again.
const MONITORED = ['reddit', 'instagram', 'linkedin'];

async function sbFetch(urlPath, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch {}
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function tgSend(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch {}
}

function evaluateSession(siteName) {
  const file = path.join(SESSIONS_DIR, `${siteName}.json`);
  if (!fs.existsSync(file)) {
    return { status: 'missing', expires_at: null, notes: 'session file not found' };
  }

  let json;
  try {
    json = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { status: 'expired', expires_at: null, notes: `parse error: ${err.message}` };
  }

  const cookies = Array.isArray(json.cookies) ? json.cookies : [];
  if (cookies.length === 0) {
    return { status: 'expired', expires_at: null, notes: 'no cookies in session file' };
  }

  // Track the SOONEST expiry among auth-critical cookies. Session cookies
  // (no expires field, or expires === -1) are skipped — they only live for
  // the browser session and aren't what we're trying to monitor.
  let soonest = null;
  for (const c of cookies) {
    const exp = c.expires;
    if (exp === undefined || exp === null || exp === -1) continue;
    if (typeof exp !== 'number') continue;
    if (soonest === null || exp < soonest) soonest = exp;
  }

  if (soonest === null) {
    return { status: 'unknown', expires_at: null, notes: 'no persistent cookies found' };
  }

  const expiresAt = new Date(soonest * 1000);
  const now = new Date();
  const daysLeft = (expiresAt - now) / (24 * 60 * 60 * 1000);

  let status;
  if (daysLeft < 0) status = 'expired';
  else if (daysLeft < RENEW_THRESHOLD_DAYS) status = 'expiring';
  else status = 'healthy';

  return {
    status,
    expires_at: expiresAt.toISOString(),
    notes: `${daysLeft.toFixed(1)} days until soonest cookie expiry`,
  };
}

async function upsertHealth(siteName, result) {
  const row = {
    site_name: siteName,
    status: result.status,
    expires_at: result.expires_at,
    notes: result.notes,
    last_checked_at: new Date().toISOString(),
  };

  // Upsert on unique site_name
  const { ok, status, text } = await sbFetch('/rest/v1/session_health?on_conflict=site_name', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });

  if (!ok) {
    console.error(`[cookie-health] upsert ${siteName} failed ${status}: ${text.slice(0, 200)}`);
  }
}

module.exports = async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Supabase env missing' });
  }

  const summary = [];
  const alerts = [];

  for (const site of MONITORED) {
    const result = evaluateSession(site);
    await upsertHealth(site, result);
    summary.push({ site, ...result });

    if (result.status === 'expiring' || result.status === 'expired' || result.status === 'missing') {
      alerts.push({ site, ...result });
    }
  }

  if (alerts.length > 0) {
    const lines = alerts.map(a => {
      const cmd = `node scripts/renew-session.js --site=${a.site}`;
      return `${a.site}: ${a.status} (${a.notes || ''})\n  ${cmd}`;
    });
    await tgSend(`Cookie health alert:\n\n${lines.join('\n\n')}`);
  } else {
    console.log('[cookie-health] all sessions healthy');
  }

  return res.status(200).json({
    ok: true,
    checked: summary.length,
    alerts: alerts.length,
    summary,
  });
};
