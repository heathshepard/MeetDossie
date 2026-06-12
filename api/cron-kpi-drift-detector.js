// api/cron-kpi-drift-detector.js
//
// SV-ENG-RIDGE-KPI-DRIFT (Ridge, 2026-06-12)
//
// Daily 6 AM CDT (11:00 UTC).
//
// Tracks 4 KPIs week-over-week:
//   1. MRR  — sum(price) where subscriptions.status='active'
//   2. Post engagement rate (7d) — sum(engagement_count) / sum(impressions)
//      from post_analytics over the last 7d. Falls back to count of posted social_posts
//      if post_analytics is empty.
//   3. Comment ship rate (7d) — count(engagement_candidates) where status='posted' last 7d
//   4. Signup conversion (7d) — founding_applications.status='approved' / total apps
//
// Compare last_7d vs prior_7d.
//   - drift = (last - prior) / max(prior, 1)
//   - alert if |drift| >= 0.10 (±10%)
//
// Snapshots persisted to kpi_snapshots table for trend history.
// Telegram alerts to Heath when drift threshold tripped.
//
// Auth: Bearer ${CRON_SECRET}  or  x-vercel-cron: 1
// Schedule: vercel.json "0 11 * * *" (6 AM CDT)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DRIFT_THRESHOLD = 0.10; // ±10%

async function sb(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
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
  } catch (err) { console.error('[kpi-drift] tg error:', err && err.message); }
}

// ─── KPI fetchers ────────────────────────────────────────────────────────

// MRR — sum of active founding/regular subscription prices.
// Founding members are $29; non-founding solo $79; team $199 etc.
// We pull all active subscriptions and sum their "price" column if present,
// else apply a price-by-plan map.
async function getMrr() {
  // subscriptions table has no `price` column — derive from `plan`.
  // Founding-friend rows ($1) appear under `plan='founding_friend'` if set,
  // or via the FOUNDING_FRIEND coupon path which may leave them as `founding`.
  // We undercount slightly when a friend row says `founding` (treats as $29).
  // This is a known accuracy limit until a `price` or `mrr_amount` column lands.
  const PRICE_MAP = {
    founding: 29,
    founding_friend: 1,
    solo: 79,
    team: 199,
    brokerage: 199,
  };
  const { ok, data } = await sb('/rest/v1/subscriptions?status=eq.active&select=plan');
  if (!ok || !Array.isArray(data)) return 0;
  let total = 0;
  for (const row of data) {
    const p = PRICE_MAP[row.plan] ?? 0;
    if (!Number.isNaN(p)) total += p;
  }
  return total;
}

// Returns posts published in [sinceIso, untilIso). Falls back to social_posts
// status='posted' count when post_analytics is empty.
async function getPostEngagementRate(sinceIso, untilIso) {
  // Try post_analytics first.
  const filter = `recorded_at=gte.${encodeURIComponent(sinceIso)}` +
                 `&recorded_at=lt.${encodeURIComponent(untilIso)}` +
                 `&select=engagement_count,impressions`;
  const { ok, data } = await sb(`/rest/v1/post_analytics?${filter}`);
  if (ok && Array.isArray(data) && data.length > 0) {
    let eng = 0, imp = 0;
    for (const r of data) {
      eng += Number(r.engagement_count || 0);
      imp += Number(r.impressions || 0);
    }
    return { rate: imp > 0 ? eng / imp : 0, sample_size: data.length, source: 'post_analytics' };
  }
  // Fallback: ship rate (posts/day). Not a true engagement rate but tracks
  // whether the funnel is alive.
  const f2 = `posted_at=gte.${encodeURIComponent(sinceIso)}` +
             `&posted_at=lt.${encodeURIComponent(untilIso)}` +
             `&status=eq.posted&select=id`;
  const r2 = await sb(`/rest/v1/social_posts?${f2}`);
  const count = r2.ok && Array.isArray(r2.data) ? r2.data.length : 0;
  return { rate: count, sample_size: count, source: 'social_posts_count' };
}

async function getCommentShipRate(sinceIso, untilIso) {
  // engagement_candidates posted in window — count rate per day.
  // Try posted_at first, fall back to updated_at then created_at.
  const tryField = async (field) => {
    const f = `${field}=gte.${encodeURIComponent(sinceIso)}` +
              `&${field}=lt.${encodeURIComponent(untilIso)}` +
              `&status=eq.posted&select=id`;
    const r = await sb(`/rest/v1/engagement_candidates?${f}`);
    return r.ok && Array.isArray(r.data) ? r.data.length : null;
  };
  let count = await tryField('posted_at');
  if (count == null) count = await tryField('updated_at');
  if (count == null) count = await tryField('created_at') || 0;
  return count;
}

async function getSignupConversion(sinceIso, untilIso) {
  const filter = `created_at=gte.${encodeURIComponent(sinceIso)}` +
                 `&created_at=lt.${encodeURIComponent(untilIso)}` +
                 `&select=status`;
  const { ok, data } = await sb(`/rest/v1/founding_applications?${filter}`);
  if (!ok || !Array.isArray(data) || data.length === 0) {
    return { rate: 0, total: 0, approved: 0 };
  }
  const approved = data.filter((r) => r.status === 'approved').length;
  return { rate: approved / data.length, total: data.length, approved };
}

