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
const { ACTIVE_FAMILY, UNDER_CONTRACT_ACTIVE_FAMILY, OFF_MARKET } = require('./_lib/mls-status-taxonomy');

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

// 2026-09-11 (Carter, urgent fix): connectMLS's own structured "Address"
// grid/detail field is suffix-less (e.g. "702 Fawndale", not "702 Fawndale
// Ln") -- so listing-marketing-facts.js's hand-typed `address` field (with
// suffix) can NEVER be corroborated against that field alone. This was the
// direct cause of the 702 Fawndale Dr/Ln bug: "Dr" was typed once, never
// verified, and quietly rode along through every sync as if it were live
// data. The street name + suffix DOES appear in the listing's own remarks
// and/or driving directions (agent-authored, but pulled fresh every sync,
// same process, same page). Cross-check the fact pack's address against
// that text and REFUSE to sync (leave the existing DB row untouched, flag
// for manual check) on a genuine mismatch -- never silently trust a typed
// value that live MLS data now contradicts.
const STREET_SUFFIXES = ['Ln', 'Ln\\.', 'Dr', 'Dr\\.', 'St', 'St\\.', 'Ave', 'Ave\\.', 'Rd', 'Rd\\.', 'Blvd', 'Blvd\\.', 'Ct', 'Ct\\.', 'Way', 'Cir', 'Trl', 'Pkwy', 'Pl', 'Ter', 'Xing', 'Loop'];

function verifyAddressAgainstMlsText(text, factAddress) {
  // factAddress e.g. "702 Fawndale Ln" or "23 Nopalito" (no suffix — some
  // streets genuinely have none, e.g. "Nopalito").
  const m = String(factAddress || '').trim().match(/^(\d+)\s+(.+)$/);
  if (!m) return { ok: true, reason: 'unparseable_fact_address' }; // don't block on something we can't even parse
  const [, num, rest] = m;
  const restEsc = rest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffixAlt = STREET_SUFFIXES.join('|');
  // Does the fact address itself already end in a known suffix?
  const factSuffixMatch = rest.match(new RegExp(`\\b(${suffixAlt})\\.?$`, 'i'));

  // Search the live text for "<num> <streetName-minus-suffix> <ANY suffix>"
  // to see what suffix (if any) the live listing's own remarks/directions use.
  const streetNameOnly = factSuffixMatch
    ? rest.slice(0, rest.length - factSuffixMatch[0].length).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : restEsc;
  const liveRe = new RegExp(`${num}\\s+${streetNameOnly}\\s+(${suffixAlt})\\b`, 'i');
  const liveMatch = text.match(liveRe);

  if (!liveMatch) {
    // No independent corroboration found in this pull — not a hard failure
    // (remarks phrasing varies), but not a verified match either.
    return { ok: true, reason: 'no_corroboration_found' };
  }
  const liveSuffix = liveMatch[1].replace(/\.$/, '').toLowerCase();
  const factSuffix = factSuffixMatch ? factSuffixMatch[1].replace(/\.$/, '').toLowerCase() : null;
  if (factSuffix && liveSuffix !== factSuffix) {
    return { ok: false, reason: `fact pack says "${factSuffix}", live MLS text says "${liveSuffix}"` };
  }
  return { ok: true, reason: 'verified_match' };
}

// syncAll() -- does the real connectMLS live pull, upserts
// listing_marketing_status same as always, AND returns the freshly-verified
// rows in memory (keyed by mls_number) so a caller in the SAME process (see
// scripts/listing-marketing-generate-live.js) can generate posts directly
// off the live read with zero persistence gap, instead of re-querying the
// DB after the browser has already closed.
async function syncAll({ verifiedBy = 'listing-marketing-status-sync.js' } = {}) {
  const context = await launchBrokerageContext({ headless: true, reason: 'listing-marketing-status-sync' });
  const page = await context.newPage();
  page.on('dialog', async (d) => { try { await d.accept(); } catch {} });
  const results = [];
  const statusByMls = {};
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
        // Cross-check the fact pack's typed street address against this
        // same live pull (see verifyAddressAgainstMlsText header comment) --
        // never let a typed value ride through unverified again after the
        // 702 Fawndale Dr/Ln incident.
        const addressCheck = verifyAddressAgainstMlsText(text || '', listing.address);
        if (!addressCheck.ok) {
          console.error(`[status-sync] ADDRESS MISMATCH for ${mls}: ${addressCheck.reason} -- leaving existing DB row untouched, refusing to sync until listing-marketing-facts.js is corrected.`);
          results.push({ mls, ok: false, reason: 'address_mismatch', detail: addressCheck.reason });
          continue;
        }
        if (addressCheck.reason === 'no_corroboration_found') {
          console.warn(`[status-sync] ${mls}: could not independently corroborate "${listing.address}" against this pull's remarks/directions text -- syncing anyway (not a hard block), but this address was NOT freshly verified.`);
        }

        const isUnderContract = UNDER_CONTRACT_ACTIVE_FAMILY.has(parsed.status);
        const isOffMarket = OFF_MARKET.has(parsed.status);
        const isActive = ACTIVE_FAMILY.has(parsed.status) && !isUnderContract && !isOffMarket;
        const verifiedAt = new Date().toISOString();

        const row = {
          mls_number: mls,
          address: listing.address,
          city: parsed.city || listing.city,
          zip: parsed.zip || listing.zip,
          list_price: parsed.price,
          mls_status: parsed.status,
          is_active: isActive,
          is_agent_owned: !!listing.isAgentOwned,
          last_verified_at: verifiedAt,
          last_verified_by: verifiedBy,
          updated_at: verifiedAt,
        };

        const { ok } = await sbFetch(`/rest/v1/listing_marketing_status?on_conflict=mls_number`, {
          method: 'POST',
          headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(row),
        });
        console.log(`[status-sync] ${mls} ${listing.address}: status=${parsed.status} price=$${parsed.price} active=${isActive}${isUnderContract ? ' (UNDER CONTRACT/OPTION -- marketing paused)' : ''}${isOffMarket ? ' (OFF MARKET -- marketing paused)' : ''}`);
        results.push({ mls, ok, status: parsed.status, isActive, price: parsed.price });
        // Only expose rows that actually parsed + wrote successfully -- a
        // failed/unparsed row must never be handed to the generator as if
        // it were a fresh live read.
        if (ok) statusByMls[mls] = row;
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
  }
  return { results, failures, statusByMls };
}

async function main() {
  const { failures } = await syncAll();
  if (failures.length) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => { console.error('[status-sync] FATAL', e.message); process.exitCode = 1; });
}

module.exports = { syncAll };
