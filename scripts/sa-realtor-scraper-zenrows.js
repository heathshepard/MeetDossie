'use strict';

/**
 * SA REALTOR scraper — ZenRows edition (2026-07-01).
 *
 * Orchestrates paginated calls to the staging endpoint /api/scrape-realtor-page
 * (which does the ZenRows premium-proxy fetch server-side) and aggregates all
 * agents into data/sa-realtor-leads-v4-zenrows.csv.
 *
 * Why via the API instead of directly:
 *   ZENROWS_API_KEY is in Vercel env only (per Section 15 CLAUDE.md rules —
 *   secrets never leave Vercel). The Vercel endpoint holds the key; this
 *   script paces + aggregates the results.
 *
 * Cost budget:
 *   Free trial = 1000 credits @ ~10/call = 100 calls max.
 *   Default plan: 3 city-slugs × 10 pages = 30 calls (~300 credits) for a safe
 *   first sweep. Bump via --max-calls flag.
 *
 * Usage:
 *   node scripts/sa-realtor-scraper-zenrows.js
 *   node scripts/sa-realtor-scraper-zenrows.js --max-calls=80 --max-pages=15
 *   node scripts/sa-realtor-scraper-zenrows.js --dry-run   (just show plan)
 *
 * Env:
 *   CRON_SECRET — required (read from .env.local)
 *   STAGING_URL — override the target base URL (default: latest preview via `vercel ls`)
 *
 * Output:
 *   data/sa-realtor-leads-v4-zenrows.csv
 *   data/sa-realtor-leads-v4-zenrows.log
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ─── Load .env.local ──────────────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch { /* non-fatal */ }

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const arg = k => (args.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || '';
const MAX_CALLS = Number(arg('max-calls')) || 90;
const MAX_PAGES = Number(arg('max-pages')) || 25;
const DRY_RUN = args.includes('--dry-run');
const DEBUG_FIRST = args.includes('--debug-first');
const STAGING_URL_ARG = arg('base-url') || process.env.STAGING_URL || '';

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v4-zenrows.csv');
const LOG_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v4-zenrows.log');
const RAW_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v4-zenrows.raw.jsonl');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const logLines = [];
function tsLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  try { fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n', 'utf8'); logLines.length = 0; } catch {}
}

// ─── Staging URL discovery ────────────────────────────────────────────────────
function getStagingUrl() {
  if (STAGING_URL_ARG) return STAGING_URL_ARG.replace(/\/+$/, '');
  try {
    const out = execSync('npx vercel ls', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Find the top-most "Ready" preview URL
    const lines = out.split('\n');
    for (const line of lines) {
      if (line.includes('Preview') && line.includes('Ready')) {
        const m = line.match(/https:\/\/meet-dossie-[a-z0-9]+-heathshepard-6590s-projects\.vercel\.app/);
        if (m) return m[0];
      }
    }
    // Fallback: any URL at bottom
    const m = out.match(/https:\/\/meet-dossie-[a-z0-9]+-heathshepard-6590s-projects\.vercel\.app/);
    if (m) return m[0];
  } catch (e) {
    tsLog(`vercel ls failed: ${e.message}`);
  }
  return 'https://meetdossie.com'; // last resort — prod (endpoint exists after merge)
}

// ─── Target plan ──────────────────────────────────────────────────────────────
//
// Realtor.com agent-directory URL patterns:
//   /realestateagents/san-antonio_tx           city page (default)
//   /realestateagents/san-antonio_tx/pg-2       paginated
//   /realestateagents/78201                     zip-code page
//   /realestateagents/boerne_tx                 suburb
//
// We hit the SA city pages first (highest agent density), then key suburbs, then
// selected zips within the SA metro. Zip-page hits cover niches (Boerne, Helotes).
function buildPlan() {
  const plan = [];
  const citySlugs = [
    'san-antonio_tx',
    'boerne_tx',
    'helotes_tx',
    'new-braunfels_tx',
    'schertz_tx',
    'universal-city_tx',
    'converse_tx',
    'cibolo_tx',
    'seguin_tx',
    'live-oak_tx',
  ];
  const zips = [
    '78201', '78202', '78203', '78204', '78205', '78207', '78208',
    '78209', '78210', '78211', '78212', '78213', '78214', '78215',
    '78216', '78217', '78218', '78219', '78220', '78221', '78222',
    '78223', '78224', '78225', '78226', '78227', '78228', '78229',
    '78230', '78231', '78232', '78233', '78234', '78235', '78237',
    '78238', '78239', '78240', '78242', '78244', '78245', '78247',
    '78248', '78249', '78250', '78251', '78252', '78253', '78254',
    '78255', '78256', '78257', '78258', '78259', '78260', '78261',
    '78263', '78264', '78266', '78268', '78269',
    // Suburbs
    '78006', // Boerne
    '78015', // Fair Oaks Ranch / Boerne
    '78023', // Helotes
    '78130', // New Braunfels
    '78154', // Schertz
    '78148', // Universal City
    '78108', // Cibolo
  ];

  // First city pages, pages 1..MAX_PAGES for SA (biggest), 1..4 for suburbs
  for (let p = 1; p <= MAX_PAGES; p++) {
    plan.push({ kind: 'city', slug: 'san-antonio_tx', page: p });
  }
  for (const slug of citySlugs.slice(1)) {
    for (let p = 1; p <= 4; p++) {
      plan.push({ kind: 'city', slug, page: p });
    }
  }
  // Then core zips, page 1 only (each is smaller)
  for (const zip of zips) {
    plan.push({ kind: 'zip', zip, page: 1 });
  }
  return plan;
}

// ─── Call the endpoint ────────────────────────────────────────────────────────
async function callScraper(baseUrl, task, cronSecret, debug = false) {
  const params = new URLSearchParams();
  if (task.kind === 'city') {
    params.set('city', task.slug);
    params.set('page', String(task.page));
  } else if (task.kind === 'zip') {
    params.set('zip', task.zip);
    params.set('page', String(task.page));
  } else if (task.kind === 'url') {
    params.set('url', task.url);
  }
  if (debug) params.set('debug', '1');
  const url = `${baseUrl}/api/scrape-realtor-page?${params.toString()}`;
  const started = Date.now();
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${cronSecret}` },
  });
  const elapsedMs = Date.now() - started;
  const bodyText = await resp.text();
  let body;
  try { body = JSON.parse(bodyText); }
  catch { body = { status: 'PARSE_ERR', raw: bodyText.slice(0, 500) }; }
  body._elapsed_ms = elapsedMs;
  return body;
}

// ─── Dedup + CSV ──────────────────────────────────────────────────────────────
const seen = new Map();
function keyOf(a) {
  return `${(a.name || '').toLowerCase().trim()}|${(a.brokerage || '').toLowerCase().trim()}`;
}
function record(a) {
  if (!a || !a.name || a.name.length < 3) return false;
  const k = keyOf(a);
  if (seen.has(k)) {
    // Merge missing fields
    const prev = seen.get(k);
    for (const f of ['phone', 'city', 'zip', 'email', 'profile_url', 'agent_id', 'bio_first_sentence']) {
      if (!prev[f] && a[f]) prev[f] = a[f];
    }
    seen.set(k, prev);
    return false;
  }
  a.scrape_ts = a.scrape_ts || new Date().toISOString();
  seen.set(k, a);
  return true;
}

function writeCSV() {
  const headers = [
    'name', 'brokerage', 'phone', 'email', 'city', 'zip',
    'profile_url', 'agent_id', 'bio_first_sentence',
    'listings_for_sale', 'recently_sold_annual', 'avg_rating', 'review_count',
    'recommendations_count', 'is_team',
    'source', 'scraped_from', 'scrape_ts',
  ];
  const csv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [headers.join(',')];
  for (const a of seen.values()) {
    rows.push(headers.map(h => csv(a[h])).join(','));
  }
  fs.writeFileSync(CSV_FILE, rows.join('\n'), 'utf8');
}

// ─── Resume from cache ────────────────────────────────────────────────────────
// Load prior CSV so we can resume without re-fetching pages that already succeeded.
// The raw JSONL tells us which (kind, slug/zip, page) tuples are already done.
const doneTasks = new Set();
function loadResume() {
  if (fs.existsSync(RAW_FILE)) {
    try {
      const lines = fs.readFileSync(RAW_FILE, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const t = obj.task || {};
          const key = `${t.kind}:${t.slug || t.zip || ''}:${t.page || 1}`;
          if (t.kind === 'url') doneTasks.add(`url:${t.url}`);
          else doneTasks.add(key);
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    tsLog(`Resume: ${doneTasks.size} tasks already completed in raw JSONL`);
  }
  if (fs.existsSync(CSV_FILE)) {
    try {
      const lines = fs.readFileSync(CSV_FILE, 'utf8').split('\n');
      if (lines.length > 1) {
        const header = parseLine(lines[0]);
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i]) continue;
          const cells = parseLine(lines[i]);
          const rec = {};
          for (let j = 0; j < header.length; j++) rec[header[j]] = cells[j] || '';
          if (rec.name && rec.brokerage) {
            const k = `${rec.name.toLowerCase()}|${rec.brokerage.toLowerCase()}`;
            seen.set(k, rec);
          }
        }
        tsLog(`Resume: loaded ${seen.size} prior agent records from CSV`);
      }
    } catch (e) {
      tsLog(`Resume: CSV load failed (${e.message}), starting fresh`);
    }
  }
}
function parseLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i+1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === ',') { out.push(cur); cur = ''; } else if (c === '"') inQ = true; else cur += c; }
  }
  out.push(cur); return out;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const resume = args.includes('--resume');
  if (!resume) {
    fs.writeFileSync(LOG_FILE, `=== SA REALTOR scraper ZenRows — ${new Date().toISOString()} ===\n`, 'utf8');
  } else {
    fs.appendFileSync(LOG_FILE, `\n=== RESUME ${new Date().toISOString()} ===\n`, 'utf8');
  }
  tsLog(`PID ${process.pid}, max-calls=${MAX_CALLS}, max-pages=${MAX_PAGES}, dry-run=${DRY_RUN}, resume=${resume}`);

  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    tsLog('FATAL: CRON_SECRET not in env');
    flushLog();
    process.exit(1);
  }

  const baseUrl = getStagingUrl();
  tsLog(`Base URL: ${baseUrl}`);

  if (resume) loadResume();

  const plan = buildPlan();
  const remaining = plan.filter(t => {
    const key = `${t.kind}:${t.slug || t.zip || ''}:${t.page || 1}`;
    return !doneTasks.has(key);
  });
  tsLog(`Plan has ${plan.length} tasks; ${plan.length - remaining.length} already done; will execute up to ${MAX_CALLS} of ${remaining.length} remaining`);

  if (DRY_RUN) {
    for (const t of remaining.slice(0, MAX_CALLS)) {
      tsLog(`  ${JSON.stringify(t)}`);
    }
    flushLog();
    return;
  }

  // Truncate raw jsonl only if not resuming
  if (!resume) fs.writeFileSync(RAW_FILE, '', 'utf8');

  let called = 0;
  let successCalls = 0;
  let creditsLeft = null;
  let consecutiveEmpty = 0;
  let consecutiveFail = 0;

  for (let taskIdx = 0; taskIdx < remaining.length; taskIdx++) {
    const task = remaining[taskIdx];
    if (called >= MAX_CALLS) {
      tsLog(`Hit MAX_CALLS=${MAX_CALLS}, stopping.`);
      break;
    }
    called++;
    let result;
    try {
      const wantDebug = DEBUG_FIRST && called === 1;
      result = await callScraper(baseUrl, task, cronSecret, wantDebug);
      // Save raw for auditing
      fs.appendFileSync(RAW_FILE, JSON.stringify({ task, result_summary: {
        status: result.status,
        http_status: result.http_status,
        agent_count: result.agent_count,
        credits_left: result.credits_left,
        elapsed_ms: result._elapsed_ms,
        error: result.error_if_any,
        target_url: result.target_url,
      }}) + '\n', 'utf8');
    } catch (err) {
      tsLog(`  call ${called} threw: ${err.message}`);
      consecutiveFail++;
      if (consecutiveFail >= 3) {
        tsLog('  3 consecutive network failures, sleeping 30s');
        await new Promise(r => setTimeout(r, 30000));
        consecutiveFail = 0;
      }
      continue;
    }
    consecutiveFail = 0;

    if (result.credits_left != null) creditsLeft = result.credits_left;

    const status = result.status || 'UNKNOWN';
    const httpS = result.http_status || 0;
    const agents = Array.isArray(result.agents) ? result.agents : [];
    const before = seen.size;
    for (const a of agents) record(a);
    const added = seen.size - before;
    tsLog(`  [${called}/${MAX_CALLS}] ${task.kind}=${task.slug || task.zip} p${task.page} — ${status} http=${httpS} agents=${agents.length} added=${added} total=${seen.size} credits_left=${creditsLeft ?? '?'} (${result._elapsed_ms}ms)`);

    if (DEBUG_FIRST && called === 1) {
      tsLog(`  DEBUG dump: next_data_first_3000=${(result.next_data_first_3000 || '').slice(0, 500)}`);
      tsLog(`  DEBUG agent_name_snippets=${JSON.stringify(result.agent_name_snippets || []).slice(0, 800)}`);
      tsLog(`  DEBUG agents_array_snippet=${(result.agents_array_snippet || '').slice(0, 800)}`);
    }

    if (status === 'FAIL' && httpS >= 400) {
      successCalls++; // we still spent credits
      consecutiveEmpty++;
    } else if (status === 'PASS') {
      successCalls++;
      consecutiveEmpty = 0;
    } else if (status === 'EMPTY') {
      successCalls++;
      consecutiveEmpty++;
    }

    if (consecutiveEmpty >= 5) {
      tsLog(`  5 consecutive empty results — likely at end of results. Advancing to next source (city/zip).`);
      // Skip the remaining pages of this source
      while (
        taskIdx + 1 < remaining.length &&
        remaining[taskIdx + 1].kind === task.kind &&
        (remaining[taskIdx + 1].slug === task.slug || remaining[taskIdx + 1].zip === task.zip)
      ) {
        taskIdx++;
      }
      consecutiveEmpty = 0;
    }

    // Persist every 5 calls
    if (called % 5 === 0) {
      writeCSV();
      flushLog();
    }

    // Cost-brake: if credits running low, stop
    if (creditsLeft != null && creditsLeft < 100) {
      tsLog(`  Credits low (${creditsLeft} left). Stopping to preserve budget.`);
      break;
    }

    // Pace — 1.5-2.5s between calls
    await new Promise(r => setTimeout(r, 1500 + Math.random() * 1000));
  }

  writeCSV();
  tsLog(`--- FINAL ---`);
  tsLog(`Calls made: ${called} / ${MAX_CALLS}`);
  tsLog(`Unique agents captured: ${seen.size}`);
  tsLog(`Credits left: ${creditsLeft ?? 'unknown'}`);
  tsLog(`CSV: ${CSV_FILE}`);
  tsLog(`Raw log: ${RAW_FILE}`);
  flushLog();

  // Emit a summary line for the caller
  console.log(`SUMMARY total=${seen.size} calls=${called} credits_left=${creditsLeft ?? 'unknown'}`);
}

main().catch(err => {
  tsLog(`FATAL: ${err.message}\n${err.stack || ''}`);
  flushLog();
  process.exit(1);
});
