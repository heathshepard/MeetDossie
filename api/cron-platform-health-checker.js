'use strict';

// api/cron-platform-health-checker.js
//
// SV-ENG-RELIABILITY-002 (Atlas, 2026-06-11)
//
// PLATFORM HEALTH CHECKER. Runs every 2h during business hours (14-23 UTC =
// 9 AM – 6 PM CDT). For each platform we publish to via Zernio, probe Zernio's
// `/api/v1/accounts` endpoint and verify our specific account_id is present
// and active. Record latency + status to `platform_health_checks` table.
//
// Failure policy:
//   - 1 fail → log, no action (Zernio sometimes burps).
//   - 2 consecutive fails → set `platform_pause_until` = now() + 1h in
//     `platform_health_state` table. cron-publish-approved checks this on every
//     fire and skips paused platforms. Wall-log the pause.
//   - 3+ consecutive fails → Cole-only Telegram ping + extend pause to 2h.
//
// Recovery:
//   - On first successful probe after a pause, reset consecutive_fails=0 and
//     clear platform_pause_until.
//
// Auth: Bearer ${CRON_SECRET} OR x-vercel-cron.
// Schedule: vercel.json `0 14-23/2 * * *`.

const { logWall, recordCronRun } = require('./_lib/wall-log.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ZERNIO_API_KEY = process.env.ZERNIO_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const COLE_TELEGRAM_CHAT_ID = process.env.COLE_TELEGRAM_CHAT_ID || process.env.TELEGRAM_CHAT_ID;

const SELF_NAME = 'cron-platform-health-checker';

const ACCOUNT_IDS = {
  facebook:  '69f253c3985e734bf3d8f9bc',
  instagram: '69f25431985e734bf3d8fcbe',
  twitter:   '69f255c6985e734bf3d90ba1',
  linkedin:  '69fccd7392b3d8e85f8f12be',
  tiktok:    '69f15791985e734bf3d13b89',
};

const PAUSE_SHORT_HOURS = 1;
const PAUSE_LONG_HOURS = 2;
const PAUSE_THRESHOLD = 2;
const PAUSE_ESCALATE_THRESHOLD = 3;

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
    console.error('[health-checker] tg error:', err && err.message);
  }
}

