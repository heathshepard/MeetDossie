#!/usr/bin/env node
// prepare-kw-touch2-send-list.js
//
// Step 2 of the Thursday 2026-07-10 / Friday 2026-07-11 KW-only touch-2
// override. Takes the filtered KW list from filter-kw-only-leads.js and:
//
//   1. Removes rows in email_suppression_list (Supabase).
//   2. Deduplicates (case-insensitive email).
//   3. Sorts Bexar first, then surrounding, then other; within each block:
//      prioritize tier_b_zenrows (verified) then tier_c_trec_pattern_guess.
//   4. Splits into Thursday (first 15) and Friday (next 15).
//   5. Writes:
//         data/kw-only-list-2026-07-09.filtered.csv  (full list, suppression-clean)
//         data/kw-only-thursday-2026-07-10.csv       (15 rows)
//         data/kw-only-friday-2026-07-11.csv         (15 rows)
//
// Note: this DOES NOT exclude prior outbound_email_queue entries. The whole
// point of touch-2 is to re-contact touch-1 recipients. If Heath wants to
// avoid double-hitting recent touches, that's a separate policy call.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.

const fs = require('fs');
const path = require('path');

// Load .env.local
try {
  const envText = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8');
  envText.split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) {
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      process.env[m[1]] = v;
    }
  });
} catch (e) { /* env optional if injected */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const INPUT     = path.join(__dirname, '..', 'data', 'kw-only-list-2026-07-09.csv');
const OUT_FULL  = path.join(__dirname, '..', 'data', 'kw-only-list-2026-07-09.filtered.csv');
const OUT_THU   = path.join(__dirname, '..', 'data', 'kw-only-thursday-2026-07-10.csv');
const OUT_FRI   = path.join(__dirname, '..', 'data', 'kw-only-friday-2026-07-11.csv');

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

async function loadSuppression() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[prepare] SUPABASE creds missing — skipping remote suppression check');
    return new Set();
  }
  const url = `${SUPABASE_URL}/rest/v1/email_suppression_list?select=email&limit=10000`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    console.warn('[prepare] suppression fetch failed:', r.status);
    return new Set();
  }
  const rows = await r.json();
  const s = new Set();
  if (Array.isArray(rows)) rows.forEach(x => { if (x && x.email) s.add(String(x.email).toLowerCase()); });
  return s;
}

async function main() {
  const text = fs.readFileSync(INPUT, 'utf8');
  const { header, rows } = parseCsv(text);
  console.log(`[prepare] loaded ${rows.length} KW rows`);

  const suppressed = await loadSuppression();
  console.log(`[prepare] suppression list size: ${suppressed.size}`);

  const kept = [];
  const seen = new Set();
  let suppRemoved = 0;
  let bounceRemoved = 0;

  for (const r of rows) {
    const em = String(r.email || '').trim().toLowerCase();
    if (!em) continue;
    if (KNOWN_BOUNCES.has(em)) { bounceRemoved++; continue; }
    if (suppressed.has(em)) { suppRemoved++; continue; }
    if (seen.has(em)) continue;
    seen.add(em);
    r.email = em;
    kept.push(r);
  }

  console.log(`[prepare] suppression removed:  ${suppRemoved}`);
  console.log(`[prepare] known-bounce removed: ${bounceRemoved}`);
  console.log(`[prepare] final KW list size:   ${kept.length}`);

  fs.writeFileSync(OUT_FULL, writeCsv(header, kept), 'utf8');
  console.log(`[prepare] wrote full filtered list: ${OUT_FULL}`);

  // Slice: 15 Thursday, 15 Friday. Order is already market+tier sorted from
  // filter-kw-only-leads.js. Prefer tier_b (verified) at top of each day.
  //
  // Rearrange: split kept into tier_b first, tier_c after, preserving market
  // order within each tier. Then Thursday = [0..15), Friday = [15..30).
  const tierB = kept.filter(r => r.confidence_tier === 'tier_b_zenrows_no_phone');
  const tierC = kept.filter(r => r.confidence_tier !== 'tier_b_zenrows_no_phone');
  const prioritized = [...tierB, ...tierC];

  const thu = prioritized.slice(0, 15);
  const fri = prioritized.slice(15, 30);

  fs.writeFileSync(OUT_THU, writeCsv(header, thu), 'utf8');
  fs.writeFileSync(OUT_FRI, writeCsv(header, fri), 'utf8');
  console.log(`[prepare] wrote Thursday 15: ${OUT_THU}`);
  console.log(`[prepare] wrote Friday 15:   ${OUT_FRI}`);

  console.log('\n[prepare] THURSDAY send preview (first 15):');
  thu.forEach((r, i) => {
    console.log(`  ${(i+1).toString().padStart(2)}. ${r.email.padEnd(40)}  ${r.name}  |  ${r.brokerage}  |  ${r.city}  |  ${r.confidence_tier}`);
  });
  console.log('\n[prepare] FRIDAY send preview (next 15):');
  fri.forEach((r, i) => {
    console.log(`  ${(i+1).toString().padStart(2)}. ${r.email.padEnd(40)}  ${r.name}  |  ${r.brokerage}  |  ${r.city}  |  ${r.confidence_tier}`);
  });
}

main().catch(e => { console.error(e); process.exit(1); });
