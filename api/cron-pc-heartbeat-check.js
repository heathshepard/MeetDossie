// Vercel Serverless Function: /api/cron-pc-heartbeat-check
// Watches pc_heartbeats table. If a PC hasn't checked in for > STALE_MINUTES
// AND we haven't already paged in the last ALERT_DEBOUNCE_MINUTES, page Heath.
//
// Auth: Vercel cron header OR Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — every 5 minutes

const { createClient } = require('@supabase/supabase-js');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const STALE_MINUTES = 10;
const ALERT_DEBOUNCE_MINUTES = 60; // don't re-page for the same outage more than once per hour

module.exports = async (req, res) => {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const auth = req.headers.authorization || '';
  const isManualAuth = CRON_SECRET && auth === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const { data: rows, error } = await supabase
    .from('pc_heartbeats')
    .select('pc_name, last_seen, last_alerted_at');

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  const now = Date.now();
  const staleCutoff = now - STALE_MINUTES * 60 * 1000;
  const debounceCutoff = now - ALERT_DEBOUNCE_MINUTES * 60 * 1000;

  const alerts = [];
  const skipped = [];

  for (const row of rows || []) {
    const lastSeen = new Date(row.last_seen).getTime();
    if (lastSeen >= staleCutoff) continue; // fresh, no alert

    const lastAlerted = row.last_alerted_at ? new Date(row.last_alerted_at).getTime() : 0;
    if (lastAlerted > debounceCutoff) {
      skipped.push({ pc_name: row.pc_name, reason: 'debounced' });
      continue;
    }

    // Silent PC — page Heath.
    const minutesSilent = Math.round((now - lastSeen) / 60000);
    const message =
      `PC OFFLINE — ${row.pc_name}\n\n` +
      `Silent for ${minutesSilent} min.\n` +
      `Last seen: ${row.last_seen}\n\n` +
      `Try Chrome Remote Desktop. If still offline, the PC may have crashed and failed to reboot cleanly.`;

    if (TELEGRAM_BOT_TOKEN) {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text: message
        })
      });
    }

    await supabase
      .from('pc_heartbeats')
      .update({ last_alerted_at: new Date(now).toISOString() })
      .eq('pc_name', row.pc_name);

    alerts.push({ pc_name: row.pc_name, minutes_silent: minutesSilent });
  }

  return res.status(200).json({
    ok: true,
    checked: (rows || []).length,
    alerted: alerts,
    skipped
  });
};