function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString();
}

function pct(v) {
  return (v * 100).toFixed(1) + '%';
}

function fmtNum(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—';
  if (Math.abs(v) < 1 && v !== 0) return v.toFixed(3);
  if (Math.abs(v) < 100) return v.toFixed(1);
  return Math.round(v).toString();
}

function drift(prev, curr) {
  const base = Math.abs(prev) > 0 ? Math.abs(prev) : 1;
  return (curr - prev) / base;
}

module.exports = withTelemetry('cron-kpi-drift-detector', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  try {
    const now = new Date();
    const nowIso = now.toISOString();
    const last7Start = daysAgoIso(7);
    const prior7Start = daysAgoIso(14);

    // ── MRR (current snapshot — no historical lookback needed) ────────────
    const mrrNow = await getMrr();

    // For prior MRR, find the most recent kpi_snapshots row >=7d old.
    const { data: priorSnapshots } = await sb(
      `/rest/v1/kpi_snapshots?taken_at=lt.${encodeURIComponent(daysAgoIso(6))}&order=taken_at.desc&limit=1&select=metrics,taken_at`
    );
    const priorMrr = Array.isArray(priorSnapshots) && priorSnapshots[0]?.metrics?.mrr
      ? Number(priorSnapshots[0].metrics.mrr)
      : null;

    // ── Engagement (7d vs prior 7d) ──────────────────────────────────────
    const engCurr = await getPostEngagementRate(last7Start, nowIso);
    const engPrev = await getPostEngagementRate(prior7Start, last7Start);

    // ── Comment ship rate (count per 7d) ─────────────────────────────────
    const commentCurr = await getCommentShipRate(last7Start, nowIso);
    const commentPrev = await getCommentShipRate(prior7Start, last7Start);

    // ── Signup conversion ────────────────────────────────────────────────
    const sigCurr = await getSignupConversion(last7Start, nowIso);
    const sigPrev = await getSignupConversion(prior7Start, last7Start);

    const metrics = {
      mrr: mrrNow,
      engagement_rate_7d: engCurr.rate,
      engagement_sample_7d: engCurr.sample_size,
      engagement_source: engCurr.source,
      comment_ship_7d: commentCurr,
      signup_conversion_7d: sigCurr.rate,
      signup_total_7d: sigCurr.total,
      signup_approved_7d: sigCurr.approved,
    };

    // Persist snapshot
    await sb('/rest/v1/kpi_snapshots', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        taken_at: nowIso,
        metrics,
        window_start: last7Start,
        window_end: nowIso,
      }),
    });

    // Compute drifts
    const drifts = {};
    if (priorMrr !== null) drifts.mrr = drift(priorMrr, mrrNow);
    drifts.engagement_rate_7d = drift(engPrev.rate, engCurr.rate);
    drifts.comment_ship_7d = drift(commentPrev, commentCurr);
    drifts.signup_conversion_7d = drift(sigPrev.rate, sigCurr.rate);

    const triggered = [];
    for (const [k, d] of Object.entries(drifts)) {
      if (Math.abs(d) >= DRIFT_THRESHOLD) {
        triggered.push({ kpi: k, drift: d });
      }
    }

    if (triggered.length > 0) {
      const lines = ['📉 <b>KPI DRIFT DETECTED</b>', ''];
      for (const t of triggered) {
        const sign = t.drift >= 0 ? '+' : '';
        const emoji = t.drift >= 0 ? '↑' : '↓';
        let label = t.kpi;
        let prev, curr;
        if (t.kpi === 'mrr') {
          prev = priorMrr; curr = mrrNow;
          label = `MRR ($${fmtNum(prev)} → $${fmtNum(curr)})`;
        } else if (t.kpi === 'engagement_rate_7d') {
          prev = engPrev.rate; curr = engCurr.rate;
          label = `Engagement (${fmtNum(prev)} → ${fmtNum(curr)} · ${engCurr.source})`;
        } else if (t.kpi === 'comment_ship_7d') {
          prev = commentPrev; curr = commentCurr;
          label = `Comments shipped 7d (${prev} → ${curr})`;
        } else if (t.kpi === 'signup_conversion_7d') {
          prev = sigPrev.rate; curr = sigCurr.rate;
          label = `Signup conv (${pct(prev)} → ${pct(curr)})`;
        }
        lines.push(`${emoji} ${label} <b>${sign}${pct(t.drift)}</b>`);
      }
      lines.push('');
      lines.push('Ridge surfacing — no auto-action taken. Investigate at /ventures.');
      await tg(lines.join('\n'));
    }

    return res.status(200).json({
      ok: true,
      metrics,
      drifts,
      triggered,
      prior_mrr: priorMrr,
      compared: {
        engagement: { prev: engPrev, curr: engCurr },
        comment_ship: { prev: commentPrev, curr: commentCurr },
        signup: { prev: sigPrev, curr: sigCurr },
      },
    });
  } catch (err) {
    console.error('[kpi-drift] crashed:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
