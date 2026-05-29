/**
 * GET /api/ventures/cron-health
 * Returns cron job health data from cron_runs table + vercel.json schedule list.
 *
 * Auth: Bearer token via Supabase JWT — heath emails only.
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const AUTHORIZED_EMAILS = new Set([
  'heath.shepard@kw.com',
  'heath@meetdossie.com',
  'heath.shepard@gmail.com',
  'heathshepard@meetdossie.com',
]);

const ALLOWED_ORIGINS = new Set(['https://meetdossie.com', 'https://www.meetdossie.com']);
const PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;
const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin) || PREVIEW_RE.test(origin) || LOCAL_RE.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type');
}

function supa(path, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  });
}

async function verifyAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json();
  return AUTHORIZED_EMAILS.has(u.email) ? u : null;
}

// Known cron jobs from vercel.json with their expected frequency in minutes
const KNOWN_CRONS = [
  { name: 'cron-generate-posts',        schedule: '0 11 * * *',     expectedMinutes: 1440, label: 'Generate Posts (daily 11AM UTC)' },
  { name: 'cron-send-for-approval',     schedule: '30 11 * * *',    expectedMinutes: 1440, label: 'Send for Approval (daily 11:30AM UTC)' },
  { name: 'cron-publish-approved',      schedule: '*/30 * * * *',   expectedMinutes: 30,   label: 'Publish Approved (every 30min)' },
  { name: 'cron-morning-brief',         schedule: '0 12 * * *',     expectedMinutes: 1440, label: 'Morning Brief (daily 12PM UTC)' },
  { name: 'cron-pipeline-check',        schedule: '0 11 * * *',     expectedMinutes: 1440, label: 'Pipeline Check (daily 11AM UTC)' },
  { name: 'cron-deadline-reminders',    schedule: '5 13 * * *',     expectedMinutes: 1440, label: 'Deadline Reminders (daily 1:05PM UTC)' },
  { name: 'cron-email-digest',          schedule: '0 13 * * *',     expectedMinutes: 1440, label: 'Email Digest (daily 1PM UTC)' },
  { name: 'cron-followup',              schedule: '0 12 * * *',     expectedMinutes: 1440, label: 'Follow-up (daily 12PM UTC)' },
  { name: 'cron-weekly-newsletter',     schedule: '0 15 * * 5',     expectedMinutes: 10080, label: 'Weekly Newsletter (Fri 3PM UTC)' },
  { name: 'cron-content-brief',         schedule: '0 14 * * 1-5',   expectedMinutes: 1440, label: 'Content Brief (weekdays 2PM UTC)' },
  { name: 'cron-coverage-check',        schedule: '0 1 * * *',      expectedMinutes: 1440, label: 'Coverage Check (daily 1AM UTC)' },
  { name: 'cron-analytics-sync',        schedule: '0 2 * * 0',      expectedMinutes: 10080, label: 'Analytics Sync (weekly Sun 2AM UTC)' },
  { name: 'cron-video-approval',        schedule: '0 10 * * *',     expectedMinutes: 1440, label: 'Video Approval (daily 10AM UTC)' },
  { name: 'cron-post-videos',           schedule: '0 13 * * *',     expectedMinutes: 1440, label: 'Post Videos (daily 1PM UTC)' },
  { name: 'cron-verify-posts',          schedule: '45 * * * *',     expectedMinutes: 60,   label: 'Verify Posts (hourly :45)' },
  { name: 'cron-generate-skit',         schedule: '0 11 * * 2,5',   expectedMinutes: 4320, label: 'Generate Skit (Tue+Fri 11AM UTC)' },
  { name: 'alert-health',               schedule: '*/5 * * * *',    expectedMinutes: 5,    label: 'Alert Health (every 5min)' },
  { name: 'cron-pipeline-health',       schedule: '0 13 * * *',     expectedMinutes: 1440, label: 'Pipeline Health (daily 1PM UTC)' },
  { name: 'cron-calculator-deadline-reminders', schedule: '0 13 * * *', expectedMinutes: 1440, label: 'Calculator Deadline Reminders (daily 1PM UTC)' },
];

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    // Fetch latest run per cron_name from cron_runs
    const r = await supa(
      'cron_runs?select=cron_name,last_run,last_status&order=last_run.desc.nullslast&limit=200'
    );
    let runRows = [];
    if (r.ok) {
      runRows = await r.json();
    }

    // Build a map: cron_name -> { last_run, last_status }
    const runMap = {};
    for (const row of runRows) {
      if (!runMap[row.cron_name]) {
        runMap[row.cron_name] = { lastRun: row.last_run, lastStatus: row.last_status };
      }
    }

    const now = Date.now();
    const crons = KNOWN_CRONS.map(c => {
      const runData = runMap[c.name] || null;
      const lastRun = runData?.lastRun ? new Date(runData.lastRun) : null;
      const lastStatus = runData?.lastStatus || null;

      // Determine health color based on recency vs expected frequency
      let health = 'unknown'; // grey — no data yet
      if (lastRun) {
        const ageMinutes = (now - lastRun.getTime()) / 60000;
        const overdue = ageMinutes > c.expectedMinutes * 1.5; // 50% overdue = yellow
        const critical = ageMinutes > c.expectedMinutes * 3;  // 3x overdue = red
        if (lastStatus === 'error') {
          health = 'error';
        } else if (critical) {
          health = 'critical';
        } else if (overdue) {
          health = 'warn';
        } else {
          health = 'ok';
        }
      }

      return {
        name: c.name,
        label: c.label,
        schedule: c.schedule,
        expectedMinutes: c.expectedMinutes,
        lastRun: lastRun ? lastRun.toISOString() : null,
        lastStatus,
        health,
      };
    });

    const okCount = crons.filter(c => c.health === 'ok').length;
    const warnCount = crons.filter(c => c.health === 'warn' || c.health === 'critical').length;
    const errorCount = crons.filter(c => c.health === 'error').length;
    const unknownCount = crons.filter(c => c.health === 'unknown').length;

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      total: crons.length,
      okCount,
      warnCount,
      errorCount,
      unknownCount,
      crons,
    });
  } catch (err) {
    console.error('[ventures/cron-health] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
}
