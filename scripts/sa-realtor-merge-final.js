'use strict';

/**
 * SA REALTOR final merge — combine ZenRows-verified (v4) + TREC-pattern-guessed (v2).
 *
 * Reads:
 *   data/sa-realtor-leads-v4-zenrows.csv    (ZenRows-verified — higher confidence)
 *   data/sa-realtor-leads-v2.csv            (TREC-pattern-guessed — 4,603 rows)
 *
 * Writes:
 *   data/sa-realtor-leads-final.csv
 *
 * Dedup key: normalized name (case-insensitive, whitespace-collapsed). Where a
 * duplicate exists across both files, the ZenRows record wins (real brokerage
 * name from Realtor.com > pattern-guessed).
 *
 * Confidence tiers added as `confidence_tier`:
 *   - tier_a_zenrows: name + brokerage + phone from Realtor.com Apollo API
 *   - tier_b_zenrows_no_phone: name + brokerage from Realtor.com, no phone
 *   - tier_c_trec_pattern_guess: name + license from TREC, brokerage pattern-guessed, email pattern-guessed
 *
 * Run:
 *   node scripts/sa-realtor-merge-final.js
 */

const fs = require('fs');
const path = require('path');

const V4_FILE = path.join(__dirname, '..', 'data', 'sa-realtor-leads-v4-zenrows.csv');
const V2_FILE = path.join(__dirname, '..', 'data', 'sa-realtor-leads-v2.csv');
const OUT_FILE = path.join(__dirname, '..', 'data', 'sa-realtor-leads-final.csv');

function parseCSV(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCSVLine(lines[0]);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const cells = parseCSVLine(lines[i]);
    const row = {};
    for (let j = 0; j < header.length; j++) row[header[j]] = cells[j] || '';
    rows.push(row);
  }
  return { header, rows };
}

function parseCSVLine(line) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuote = false;
      else cur += c;
    } else {
      if (c === ',') { out.push(cur); cur = ''; }
      else if (c === '"') inQuote = true;
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function normalizeName(n) {
  return String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function main() {
  console.log('=== SA REALTOR final merge ===');

  // Load v4 ZenRows
  const v4 = fs.existsSync(V4_FILE)
    ? parseCSV(fs.readFileSync(V4_FILE, 'utf8'))
    : { header: [], rows: [] };
  console.log(`v4 ZenRows-verified: ${v4.rows.length} rows`);

  // Load v2 TREC-pattern-guess (schema: name,brokerage,email,phone,license_id,linkedin_url,source,scrape_ts,sa_zip,role_type)
  const v2 = fs.existsSync(V2_FILE)
    ? parseCSV(fs.readFileSync(V2_FILE, 'utf8'))
    : { header: [], rows: [] };
  console.log(`v2 TREC-pattern-guess: ${v2.rows.length} rows`);

  // Merged map, keyed on normalized name.
  // A name collision keeps the highest-confidence tier and enriches missing fields
  // from the other row.
  const merged = new Map();

  // Prefer ZenRows records — insert first
  for (const r of v4.rows) {
    const key = normalizeName(r.name);
    if (!key || key.length < 3) continue;
    const tier = r.phone ? 'tier_a_zenrows' : 'tier_b_zenrows_no_phone';
    merged.set(key, {
      name: r.name,
      brokerage: r.brokerage || '',
      email: r.email || '',
      phone: r.phone || '',
      city: r.city || '',
      zip: r.zip || '',
      license_id: '',
      profile_url: r.profile_url || '',
      agent_id: r.agent_id || '',
      bio_first_sentence: r.bio_first_sentence || '',
      listings_for_sale: r.listings_for_sale || '',
      recently_sold_annual: r.recently_sold_annual || '',
      avg_rating: r.avg_rating || '',
      review_count: r.review_count || '',
      is_team: r.is_team || '',
      source_primary: 'zenrows_realtor',
      source_secondary: '',
      confidence_tier: tier,
      scrape_ts: r.scrape_ts || new Date().toISOString(),
    });
  }

  // Now add v2 rows — either enrich existing (add license_id, email pattern guess) or insert as tier_c
  let enrichedCount = 0;
  let newFromV2 = 0;
  for (const r of v2.rows) {
    const key = normalizeName(r.name);
    if (!key || key.length < 3) continue;
    if (merged.has(key)) {
      // Enrich the ZenRows record with license_id + pattern-guess email if it's missing
      const existing = merged.get(key);
      let changed = false;
      if (!existing.license_id && r.license_id) { existing.license_id = r.license_id; changed = true; }
      if (!existing.email && r.email) { existing.email = r.email; changed = true; }
      if (!existing.phone && r.phone) { existing.phone = r.phone; changed = true; }
      if (!existing.zip && r.sa_zip) { existing.zip = r.sa_zip; changed = true; }
      if (changed) {
        existing.source_secondary = 'trec_license_search+pattern_guess_email';
        enrichedCount++;
      }
      merged.set(key, existing);
    } else {
      merged.set(key, {
        name: r.name,
        brokerage: r.brokerage || '',
        email: r.email || '',
        phone: r.phone || '',
        city: '',
        zip: r.sa_zip || '',
        license_id: r.license_id || '',
        profile_url: '',
        agent_id: '',
        bio_first_sentence: '',
        listings_for_sale: '',
        recently_sold_annual: '',
        avg_rating: '',
        review_count: '',
        is_team: '',
        source_primary: 'trec_license_search+pattern_guess_email',
        source_secondary: '',
        confidence_tier: 'tier_c_trec_pattern_guess',
        scrape_ts: r.scrape_ts || new Date().toISOString(),
      });
      newFromV2++;
    }
  }

  // Emit CSV
  const headers = [
    'name', 'brokerage', 'email', 'phone', 'city', 'zip', 'license_id',
    'profile_url', 'agent_id', 'bio_first_sentence',
    'listings_for_sale', 'recently_sold_annual', 'avg_rating', 'review_count',
    'is_team', 'confidence_tier', 'source_primary', 'source_secondary', 'scrape_ts',
  ];
  const csv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const rows = [headers.join(',')];
  for (const r of merged.values()) {
    rows.push(headers.map(h => csv(r[h])).join(','));
  }
  fs.writeFileSync(OUT_FILE, rows.join('\n'), 'utf8');

  // Report tier breakdown
  const tierCounts = {};
  for (const r of merged.values()) {
    tierCounts[r.confidence_tier] = (tierCounts[r.confidence_tier] || 0) + 1;
  }

  console.log('---');
  console.log(`v4 ZenRows records inserted: ${v4.rows.length}`);
  console.log(`v2 rows that enriched an existing v4 record: ${enrichedCount}`);
  console.log(`v2 rows added new (no ZenRows match): ${newFromV2}`);
  console.log(`Final total: ${merged.size}`);
  console.log(`Tier breakdown:`);
  for (const [t, n] of Object.entries(tierCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }
  console.log(`Written to: ${OUT_FILE}`);

  // Emit machine-readable summary for the caller
  console.log(`SUMMARY total=${merged.size} tier_a=${tierCounts.tier_a_zenrows || 0} tier_b=${tierCounts.tier_b_zenrows_no_phone || 0} tier_c=${tierCounts.tier_c_trec_pattern_guess || 0} enriched=${enrichedCount}`);
}

main();
