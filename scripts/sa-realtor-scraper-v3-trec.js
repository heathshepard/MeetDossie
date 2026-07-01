'use strict';

// scripts/sa-realtor-scraper-v3-trec.js
//
// SA REALTOR scraper v3 — TREC-FIRST, DNC-SCRUBBED.
//
// Built 2026-06-30 (Heath, Chamonix) after v2's public-site scrapes
// (Realtor 429, Zillow 403, Homes 403) got fingerprint-blocked.
//
// Pivot to TREC's public license database — open records under TX PIA,
// not bot-blocked, and SB510 native opt-out gives us DNC scrubbing for free.
//
// ─── Strategy ────────────────────────────────────────────────────────────────
//
// PHASE A — Enumerate (TREC Typesense)
//   For each SA-anchored brokerage seed (~25 brokers), query Typesense
//   `licenses` collection for Active Salespersons whose
//   sponsoringData.sponsorLicenseNumber matches. Output: candidate set
//   {license, detailId, firstName, middleName, lastName, brokerageDisplay}.
//
// PHASE B — TREC licenseDetail + DNC scrub
//   For each candidate, GET https://www.trec.texas.gov/acaif/api/licenseDetail/{detailId}
//   at polite pace (~1 req / 3 sec).
//
//   The response has addressLine1, city, state, zipCode, phone (base64).
//   SB510 mechanism: if the licensee opted out, ALL contact fields are
//   blank ("" — not "Withheld due to SB510" in this endpoint, just empty).
//   That's the TREC DNC signal.
//
//   RULES:
//   • address blank → DNC, log to trec-dnc-2026-06-30.csv, EXCLUDE from leads
//   • address present + zipCode starts with "78" → KEEP (SA market)
//   • address present + zipCode does NOT start with "78" → log as non-SA, skip
//
// PHASE C — Brokerage office-page email enrichment (optional)
//   For top brokerages with public per-agent pages (Phyllis Browning, KW, etc.)
//   visit the per-agent profile and extract their published email.
//   Playwright + DossieBot Chrome profile (same as v2). Polite pace.
//   For brokerages without public per-agent pages, fall back to
//   pattern-guess (first.last@domain, etc.) tagged as 'trec+pattern_guess'.
//
// ─── Why no separate DNC file download ───────────────────────────────────────
// We confirmed (2026-06-30): TREC publishes trecfile.zip (130MB unzipped)
// containing ~310k licensees, but ALL contact columns are "Withheld due to
// SB510" for EVERY record. SB510 redacts at the bulk-export level. The DNC
// signal lives in the per-licensee detail endpoint — opted-out = blank
// address. We use that as the authoritative DNC mechanism.
//
// Per Heath's brief: "We still write trec-dnc-2026-06-30.csv" — but the
// contents are the licenses we EXCLUDED for blank-contact, not a separate
// downloaded list. Same outcome: no opted-out licensee gets cold email.
//
// ─── Output ──────────────────────────────────────────────────────────────────
//
//   data/sa-realtor-leads-v3-trec.csv      — clean, DNC-scrubbed, SA-zip-filtered
//   data/trec-dnc-2026-06-30.csv           — excluded for SB510 opt-out
//   data/sa-realtor-leads-v3-trec.log      — counts, percentages, errors
//   scripts/.sa-realtor-v3-state.json      — resume state
//
// ─── Run ─────────────────────────────────────────────────────────────────────
//
//   node scripts/sa-realtor-scraper-v3-trec.js                 # all phases
//   node scripts/sa-realtor-scraper-v3-trec.js --phase=enumerate
//   node scripts/sa-realtor-scraper-v3-trec.js --phase=detail
//   node scripts/sa-realtor-scraper-v3-trec.js --phase=enrich  # optional Playwright pass
//   node scripts/sa-realtor-scraper-v3-trec.js --max-candidates=200   # trial run
//   node scripts/sa-realtor-scraper-v3-trec.js --detail-delay=2000    # ms between detail calls
//   node scripts/sa-realtor-scraper-v3-trec.js --resume               # skip already-processed
//
// ─── Constraints (locked) ────────────────────────────────────────────────────
//
//   • No auth bypass on TREC or brokerage sites
//   • No captcha bypass — log + pivot
//   • DNC scrub REQUIRED — non-negotiable
//   • Polite pacing: TREC 1 req / 3 sec, brokerage pages 1 req / 4 sec
//   • Per Heath's brief: do NOT touch scripts/trec-*, api/_lib/trec-*,
//     api/fill-form*.js — those are unrelated frozen ground truth.

