'use strict';

// scripts/sa-realtor-scraper-trec.js
//
// TREC-direct scraper for San Antonio REALTORs. Uses TREC's public Typesense
// search index (HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd, search-only key, baked into
// www.trec.texas.gov/apps/license-search/dist/assets/index-sQ3mpem9.js).
//
// Strategy
// --------
// 1. SEED — hand-built list of SA-market broker companies' TREC license numbers.
//    Sourced from a "San Antonio" organizationName query + known SA franchises.
// 2. ENUMERATE — for each broker license, query sales agents whose
//    sponsoringData.sponsorLicenseNumber matches. Paginate per_page=100.
// 3. NORMALIZE — agent license is "{customId}", broker on file is in
//    sponsoringData. We do NOT call /licenseDetail since TREC does not publish
//    individual sales-agent contact info (personal phone/email/address are
//    blank).
// 4. EMAIL GUESS — apply per-brokerage email patterns where the domain is
//    publicly published (KW, eXp, Phyllis Browning, etc.) — flagged as
//    'pattern_guess' in source column so Pierce knows to verify before send.
// 5. OUTPUT — CSV at data/sa-realtor-leads-v2.csv with role_type='solo_agent'
//    for Salesperson type and 'broker' for Broker Individual.
//
// Run
// ---
//   node scripts/sa-realtor-scraper-trec.js
//   node scripts/sa-realtor-scraper-trec.js --include-brokers  (also pull Broker Individual)
//   node scripts/sa-realtor-scraper-trec.js --max-per-brokerage=200

const path = require('path');
const fs = require('fs');

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
} catch {}

const TS_HOST = 'https://www.trec.texas.gov/ts';
const TS_KEY = 'HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd';
const TARGET_LEADS = 500;
const args = process.argv.slice(2);
const INCLUDE_BROKERS = args.includes('--include-brokers');
const MAX_PER_BROKERAGE = Number((args.find(a => a.startsWith('--max-per-brokerage=')) || '').split('=')[1]) || 250;

const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v2.csv');
const LOG_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v2.log');

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
};

