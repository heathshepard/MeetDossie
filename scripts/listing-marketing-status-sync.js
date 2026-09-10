'use strict';

// scripts/listing-marketing-status-sync.js
//
// Daily live-status sync for the listing-marketing pipeline. Pulls each
// tracked MLS# straight from connectMLS (never trusts a cached/stale value
// -- per CLAUDE.md's "MLS status is the sole source of truth" rule) and
// upserts public.listing_marketing_status. Auto-pauses (is_active=false)
// any listing that has left the postable-active family (Pending, Pending
// SB, Sold, Expired, Cancelled, Withdrawn, or "Active Option"/AO -- AO
// means a buyer already has an accepted contract in the option period;
// marketing an already-under-contract listing is exactly the "auto-stop"
// failure mode this script exists to prevent).
//
// Run this BEFORE scripts/listing-marketing-generator.js every day -- the
// generator trusts this table and does NOT re-check connectMLS itself.
//
// Usage:
//   node scripts/listing-marketing-status-sync.js
//
// Owner: Carter, 2026-09-10

const path = require('path');
const fs = require('fs');
const { launchBrokerageContext } = require('./_lib/brokerage-browser');
const { ensureSignedIn, smartBarSearch } = require('./_lib/connectmls-actions');
const { LISTINGS } = require('./_lib/listing-marketing-facts');

// Load .env.local
try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[k]) process.env[k] = v;
    }
  }
} catch (e) { /* non-fatal */ }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Status-family taxonomy per memory/sabor-mls-status-codes.md -- confirmed
// via the in-app "Change Status" picker, never expanded from guesswork.
const ACTIVE_FAMILY = new Set(['NEW', 'ACT', 'BOM', 'EXT', 'PCH', 'CS']); // New, Active, Back on Market, Extended, Price Change, Coming Soon
// Active-family-but-functionally-under-contract -- do NOT market these.
const UNDER_CONTRACT_ACTIVE_FAMILY = new Set(['AO', 'ARFR', 'AAR']); // Active Option, Active RFR, Active/Application Received
const OFF_MARKET = new Set(['PEN', 'PSB', 'SLD', 'EXP', 'CAN', 'WD', 'RNTD']);

async function sbFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function parseListingRow(text, mls) {
  // smartBarSearch lands on either a single-result summary row or a full
  // detail report depending on prior page state -- both contain this line:
  //   "<MLS#> <STATUS> <Class> <Type> <Area> \n <Address> \n <City> Texas <Zip> $<price> ..."
  const re = new RegExp(`${mls}\\s+([A-Z]+)\\s+[^\\n]*\\n[^\\n]*\\n\\s*([\\w .]+?)\\s+Texas\\s+(\\d{5})\\s+\\$?([\\d,]+)`);
  const m = text.match(re);
  if (!m) return null;
  return {
    status: m[1],
    city: m[2].trim(),
    zip: m[3],
    price: Number(m[4].replace(/,/g, '')),
  };
}

async function main() {
  const context = await launchBrokerageContext({ headless: true, reason: 'listing-marketing-status-sync' });
  const page = await context.newPage();
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });
  const results = [];
  try {
    await page.goto('https://lera.connectmls.com/mls/home/home.jsp', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await ensureSignedIn(page, context);

    for (const mls of Object.keys(LISTINGS)) {
      const listing = LISTINGS[mls];
      try {
        await page.waitForTimeout(1500); // let the prior search's page state settle before the next SmartBar query
        const text = await smartBarSearch(page, mls);
        const parsed = parseListingRow(text || '', mls);
        if (!parsed) {
          console.error(`[status-sync] COULD NOT PARSE status for ${mls} (${listing.address}) -- leaving existing DB row untouched, flagging for manual check`);
          try { fs.writeFileSync(path.join('C:\\Users\\Heath\\Projects\\MeetDossie\\.tmp\\listing-status-check', `debug-${mls}.txt`), text || ''); } catch (e) {}
          results.push({ mls, ok: false, reason: 'parse_failed' });
          continue;
        }
        const isUnderContract = UNDER_CONTRACT_ACTIVE_FAMILY.has(parsed.status);
        const isOffMarket = OFF_MARKET.has(parsed.status);
        const isActive = ACTIVE_FAMILY.has(parsed.status) && !isUnderContract && !isOffMarket;

        const row = {
          mls_number: mls,
          address: listing.address,
          city: parsed.city || listing.city,
          zip: parsed.zip || listing.zip,
          list_price: parsed.price,
          mls_status: parsed.status,
          is_active: isActive,
          is_agent_owned: !!listing.isAgentOwned,
          last_verified_at: new Date().toISOString(),
          last_verified_by: 'listing-marketing-status-sync.js',
          updated_at: new Date().toISOString(),
        };

        const { ok } = await sbFetch(`/rest/v1/listing_marketing_status?on_conflict=mls_number`, {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(row),
        });
        console.log(`[status-sync] ${mls} ${listing.address}: status=${parsed.status} price=$${parsed.price} active=${isActive}${isUnderContract ? ' (UNDER CONTRACT/OPTION -- marketing paused)' : ''}${isOffMarket ? ' (OFF MARKET -- marketing paused)' : ''}`);
        results.push({ mls, ok, status: parsed.status, isActive, price: parsed.price });
      } catch (e) {
        console.error(`[status-sync] ERROR for ${mls}:`, e.message);
        results.push({ mls, ok: false, reason: e.message });
      }
    }
  } finally {
    await context.close();
  }
  const failures = results.filter((r) => !r.ok);
  console.log(`[status-sync] DONE. ${results.length - failures.length}/${results.length} synced.`);
  if (failures.length) {
    console.error('[status-sync] FAILURES (left untouched in DB, needs manual check):', JSON.stringify(failures));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('[status-sync] FATAL', e.message); process.exitCode = 1; });