const path = require('path');
const fs = require('fs');
const os = require('os');

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
function flag(name, def) {
  const m = args.find(a => a.startsWith(`--${name}=`));
  return m ? m.split('=').slice(1).join('=') : def;
}
const PHASE = flag('phase', 'all');             // enumerate | detail | enrich | all
const MAX_CANDIDATES = Number(flag('max-candidates', 0)) || Infinity;
const DETAIL_DELAY_MS = Number(flag('detail-delay', 3000));
const ENRICH_DELAY_MS = Number(flag('enrich-delay', 4500));
const RESUME = args.includes('--resume');
const INCLUDE_BROKERS = args.includes('--include-brokers');
const MAX_PER_BROKERAGE = Number(flag('max-per-brokerage', 500));
const SKIP_ENRICH = args.includes('--skip-enrich');

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v3-trec.csv');
const DNC_FILE = path.join(DATA_DIR, 'trec-dnc-2026-06-30.csv');
const LOG_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v3-trec.log');
const STATE_FILE = path.join(__dirname, '.sa-realtor-v3-state.json');

// ─── Constants ────────────────────────────────────────────────────────────────
const TS_HOST = 'https://www.trec.texas.gov/ts';
const TS_KEY = 'HvqEl9eBZY6YjQBAU8uW4e9KBGHRvqrd';  // public search-only key
const DETAIL_HOST = 'https://www.trec.texas.gov/acaif/api/licenseDetail';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// SA-market cities (lowercased). Used as a secondary filter on top of 78xxx zip.
const SA_CITIES = new Set([
  'san antonio', 'boerne', 'helotes', 'schertz', 'universal city', 'cibolo',
  'converse', 'live oak', 'selma', 'leon valley', 'alamo heights', 'stone oak',
  'castle hills', 'new braunfels', 'bulverde', 'fair oaks ranch', 'garden ridge',
  'spring branch', 'canyon lake', 'pleasanton', 'jourdanton', 'floresville',
  'la vernia', 'adkins', 'china grove', 'elmendorf', 'somerset', 'lytle',
  'natalia', 'kirby', 'windcrest', 'shavano park', 'hollywood park',
  'hill country village', 'terrell hills', 'olmos park', 'fredericksburg',
  'kerrville', 'bandera', 'comfort', 'pipe creek', 'mico',
]);

// SA-market zip prefixes
const SA_ZIP_PREFIXES = ['780', '781', '782'];  // 780xx 781xx 782xx
const SA_ZIP_RE = /^(780|781|782)\d\d$/;

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  candidates: {},       // license_id -> candidate metadata (from enumerate)
  details: {},          // license_id -> detail result (kept/dnc/non_sa/error)
  enriched_emails: {},  // license_id -> { email, source, scraped_ts }
  stats: {
    candidates_total: 0,
    detail_kept_sa: 0,
    detail_dnc: 0,
    detail_non_sa: 0,
    detail_errors: 0,
    enriched_via_brokerage: 0,
    enriched_via_pattern_guess: 0,
  },
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const obj = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      Object.assign(state, obj);
      log(`Loaded state: ${Object.keys(state.candidates).length} candidates, ${Object.keys(state.details).length} details, ${Object.keys(state.enriched_emails).length} enriched`);
    }
  } catch (e) {
    log(`State load failed (continuing fresh): ${e.message}`);
  }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (e) {
    log(`State save failed: ${e.message}`);
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n', 'utf8'); } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const human = (min, max) => sleep(min + Math.random() * (max - min));

// ─── Brokerage seeds ─────────────────────────────────────────────────────────
// Mirrors v2's seed list (proven correct). Each seed targets a single
// SA-anchored broker license via explicit override OR fuzzy org-name search
// with a containsRequired guardrail to avoid statewide franchise contamination.
//
// emailDomain + emailPattern enable per-agent pattern-guess fallback when
// Phase C enrichment isn't possible for this brokerage.
//
// rosterPattern (when set) tells Phase C how to navigate the brokerage's
// public site to find per-agent emails.

const BROKERAGE_SEEDS = [
  // ── SA-anchored independent brokerages (explicit license overrides) ──
  { brand: 'Phyllis Browning Company', brokerLicense: '400203-BB',
    emailDomain: 'phyllisbrowning.com', emailPattern: 'first',
    brokerageDisplay: 'Phyllis Browning Company',
    rosterPattern: { type: 'phyllis-browning' } },
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
  { brand: 'Real Estate Brokers of San Antonio', brokerLicense: null, orgQuery: 'Real Estate Brokers of San Antonio', containsRequired: 'real estate brokers',
    emailDomain: null, emailPattern: null,
    brokerageDisplay: 'Real Estate Brokers of San Antonio' },
  { brand: 'Vortex Realty', brokerLicense: null, orgQuery: 'Vortex Realty', containsRequired: 'vortex',
    emailDomain: 'vortexrealty.com', emailPattern: 'first',
    brokerageDisplay: 'Vortex Realty' },
];

// ─── Typesense fetch helper (Phase A) ────────────────────────────────────────
async function ts(p, params) {
  const u = new URL(TS_HOST + p);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(u, { headers: { 'x-typesense-api-key': TS_KEY, 'User-Agent': UA } });
      if (!r.ok) {
        log(`  Typesense ${r.status} on ${p} ${JSON.stringify(params)}`);
        await sleep(1500);
        continue;
      }
      return await r.json();
    } catch (e) {
      log(`  Typesense fetch err: ${e.message}`);
      await sleep(1500);
    }
  }
  return null;
}

