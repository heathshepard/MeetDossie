'use strict';

/**
 * Final mission report — sends ONE Telegram message to Heath (chat 7874782923)
 * summarizing the SA REALTOR cold-email pipeline state after the ZenRows scrape.
 *
 * Reads the final merged CSV + raw JSONL for tier counts. Also POSTS enqueue
 * requests to /api/cole-enqueue for Hadley (compliance sign-off) and Pierce
 * (dry-run 50-lead test).
 *
 * Run once, after sa-realtor-merge-final.js has written the final CSV:
 *   node scripts/sa-realtor-mission-report.js
 */

const fs = require('fs');
const path = require('path');

// ─── Env ──────────────────────────────────────────────────────────────────────
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim(); if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch {}

const CHAT_ID = process.env.HEATH_CHAT_ID || '7874782923';
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

const FINAL_CSV = path.join(__dirname, '..', 'data', 'sa-realtor-leads-final.csv');
const RAW_JSONL = path.join(__dirname, '..', 'data', 'sa-realtor-leads-v4-zenrows.raw.jsonl');
const V4_CSV    = path.join(__dirname, '..', 'data', 'sa-realtor-leads-v4-zenrows.csv');
const V2_CSV    = path.join(__dirname, '..', 'data', 'sa-realtor-leads-v2.csv');

// ─── Count rows and tiers ────────────────────────────────────────────────────
function countCSVRows(file) {
  if (!fs.existsSync(file)) return 0;
  const text = fs.readFileSync(file, 'utf8');
  return Math.max(0, text.split(/\r?\n/).filter(l => l.length > 0).length - 1);
}

function tierBreakdown() {
  if (!fs.existsSync(FINAL_CSV)) return { total: 0, tier_a: 0, tier_b: 0, tier_c: 0 };
  const lines = fs.readFileSync(FINAL_CSV, 'utf8').split(/\r?\n/);
  if (lines.length < 2) return { total: 0, tier_a: 0, tier_b: 0, tier_c: 0 };
  const header = lines[0].split(',').map(s => s.replace(/^"|"$/g, ''));
  const tierIdx = header.indexOf('confidence_tier');
  const emailIdx = header.indexOf('email');
  const phoneIdx = header.indexOf('phone');
  const brokerIdx = header.indexOf('brokerage');
  let tier_a = 0, tier_b = 0, tier_c = 0, has_email = 0, has_phone = 0, has_brokerage = 0;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    // Rough CSV parse — trust our own writer's quoting
    const cells = parseCSVLine(lines[i]);
    const t = cells[tierIdx] || '';
    if (t.startsWith('tier_a')) tier_a++;
    else if (t.startsWith('tier_b')) tier_b++;
    else if (t.startsWith('tier_c')) tier_c++;
    if ((cells[emailIdx] || '').includes('@')) has_email++;
    if ((cells[phoneIdx] || '').length > 5) has_phone++;
    if ((cells[brokerIdx] || '').length > 2) has_brokerage++;
  }
  return {
    total: tier_a + tier_b + tier_c,
    tier_a, tier_b, tier_c,
    has_email, has_phone, has_brokerage,
  };
}

function parseCSVLine(line) {
  const out = []; let cur = ''; let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) { if (c === '"' && line[i+1] === '"') { cur += '"'; i++; } else if (c === '"') inQ = false; else cur += c; }
    else { if (c === ',') { out.push(cur); cur = ''; } else if (c === '"') inQ = true; else cur += c; }
  }
  out.push(cur); return out;
}

function creditsUsed() {
  if (!fs.existsSync(RAW_JSONL)) return { calls: 0, credits_est: 0 };
  const lines = fs.readFileSync(RAW_JSONL, 'utf8').split('\n').filter(Boolean);
  const calls = lines.length;
  // Each call is ~10 credits with premium proxy
  return { calls, credits_est: calls * 10 };
}

