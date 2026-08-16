#!/usr/bin/env node
/**
 * Make the demo account safe to screen-share and safe to record.
 *
 * DRY RUN BY DEFAULT. Prints every change it would make and touches nothing.
 *   node scripts/carter-scrub-demo-pii.js              # report
 *   node scripts/carter-scrub-demo-pii.js --execute    # apply
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT A DELETE SCRIPT
 * --------------------------------------------------
 * The demo account carries real client names. Confirmed by cross-referencing
 * the live database, not by guesswork:
 *   - one dossier duplicates a real transaction outright — same address, same
 *     buyer, same seller, copied into the demo account
 *   - one carries a family who are real clients on another live listing
 *   - one carries a real listing address with both parties populated
 * 205 Kendall Falls is the worst case: it is the dossier the capability audit
 * recommends demoing, and marketing screen recordings are queued against it.
 * Recording it as-is publishes real client names on the homepage.
 *
 * Those dossiers are also the best-populated demo content in the product. So
 * the fix is to RENAME the parties to obviously fictional stand-ins, not to
 * delete the dossiers and gut the demo. Only unambiguous QA artefacts
 * ("E2E-<timestamp>", "999 Carter Test Ln", 13x "123 Main St") are deleted.
 *
 * NO REAL NAME APPEARS IN THIS FILE. MeetDossie is a public repo. The script
 * DERIVES which names are real at runtime:
 *   1. any party name or address in the demo account that also appears on a
 *      non-demo (real) account, and
 *   2. deny-by-default — any remaining human-looking name that is not on the
 *      obvious-test-fixture allowlist below.
 * Replacements are deterministic (same input -> same fictional name) so a
 * dossier reads consistently after the scrub.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EXECUTE = process.argv.includes('--execute');

// Names that are obviously fixtures, not people. Anything NOT matching these is
// treated as potentially real and gets replaced.
const OBVIOUS_FIXTURE = [
  /\btest\b/i, /\bdemo\b/i, /\bverify\b/i, /\bquinn\b/i, /\batlas\b/i,
  /\bcarter\b/i, /\bhadley\b/i, /\bapv\b/i, /\be2e\b/i,
  /^john (smith|q public)$/i, /^robert seller$/i, /^jane doe$/i,
];

// Deletable QA artefacts (address patterns).
const JUNK_ADDRESS = [
  /^E2E-\d+/i, /\bCarter Test\b/i, /\bQuinn (Round \d+ )?Verify\b/i,
  /\bQuinn Buyer APV\b/i, /\bAPV Buyer Test\b/i, /\bLoop Test Lane\b/i,
  /\bZelda Demo Way\b/i, /^ATLAS-E2E/i, /^HADLEY-AMENDMENT/i,
  /^123 Main St(reet)?\.?$/i, /^1234 Main St\.?$/i,
];

const FIRST = ['Avery','Rowan','Sloane','Emerson','Quincy','Marlowe','Tatum','Ellis','Harper','Sutton','Reese','Blakely','Nolan','Sawyer','Wren','Larkin'];
const LAST  = ['Ashford','Bellamy','Calloway','Dunmore','Everly','Fairbanks','Grayson','Hollis','Ivory','Jennings','Kingsley','Lockhart','Merritt','Northcott','Oakley','Pennington'];

function fictionalName(seed, plural) {
  const h = crypto.createHash('sha256').update(String(seed)).digest();
  const one = () => `${FIRST[h[0] % FIRST.length]} ${LAST[h[1] % LAST.length]}`;
  if (!plural) return one();
  const second = `${FIRST[h[2] % FIRST.length]} ${LAST[h[1] % LAST.length]}`;
  return `${one()} and ${second}`;
}

const STREETS = ['Windmere', 'Copperfield', 'Halbrook', 'Ravensworth', 'Tessley', 'Marbury', 'Feathergate', 'Wrenfield', 'Alderpine', 'Brookhollow'];
const SUFFIX = ['Ln', 'Dr', 'Ct', 'Way', 'Trl', 'Cv'];

// Keep the house number and the city/state/zip tail so the record still reads
// like a real Texas address; replace only the identifying street name.
function fictionalAddress(seed, original) {
  const h = crypto.createHash('sha256').update(`addr:${seed}`).digest();
  const num = String(original || '').trim().match(/^\d+/);
  const tail = String(original || '').match(/,\s*[^,]+,\s*[A-Z]{2}\s*\d{0,5}\s*$/i);
  const houseNo = num ? num[0] : String(100 + (h[3] % 8900));
  return `${houseNo} ${STREETS[h[0] % STREETS.length]} ${SUFFIX[h[1] % SUFFIX.length]}${tail ? tail[0] : ''}`;
}

function loadEnv() {
  const raw = fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').replace(/^﻿/, '');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
  return env;
}
const env = loadEnv();
const BASE = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!BASE || !KEY) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

async function rest(q, init = {}) {
  const res = await fetch(`${BASE}/rest/v1/${q}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${q} -> ${res.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const addrKey = (s) => norm(s)
  .replace(/\b(st|street|dr|drive|rd|road|ln|lane|ave|avenue|blvd|pkwy|parkway|cir|circle|ct|court|way|tx|texas|san antonio|austin)\b/g, '')
  .replace(/\s+/g, ' ').trim();

// A human-looking name we did not positively recognise as a fixture.
function looksReal(name) {
  const n = String(name || '').trim();
  if (n.length < 4) return false;
  if (OBVIOUS_FIXTURE.some((re) => re.test(n))) return false;
  return /[a-z]/i.test(n);
}

(async () => {
  const profiles = await rest('profiles?select=id,email,is_demo');
  const demoIds = new Set(profiles.filter((p) => p.is_demo).map((p) => p.id));
  if (!demoIds.size) { console.log('No is_demo profiles. Nothing to do.'); return; }

  const all = await rest('transactions?select=id,user_id,property_address,buyer_name,seller_name,status');
  const demo = all.filter((t) => demoIds.has(t.user_id));
  const real = all.filter((t) => !demoIds.has(t.user_id));

  // Everything that appears on a REAL account is, by definition, real.
  const realAddrs = new Set(real.map((t) => addrKey(t.property_address)).filter(Boolean));
  const realNames = new Set();
  for (const t of real) {
    for (const n of [t.buyer_name, t.seller_name]) if (n && norm(n).length > 4) realNames.add(norm(n));
  }

  const deletes = [];
  const renames = [];

  for (const t of demo) {
    const addr = String(t.property_address || '').trim();
    if (!addr || JUNK_ADDRESS.some((re) => re.test(addr))) { deletes.push(t); continue; }

    const patch = {};
    const notes = [];
    // An address that also exists on a real account identifies a real property
    // and a real client even when the party names are fixtures — a demo showing
    // a live listing address is still a leak. Replace the street name, keep the
    // shape so the dossier still looks plausible on screen.
    const dupAddr = addrKey(addr) && realAddrs.has(addrKey(addr));
    if (dupAddr) {
      notes.push('address also on a real account');
      patch.property_address = fictionalAddress(t.id, addr);
    }

    for (const field of ['buyer_name', 'seller_name']) {
      const v = t[field];
      if (!v || !String(v).trim()) continue;
      const onReal = realNames.has(norm(v));
      if (onReal || looksReal(v)) {
        patch[field] = fictionalName(`${t.id}:${field}`, /,| and | & /i.test(String(v)));
        notes.push(onReal ? `${field} matches a real account` : `${field} not a known fixture`);
      }
    }
    if (Object.keys(patch).length) renames.push({ t, patch, notes, dupAddr });
  }

  console.log(`\nDemo dossiers: ${demo.length}   Real dossiers compared against: ${real.length}\n`);

  console.log(`--- DELETE (${deletes.length}) — QA artefacts / blank address ---`);
  deletes.forEach((t) => console.log(`  ${(t.status || '-').padEnd(7)} ${String(t.property_address || '(blank)').slice(0, 46)}  ${t.id.slice(0, 8)}`));

  console.log(`\n--- SCRUB NAMES (${renames.length}) — dossier kept, parties replaced with fictional stand-ins ---`);
  for (const r of renames) {
    console.log(`  ${(r.t.status || '-').padEnd(7)} ${String(r.t.property_address).slice(0, 40).padEnd(42)} ${r.t.id.slice(0, 8)}${r.dupAddr ? '  [DUPLICATES A REAL DOSSIER]' : ''}`);
    for (const [k, v] of Object.entries(r.patch)) console.log(`             ${k} -> "${v}"`);
    console.log(`             reason: ${[...new Set(r.notes)].join('; ')}`);
  }

  const dupes = renames.filter((r) => r.dupAddr);
  if (dupes.length) {
    console.log(`\n  ${dupes.length} dossier(s) duplicated a real property. Both the address and the`);
    console.log(`  parties are replaced, so nothing recognisable survives the scrub.`);
  }

  if (!EXECUTE) {
    console.log(`\nDRY RUN — nothing changed.`);
    console.log(`Would delete ${deletes.length} dossiers and rewrite parties on ${renames.length}.`);
    console.log(`Re-run with --execute to apply.\n`);
    return;
  }

  for (const r of renames) {
    await rest(`transactions?id=eq.${r.t.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(r.patch),
    });
    console.log(`  scrubbed ${r.t.id.slice(0, 8)} ${r.t.property_address}`);
  }
  const CHILD = ['documents', 'action_items', 'dossier_milestones', 'deadline_reminders', 'email_queue', 'amendments', 'transaction_offers'];
  for (const t of deletes) {
    for (const tbl of CHILD) {
      try { await rest(`${tbl}?transaction_id=eq.${t.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } }); }
      catch (e) { if (!/42703|does not exist/i.test(e.message)) console.warn(`   ${tbl}: ${e.message}`); }
    }
    await rest(`transactions?id=eq.${t.id}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    console.log(`  deleted  ${t.id.slice(0, 8)} ${t.property_address || '(blank)'}`);
  }
  console.log(`\nDone. ${renames.length} scrubbed, ${deletes.length} deleted.\n`);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