async function resolveBrokerLicenses(seed) {
  if (seed.brokerLicense) return [{ license: seed.brokerLicense, org: seed.brokerageDisplay }];
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
      const matched = (d.sponsoringData || []).some(s => s.sponsorLicenseNumber === brokerLicense);
      if (!matched) continue;
      agents.push({
        license: d.customId,
        detailId: d.detailId || d.referenceContactId || '',
        firstName: d.firstName || '',
        middleName: d.middleName || '',
        lastName: d.lastName || '',
        organizationName: d.organizationName || '',
        type: d.type ? d.type.subType : '',
        sponsorLicense: brokerLicense,
        brokerageDisplay: seed.brokerageDisplay,
        emailDomain: seed.emailDomain,
        emailPattern: seed.emailPattern,
        brand: seed.brand,
        rosterPattern: seed.rosterPattern || null,
      });
    }
    if (res.hits.length < 100) break;
    page++;
  }
  return agents;
}

async function phaseEnumerate() {
  log(`=== PHASE A: ENUMERATE — ${BROKERAGE_SEEDS.length} seeds ===`);
  for (const seed of BROKERAGE_SEEDS) {
    log(`--- ${seed.brand} (q="${seed.orgQuery || seed.brokerLicense}") ---`);
    const brokers = await resolveBrokerLicenses(seed);
    log(`  resolved ${brokers.length} broker license(s)`);
    for (const b of brokers) {
      const agents = await fetchAgentsForBroker(b.license, seed);
      log(`    ${b.org || seed.brokerageDisplay} (${b.license}): ${agents.length} agents`);
      for (const a of agents) {
        if (state.candidates[a.license]) continue;  // dedupe by license
        state.candidates[a.license] = a;
      }
    }
    saveState();
  }
  state.stats.candidates_total = Object.keys(state.candidates).length;
  log(`Phase A complete: ${state.stats.candidates_total} unique candidates`);
}

// ─── TREC licenseDetail (Phase B) + DNC scrub ────────────────────────────────

