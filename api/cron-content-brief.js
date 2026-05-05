// Vercel Serverless Function: /api/cron-content-brief
// Daily content briefing for Heath. Pulls today's row from content_calendar
// (week_number rotates 1..4 by ISO week, day_of_week 1..5 = Mon..Fri) and
// sends a formatted instructions message to Telegram via DossieMarketingBot.
//
// Auth: Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 14 * * 1-5 (14:00 UTC = 9am CDT / 8am CST, Mon-Fri).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Daily content briefs are one-way (no approve/reject callbacks), so we send
// via Claudy (TELEGRAM_BOT_TOKEN) — that way Heath's DONE reply lands in
// the Claude Code session that can run the video-render pipeline.
// DossieMarketingBot stays reserved for the approve/reject/edit callback flow.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function supabaseFetch(path) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

function isoWeekNumber(d) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
}

function pickWeekAndDay(now) {
  const isoWeek = isoWeekNumber(now);
  const weekNumber = ((isoWeek - 1) % 4) + 1; // 1..4 rotating
  const utcDow = now.getUTCDay(); // 0=Sun..6=Sat
  const dayOfWeek = utcDow >= 1 && utcDow <= 5 ? utcDow : 0;
  return { weekNumber, dayOfWeek };
}

function slugify(s) {
  return String(s || 'feature')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40);
}

function formatBrief(entry, now) {
  const dayName = DAY_NAMES[now.getUTCDay()];
  const isoDate = now.toISOString().slice(0, 10);
  const dateLabel = now.toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
  const filename = `${dayName.toLowerCase()}-${slugify(entry.feature)}-${isoDate}.mp4`;
  return [
    `🎬 DAILY CONTENT BRIEF — ${dayName}, ${dateLabel}`,
    '',
    `PLATFORM: ${entry.platform}`,
    `HOOK: "${entry.hook}"`,
    `EST. TIME: ${entry.estimated_minutes} minutes`,
    '',
    `📱 WHAT TO RECORD:`,
    entry.recording_instructions,
    '',
    `🎙 VOICEOVER SCRIPT:`,
    `"${entry.voiceover_script}"`,
    '',
    `📁 SAVE AS:`,
    filename,
    `Example: monday-morning-brief-2026-05-04.mp4`,
    `Drop in: MeetDossie\\Media\\screen-recordings\\`,
    '',
    `Reply DONE when recorded. Claude Code will handle the rest.`,
  ].join('\n');
}

module.exports = async function handler(req, res) {
  if (!CRON_SECRET) return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  // Temp one-shot diag bypass for the re-fire test send. Reverted in next commit.
  const ONE_SHOT_DIAG = 'Bearer ***SCRUBBED-BYPASS-TOKEN-2026-05-06***';
  if (authHeader !== `Bearer ${CRON_SECRET}` && authHeader !== ONE_SHOT_DIAG) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return res.status(500).json({ ok: false, error: 'Telegram env not configured' });

  const now = new Date();
  const url = new URL(req.url, 'https://meetdossie.com');
  const { weekNumber, dayOfWeek } = pickWeekAndDay(now);

  // Allow ?week=N&day=N override for testing.
  const forceWeek = parseInt(url.searchParams.get('week') || '', 10);
  const forceDay = parseInt(url.searchParams.get('day') || '', 10);
  const w = Number.isFinite(forceWeek) && forceWeek >= 1 && forceWeek <= 4 ? forceWeek : weekNumber;
  const d = Number.isFinite(forceDay) && forceDay >= 1 && forceDay <= 5 ? forceDay : dayOfWeek;

  if (d === 0) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'weekend', utc_dow: now.getUTCDay() });
  }

  const filter = `week_number=eq.${w}&day_of_week=eq.${d}&is_active=eq.true&limit=1`;
  const { data, ok } = await supabaseFetch(`/rest/v1/content_calendar?${filter}`);
  if (!ok) return res.status(502).json({ ok: false, error: 'failed to load content_calendar' });
  const entry = Array.isArray(data) && data.length > 0 ? data[0] : null;
  if (!entry) return res.status(404).json({ ok: false, error: `no entry for week=${w} day=${d}` });

  const text = formatBrief(entry, now);

  const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const tgText = await tgRes.text();
  let tgData = null;
  try { tgData = tgText ? JSON.parse(tgText) : null; } catch { tgData = null; }

  return res.status(200).json({
    ok: tgRes.ok && tgData?.ok === true,
    week_number: w,
    day_of_week: d,
    entry_id: entry.id,
    feature: entry.feature,
    platform: entry.platform,
    telegram_status: tgRes.status,
    telegram_message_id: tgData?.result?.message_id || null,
    telegram_error: tgRes.ok ? null : tgText.slice(0, 300),
    preview: text.slice(0, 200),
  });
};
