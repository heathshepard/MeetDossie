// Vercel Serverless Function: /api/cron-fb-unlock-alerts
//
// Mondays at 9 AM CDT (14:00 UTC). Finds Facebook groups where we've been
// commenting consistently (>=5 substantive comments) and could plausibly DM
// the admin to ask for posting access. For each, pings Heath via Claudy on
// Telegram with a Pierce-drafted DM, then marks admin_unlock_status='pending'
// to avoid re-pinging next week.
//
// Schedule (in vercel.json): "0 14 * * 1"
// Auth: x-vercel-cron header OR Bearer ${CRON_SECRET}
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (Claudy)
//   CRON_SECRET

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET               = process.env.CRON_SECRET;

const COMMENT_THRESHOLD = 5;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-fb-unlock-alerts] Telegram not configured');
    return { ok: false };
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[cron-fb-unlock-alerts] Telegram failed', r.status, t.slice(0, 200));
      return { ok: false };
    }
    return { ok: true };
  } catch (e) {
    console.error('[cron-fb-unlock-alerts] Telegram threw', e && e.message);
    return { ok: false };
  }
}

// Best-effort DM template. Heath will edit before sending — we're not
// auto-sending FB DMs. Kept short, friendly, low-pressure.
function draftDM(groupName) {
  return [
    `Hey — been enjoying ${groupName} and learning a lot from everyone.`,
    `I work with Texas real estate agents on transaction coordination workflows and had a question I think this community could actually help with.`,
    `Any chance I could share a single post asking the group? Totally fine if not — wanted to ask first instead of just dropping it in.`,
    `Thanks!`,
  ].join('\n\n');
}

module.exports = withTelemetry('cron-fb-unlock-alerts', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  // Query candidates:
  //   posting_status = 'comment_only'
  //   AND comment_count >= 5
  //   AND admin_unlock_status IN ('not_needed', NULL)  (PostgREST: in.("not_needed"))
  const path =
    `/rest/v1/fb_groups?` +
    `posting_status=eq.comment_only&` +
    `comment_count=gte.${COMMENT_THRESHOLD}&` +
    `admin_unlock_status=in.(not_needed)&` +
    `select=group_url,group_name,comment_count,last_commented_at`;

  const candidatesRes = await supabaseFetch(path);
  if (!candidatesRes.ok) {
    return res.status(500).json({ ok: false, error: 'Failed to query fb_groups', detail: candidatesRes.data });
  }

  const candidates = Array.isArray(candidatesRes.data) ? candidatesRes.data : [];
  console.log(`[cron-fb-unlock-alerts] ${candidates.length} candidates`);

  const processed = [];
  const errors = [];

  for (const row of candidates) {
    const draft = draftDM(row.group_name);

    // 1. Stash the draft in fb_admin_dms
    const dmInsert = await supabaseFetch('/rest/v1/fb_admin_dms', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        group_url:  row.group_url,
        group_name: row.group_name,
        draft_body: draft,
        status:     'draft',
        drafted_by: 'pierce',
      }),
    });

    if (!dmInsert.ok) {
      console.warn(`[cron-fb-unlock-alerts] DM draft insert failed for ${row.group_url}`, dmInsert.data);
      errors.push({ group_url: row.group_url, stage: 'dm_draft', detail: dmInsert.data });
      continue;
    }

    // 2. Mark group as pending so we don't double-alert next week
    const patchRes = await supabaseFetch(
      `/rest/v1/fb_groups?group_url=eq.${encodeURIComponent(row.group_url)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          admin_unlock_status: 'pending',
          last_unlock_dm_at:   new Date().toISOString(),
        }),
      }
    );
    if (!patchRes.ok) {
      console.warn(`[cron-fb-unlock-alerts] PATCH failed for ${row.group_url}`, patchRes.data);
      errors.push({ group_url: row.group_url, stage: 'group_patch', detail: patchRes.data });
    }

    // 3. Telegram ping
    const msg =
      `<b>🔓 Ready to ask for posting access</b>\n\n` +
      `Group: <b>${row.group_name}</b>\n` +
      `Substantive comments: ${row.comment_count}\n\n` +
      `Pierce drafted a DM — review in the Atlas dashboard:\n` +
      `https://meetdossie.com/ventures/social/fb-groups`;
    await sendTelegram(msg);

    processed.push({
      group_url: row.group_url,
      group_name: row.group_name,
      comment_count: row.comment_count,
    });
  }

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    candidates: candidates.length,
    processed: processed.length,
    processed_groups: processed,
    errors,
  });
});
