// Vercel Serverless Function: POST /api/pc-heartbeat
// Called every 60s by a Windows Task Scheduler job on each headless PC.
// Records last_seen so /api/cron-pc-heartbeat-check can page Heath when a machine goes silent.
//
// Auth: Authorization: Bearer ${PC_HEARTBEAT_SECRET}
// Body: { pc_name: string, meta?: object }

const { createClient } = require('@supabase/supabase-js');

const PC_HEARTBEAT_SECRET = process.env.PC_HEARTBEAT_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const auth = req.headers.authorization || '';
  if (!PC_HEARTBEAT_SECRET || auth !== `Bearer ${PC_HEARTBEAT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { pc_name, meta } = req.body || {};
  if (!pc_name || typeof pc_name !== 'string') {
    return res.status(400).json({ error: 'pc_name required' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false }
  });

  const now = new Date().toISOString();

  // Upsert: bump last_seen. Clear last_alerted_at so a recovery re-arms paging for the next outage.
  const { error } = await supabase
    .from('pc_heartbeats')
    .upsert({
      pc_name,
      last_seen: now,
      last_alerted_at: null,
      meta: meta || {}
    }, { onConflict: 'pc_name' });

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(200).json({ ok: true, pc_name, last_seen: now });
};
