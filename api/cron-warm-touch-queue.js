// Vercel Serverless Function: /api/cron-warm-touch-queue
//
// Runs Mon/Wed/Fri at 08:00 CDT (13:00 UTC), 1 hour before the cold email
// batch fires. Pulls the next ~30 leads from the SA realtor pool who haven't
// been emailed yet, and inserts them into warm_touch_queue so the LinkedIn
// engager can find and engage their content before the cold email lands.
//
// The cold email batch job (cron-cold-email-daily-batch) checks warm_touch_queue
// and prioritizes leads who were engaged >= 3 days ago over unwarmed leads.
//
// Auth: Bearer ${CRON_SECRET}
// Schedule: 0 13 * * 1,3,5 (Mon/Wed/Fri 13:00 UTC = 08:00 CDT)

const fs = require('fs');
const path = require('path');
const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const LEADS_CSV = path.join(process.cwd(), 'data/sa-realtor-leads-final-v2.csv');
const BATCH_SIZE = 30;

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function loadLeads() {
  const raw = fs.readFileSync(LEADS_CSV, 'utf8');
  const lines = raw.trim().split('\n');
  const header = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.match(/(".*?"|[^,]*)/g) || [];
    const obj = {};
    header.forEach((col, i) => {
      obj[col.trim()] = (vals[i] || '').replace(/^"|"$/g, '').trim();
    });
    return obj;
  });
}

function isValidEmail(e) {
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

async function loadAlreadyQueued() {
  const set = new Set();
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/outbound_email_queue?select=to_email&limit=${pageSize}&offset=${offset}`,
      { headers: sbHeaders() }
    );
    if (!r.ok) break;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach(x => { if (x.to_email) set.add(x.to_email.toLowerCase()); });
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return set;
}

async function loadAlreadyWarmed() {
  const set = new Set();
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/warm_touch_queue?select=lead_email&limit=5000`,
    { headers: sbHeaders() }
  );
  if (!r.ok) return set;
  const rows = await r.json();
  if (Array.isArray(rows)) rows.forEach(x => { if (x.lead_email) set.add(x.lead_email.toLowerCase()); });
  return set;
}

async function handler(req, res) {
  const startedAt = Date.now();
  const auth = (req.headers.authorization || '').replace('Bearer ', '');
  if (auth !== CRON_SECRET) return res.status(401).json({ error: 'unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE config' });
  }

  try {
    const alreadyEmailed = await loadAlreadyQueued();
    const alreadyWarmed = await loadAlreadyWarmed();
    const leads = loadLeads();

    const candidates = leads.filter(l =>
      isValidEmail(l.email) &&
      !alreadyEmailed.has(l.email.toLowerCase()) &&
      !alreadyWarmed.has(l.email.toLowerCase()) &&
      l.name
    );

    // Prefer tier 1 (verified emails) then tier 2
    candidates.sort((a, b) => {
      const tierOrder = { tier_b_zenrows_no_phone: 0, tier_c_kw_pattern: 1, tier_d_trec_pattern: 2 };
      return (tierOrder[a.confidence_tier] || 3) - (tierOrder[b.confidence_tier] || 3);
    });

    const batch = candidates.slice(0, BATCH_SIZE);
    let inserted = 0;

    for (const lead of batch) {
      const row = {
        lead_email: lead.email.toLowerCase(),
        lead_name: lead.name,
        lead_city: lead.city || 'San Antonio',
        lead_brokerage: lead.brokerage || '',
        platform: 'linkedin',
        status: 'pending',
      };
      const r = await fetch(`${SUPABASE_URL}/rest/v1/warm_touch_queue`, {
        method: 'POST',
        headers: sbHeaders({ Prefer: 'return=minimal' }),
        body: JSON.stringify(row),
      });
      if (r.ok || r.status === 201) inserted++;
    }

    const duration_ms = Date.now() - startedAt;
    const result = { inserted, candidates_available: candidates.length, batch_size: batch.length };
    recordCronRun('cron-warm-touch-queue', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = err?.message?.slice(0, 500) || 'crash';
    recordCronRun('cron-warm-touch-queue', 'error', { duration_ms, error: msg }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms });
  }
}

module.exports = handler;
module.exports.default = handler;