// ─── SA brokerage seeds ──────────────────────────────────────────────────────
// Each entry: { name, licenseQuery (organizationName search term), emailDomain,
//   emailPattern: 'first.last' | 'firstinitiallast' | 'first' | null,
//   brokerageDisplay (canonical name to write to CSV) }
//
// The license number is resolved at runtime by querying organizationName.
// Where multiple TREC entries match the same brand (KW has many SA market
// centers), each is its own seed.
// Each seed has either:
//   - brokerLicense (explicit override — skips org-name resolution), OR
//   - orgQuery (fuzzy name search, with optional containsRequired filter)
//
// brokerLicense overrides are determined empirically by manually finding the
// SA-anchored broker company in the TREC search and capturing its customId.
// This avoids the statewide-franchise contamination problem (KW LLC umbrella,
// eXp Realty statewide, Compass statewide, etc.).
const BROKERAGE_SEEDS = [
  // ── SA-anchored independent brokerages (explicit license overrides) ──
  { brand: 'Phyllis Browning Company', brokerLicense: '400203-BB',
    emailDomain: 'phyllisbrowning.com', emailPattern: 'first',
    brokerageDisplay: 'Phyllis Browning Company' },
  { brand: 'JBGoodwin REALTORS', brokerLicense: null, orgQuery: 'JBGoodwin', containsRequired: 'jbgoodwin',
    emailDomain: 'jbgoodwin.com', emailPattern: 'first.last',
    brokerageDisplay: 'JBGoodwin REALTORS' },
  { brand: "Kuper Sotheby's International Realty", brokerLicense: null, orgQuery: 'Kuper Sotheby', containsRequired: 'kuper',
    emailDomain: 'kupersir.com', emailPattern: 'first.last',
    brokerageDisplay: "Kuper Sotheby's International Realty" },
  { brand: "Coldwell Banker D'Ann Harper", brokerLicense: '416239-BB',
    emailDomain: 'cbharper.com', emailPattern: 'first.last',
    brokerageDisplay: "Coldwell Banker D'Ann Harper, REALTORS" },
  { brand: "Levi Rodgers Real Estate Group", brokerLicense: '9004960-BB',
    emailDomain: 'lrreg.com', emailPattern: 'first.last',
    brokerageDisplay: 'Levi Rodgers Real Estate Group' },
  { brand: 'BHHS Don Johnson REALTORS', brokerLicense: '274139-BB',
    emailDomain: 'donjohnsonrealtors.com', emailPattern: 'first.last',
    brokerageDisplay: 'Berkshire Hathaway HomeServices Don Johnson REALTORS' },
  { brand: 'San Antonio Elite Realty', brokerLicense: null, orgQuery: 'San Antonio Elite Realty', containsRequired: 'san antonio elite',
    emailDomain: 'saeliterealty.com', emailPattern: 'first.last',
    brokerageDisplay: 'San Antonio Elite Realty, LLC' },
  { brand: 'San Antonio Legacy Group', brokerLicense: '504634-BB',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'San Antonio Legacy Group, LLC' },
  { brand: 'San Antonio Home Realtors', brokerLicense: '535853-BB',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'San Antonio Home Realtors LLC' },
  { brand: 'KW San Antonio Region (Willis)', brokerLicense: '547594-BB',
    emailDomain: 'kw.com', emailPattern: 'first.last',
    brokerageDisplay: 'KW SA Region (Boerne, CityView, Dominion, Kerrville, Bandera, Fredericksburg)' },
  { brand: 'KW Heritage SA', brokerLicense: '434367-BB',
    emailDomain: 'kw.com', emailPattern: 'first.last',
    brokerageDisplay: 'KW Heritage (SA Hill Country, Canyon Lake, New Braunfels)' },
  { brand: 'Northwest Real Estate of San Antonio', brokerLicense: '572472-BB',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Northwest Real Estate of San Antonio, LLC' },
  { brand: 'The San Antonio Real Estate Company', brokerLicense: '9007410-BB',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'The San Antonio Real Estate Company LLC' },
  { brand: 'Exquisite Properties', brokerLicense: null, orgQuery: 'Exquisite Properties', containsRequired: 'exquisite',
    emailDomain: 'exquisitepropertiestx.com', emailPattern: 'first.last',
    brokerageDisplay: 'Exquisite Properties, LLC' },
  // Bramlett Real Estate — Austin HQ, dropped from SA scrape.
  { brand: 'Reliance Residential Realty', brokerLicense: null, orgQuery: 'Reliance Residential', containsRequired: 'reliance',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Reliance Residential Realty' },
  { brand: 'Anders Realty', brokerLicense: null, orgQuery: 'Anders Realty', containsRequired: 'anders realty',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Anders Realty' },
  { brand: 'Trinity Real Estate Texas', brokerLicense: null, orgQuery: 'Trinity Real Estate', containsRequired: 'trinity real estate',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Trinity Real Estate' },
  { brand: 'Centennial Real Estate', brokerLicense: null, orgQuery: 'Centennial Real Estate', containsRequired: 'centennial',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Centennial Real Estate' },
  { brand: 'MileStar Real Estate', brokerLicense: null, orgQuery: 'MileStar', containsRequired: 'milestar',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'MileStar Real Estate' },
  { brand: 'Pinnacle Realty Advisors', brokerLicense: null, orgQuery: 'Pinnacle Realty', containsRequired: 'pinnacle',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Pinnacle Realty Advisors' },
  { brand: 'Texas Premier Realty', brokerLicense: '9014663-BB',
    emailDomain: 'texaspremierrealty.com', emailPattern: 'first.last',
    brokerageDisplay: 'Texas Premier Realty LLC' },
  { brand: 'Foundation Real Estate', brokerLicense: null, orgQuery: 'Foundation Real Estate', containsRequired: 'foundation',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Foundation Real Estate' },
  // JPAR / JP Piccinini is statewide — drop unless we can isolate SA office.
  // { brand: 'JPAR San Antonio', ... }
  { brand: 'Real Estate Brokers of San Antonio', brokerLicense: null, orgQuery: 'Real Estate Brokers of San Antonio', containsRequired: 'real estate brokers',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Real Estate Brokers of San Antonio' },
  { brand: 'Vortex Realty', brokerLicense: null, orgQuery: 'Vortex Realty', containsRequired: 'vortex',
    emailDomain: 'vortexrealty.com', emailPattern: 'first',
    brokerageDisplay: 'Vortex Realty' },
];

// SA-area zip codes — used when we report sa_zip column.
const SA_ZIPS_PRIMARY = '78201';  // default unknown SA zip

// ─── Typesense fetch helper ──────────────────────────────────────────────────
async function ts(path, params) {
  const u = new URL(TS_HOST + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { headers: { 'x-typesense-api-key': TS_KEY } });
      if (!r.ok) {
        log(`  Typesense ${r.status} on ${path} ${JSON.stringify(params)}`);
        await new Promise(res => setTimeout(res, 1500));
        continue;
      }
      return await r.json();
    } catch (e) {
      log(`  Typesense fetch err: ${e.message}`);
      await new Promise(res => setTimeout(res, 1500));
    }
  }
  return null;
}

// ─── Resolve broker license numbers from organizationName ────────────────────
async function resolveBrokerLicenses(seed) {
  // Explicit override — single broker
  if (seed.brokerLicense) {
    return [{ license: seed.brokerLicense, org: seed.brokerageDisplay }];
  }
  const out = [];
  const res = await ts('/collections/licenses/documents/search', {
    q: seed.orgQuery,
    query_by: 'organizationName,dbas',
    filter_by: 'type.subType:Broker Company && status.value:Active',
    per_page: 50,
    page: 1,
  });
  if (!res) return out;
  const needle = (seed.containsRequired || seed.orgQuery).toLowerCase();
  for (const h of res.hits || []) {
    const d = h.document;
    const hay = ((d.organizationName || '') + ' ' + (d.dbas || []).join(' ')).toLowerCase();
    if (!hay.includes(needle)) continue;
    out.push({ license: d.customId, org: d.organizationName });
  }
  return out;
}

// ─── Enumerate sales agents under a broker license ───────────────────────────
async function fetchAgentsForBroker(brokerLicense, seed) {
  const agents = [];
  let page = 1;
  while (page <= 25 && agents.length < MAX_PER_BROKERAGE) {
    const filter = INCLUDE_BROKERS
      ? '(type.subType:Salesperson || type.subType:Broker Individual) && status.value:Active'
      : 'type.subType:Salesperson && status.value:Active';
    const res = await ts('/collections/licenses/documents/search', {
      q: brokerLicense,
      query_by: 'sponsoringData.sponsorLicenseNumber',
      filter_by: filter,
      per_page: 100,
      page,
    });
    if (!res || !(res.hits || []).length) break;
    for (const h of res.hits) {
      const d = h.document;
      // Confirm the sponsor link is the right one (Typesense fuzzy match)
      const matched = (d.sponsoringData || []).some(s => s.sponsorLicenseNumber === brokerLicense);
      if (!matched) continue;
      agents.push({
        license: d.customId,
        firstName: d.firstName || '',
        middleName: d.middleName || '',
        lastName: d.lastName || '',
        organizationName: d.organizationName || '',
        type: d.type ? d.type.subType : '',
        sponsorLicense: brokerLicense,
        brokerageDisplay: seed.brokerageDisplay,
        emailDomain: seed.emailDomain,
        emailPattern: seed.emailPattern,
      });
    }
    if (res.hits.length < 100) break;
    page++;
  }
  return agents;
}

// ─── Email pattern guess ─────────────────────────────────────────────────────
function slugifyName(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function guessEmail(first, last, domain, pattern) {
  if (!domain || !pattern) return '';
  const f = slugifyName(first), l = slugifyName(last);
  if (!f || !l) return '';
  switch (pattern) {
    case 'first.last': return `${f}.${l}@${domain}`;
    case 'firstinitiallast': return `${f[0]}${l}@${domain}`;
    case 'first': return `${f}@${domain}`;
    default: return '';
  }
}

// ─── Output ──────────────────────────────────────────────────────────────────
function csvEsc(v) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }

function writeRows(rows) {
  const headers = 'name,brokerage,email,phone,license_id,linkedin_url,source,scrape_ts,sa_zip,role_type';
  const lines = [headers];
  const now = new Date().toISOString();
  for (const r of rows) {
    lines.push([
      csvEsc(r.name), csvEsc(r.brokerage), csvEsc(r.email), csvEsc(r.phone || ''),
      csvEsc(r.license_id), csvEsc(r.linkedin_url || ''), csvEsc(r.source),
      csvEsc(now), csvEsc(r.sa_zip || ''), csvEsc(r.role_type),
    ].join(','));
  }
  fs.writeFileSync(CSV_FILE, lines.join('\n'), 'utf8');
}

async function sendTelegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID || '7874782923';
  if (!tok) { log('No TELEGRAM_BOT_TOKEN, skipping ping'); return; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    log(`Telegram ping ${r.status}`);
  } catch (e) {
    log(`Telegram failed: ${e.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LOG_FILE, `=== TREC SA scrape — ${new Date().toISOString()} ===\n`, 'utf8');
  log(`SA REALTOR scraper (TREC mode), include_brokers=${INCLUDE_BROKERS}, max_per_brokerage=${MAX_PER_BROKERAGE}`);
  log(`Seeded ${BROKERAGE_SEEDS.length} brokerages to enumerate`);

  const allAgents = new Map();  // dedupe by license number
  const brokerageCounts = {};
  let totalLicensesSeen = 0;

  for (const seed of BROKERAGE_SEEDS) {
    log(`--- ${seed.brand} (query: "${seed.orgQuery}") ---`);
    const brokers = await resolveBrokerLicenses(seed);
    log(`  resolved ${brokers.length} broker licenses`);
    brokerageCounts[seed.brand] = { brokers: brokers.length, agents: 0 };
    for (const b of brokers) {
      const agents = await fetchAgentsForBroker(b.license, seed);
      log(`    ${b.org} (${b.license}): ${agents.length} agents`);
      for (const a of agents) {
        totalLicensesSeen++;
        if (allAgents.has(a.license)) continue;
        allAgents.set(a.license, a);
        brokerageCounts[seed.brand].agents++;
      }
    }
    log(`  cumulative unique agents: ${allAgents.size}`);
  }

  log(`Total agent records seen across brokerages: ${totalLicensesSeen}`);
  log(`Unique agents (deduped by license): ${allAgents.size}`);

  // Build CSV rows with email guesses
  const rows = [];
  let emailGuessable = 0;
  for (const a of allAgents.values()) {
    const fullName = [a.firstName, a.middleName, a.lastName].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const properName = [
      capitalize(a.firstName), capitalize(a.middleName), capitalize(a.lastName),
    ].filter(Boolean).join(' ');
    const guessedEmail = guessEmail(a.firstName, a.lastName, a.emailDomain, a.emailPattern);
    if (guessedEmail) emailGuessable++;
    rows.push({
      name: properName,
      brokerage: a.brokerageDisplay,
      email: guessedEmail,
      phone: '',
      license_id: a.license,
      linkedin_url: '',
      source: guessedEmail ? 'trec+pattern_guess' : 'trec',
      sa_zip: '',
      role_type: a.type === 'Salesperson' ? 'solo_agent' : (a.type || 'unknown'),
    });
  }

  writeRows(rows);
  log(`CSV written: ${CSV_FILE} (${rows.length} unique solo agents)`);
  log(`Email guesses applied: ${emailGuessable} (${rows.length ? Math.round(100*emailGuessable/rows.length) : 0}%)`);

  // Per-brokerage summary
  for (const [brand, c] of Object.entries(brokerageCounts)) {
    log(`  ${brand}: ${c.brokers} broker(s), ${c.agents} unique agents`);
  }

  const summary = `SA REALTOR TREC scrape: ${rows.length} unique solo agents, ${emailGuessable} email-guessable (${rows.length ? Math.round(100*emailGuessable/rows.length) : 0}%). CSV: data/sa-realtor-leads-v2.csv`;
  log(summary);
  await sendTelegram(summary);
}

function capitalize(s) {
  if (!s) return '';
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

main().catch(err => {
  log(`FATAL: ${err.message}\n${err.stack || ''}`);
  process.exit(1);
});