async function probeZernioAccounts() {
  if (!ZERNIO_API_KEY) return { ok: false, error: 'no-zernio-key' };
  const startedAt = Date.now();
  try {
    const res = await fetch('https://zernio.com/api/v1/accounts', {
      headers: {
        Authorization: `Bearer ${ZERNIO_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });
    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      return { ok: false, status: res.status, latencyMs };
    }
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data || !Array.isArray(data.accounts)) {
      return { ok: false, status: 200, latencyMs, error: 'no-accounts-array' };
    }
    return { ok: true, accounts: data.accounts, latencyMs };
  } catch (err) {
    return { ok: false, error: err && err.message, latencyMs: Date.now() - startedAt };
  }
}

function findAccount(accounts, accountId) {
  return (accounts || []).find((a) => (a._id || a.id) === accountId) || null;
}

async function loadState() {
  const { ok, data } = await sb('/rest/v1/platform_health_state?select=*&limit=20');
  const map = new Map();
  if (ok && Array.isArray(data)) {
    for (const row of data) map.set(row.platform, row);
  }
  return map;
}

async function upsertState(platform, patch) {
  const body = JSON.stringify({ platform, ...patch, updated_at: new Date().toISOString() });
  const res = await sb('/rest/v1/platform_health_state?on_conflict=platform', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body,
  });
  return res.ok;
}

async function insertCheck(platform, result) {
  const body = JSON.stringify({
    platform,
    checked_at: new Date().toISOString(),
    ok: !!result.ok,
    latency_ms: result.latencyMs || null,
    http_status: result.status || null,
    error: result.error || null,
    account_active: !!result.accountActive,
  });
  await sb('/rest/v1/platform_health_checks', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body,
  });
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

  const probe = await probeZernioAccounts();
  const state = await loadState();
  const results = [];

  for (const [platform, accountId] of Object.entries(ACCOUNT_IDS)) {
    const cur = state.get(platform) || { platform, consecutive_fails: 0, platform_pause_until: null };
    let okForThisPlatform = false;
    let accountActive = false;
    let detail = {};

    if (probe.ok) {
      const acc = findAccount(probe.accounts, accountId);
      if (acc && (acc.isActive || acc.is_active)) {
        okForThisPlatform = true;
        accountActive = true;
      } else if (acc) {
        detail = { account_found_but_inactive: true };
      } else {
        detail = { account_not_found_in_response: true };
      }
    } else {
      detail = { zernio_probe_failed: true, status: probe.status, error: probe.error };
    }

    await insertCheck(platform, {
      ok: okForThisPlatform,
      latencyMs: probe.latencyMs,
      status: probe.status,
      error: probe.error,
      accountActive,
    });

    let consecutiveFails = okForThisPlatform ? 0 : (cur.consecutive_fails || 0) + 1;
    let pauseUntilIso = cur.platform_pause_until || null;
    let escalation = null;

    if (consecutiveFails >= PAUSE_ESCALATE_THRESHOLD) {
      pauseUntilIso = new Date(Date.now() + PAUSE_LONG_HOURS * 3600 * 1000).toISOString();
      escalation = 'escalated';
      await tg(`🚨 <b>${platform}</b> paused ${PAUSE_LONG_HOURS}h — ${consecutiveFails} consecutive Zernio probe fails. Detail: <code>${JSON.stringify(detail).slice(0, 200)}</code>`);
      await logWall({
        wall_id: `WALL-PLATFORM-${platform.toUpperCase()}-DOWN`,
        title: `${platform} probe failed ${consecutiveFails}x consecutively — extended pause`,
        what_broke: `Zernio /accounts probe failed for ${platform}: ${JSON.stringify(detail)}`,
        detected_by: SELF_NAME,
        root_cause: 'Zernio account inactive, API down, or session expired',
        route_around: `Paused ${platform} for ${PAUSE_LONG_HOURS}h via platform_health_state.platform_pause_until; cron-publish-approved skips paused platforms`,
        permanent_fix: 'PENDING — manual Zernio account refresh if pause repeats next probe cycle',
        resolved_by: SELF_NAME,
        reoccurrence_guard: `${SELF_NAME} runs every 2h; auto-pauses + extends on repeat fails`,
        metadata: { platform, consecutive_fails: consecutiveFails, detail },
      });
    } else if (consecutiveFails >= PAUSE_THRESHOLD) {
      pauseUntilIso = new Date(Date.now() + PAUSE_SHORT_HOURS * 3600 * 1000).toISOString();
      escalation = 'paused';
      await logWall({
        wall_id: `WALL-PLATFORM-${platform.toUpperCase()}-FLAKY`,
        title: `${platform} probe failed ${consecutiveFails}x consecutively — short pause`,
        what_broke: `Zernio /accounts probe failed for ${platform}: ${JSON.stringify(detail)}`,
        detected_by: SELF_NAME,
        root_cause: 'Zernio API flake or transient account issue',
        route_around: `Paused ${platform} for ${PAUSE_SHORT_HOURS}h via platform_health_state.platform_pause_until`,
        permanent_fix: 'Auto-resolves on next successful probe',
        resolved_by: SELF_NAME,
        reoccurrence_guard: `Threshold=${PAUSE_THRESHOLD} fails before pause`,
        metadata: { platform, consecutive_fails: consecutiveFails, detail },
      });
    } else if (okForThisPlatform && cur.platform_pause_until) {
      // Recovery — clear pause.
      pauseUntilIso = null;
      escalation = 'recovered';
    }

    await upsertState(platform, {
      consecutive_fails: consecutiveFails,
      platform_pause_until: pauseUntilIso,
      last_probe_ok: okForThisPlatform,
      last_latency_ms: probe.latencyMs || null,
      last_checked_at: new Date().toISOString(),
    });

    results.push({
      platform,
      ok: okForThisPlatform,
      consecutive_fails: consecutiveFails,
      pause_until: pauseUntilIso,
      escalation,
      latency_ms: probe.latencyMs,
      detail,
    });
  }

  await recordCronRun(SELF_NAME, 'ok');

  return res.status(200).json({
    ok: true,
    probe_ok: !!probe.ok,
    probe_latency_ms: probe.latencyMs,
    results,
  });
};