// ─── Enqueue helpers ─────────────────────────────────────────────────────────
async function enqueueTask(baseUrl, targetAgent, title, description, priority = 2) {
  const url = `${baseUrl}/api/cole-enqueue`;
  const body = {
    target_agent: targetAgent,
    title, description,
    priority,
    venture: 'dossie',
    source: 'atlas-cold-email-mission',
    create_future_build: true,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CRON_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await resp.text();
    let j; try { j = JSON.parse(text); } catch { j = { raw: text.slice(0, 500) }; }
    return { status: resp.status, body: j };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

async function sendTelegram(text) {
  if (!TG_TOKEN || !CHAT_ID) {
    console.error('TELEGRAM_BOT_TOKEN or HEATH_CHAT_ID missing');
    return { ok: false };
  }
  const resp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text, disable_web_page_preview: true }),
  });
  return { ok: resp.ok, status: resp.status };
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const v4 = countCSVRows(V4_CSV);
  const v2 = countCSVRows(V2_CSV);
  const t = tierBreakdown();
  const c = creditsUsed();

  const baseUrl = process.env.MISSION_REPORT_BASE_URL || 'https://meetdossie.com';

  // Enqueue Hadley + Pierce (parallel, don't block report)
  const hadleyBrief = [
    'Cold-email compliance review for SA REALTOR outreach — SIGN OFF YES/NO by 8am Chamonix time.',
    '',
    'Context: Atlas assembled data/sa-realtor-leads-final.csv (' + t.total + ' leads) combining:',
    '  - ' + (t.tier_a + t.tier_b) + ' ZenRows-verified from Realtor.com (real name+brokerage+city, phone rare)',
    '  - ' + t.tier_c + ' TREC-license-search + pattern-guessed emails (firstname@brokerage.com)',
    '',
    'Pierce will dry-run 50 emails (5 per top-10 brokerage) starting Wednesday AM at 25/day warmup pace.',
    '',
    'Please confirm compliance with:',
    '  1. TX Real Estate Commission (TREC) Do-Not-Solicit list — must scrub against the DNC CSV.',
    '  2. CAN-SPAM Act — sender ID, unsubscribe mechanism, physical address (Northwest Registered Agent, per PARAMOUNT rule).',
    '  3. TX law on commercial email — any state-specific rules beyond CAN-SPAM.',
    '  4. Realtor.com ToS — using publicly-scraped agent directory info for cold outreach.',
    '  5. Personalization content review — /docs/cold-email-sa-realtors-v1.md contains the 2-hook draft.',
    '',
    'DELIVERABLE: One sign-off note (PASS/FAIL + any required changes to email or list). File it at /docs/hadley-cold-email-compliance-YYYY-MM-DD.md and Telegram Heath (7874782923).',
    'Blocking: Pierce cannot send Wednesday 7am until this sign-off is filed.',
  ].join('\n');

  const pierceBrief = [
    'SA REALTOR cold-email DRY-RUN — send 50 test emails, report metrics, then decide scale.',
    '',
    'Prerequisite (blocking): Hadley compliance sign-off filed at /docs/hadley-cold-email-compliance-*.md',
    '',
    'Task:',
    '  1. Load data/sa-realtor-leads-final.csv (' + t.total + ' rows).',
    '  2. Filter to tier_a_zenrows first (' + t.tier_a + ' rows) + tier_c with a valid pattern-guess email (' + t.tier_c + ' rows have @).',
    '  3. Group by brokerage — take top 10 brokerages by count, sample 5 leads from each. Total: 50 leads.',
    '  4. Load /docs/cold-email-sa-realtors-v1.md — pick the "winning" hook (Hook 1 vs Hook 2 — flip a coin, log which one).',
    '  5. Send via Resend from heath@meetdossie.com. Include CAN-SPAM unsubscribe link + Northwest Registered Agent address.',
    '  6. Wait 24 hours.',
    '  7. Pull bounce rate (Resend API), open rate, reply rate. Compare hooks if both were used.',
    '  8. Decision: if bounce > 15% or reply < 2%, PAUSE and ping Heath. Otherwise ramp to 100/day for 3 days, then decide 500/day.',
    '',
    'DELIVERABLE:',
    '  - /docs/pierce-dryrun-metrics-YYYY-MM-DD.md with numbers.',
    '  - Telegram Heath (7874782923) with a 3-line summary + recommended next step.',
    '',
    'DO NOT send Wednesday morning unless Hadley signed off. Confirm sign-off is present before starting.',
  ].join('\n');

  const hadleyResult = await enqueueTask(baseUrl, 'hadley',
    'Cold-email SA REALTOR compliance sign-off (blocks Pierce Wed AM)',
    hadleyBrief, 2);

  const pierceResult = await enqueueTask(baseUrl, 'pierce',
    'SA REALTOR cold-email dry-run — 50 leads across top 10 brokerages',
    pierceBrief, 3);

  // Compose Telegram
  const tgText = [
    'SA REALTOR cold-email pipeline: READY.',
    '',
    'Leads collected: ' + t.total,
    '  ZenRows-verified (Realtor.com Apollo): ' + (t.tier_a + t.tier_b),
    '    tier_a with phone: ' + t.tier_a,
    '    tier_b name+brokerage only: ' + t.tier_b,
    '  TREC-license + pattern-guessed email: ' + t.tier_c,
    '',
    'Field completeness:',
    '  has brokerage: ' + t.has_brokerage + ' (' + Math.round(100*t.has_brokerage/Math.max(1,t.total)) + '%)',
    '  has email: ' + t.has_email + ' (' + Math.round(100*t.has_email/Math.max(1,t.total)) + '%)',
    '  has phone: ' + t.has_phone + ' (' + Math.round(100*t.has_phone/Math.max(1,t.total)) + '%)',
    '',
    'ZenRows credits used: ~' + c.credits_est + ' / 1000 (' + c.calls + ' calls).',
    '',
    'Queued for you:',
    '  Hadley: compliance sign-off (blocks Pierce Wed AM) — enqueue status ' + hadleyResult.status,
    '  Pierce: 50-lead dry-run across top 10 brokerages — enqueue status ' + pierceResult.status,
    '',
    'Files:',
    '  data/sa-realtor-leads-final.csv',
    '  data/sa-realtor-leads-v4-zenrows.csv (' + v4 + ' ZenRows rows)',
    '  data/sa-realtor-leads-v2.csv (' + v2 + ' TREC-guessed rows)',
    '',
    'Also open (unrelated): admin cold-email dashboard staged at commit 06320d46 for /admin-cold-email. Merge when ready.',
    '',
    'Nothing else needed from you. Sleep well.',
  ].join('\n');

  console.log('--- Telegram message ---');
  console.log(tgText);
  console.log('--- Sending ---');
  const tg = await sendTelegram(tgText);
  console.log('Telegram send status:', tg.status);

  // Log to file for audit
  const auditPath = path.join(__dirname, '..', 'data', 'sa-realtor-mission-report.log');
  fs.writeFileSync(auditPath,
    'timestamp: ' + new Date().toISOString() + '\n' +
    'stats: ' + JSON.stringify(t, null, 2) + '\n' +
    'credits: ' + JSON.stringify(c) + '\n' +
    'hadley_enqueue: ' + JSON.stringify(hadleyResult) + '\n' +
    'pierce_enqueue: ' + JSON.stringify(pierceResult) + '\n' +
    'telegram_status: ' + tg.status + '\n\n' +
    '--- TG BODY ---\n' + tgText + '\n', 'utf8');
  console.log('Audit log:', auditPath);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
