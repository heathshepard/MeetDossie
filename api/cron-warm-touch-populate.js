// Vercel Serverless Function: /api/cron-warm-touch-populate
//
// Runs Mon-Fri at 12:00 UTC (07:00 CDT), 2 hours BEFORE the cold email batch
// at 14:00 UTC. Selects the next batch of leads from the SA realtor pool and
// inserts them into warm_touch_queue so the LinkedIn engager can pre-engage
// them before the cold email hits.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}
// Schedule: vercel.json — 0 12 * * 1-5 (Mon-Fri 12:00 UTC = 07:00 CDT)

const fs = require('fs');
const path = require('path');
const { recordCronRun } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const LEADS_CSV = path.join(process.cwd(), 'data/sa-realtor-leads-final-v2.csv');
const KNOWN_BOUNCES = new Set(['cheo.chayoh@lptrealty.com']);

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// Minimal CSV parser — same as cron-cold-email-daily-batch.js
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).filter(r => r.length === header.length).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function loadLeads() {
  if (!fs.existsSync(LEADS_CSV)) {
    console.warn('[warm-touch-populate] leads CSV not bundled:', LEADS_CSV);
    return [];
  }
  return parseCsv(fs.readFileSync(LEADS_CSV, 'utf8'));
}

function sbHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function getDailyTarget(now) {
  const today = now.toISOString().slice(0, 10);
  const url = `${SUPABASE_URL}/rest/v1/cold_email_cadence?week_start=lte.${today}&order=week_num.desc&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`cadence lookup failed: ${r.status}`);
  const rows = await r.json();
  if (!Array.isArray(rows) || !rows.length) {
    console.warn('[warm-touch-populate] no cadence row for', today, '- defaulting to 10');
    return { daily_target: 10, week_num: 0, fallback: true };
  }
  return rows[0];
}

// Build exclusion set: outbound_email_queue (any status) + email_suppression_list
// + warm_touch_queue (any status). One roundtrip each.
async function loadExclusionSet() {
  const excluded = new Set();

  // outbound_email_queue
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/outbound_email_queue?select=to_email&order=created_at.asc&limit=${pageSize}&offset=${offset}`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) throw new Error(`queue scan failed: ${r.status}`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) break;
    rows.forEach(x => { if (x && x.to_email) excluded.add(String(x.to_email).toLowerCase()); });
    if (rows.length < pageSize) break;
    offset += pageSize;
  }

  // email_suppression_list
  const sUrl = `${SUPABASE_URL}/rest/v1/email_suppression_list?select=email&limit=5000`;
  const sr = await fetch(sUrl, { headers: sbHeaders() });
  if (sr.ok) {
    const rows = await sr.json();
    if (Array.isArray(rows)) rows.forEach(x => { if (x && x.email) excluded.add(String(x.email).toLowerCase()); });
  }

  // warm_touch_queue (any status — don't re-queue leads already in the pipeline)
  const wUrl = `${SUPABASE_URL}/rest/v1/warm_touch_queue?select=lead_email&limit=5000`;
  const wr = await fetch(wUrl, { headers: sbHeaders() });
  if (wr.ok) {
    const rows = await wr.json();
    if (Array.isArray(rows)) rows.forEach(x => { if (x && x.lead_email) excluded.add(String(x.lead_email).toLowerCase()); });
  }

  return excluded;
}

