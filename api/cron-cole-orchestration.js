// Vercel Serverless Function: /api/cron-cole-orchestration
// Cole's daily morning sweep — surfaces cross-agent task status, stuck posts,
// and new signups to Heath via Telegram.
//
// Auth: Authorization: Bearer ${CRON_SECRET} OR x-vercel-cron: 1
// Triggered by: cron-job.org external cron (NOT in vercel.json — Vercel is at limit)
// Suggested schedule: 0 12 * * * (12:00 UTC = 7:00am CST daily)
//
// Queries:
//   1. ventures_tasks — pending/in_progress/blocked count by agent
//   2. ventures_activity_events — last 24h activity per agent
//   3. social_posts — posts stuck in 'draft' for >24h
//   4. subscriptions — new signups in last 24h
//
// Outputs:
//   - Telegram message to TELEGRAM_CHAT_ID
//   - ventures_activity_events log: agent_name='cole', event_type='orchestration'

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function supaFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(opts.headers || {}),
  };
  const res = await fetch(url, { ...opts, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn('[cron-cole-orchestration] TELEGRAM_BOT_TOKEN not set — skipping Telegram');
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN not set' };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
  });
  const body = await res.text();
  let data = null;
  try { data = body ? JSON.parse(body) : null; } catch { data = null; }
  if (!res.ok || data?.ok !== true) {
    console.error('[cron-cole-orchestration] Telegram failed:', res.status, body.slice(0, 200));
  }
  return { ok: res.ok && data?.ok === true };
}

// ─── Query helpers ────────────────────────────────────────────────────────────

// 1. ventures_tasks: count by agent for status IN (pending, in_progress, blocked)
async function getTaskSummary() {
  try {
    const { ok, data } = await supaFetch(
      'ventures_tasks?status=in.(pending,in_progress,blocked)&select=agent_name,status',
      { headers: { Prefer: 'count=exact' } },
    );
    if (!ok || !Array.isArray(data)) return { total: 0, byAgent: {} };

    const byAgent = {};
    for (const task of data) {
      const agent = task.agent_name || 'unknown';
      byAgent[agent] = (byAgent[agent] || 0) + 1;
    }
    return { total: data.length, byAgent };
  } catch (err) {
    console.warn('[cron-cole-orchestration] ventures_tasks query error:', err.message);
    return { total: 0, byAgent: {}, error: err.message };
  }
}

// 2. ventures_activity_events: last event per agent in past 24h
async function getRecentActivity() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { ok, data } = await supaFetch(
      `ventures_activity_events?created_at=gte.${encodeURIComponent(since)}&select=agent_name,event_type,summary,created_at&order=created_at.desc&limit=50`,
    );
    if (!ok || !Array.isArray(data)) return {};

    // Latest event per agent
    const byAgent = {};
    for (const event of data) {
      const agent = event.agent_name || 'unknown';
      if (!byAgent[agent]) {
        byAgent[agent] = {
          eventType: event.event_type || '',
          summary: (event.summary || '').slice(0, 80),
          at: event.created_at,
        };
      }
    }
    return byAgent;
  } catch (err) {
    console.warn('[cron-cole-orchestration] ventures_activity_events query error:', err.message);
    return {};
  }
}

// 3. social_posts: stuck in 'draft' for >24h (cron-generate-posts fired but approval never happened)
async function getStuckPosts() {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { ok, data } = await supaFetch(
      `social_posts?status=eq.draft&created_at=lt.${encodeURIComponent(cutoff)}&select=id,persona,platform,created_at&order=created_at.asc&limit=20`,
    );
    if (!ok || !Array.isArray(data)) return 0;
    return data.length;
  } catch (err) {
    console.warn('[cron-cole-orchestration] social_posts query error:', err.message);
    return 0;
  }
}