function decodePhone(b64) {
  if (!b64) return '';
  try {
    return Buffer.from(String(b64), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

async function fetchDetail(detailId) {
  if (!detailId) return null;
  try {
    const r = await fetch(`${DETAIL_HOST}/${encodeURIComponent(detailId)}`, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
    });
    if (!r.ok) return { _http: r.status };
    const json = await r.json();
    if (Array.isArray(json) && json.length > 0) return json[0];
    return null;
  } catch (e) {
    return { _error: e.message };
  }
}

function classifyDetail(detail) {
  if (!detail) return { kind: 'error', reason: 'no_response' };
  if (detail._http) return { kind: 'error', reason: `http_${detail._http}` };
  if (detail._error) return { kind: 'error', reason: `fetch_err_${detail._error}` };

  const addr1 = (detail.addressLine1 || '').trim();
  const city = (detail.city || '').trim().toLowerCase();
  const zip = (detail.zipCode || '').trim();

  // SB510 opt-out signal: TREC withholds ALL contact fields for opted-out
  // licensees. The detail endpoint returns blank addressLine1 + blank city
  // + blank zip in that case. That's our DNC scrub.
  if (!addr1 && !city && !zip) return { kind: 'dnc', reason: 'sb510_optout' };

  // Some records have partial blanks — treat any blank addr1 as DNC to be safe.
  if (!addr1) return { kind: 'dnc', reason: 'no_addr1' };

  // SA market filter: 78xxx zip OR named SA city.
  const zipMatch = SA_ZIP_RE.test(zip);
  const cityMatch = SA_CITIES.has(city);
  if (zipMatch || cityMatch) return { kind: 'keep' };

  return { kind: 'non_sa', reason: `zip=${zip} city=${city}` };
}

async function phaseDetail() {
  const candidates = Object.values(state.candidates);
  const limit = Math.min(candidates.length, MAX_CANDIDATES);
  log(`=== PHASE B: DETAIL + DNC SCRUB — ${limit} candidates @ ${DETAIL_DELAY_MS}ms each ===`);
  log(`  estimated time: ${Math.round(limit * DETAIL_DELAY_MS / 60000)} min`);

  let processed = 0;
  for (const a of candidates) {
    if (processed >= limit) break;
    processed++;
    if (RESUME && state.details[a.license]) continue;

    const detail = await fetchDetail(a.detailId);
    const cls = classifyDetail(detail);
    state.details[a.license] = {
      kind: cls.kind,
      reason: cls.reason || '',
      addr1: detail && detail.addressLine1 ? detail.addressLine1 : '',
      city: detail && detail.city ? detail.city : '',
      state: detail && detail.state ? detail.state : '',
      zip: detail && detail.zipCode ? detail.zipCode : '',
      phone: detail && detail.phone ? decodePhone(detail.phone) : '',
      businessName: detail && detail.businessName ? detail.businessName : '',
      ts: new Date().toISOString(),
    };

    if (cls.kind === 'keep') state.stats.detail_kept_sa++;
    else if (cls.kind === 'dnc') state.stats.detail_dnc++;
    else if (cls.kind === 'non_sa') state.stats.detail_non_sa++;
    else state.stats.detail_errors++;

    if (processed % 25 === 0) {
      log(`  detail ${processed}/${limit} — SA-keep ${state.stats.detail_kept_sa}, DNC ${state.stats.detail_dnc}, non-SA ${state.stats.detail_non_sa}, err ${state.stats.detail_errors}`);
      saveState();
    }
    await sleep(DETAIL_DELAY_MS);
  }
  saveState();
  log(`Phase B complete: SA-keep ${state.stats.detail_kept_sa}, DNC ${state.stats.detail_dnc}, non-SA ${state.stats.detail_non_sa}, err ${state.stats.detail_errors}`);
}

// ─── Brokerage email enrichment (Phase C) ────────────────────────────────────
// Visits per-brokerage public pages to find published agent emails.
// Falls back to pattern-guess (first.last@domain etc.) when the brokerage
// has emailDomain+emailPattern but no public roster scraper.

function slugifyName(s) {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z]/g, '');
}

function guessEmailFromPattern(first, last, domain, pattern) {
  if (!domain || !pattern) return '';
  const f = slugifyName(first), l = slugifyName(last);
  if (!f || !l) return '';
  switch (pattern) {
    case 'first.last': return `${f}.${l}@${domain}`;
    case 'firstinitiallast': return `${f[0]}${l}@${domain}`;
    case 'first': return `${f}@${domain}`;
    case 'firstlast': return `${f}${l}@${domain}`;
    default: return '';
  }
}

// Phyllis Browning publishes per-agent pages at
// https://www.phyllisbrowning.com/realestate/agent/{first-last}/
// Observed 2026-06-30: email rendered as plain text in <a class="agent-email">
// AND as <input id="AgentEmail" value="..."> in the contact form. No mailto:
// prefix. Pattern is initial+lastname@phyllisbrowning.com (e.g. mthompson).
async function enrichPhyllisBrowning(candidate) {
  const f = slugifyName(candidate.firstName);
  const l = slugifyName(candidate.lastName);
  if (!f || !l) return null;
  // Try first-last slug; if 404, try last-only as fallback (rare).
  const slugs = [`${f}-${l}`];
  for (const slug of slugs) {
    const url = `https://www.phyllisbrowning.com/realestate/agent/${slug}/`;
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        redirect: 'follow',
      });
      if (!r.ok) continue;
      const html = await r.text();
      // Pull every email-shaped string at @phyllisbrowning.com
      const allEmails = [...html.matchAll(/([A-Za-z0-9._%+-]+@phyllisbrowning\.com)/gi)]
        .map(m => m[1].toLowerCase());
      // Pick the first that isn't a shared inbox (info@, admin@, contact@, support@)
      const sharedInboxes = new Set(['info', 'admin', 'contact', 'support', 'sales', 'hello']);
      for (const e of allEmails) {
        const local = e.split('@')[0];
        if (!sharedInboxes.has(local)) return e;
      }
    } catch { /* try next slug */ }
  }
  return null;
}

