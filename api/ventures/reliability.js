/**
 * GET /api/ventures/reliability
 *
 * Returns full reliability snapshot:
 *   - cron_runs (last_run, last_status, last_meta) for ALL crons declared in vercel.json
 *   - schedule + expected window per cron
 *   - color-coded health: green (within 2x window), yellow (2x-3x), red (>3x)
 *
 * Auth: Bearer Supabase JWT — heath emails only.
 * Env:  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * This endpoint is the data source for /ventures/reliability HTML dashboard.
 * Ridge-owned. Read-only — no state changes.
 */

const fs = require('fs');
const path = require('path');

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

function supa(p, opts = {}) {
  return fetch(`${SUPABASE_URL}/rest/v1/${p}`, {
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

// Parse cron expression to minimum window (minutes between fires).
// Returns the SHORTEST gap between fires across the week.
// Examples:
//   "*/5 * * * *"      → 5
//   "*/30 * * * *"     → 30
//   "0 * * * *"        → 60
//   "0 11 * * *"       → 1440
//   "0 11 * * 1-5"     → 1440 (then 4320 on weekends; we use 1440 — alarm only on weekday miss)
//   "0 11 * * 1,2,5"   → variable; we take the shortest interval
//   "0 13-23 * * *"    → 60 (every hour from 13–23 UTC)
//   "30 13 10 6 *"     → 525600 (yearly; treat as 525600)
function cronToWindowMin(expr) {
  if (!expr || typeof expr !== 'string') return 1440;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 1440;
  const [minP, hourP, domP, monP, dowP] = parts;

  // Step pattern in minute slot
  const stepMatch = String(minP).match(/^\*\/(\d+)$/);
  if (stepMatch) return Number(stepMatch[1]);

  // Every minute
  if (minP === '*') return 1;

  // Specific minute on every hour
  if (hourP === '*') return 60;

  // hour range like 13-23
  const rangeMatch = String(hourP).match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const span = Number(rangeMatch[2]) - Number(rangeMatch[1]) + 1;
    return span >= 24 ? 60 : 60;
  }

  // hour list
  if (String(hourP).includes(',')) {
    const hrs = String(hourP).split(',').map(Number).sort((a, b) => a - b);
    let minGap = 24 * 60;
    for (let i = 1; i < hrs.length; i++) minGap = Math.min(minGap, (hrs[i] - hrs[i - 1]) * 60);
    // Also gap from last hour back to first hour next day
    minGap = Math.min(minGap, ((24 - hrs[hrs.length - 1]) + hrs[0]) * 60);
    return minGap;
  }

  // Daily fixed hour
  if (/^\d+$/.test(hourP)) {
    // Check day-of-week or day-of-month restriction
    if (dowP !== '*') {
      // weekday-restricted
      if (/^\d-\d$/.test(dowP) || /,/.test(dowP)) return 1440; // best-effort
      if (/^\d$/.test(dowP)) return 7 * 1440; // weekly
    }
    if (domP !== '*' && /^\d+$/.test(domP)) {
      // monthly or yearly
      if (monP !== '*') return 365 * 1440;
      return 30 * 1440;
    }
    return 1440;
  }

  return 1440;
}

function classifyHealth(lastRunIso, lastStatus, windowMin) {
  if (!lastRunIso) return 'silent'; // grey — never seen
  const ageMin = (Date.now() - new Date(lastRunIso).getTime()) / 60000;
  if (lastStatus === 'error') return 'error';
  if (ageMin > windowMin * 3) return 'red';
  if (ageMin > windowMin * 2) return 'yellow';
  return 'green';
}

// Load crons from vercel.json (single source of truth).
function loadVercelCrons() {
  try {
    const vercelPath = path.join(process.cwd(), 'vercel.json');
    const raw = fs.readFileSync(vercelPath, 'utf8');
    const parsed = JSON.parse(raw);
    const crons = Array.isArray(parsed.crons) ? parsed.crons : [];
    return crons.map((c) => {
      const name = String(c.path || '').replace(/^\/api\//, '').replace(/\.js$/, '');
      return {
        name,
        path: c.path,
        schedule: c.schedule,
        window_min: cronToWindowMin(c.schedule),
      };
    });
  } catch (err) {
    console.warn('[reliability] failed to load vercel.json:', err.message);
    return [];
  }
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const user = await verifyAuth(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const declared = loadVercelCrons();

    // Pull current cron_runs snapshot for all known + any unknowns Ridge wants visible.
    const r = await supa('cron_runs?select=cron_name,last_run,last_status,last_meta&order=last_run.desc.nullslast&limit=500');
    const runRows = r.ok ? await r.json() : [];
    const runMap = {};
    for (const row of runRows) {
      if (!runMap[row.cron_name]) {
        runMap[row.cron_name] = {
          last_run: row.last_run,
          last_status: row.last_status,
          last_meta: row.last_meta,
        };
      }
    }

    const declaredNames = new Set(declared.map((c) => c.name));

    const declaredOut = declared.map((c) => {
      const run = runMap[c.name] || null;
      return {
        name: c.name,
        path: c.path,
        schedule: c.schedule,
        window_min: c.window_min,
        last_run: run?.last_run || null,
        last_status: run?.last_status || null,
        last_meta: run?.last_meta || null,
        health: classifyHealth(run?.last_run, run?.last_status, c.window_min),
        declared: true,
      };
    });

    // Surface unknown crons (telemetry seen but not in vercel.json — usually manual jobs).
    const unknownOut = [];
    for (const [name, run] of Object.entries(runMap)) {
      if (declaredNames.has(name)) continue;
      unknownOut.push({
        name,
        path: null,
        schedule: 'manual / unknown',
        window_min: null,
        last_run: run.last_run,
        last_status: run.last_status,
        last_meta: run.last_meta,
        health: run.last_status === 'error' ? 'error' : 'green',
        declared: false,
      });
    }

    const all = [...declaredOut, ...unknownOut];

    const counts = {
      total: all.length,
      green: all.filter((x) => x.health === 'green').length,
      yellow: all.filter((x) => x.health === 'yellow').length,
      red: all.filter((x) => x.health === 'red').length,
      error: all.filter((x) => x.health === 'error').length,
      silent: all.filter((x) => x.health === 'silent').length,
    };

    return res.status(200).json({
      generatedAt: new Date().toISOString(),
      counts,
      crons: all,
    });
  } catch (err) {
    console.error('[ventures/reliability] error:', err);
    return res.status(500).json({ error: 'Internal server error', message: err.message });
  }
};