// 4. subscriptions: new signups in last 24h
async function getNewSignups() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { ok, data } = await supaFetch(
      `subscriptions?created_at=gte.${encodeURIComponent(since)}&status=eq.active&select=id,plan,created_at`,
    );
    if (!ok || !Array.isArray(data)) return 0;
    return data.length;
  } catch (err) {
    console.warn('[cron-cole-orchestration] subscriptions query error:', err.message);
    return 0;
  }
}

// ─── Build digest message ─────────────────────────────────────────────────────

function buildDigest(tasks, activity, stuckPosts, newSignups) {
  const lines = ['Cole\'s overnight sweep:'];

  // Tasks
  if (tasks.total === 0) {
    lines.push('Tasks: none open');
  } else {
    const agentList = Object.entries(tasks.byAgent)
      .sort(([, a], [, b]) => b - a)
      .map(([agent, count]) => `${agent}:${count}`)
      .join(', ');
    lines.push(`Tasks: ${tasks.total} open (${agentList})`);
  }

  // Agent activity
  const knownAgents = ['cole', 'hadley', 'pierce', 'atlas', 'carter', 'sage'];
  const activeAgents = Object.keys(activity);
  const inactiveAgents = knownAgents.filter((a) => !activeAgents.includes(a));

  if (activeAgents.length > 0) {
    const activityLines = activeAgents
      .filter((a) => a !== 'cole') // exclude self
      .map((a) => {
        const e = activity[a];
        return `  ${a}: ${e.eventType}${e.summary ? ' - ' + e.summary : ''}`;
      });
    if (activityLines.length > 0) {
      lines.push('24h agent activity:');
      lines.push(...activityLines);
    }
  }
  if (inactiveAgents.length > 0) {
    lines.push(`Silent (24h): ${inactiveAgents.join(', ')}`);
  }

  // Stuck posts
  if (stuckPosts > 0) {
    lines.push(`ATTENTION: ${stuckPosts} draft post${stuckPosts === 1 ? '' : 's'} stuck >24h — check DossieMarketingBot approval queue`);
  } else {
    lines.push('Social: no stuck drafts');
  }

  // New signups
  if (newSignups > 0) {
    lines.push(`New signups (24h): ${newSignups} — check Stripe + provision if needed`);
  } else {
    lines.push('Signups: none in last 24h');
  }

  return lines.join('\n');
}

// ─── Log activity event ───────────────────────────────────────────────────────

async function logActivityEvent(summary) {
  try {
    const { ok, status, data } = await supaFetch('ventures_activity_events', {
      method: 'POST',
      body: JSON.stringify({
        agent_name: 'cole',
        event_type: 'orchestration',
        summary,
        metadata: { source: 'cron-cole-orchestration' },
      }),
    });
    if (!ok) {
      console.warn('[cron-cole-orchestration] activity event insert failed:', status, JSON.stringify(data));
    }
  } catch (err) {
    // Non-fatal — table may not exist yet. Log and continue.
    console.warn('[cron-cole-orchestration] activity event log threw:', err.message);
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-cole-orchestration', async function handler(req, res) {
  // Auth: Vercel built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Run all queries in parallel for speed
  const [tasks, activity, stuckPosts, newSignups] = await Promise.all([
    getTaskSummary(),
    getRecentActivity(),
    getStuckPosts(),
    getNewSignups(),
  ]);

  const digest = buildDigest(tasks, activity, stuckPosts, newSignups);
  const message = `Good morning.\n${digest}`;

  console.log('[cron-cole-orchestration]', message);

  // Send to Telegram
  const telegramResult = await sendTelegram(message);

  // Log to ventures_activity_events
  const logSummary = `daily sweep complete — ${tasks.total} tasks, ${stuckPosts} stuck posts, ${newSignups} new signups`;
  await logActivityEvent(logSummary);

  return res.status(200).json({
    ok: true,
    telegramOk: telegramResult.ok,
    tasks,
    stuckPosts,
    newSignups,
    agentsActive: Object.keys(activity).length,
    digest: message,
  });
});
