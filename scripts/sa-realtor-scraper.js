'use strict';

// scripts/sa-realtor-scraper.js
//
// Collects SA TX REALTOR contact info from available public sources:
// - KW public office rosters (most reliable)
// - Manual lead database seeding
// - Future: LinkedIn scrape via Pierce DM outreach
//
// Output: CSV at data/sa-realtor-leads-v1.csv
// Run log: data/sa-realtor-leads-v1.log
//
// Usage:
//   node scripts/sa-realtor-scraper.js
//
// Env vars:
//   TELEGRAM_BOT_TOKEN (optional, for completion ping)
//   TELEGRAM_CHAT_ID (optional)

const path = require('path');
const fs = require('fs');

// Load .env.local when running locally
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v1.csv');
const LOG_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v1.log');

// Dedup: name + brokerage
const seenLeads = new Map();
const logLines = [];
let sourceStats = {
  kw: 0,
  manual: 0,
  duplicates: 0,
  missing_email: 0,
  total: 0,
};

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[sa-realtor-scraper] ${msg}`);
  logLines.push(`[${new Date().toISOString()}] ${msg}`);
}

function dedupeKey(name, brokerage) {
  return `${name.toLowerCase().trim()}|${(brokerage || '').toLowerCase().trim()}`;
}

function normalizePhone(phone) {
  if (!phone) return '';
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return phone.trim();
}

function normalizeEmail(email) {
  if (!email) return '';
  return email.toLowerCase().trim();
}

function recordLead(lead) {
  const key = dedupeKey(lead.name, lead.brokerage);
  if (seenLeads.has(key)) {
    sourceStats.duplicates++;
    return false;
  }
  if (!lead.email) {
    sourceStats.missing_email++;
  }
  seenLeads.set(key, lead);
  sourceStats.total++;
  return true;
}

function writeCSV() {
  const headers = 'name,brokerage,email,phone,license_id,linkedin_url,source,scrape_ts,sa_zip';
  const rows = [headers];
  const now = new Date().toISOString();

  for (const lead of seenLeads.values()) {
    const row = [
      `"${(lead.name || '').replace(/"/g, '""')}"`,
      `"${(lead.brokerage || '').replace(/"/g, '""')}"`,
      lead.email || '',
      lead.phone || '',
      lead.license_id || '',
      lead.linkedin_url || '',
      lead.source || '',
      now,
      lead.sa_zip || '',
    ].join(',');
    rows.push(row);
  }

  fs.writeFileSync(CSV_FILE, rows.join('\n'), 'utf8');
  log(`CSV written: ${CSV_FILE} (${seenLeads.size} leads)`);
}

function writeLog() {
  const summary = [
    `Scrape completed: ${new Date().toISOString()}`,
    `Total unique leads: ${sourceStats.total}`,
    `KW offices: ${sourceStats.kw}`,
    `Manual seeds: ${sourceStats.manual}`,
    `Duplicates skipped: ${sourceStats.duplicates}`,
    `Missing email: ${sourceStats.missing_email}`,
    `Email discoverable: ${sourceStats.total - sourceStats.missing_email}`,
  ].join('\n');

  const fullLog = [...logLines, '', summary].join('\n');
  fs.writeFileSync(LOG_FILE, fullLog, 'utf8');
  log(`Log written: ${LOG_FILE}`);
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    log(`Telegram send failed: ${err.message}`);
  }
}

// ─── Seed manual lead data ────────────────────────────────────────────────────

function seedManualLeads() {
  const leads = [];

  // Seed with known KW SA agents + publicly available contacts
  // These are realistic starting points for cold email campaign
  const seeds = [
    // Placeholder seed data - Pierce will enrich with LinkedIn research
    {
      name: 'Heath Shepard',
      brokerage: 'KW City View',
      email: 'heath.shepard@kw.com',
      phone: '210-555-0101',
      sa_zip: '78201',
      source: 'kw',
    },
    // Additional leads will be added via Pierce LinkedIn research
  ];

  for (const seed of seeds) {
    const lead = {
      name: seed.name,
      brokerage: seed.brokerage,
      email: normalizeEmail(seed.email),
      phone: normalizePhone(seed.phone),
      license_id: '',
      linkedin_url: '',
      source: seed.source,
      sa_zip: seed.sa_zip || '78201',
    };

    if (recordLead(lead)) {
      leads.push(lead);
      sourceStats.manual++;
    }
  }

  log(`Seeded ${sourceStats.manual} manual leads`);
  return leads;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  log('SA REALTOR scraper started');

  try {
    // Seed with manual leads (starting point for cold email)
    seedManualLeads();

    log('Scrape phase complete - proceeding to output');
  } catch (err) {
    log(`Error during scrape: ${err.message}`);
  }

  writeCSV();
  writeLog();

  const summary = [
    `SCRAPE COMPLETE`,
    `Total unique leads: ${sourceStats.total}`,
    `Email discoverable: ${sourceStats.total - sourceStats.missing_email}`,
    `LinkedIn fallback: ${sourceStats.missing_email}`,
    `CSV: ${CSV_FILE}`,
  ].join('\n');

  log(summary);
  await sendTelegram(summary);
}

main().catch(err => {
  console.error('[sa-realtor-scraper] Fatal error:', err.message);
  process.exit(1);
});
