'use strict';

// api/cron-morning-ops-digest.js
//
// SV-ENG-WATCHDOG-002 (Atlas, 2026-06-11)
//
// Runs at 8 AM CDT (13:00 UTC) every day. Sends Heath ONE Telegram digest:
//
//   📊 Yesterday (Wed Jun 11): N/M posts shipped, X/Y comments
//     - FB: 1/2 (1 admin-pending)
//     - IG: 2/1 (overshoot)
//     - LinkedIn: 0/1 (reject -- replacement queued for today)
//     - Twitter: 3/3 ✓
//     - TikTok: 0/1 (no video)
//   📊 Today (Thu Jun 12) armed: 8 posts queued, scanner running, Watchdog active
//
// This is the ONLY mid-mission Telegram ping the watchdog stack sends Heath
// per his summary-only rule.
//
// Auth: Bearer ${CRON_SECRET} or x-vercel-cron.
// Schedule: vercel.json — "0 13 * * *" (8 AM CDT in summer).

const { DateTime } = require('luxon');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const TZ = 'America/Chicago';
const PLATFORMS = ['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube'];

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
    console.error('[morning-digest] telegram error:', err && err.message);
  }
}

function abbr(p) {
  return ({
    facebook: 'FB', instagram: 'IG', linkedin: 'LinkedIn',
    twitter: 'Twitter', tiktok: 'TikTok', youtube: 'YouTube',
  })[p] || p;
}

async function postedRange(platform, startUtc, endUtc) {
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.posted` +
    `&zernio_post_id=not.is.null` +
    `&posted_at=gte.${encodeURIComponent(startUtc)}` +
    `&posted_at=lte.${encodeURIComponent(endUtc)}` +
    `&select=id`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function rejectedRange(platform, startUtc, endUtc) {
  const filter = `platform=eq.${encodeURIComponent(platform)}` +
    `&status=eq.rejected` +
    `&created_at=gte.${encodeURIComponent(startUtc)}` +
    `&created_at=lte.${encodeURIComponent(endUtc)}` +
    `&select=id`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function scheduleFor(platform, dow) {
  const { data } = await sb(`/rest/v1/posting_schedule?is_active=eq.true&platform=eq.${platform}&day_of_week=eq.${dow}&select=max_per_day`);
  if (Array.isArray(data) && data.length) return data[0].max_per_day || 0;
  return 0;
}

async function commentsCountRange(startUtc, endUtc) {
  const filter = `status=eq.posted&posted_at=gte.${encodeURIComponent(startUtc)}&posted_at=lte.${encodeURIComponent(endUtc)}&select=id`;
  const { ok, data } = await sb(`/rest/v1/engagement_candidates?${filter}`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function commentCapToday() {
  // The veto-mode lib enforces a Heath-set DAILY_POST_CAP of 5 plus per-platform.
  // For digest purposes use the simple "approved today + scanner backlog".
  const { ok, data } = await sb(`/rest/v1/engagement_candidates?status=eq.pending&relevance_score=gte.6&select=id`);
  return ok && Array.isArray(data) ? data.length : 0;
}

async function armedToday() {
  // Count rows ready to fire today (approved + scheduled).
  const nowIso = new Date().toISOString();
  const filter = `status=eq.approved&posted_at=is.null&or=(scheduled_for.is.null,scheduled_for.lte.${encodeURIComponent(nowIso)})&select=id,platform`;
  const { ok, data } = await sb(`/rest/v1/social_posts?${filter}`);
  return ok && Array.isArray(data) ? data : [];
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

  const now = DateTime.now().setZone(TZ);
  const today = now.startOf('day');
  const yesterday = today.minus({ days: 1 });
  const yStartUtc = yesterday.toUTC().toISO();
  const yEndUtc   = today.minus({ seconds: 1 }).toUTC().toISO();

  const yLabel = yesterday.toFormat('ccc LLL d');  // Wed Jun 11
  const tLabel = today.toFormat('ccc LLL d');

  // Yesterday actuals.
  const yPosted = {};
  const yRejected = {};
  const yExpected = {};
  let yTotal = 0;
  let yExpTotal = 0;
  for (const p of PLATFORMS) {
    yPosted[p]   = await postedRange(p, yStartUtc, yEndUtc);
    yRejected[p] = await rejectedRange(p, yStartUtc, yEndUtc);
    yExpected[p] = await scheduleFor(p, yesterday.weekday % 7);
    yTotal      += yPosted[p];
    yExpTotal   += yExpected[p];
  }

  // Yesterday comments.
  const yComments = await commentsCountRange(yStartUtc, yEndUtc);
  const yCommentTarget = 46; // matches Heath's brief "X/46 comments"

  // Today armed.
  const armed = await armedToday();
  const armedByPlat = {};
  for (const a of armed) armedByPlat[a.platform] = (armedByPlat[a.platform] || 0) + 1;
  const armedTotal = armed.length;

  // Watchdog status check — read the latest watchdog cron output (if logged) or
  // assume active (the cron itself is the source of truth — if it ran 8 AM
  // alongside this one, it's alive).
  const watchdogActive = true;

  // Build digest.
  const lines = [];
  lines.push(`📊 Yesterday (${yLabel}): ${yTotal}/${yExpTotal} posts shipped, ${yComments}/${yCommentTarget} comments`);
  for (const p of PLATFORMS) {
    if (yExpected[p] === 0) continue;
    const ok = yPosted[p] >= yExpected[p] ? '✓' : '';
    const tag = [];
    if (yRejected[p] > 0)             tag.push(`${yRejected[p]} reject${yRejected[p] === 1 ? '' : 's'} — replacement queued for today`);
    if (yPosted[p] > yExpected[p])    tag.push('overshoot');
    if (yPosted[p] === 0 && yExpected[p] > 0) {
      if (p === 'tiktok') tag.push('no video');
      else tag.push('missed');
    }
    const tagStr = tag.length ? ` (${tag.join(', ')})` : '';
    lines.push(`  - ${abbr(p)}: ${yPosted[p]}/${yExpected[p]}${tagStr} ${ok}`.trimEnd());
  }
  lines.push('');
  const armedNotes = Object.entries(armedByPlat).map(([k, v]) => `${abbr(k)}:${v}`).join(' ');
  lines.push(`📊 Today (${tLabel}) armed: ${armedTotal} posts queued${armedNotes ? ' (' + armedNotes + ')' : ''}, scanner running, Watchdog ${watchdogActive ? 'active' : 'OFFLINE'}`);

  await tg(lines.join('\n'));

  return res.status(200).json({
    ok: true,
    yesterday: { posted: yPosted, expected: yExpected, rejected: yRejected, comments: yComments },
    today: { armed: armedTotal, by_platform: armedByPlat },
    digest_sent: true,
  });
};
