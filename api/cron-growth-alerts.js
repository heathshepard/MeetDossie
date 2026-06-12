// Vercel Serverless Function: /api/cron-growth-alerts
// Runs every Monday at 9AM CST (14:00 UTC). Checks Dossie growth metrics against
// predefined benchmarks. When a new milestone is crossed for the first time,
// inserts a row into growth_milestones and sends a Telegram alert to Heath via Claudy.
//
// Auth: Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: 0 14 * * 1  (Monday 9AM CST / 14:00 UTC)
//
// Environment:
//   SUPABASE_URL                 — Supabase project URL
//   SUPABASE_SERVICE_ROLE_KEY    — service-role JWT
//   TELEGRAM_BOT_TOKEN           — Claudy bot token for Heath alerts
//   TELEGRAM_CHAT_ID             — Heath's Telegram chat ID
//   CRON_SECRET                  — bearer token for manual auth

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

const BENCHMARKS = [
  { id: 'founding_25', metric: 'founding_count', threshold: 25, message: '25 founding members! Time to activate referral links and Twitter/X scanning.' },
  { id: 'founding_30', metric: 'founding_count', threshold: 30, message: '30 founding members! Start collecting formal testimonials. Paid ads prep begins.' },
  { id: 'founding_38', metric: 'founding_count', threshold: 38, message: '38 founding members - 12 spots left. Launch FB/IG retargeting at $5-10/day NOW.' },
  { id: 'founding_45', metric: 'founding_count', threshold: 45, message: '45 founding members - 5 spots left! Announce scarcity publicly. Last call posts.' },
  { id: 'founding_50', metric: 'founding_count', threshold: 50, message: 'FOUNDING FULL! Close /founding page, activate $79/mo pricing, launch affiliate program.' },
  { id: 'mrr_500',     metric: 'mrr_cents',      threshold: 50000,  message: '$500 MRR hit! First paid ad budget unlocked. Start $5/day FB retargeting.' },
  { id: 'mrr_1000',    metric: 'mrr_cents',      threshold: 100000, message: '$1,000 MRR! Consider part-time CS hire. Expand LinkedIn outreach to brokers.' },
  { id: 'mrr_2500',    metric: 'mrr_cents',      threshold: 250000, message: '$2,500 MRR! Statewide Texas expansion push. Begin Houston/DFW/Austin geo-targeted ads.' },
  { id: 'mrr_5000',    metric: 'mrr_cents',      threshold: 500000, message: '$5,000 MRR! Full-time hire ready. Evaluate Series A prep or strategic acquirer outreach.' },
  { id: 'customers_25', metric: 'customer_count', threshold: 25,   message: '25 customers! Request video testimonials from top 3 most active users.' },
];

// ---------------------------------------------------------------------------
// Supabase helpers
// ---------------------------------------------------------------------------

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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// ---------------------------------------------------------------------------
// Metrics query
// ---------------------------------------------------------------------------

async function fetchMetrics() {
  // founding_count: active founding subscriptions
  const foundingRes = await supabaseFetch(
    "/rest/v1/subscriptions?status=eq.active&plan=eq.founding&select=id"
  );
  const founding_count = (foundingRes.ok && Array.isArray(foundingRes.data))
    ? foundingRes.data.length
    : 0;

  // customer_count: all active subscriptions (including friend tier)
  const customerRes = await supabaseFetch(
    "/rest/v1/subscriptions?status=eq.active&select=id"
  );
  const customer_count = (customerRes.ok && Array.isArray(customerRes.data))
    ? customerRes.data.length
    : 0;

  // mrr_cents: founding members at $2900/mo, everything else at $100/mo (friend tier)
  // We derive this from counts rather than a SUM to avoid relying on an amount column
  // that may not exist. This matches the actual billing structure.
  const friendRes = await supabaseFetch(
    "/rest/v1/subscriptions?status=eq.active&plan=neq.founding&select=id"
  );
  const friend_count = (friendRes.ok && Array.isArray(friendRes.data))
    ? friendRes.data.length
    : 0;
  const mrr_cents = (founding_count * 2900) + (friend_count * 100);

  return { founding_count, customer_count, mrr_cents };
}

// ---------------------------------------------------------------------------
// Milestone tracking
// ---------------------------------------------------------------------------

async function firedMilestoneIds() {
  const r = await supabaseFetch("/rest/v1/growth_milestones?select=id");
  if (!r.ok || !Array.isArray(r.data)) return new Set();
  return new Set(r.data.map((row) => row.id));
}

async function recordMilestone(id, metricValue) {
  await supabaseFetch("/rest/v1/growth_milestones", {
    method: "POST",
    headers: { Prefer: "resolution=ignore-duplicates,return=minimal" },
    body: JSON.stringify({ id, metric_value: metricValue }),
  });
}

// ---------------------------------------------------------------------------
// Telegram alert
// ---------------------------------------------------------------------------

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn("[cron-growth-alerts] Telegram not configured");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: "HTML" }),
      }
    );
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.error("[cron-growth-alerts] Telegram failed:", res.status, t.slice(0, 200));
    }
  } catch (err) {
    console.error("[cron-growth-alerts] Telegram threw:", err && err.message);
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

module.exports = withTelemetry('cron-growth-alerts', async function handler(req, res) {
  const isVercelCron = req.headers["x-vercel-cron"] === "1";
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || "";
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: "Supabase not configured" });
  }

  console.log("[cron-growth-alerts] starting at", new Date().toISOString());

  let metrics;
  try {
    metrics = await fetchMetrics();
  } catch (err) {
    console.error("[cron-growth-alerts] fetchMetrics failed:", err && err.message);
    return res.status(500).json({ ok: false, error: "Failed to fetch metrics: " + String(err && err.message || err) });
  }

  console.log("[cron-growth-alerts] metrics:", metrics);

  let fired;
  try {
    fired = await firedMilestoneIds();
  } catch (err) {
    console.error("[cron-growth-alerts] firedMilestoneIds failed:", err && err.message);
    return res.status(500).json({ ok: false, error: "Failed to query growth_milestones: " + String(err && err.message || err) });
  }

  const triggered = [];

  for (const benchmark of BENCHMARKS) {
    const currentValue = metrics[benchmark.metric] ?? 0;
    if (currentValue >= benchmark.threshold && !fired.has(benchmark.id)) {
      console.log(`[cron-growth-alerts] NEW milestone: ${benchmark.id} (value=${currentValue})`);
      try {
        await recordMilestone(benchmark.id, currentValue);
      } catch (err) {
        console.error(`[cron-growth-alerts] recordMilestone failed for ${benchmark.id}:`, err && err.message);
      }
      triggered.push({ id: benchmark.id, message: benchmark.message, value: currentValue });
    }
  }

  for (const t of triggered) {
    const text = `<b>Dossie growth milestone hit</b>\n\n${t.message}\n\nCurrent value: ${t.value}`;
    await sendTelegram(text);
  }

  if (triggered.length === 0) {
    console.log("[cron-growth-alerts] no new milestones this run");
  }

  return res.status(200).json({
    ok: true,
    ran_at: new Date().toISOString(),
    metrics,
    milestones_triggered: triggered.length,
    triggered,
  });
});
