#!/usr/bin/env node
// filter-kw-only-leads.js
//
// One-off filter for Thursday 2026-07-10 + Friday 2026-07-11 KW-only cold
// email touch-2 override (DocuSign migration week).
//
// Input:  data/sa-realtor-leads-final-v2.csv (4,824 rows)
// Output: data/kw-only-list-2026-07-09.csv (KW-brokerage subset)
//
// Filter:
//   - brokerage matches /keller\s*williams|^kw\b|kw\s|\bkw\s|\(kw\)/i
//   - valid email
//   - not in KNOWN_BOUNCES
//
// Suppression check against email_suppression_list happens in a separate
// step (requires Supabase — see kw-suppression-check.js).

const fs = require('fs');
const path = require('path');

const INPUT  = path.join(__dirname, '..', 'data', 'sa-realtor-leads-final-v2.csv');
const OUTPUT = path.join(__dirname, '..', 'data', 'kw-only-list-2026-07-09.csv');

const KNOWN_BOUNCES = new Set(['cheo.chayoh@lptrealty.com']);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (ch === '\r') { /* skip */ }
      else field += ch;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { header: [], rows: [] };
  const header = rows[0];
  const records = rows.slice(1).filter(r => r.length === header.length).map(r => {
    const o = {};
    header.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
  return { header, rows: records };
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeCsv(header, rows) {
  const out = [];
  out.push(header.map(csvEscape).join(','));
  for (const r of rows) {
    out.push(header.map(h => csvEscape(r[h])).join(','));
  }
  return out.join('\n') + '\n';
}

function isValidEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());
}

// KW brokerage matcher. Handles:
//   "KELLER WILLIAMS LEGACY", "Keller Williams Heritage", "KW City View",
//   "KW BOERNE", "Keller Williams Realty", "KW Hill Country", etc.
// Excludes: any brokerage that just happens to have the letters kw somewhere.
function isKW(brokerage) {
  const b = String(brokerage || '').trim().toLowerCase();
  if (!b) return false;
  if (/keller\s*williams/.test(b)) return true;
  // Standalone "kw" token (start of string, or preceded/followed by space/paren)
  if (/(^|[\s(])kw($|[\s)])/.test(b)) return true;
  return false;
}

function main() {
  if (!fs.existsSync(INPUT)) {
    console.error('INPUT missing:', INPUT);
    process.exit(1);
  }
  const text = fs.readFileSync(INPUT, 'utf8');
  const { header, rows } = parseCsv(text);
  console.log(`[filter-kw] loaded ${rows.length} total rows`);

  const stats = {
    total: rows.length,
    kw_match: 0,
    valid_email: 0,
    known_bounce_removed: 0,
    tier_breakdown: {},
    source_breakdown: {},
    mc_top_10: {},
  };

  const kept = [];
  const seenEmails = new Set();

  for (const r of rows) {
    if (!isKW(r.brokerage)) continue;
    stats.kw_match += 1;
    if (!isValidEmail(r.email)) continue;
    stats.valid_email += 1;
    const em = r.email.trim().toLowerCase();
    if (KNOWN_BOUNCES.has(em)) { stats.known_bounce_removed += 1; continue; }
    if (seenEmails.has(em)) continue;
    seenEmails.add(em);
    // normalize email in output
    r.email = em;
    kept.push(r);

    stats.tier_breakdown[r.confidence_tier || 'unknown'] =
      (stats.tier_breakdown[r.confidence_tier || 'unknown'] || 0) + 1;
    stats.source_breakdown[r.email_source || 'unknown'] =
      (stats.source_breakdown[r.email_source || 'unknown'] || 0) + 1;
    const mc = (r.brokerage || '').trim();
    stats.mc_top_10[mc] = (stats.mc_top_10[mc] || 0) + 1;
  }

  // Sort by market: Bexar/San Antonio first, then surrounding.
  const bexarCities = new Set([
    'San Antonio', 'Boerne', 'Helotes', 'Cibolo', 'Schertz', 'Universal City',
    'Live Oak', 'Converse', 'Selma', 'Alamo Heights', 'Leon Valley',
    'Castle Hills', 'Fair Oaks Ranch',
  ].map(s => s.toLowerCase()));
  const surroundingCities = new Set([
    'New Braunfels', 'Seguin', 'Bulverde', 'Spring Branch', 'Canyon Lake',
    'Fair Oaks', 'Fredericksburg', 'Kerrville', 'Comfort',
  ].map(s => s.toLowerCase()));

  function marketRank(city) {
    const c = String(city || '').trim().toLowerCase();
    if (bexarCities.has(c)) return 0;
    if (surroundingCities.has(c)) return 1;
    return 2;
  }

  kept.sort((a, b) => {
    const ra = marketRank(a.city);
    const rb = marketRank(b.city);
    if (ra !== rb) return ra - rb;
    // Within a market, prioritize by tier signal (existing > pattern_guess > trec)
    const tierRank = t => {
      if (t === 'tier_b_zenrows_no_phone') return 0;
      if (t === 'tier_c_trec_pattern_guess') return 2;
      return 1;
    };
    return tierRank(a.confidence_tier) - tierRank(b.confidence_tier);
  });

  fs.writeFileSync(OUTPUT, writeCsv(header, kept), 'utf8');

  console.log('\n[filter-kw] STATS');
  console.log('  total_rows:            ', stats.total);
  console.log('  kw_brokerage_match:    ', stats.kw_match);
  console.log('  valid_email:           ', stats.valid_email);
  console.log('  known_bounce_removed:  ', stats.known_bounce_removed);
  console.log('  kept (deduped, sorted):', kept.length);
  console.log('  output:                ', OUTPUT);
  console.log('\n  tier_breakdown:');
  for (const [t, n] of Object.entries(stats.tier_breakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n.toString().padStart(5)}  ${t}`);
  }
  console.log('\n  email_source_breakdown:');
  for (const [s, n] of Object.entries(stats.source_breakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n.toString().padStart(5)}  ${s}`);
  }
  console.log('\n  top MCs (offices) among kept KW leads:');
  const topMc = Object.entries(stats.mc_top_10)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15);
  for (const [mc, n] of topMc) {
    console.log(`    ${n.toString().padStart(5)}  ${mc}`);
  }
}

main();