// Idempotency: check if we already populated today's batch by looking for rows
// created today in warm_touch_queue.
async function todayAlreadyPopulated(today) {
  const startOfDay = `${today}T00:00:00Z`;
  const endOfDay = `${today}T23:59:59Z`;
  const url = `${SUPABASE_URL}/rest/v1/warm_touch_queue?created_at=gte.${startOfDay}&created_at=lte.${endOfDay}&select=id&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) return false; // fail-open
  const rows = await r.json().catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

function selectLeads(count, excluded) {
  const all = loadLeads();
  const selected = [];
  const seen = new Set();

  const isValid = r =>
    isValidEmail(r.email) &&
    !KNOWN_BOUNCES.has((r.email || '').toLowerCase()) &&
    !excluded.has((r.email || '').toLowerCase()) &&
    r.name; // need a name for LinkedIn search

  // Tier 1: ZenRows-verified existing emails
  const tier1 = all.filter(r =>
    r.confidence_tier === 'tier_b_zenrows_no_phone' &&
    r.email_source === 'existing' &&
    isValid(r)
  );

  // Tier 2: ZenRows-scoped + brokerage pattern guess
  const tier2 = all.filter(r =>
    r.confidence_tier === 'tier_b_zenrows_no_phone' &&
    typeof r.email_source === 'string' &&
    r.email_source.startsWith('pattern_guess:') &&
    isValid(r)
  );

  // Tier 3: TREC-scoped pattern guess
  const tier3 = all.filter(r =>
    r.confidence_tier === 'tier_c_trec_pattern_guess' &&
    isValid(r)
  );

  const take = (pool) => {
    for (const r of pool) {
      const k = r.email.toLowerCase();
      if (seen.has(k)) continue;
      selected.push(r);
      seen.add(k);
      if (selected.length >= count) return true;
    }
    return false;
  };

  take(tier1) || take(tier2) || take(tier3);

  return {
    selected,
    tier1_avail: tier1.length,
    tier2_avail: tier2.length,
    tier3_avail: tier3.length,
  };
}

async function handler(req, res) {
  const forceDryRun = req.query && (req.query.dry === '1' || req.query.dry === 'true');
  const forceRun = req.query && (req.query.force === '1' || req.query.force === 'true');

  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'supabase_not_configured' });
  }

  const startedAt = Date.now();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const dow = now.getUTCDay();

  // Weekend skip
  if (!forceRun && (dow === 0 || dow === 6)) {
    return res.status(200).json({ ok: true, skipped: 'weekend', dow });
  }

  try {
    // Idempotency: skip if today's leads are already in the queue
    if (!forceRun && await todayAlreadyPopulated(today)) {
      recordCronRun('cron-warm-touch-populate', 'ok', {
        skipped: 'already_populated_today', today,
      }).catch(() => {});
      return res.status(200).json({ ok: true, skipped: 'already_populated_today', today });
    }

    const cadence = await getDailyTarget(now);
    const dailyTarget = Math.max(0, cadence.daily_target || 0);
    if (dailyTarget === 0) {
      return res.status(200).json({ ok: true, skipped: 'daily_target=0', cadence });
    }

    const excluded = await loadExclusionSet();
    const { selected, tier1_avail, tier2_avail, tier3_avail } = selectLeads(dailyTarget, excluded);

    const result = {
      target: dailyTarget,
      selected: selected.length,
      queued: 0,
      skipped: 0,
      errors: 0,
      tier1_avail,
      tier2_avail,
      tier3_avail,
      week_num: cadence.week_num,
      dry_run: !!forceDryRun,
    };

    for (const lead of selected) {
      const row = {
        lead_email: lead.email.toLowerCase().trim(),
        lead_name: lead.name || null,
        lead_city: (lead.city || '').trim() || 'San Antonio',
        lead_brokerage: (lead.brokerage || '').trim() || null,
        platform: 'linkedin',
        status: 'pending',
      };

      if (forceDryRun) {
        result.queued += 1;
        continue;
      }

      try {
        const r = await fetch(`${SUPABASE_URL}/rest/v1/warm_touch_queue`, {
          method: 'POST',
          headers: sbHeaders({ Prefer: 'return=minimal' }),
          body: JSON.stringify(row),
        });
        if (r.ok || r.status === 201) {
          result.queued += 1;
        } else {
          // 409 = duplicate (UNIQUE constraint on lead_email+platform)
          if (r.status === 409) {
            result.skipped += 1;
          } else {
            result.errors += 1;
            const text = await r.text().catch(() => '');
            console.warn('[warm-touch-populate] insert failed', row.lead_email, r.status, text.slice(0, 200));
          }
        }
      } catch (err) {
        result.errors += 1;
        console.warn('[warm-touch-populate] insert error', row.lead_email, err && err.message);
      }
    }

    const duration_ms = Date.now() - startedAt;
    recordCronRun('cron-warm-touch-populate', 'ok', { duration_ms, ...result }).catch(() => {});
    return res.status(200).json({ ok: true, duration_ms, ...result });
  } catch (err) {
    const duration_ms = Date.now() - startedAt;
    const msg = (err && err.message) ? err.message.slice(0, 500) : 'crash';
    recordCronRun('cron-warm-touch-populate', 'error', { duration_ms, error: msg }).catch(() => {});
    return res.status(500).json({ ok: false, error: msg, duration_ms });
  }
}

module.exports = handler;
module.exports.default = handler;