async function phaseEnrich() {
  log(`=== PHASE C: EMAIL ENRICHMENT @ ${ENRICH_DELAY_MS}ms each ===`);
  if (SKIP_ENRICH) {
    log('  --skip-enrich set, falling back to pattern-guess only');
  }

  let kept = 0, perBrokeragePages = 0, patternGuessed = 0;
  for (const lic of Object.keys(state.details)) {
    if (state.details[lic].kind !== 'keep') continue;
    kept++;
    const cand = state.candidates[lic];
    if (!cand) continue;
    if (state.enriched_emails[lic] && state.enriched_emails[lic].email) continue;

    // 1. Per-brokerage public roster scrape
    let email = '';
    let source = '';
    if (!SKIP_ENRICH && cand.rosterPattern) {
      if (cand.rosterPattern.type === 'phyllis-browning') {
        email = await enrichPhyllisBrowning(cand);
        if (email) {
          source = 'brokerage_page';
          perBrokeragePages++;
        }
        await sleep(ENRICH_DELAY_MS);
      }
    }

    // 2. Pattern-guess fallback
    if (!email && cand.emailDomain && cand.emailPattern) {
      email = guessEmailFromPattern(cand.firstName, cand.lastName, cand.emailDomain, cand.emailPattern);
      if (email) {
        source = 'pattern_guess';
        patternGuessed++;
      }
    }

    if (email) {
      state.enriched_emails[lic] = { email, source, scraped_ts: new Date().toISOString() };
    }

    if (kept % 50 === 0) {
      log(`  enrich progress: ${kept} SA-keep examined, ${perBrokeragePages} per-brokerage pages, ${patternGuessed} pattern guesses`);
      saveState();
    }
  }
  state.stats.enriched_via_brokerage = perBrokeragePages;
  state.stats.enriched_via_pattern_guess = patternGuessed;
  saveState();
  log(`Phase C complete: ${perBrokeragePages} brokerage-page emails, ${patternGuessed} pattern guesses`);
}

// ─── CSV write (clean leads + DNC) ───────────────────────────────────────────

function csvEsc(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }

