// Jarvis V5 R4 — Money Pulse cron
// Every 5 min: query Stripe MTD revenue + compose per-service spend
//              + insert money_pulse_snapshots row.
// Spend data: fixed monthly costs from Atlas's recurring-costs.md = $99.65,
//             plus best-effort variable estimates (we don't yet wire per-service APIs).

import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const FIXED_MONTHLY = {
  vercel: 0,
  supabase: 0,
  anthropic: 0,        // variable, tracked separately
  elevenlabs: 18.33,
  resend: 0,
  hcti: 0,             // free under 50/mo
  submagic: 12.00,
  zernio: 18.00,
  hiscox_eo: 33.32,
  digitalocean: 18.00,
};
const FIXED_TOTAL = Object.values(FIXED_MONTHLY).reduce((a, b) => a + b, 0); // 99.65

const BUDGET_LIMIT = 200.00; // approved monthly fixed-cost budget

function alertState(spend, budget) {
  if (!budget) return 'green';
  const ratio = spend / budget;
  if (ratio >= 1.0) return 'red';
  if (ratio >= 0.8) return 'amber';
  return 'green';
}

async function getStripeMtdRevenue() {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) return null;
  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });

  // MTD window — first of this month UTC
  const now = new Date();
  const firstOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const since = Math.floor(firstOfMonth.getTime() / 1000);

  let total = 0;
  let starting_after = undefined;
  let safety = 0;
  while (safety < 20) {
    const list = await stripe.charges.list({
      created: { gte: since },
      limit: 100,
      starting_after,
    });
    for (const c of list.data) {
      if (c.status === 'succeeded' && !c.refunded) {
        total += (c.amount - (c.amount_refunded || 0));
      }
    }
    if (!list.has_more) break;
    starting_after = list.data[list.data.length - 1]?.id;
    safety += 1;
  }
  return total / 100;
}

export default async function handler(req, res) {
  // Vercel cron sends GET; allow CRON_SECRET bypass too
  const auth = req.headers.authorization || '';
  const isCron = auth === `Bearer ${process.env.CRON_SECRET}`;
  const isVercelCron = req.headers['user-agent']?.includes('vercel') || req.headers['x-vercel-cron'];
  if (!isCron && !isVercelCron && req.method !== 'POST') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'supabase_env_missing' });
  }
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let mtdRevenue = null;
  try {
    mtdRevenue = await getStripeMtdRevenue();
  } catch (err) {
    console.warn('[money-pulse] stripe MTD revenue failed:', err?.message || err);
  }

  const mtdSpend = FIXED_TOTAL;
  const state = alertState(mtdSpend, BUDGET_LIMIT);

  try {
    const { data, error } = await admin
      .from('money_pulse_snapshots')
      .insert({
        source: 'cron',
        mtd_revenue_usd: mtdRevenue,
        mtd_spend_usd: mtdSpend,
        budget_limit_usd: BUDGET_LIMIT,
        alert_state: state,
        per_service: FIXED_MONTHLY,
        notes: null,
      })
      .select()
      .maybeSingle();
    if (error) throw error;

    // Prune anything older than 14 days, keep DB lean
    const cutoff = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();
    await admin.from('money_pulse_snapshots').delete().lt('captured_at', cutoff);

    // Update cron_runs heartbeat
    await admin.from('cron_runs').upsert({
      cron_name: 'cron-money-pulse-snapshot',
      last_run: new Date().toISOString(),
      last_status: 'ok',
      last_meta: { mtd_revenue: mtdRevenue, mtd_spend: mtdSpend, state },
    }, { onConflict: 'cron_name' });

    return res.status(200).json({ ok: true, snapshot: data });
  } catch (err) {
    console.error('[money-pulse] insert failed:', err);
    return res.status(500).json({ error: 'insert_failed', detail: String(err?.message || err) });
  }
}