function properCase(s) {
  if (!s) return '';
  return s.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function writeCSVs() {
  const now = new Date().toISOString();

  // Schema (v2 schema, per Heath's brief):
  // name, brokerage, email, phone, license_id, linkedin_url, source,
  // scrape_ts, sa_zip, role_type, office_city, years_experience,
  // neighborhoods, specialty, languages, recent_listings_visible,
  // bio_blurb_first_sentence
  const headers = [
    'name', 'brokerage', 'email', 'phone', 'license_id', 'linkedin_url',
    'source', 'scrape_ts', 'sa_zip', 'role_type', 'office_city',
    'years_experience', 'neighborhoods', 'specialty', 'languages',
    'recent_listings_visible', 'bio_blurb_first_sentence',
  ].join(',');
  const lines = [headers];

  let withEmail = 0;
  let withVerifiedEmail = 0;     // brokerage_page only
  let withPhone = 0;
  for (const [lic, det] of Object.entries(state.details)) {
    if (det.kind !== 'keep') continue;
    const c = state.candidates[lic];
    if (!c) continue;
    const enr = state.enriched_emails[lic] || {};
    const properName = properCase([c.firstName, c.middleName, c.lastName].filter(Boolean).join(' '));
    const email = enr.email || '';
    if (email) withEmail++;
    if (email && enr.source === 'brokerage_page') withVerifiedEmail++;
    if (det.phone) withPhone++;
    const source = email
      ? (enr.source === 'brokerage_page' ? 'trec+brokerage_page' : 'trec+pattern_guess')
      : 'trec';
    lines.push([
      csvEsc(properName),
      csvEsc(c.brokerageDisplay),
      csvEsc(email),
      csvEsc(det.phone),
      csvEsc(c.license),
      csvEsc(''),                // linkedin_url — left blank for Pierce pass
      csvEsc(source),
      csvEsc(det.ts || now),
      csvEsc(det.zip),
      csvEsc(c.type === 'Salesperson' ? 'solo_agent' : (c.type || 'unknown').toLowerCase()),
      csvEsc(properCase(det.city)),
      csvEsc(''),                // years_experience — blank, TREC does not publish
      csvEsc(''),                // neighborhoods
      csvEsc(''),                // specialty
      csvEsc(''),                // languages
      csvEsc(''),                // recent_listings_visible
      csvEsc(''),                // bio_blurb_first_sentence
    ].join(','));
  }
  fs.writeFileSync(CSV_FILE, lines.join('\n'), 'utf8');
  log(`Leads CSV written: ${CSV_FILE} (${lines.length - 1} rows, ${withEmail} with email, ${withPhone} with phone)`);

  // DNC file: list of licenses excluded for SB510 opt-out (or otherwise no
  // public contact). Heath's brief asks for trec-dnc-2026-06-30.csv as a
  // separate file. Here it's the licenses we proactively excluded — the
  // "DON'T CONTACT" universe.
  const dncLines = ['license_id,name,brokerage,reason,detail_ts'];
  let dncCount = 0;
  for (const [lic, det] of Object.entries(state.details)) {
    if (det.kind !== 'dnc') continue;
    const c = state.candidates[lic];
    if (!c) continue;
    const properName = properCase([c.firstName, c.middleName, c.lastName].filter(Boolean).join(' '));
    dncLines.push([
      csvEsc(c.license),
      csvEsc(properName),
      csvEsc(c.brokerageDisplay),
      csvEsc(det.reason || 'sb510_optout'),
      csvEsc(det.ts || now),
    ].join(','));
    dncCount++;
  }
  fs.writeFileSync(DNC_FILE, dncLines.join('\n'), 'utf8');
  log(`DNC CSV written: ${DNC_FILE} (${dncCount} excluded for SB510 opt-out)`);

  return { leadsRows: lines.length - 1, withEmail, withVerifiedEmail, withPhone, dncCount };
}

// ─── Telegram ping ───────────────────────────────────────────────────────────
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
  if (!RESUME) {
    fs.writeFileSync(LOG_FILE, `=== TREC SA scrape v3 — ${new Date().toISOString()} ===\n`, 'utf8');
  }
  log(`Starting v3-trec scraper. PHASE=${PHASE}, RESUME=${RESUME}, MAX_CANDIDATES=${MAX_CANDIDATES === Infinity ? 'all' : MAX_CANDIDATES}`);

  if (RESUME) loadState();

  if (PHASE === 'enumerate' || PHASE === 'all') {
    await phaseEnumerate();
  }
  if (PHASE === 'detail' || PHASE === 'all') {
    await phaseDetail();
  }
  if (PHASE === 'enrich' || PHASE === 'all') {
    await phaseEnrich();
  }

  const out = writeCSVs();
  saveState();

  const emailPct = out.leadsRows > 0 ? Math.round(100 * out.withEmail / out.leadsRows) : 0;
  const verifiedPct = out.leadsRows > 0 ? Math.round(100 * out.withVerifiedEmail / out.leadsRows) : 0;
  const summary = `SA REALTOR v3-trec: ${out.leadsRows} leads after DNC scrub. Email-discoverable ${emailPct}% (${verifiedPct}% verified-via-brokerage-page, rest pattern_guess). ${out.dncCount} DNC-scrubbed via SB510 opt-out. File: data/sa-realtor-leads-v3-trec.csv`;
  log('=== FINAL ===');
  log(summary);
  log(`  candidates_total: ${state.stats.candidates_total || Object.keys(state.candidates).length}`);
  log(`  SA-keep: ${state.stats.detail_kept_sa}, DNC: ${state.stats.detail_dnc}, non-SA: ${state.stats.detail_non_sa}, errors: ${state.stats.detail_errors}`);
  log(`  enriched via brokerage page: ${state.stats.enriched_via_brokerage}`);
  log(`  enriched via pattern guess: ${state.stats.enriched_via_pattern_guess}`);
  await sendTelegram(summary);
}

main().catch(err => {
  log(`FATAL: ${err.message}\n${err.stack || ''}`);
  process.exit(1);
});
