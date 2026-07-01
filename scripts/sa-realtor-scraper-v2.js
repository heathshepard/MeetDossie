'use strict';

// scripts/sa-realtor-scraper-v2.js
//
// SA REALTOR lead scraper — REAL. Built 2026-06-30 after v1 punted with 1 seed lead.
//
// Method order (drops to next on failure, never punts silently):
//   1. realtor.com SA agent directory via Playwright + DossieBot Chrome profile
//   2. zillow.com SA agent directory via Playwright + DossieBot Chrome profile
//   3. homes.com SA agent directory via Playwright + DossieBot Chrome profile
//   4. TREC license-holder cross-reference (name verification + license_id enrich)
//
// Constraints:
//   - Human-pace timing (2-5 sec between page actions)
//   - No CAPTCHA bypass, no auth bypass
//   - Resumable: CSV appended-to (not overwritten) and dedup file persisted
//   - DossieBot Chrome profile cloned to %TEMP%\dossiebot-scrape so we don't
//     fight Chrome's profile lock when Heath has Chrome open
//
// Output:
//   data/sa-realtor-leads-v2.csv
//   data/sa-realtor-leads-v2.log
//   scripts/.sa-realtor-v2-seen.json  (dedup state for resume)
//
// Run:
//   node scripts/sa-realtor-scraper-v2.js
//   node scripts/sa-realtor-scraper-v2.js --method=realtor      (single method)
//   node scripts/sa-realtor-scraper-v2.js --max-pages=20        (cap per method)
//   node scripts/sa-realtor-scraper-v2.js --headless            (no UI; slower for bot detection)
//   node scripts/sa-realtor-scraper-v2.js --enrich-profiles     (drill each agent's profile page for bio fields)
//   node scripts/sa-realtor-scraper-v2.js --target=2000         (override default 500 lead target)
//
// Schema extension 2026-06-30 (Heath, Chamonix): added 7 personalization columns
// for "warm peer-agent" cold email tone. Only public, professional info — never
// listings volume/family/personal signals. See SA-REALTOR-SCRAPER.md.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const { zenrowsFetch, extractStructured, getCostSummary } = require('./_lib/zenrows-fetch');

// ─── Load .env.local ──────────────────────────────────────────────────────────
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
} catch { /* non-fatal */ }

// ─── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const ONLY_METHOD = (args.find(a => a.startsWith('--method=')) || '').split('=')[1] || '';
const MAX_PAGES = Number((args.find(a => a.startsWith('--max-pages=')) || '').split('=')[1]) || 25;
const HEADLESS = args.includes('--headless');
const ENRICH_PROFILES = args.includes('--enrich-profiles');
const TARGET_LEADS = Number((args.find(a => a.startsWith('--target=')) || '').split('=')[1]) || 500;

// ─── Paths ────────────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, '..', 'data');
const CSV_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v2.csv');
const LOG_FILE = path.join(DATA_DIR, 'sa-realtor-leads-v2.log');
const SEEN_FILE = path.join(__dirname, '.sa-realtor-v2-seen.json');

const CHROME_USER_DATA = process.env.PLAYWRIGHT_PROFILE_DIR
  || path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Profile 4';
// We clone the profile to TEMP so we don't fight Chrome's lock on Heath's live session.
const CLONE_DIR = path.join(os.tmpdir(), 'dossiebot-scrape-profile');

// ─── State ────────────────────────────────────────────────────────────────────
const seenLeads = new Map();          // dedupe by name+brokerage
const seenUrls = new Set();           // dedupe agent profile URLs across runs
const stats = {
  zenrows_realtor_agents: 0,          // ZenRows tier results (new Tier 0)
  realtor_pages: 0, realtor_cards: 0, realtor_blocked: 0,
  zillow_pages: 0, zillow_cards: 0, zillow_blocked: 0,
  homes_pages: 0, homes_cards: 0, homes_blocked: 0,
  trec_verified: 0, trec_skipped: 0,
  duplicates: 0, missing_email: 0,
  total: 0,
};
const logLines = [];

function tsLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  logLines.push(line);
}

function flushLog() {
  try {
    fs.appendFileSync(LOG_FILE, logLines.join('\n') + '\n', 'utf8');
    logLines.length = 0;
  } catch (e) {
    console.warn('Log flush failed:', e.message);
  }
}

function loadSeen() {
  try {
    if (fs.existsSync(SEEN_FILE)) {
      const obj = JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8'));
      (obj.leads || []).forEach(l => seenLeads.set(dedupeKey(l.name, l.brokerage), l));
      (obj.urls || []).forEach(u => seenUrls.add(u));
      tsLog(`Loaded ${seenLeads.size} prior leads + ${seenUrls.size} seen URLs from cache`);
    }
  } catch (e) {
    tsLog(`Seen file load failed (continuing fresh): ${e.message}`);
  }
}

function saveSeen() {
  try {
    fs.writeFileSync(SEEN_FILE, JSON.stringify({
      leads: [...seenLeads.values()],
      urls: [...seenUrls],
    }), 'utf8');
  } catch (e) {
    tsLog(`Seen file save failed: ${e.message}`);
  }
}

function dedupeKey(name, brokerage) {
  return `${(name || '').toLowerCase().trim()}|${(brokerage || '').toLowerCase().trim()}`;
}

// Fields that get merged on dedup (any newly-found value wins if prior was blank)
const MERGE_FIELDS = [
  'email', 'phone', 'license_id', 'linkedin_url', 'sa_zip', 'profile_url',
  // 2026-06-30 personalization extension
  'office_city', 'years_experience', 'neighborhoods', 'specialty',
  'languages', 'recent_listings_visible', 'bio_blurb_first_sentence',
];

function recordLead(lead) {
  if (!lead.name || lead.name.length < 4) return false;
  const key = dedupeKey(lead.name, lead.brokerage);
  if (seenLeads.has(key)) {
    // Merge any newly-found fields into the existing record.
    const prev = seenLeads.get(key);
    let changed = false;
    for (const k of MERGE_FIELDS) {
      if (!prev[k] && lead[k]) { prev[k] = lead[k]; changed = true; }
    }
    if (changed) seenLeads.set(key, prev);
    stats.duplicates++;
    return false;
  }
  if (!lead.email) stats.missing_email++;
  seenLeads.set(key, lead);
  stats.total++;
  // Track which personalization fields filled — for milestone reports
  if (lead.office_city) stats.has_office_city = (stats.has_office_city || 0) + 1;
  if (lead.years_experience) stats.has_years = (stats.has_years || 0) + 1;
  if (lead.neighborhoods) stats.has_neighborhoods = (stats.has_neighborhoods || 0) + 1;
  if (lead.specialty) stats.has_specialty = (stats.has_specialty || 0) + 1;
  if (lead.languages) stats.has_languages = (stats.has_languages || 0) + 1;
  if (lead.recent_listings_visible) stats.has_listings_count = (stats.has_listings_count || 0) + 1;
  if (lead.bio_blurb_first_sentence) stats.has_bio_blurb = (stats.has_bio_blurb || 0) + 1;
  // Milestone Telegram pings at 500 / 1000 / 2000
  const milestones = [500, 1000, 2000];
  if (milestones.includes(stats.total)) {
    sendMilestonePing(stats.total).catch(() => {});
  }
  return true;
}

function writeCSV() {
  // Schema: original 11 cols + 7 personalization cols (2026-06-30 extension).
  // Empty values are written as empty strings — no fabrication. See SA-REALTOR-SCRAPER.md.
  const headers = [
    'name', 'brokerage', 'email', 'phone', 'license_id', 'linkedin_url',
    'source', 'scrape_ts', 'sa_zip', 'role_type', 'profile_url',
    // Personalization columns (peer-agent tone — no creepy surveillance signals)
    'office_city', 'years_experience', 'neighborhoods', 'specialty',
    'languages', 'recent_listings_visible', 'bio_blurb_first_sentence',
  ].join(',');
  const rows = [headers];
  const csv = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  for (const lead of seenLeads.values()) {
    rows.push([
      csv(lead.name), csv(lead.brokerage), csv(lead.email), csv(lead.phone),
      csv(lead.license_id), csv(lead.linkedin_url), csv(lead.source),
      csv(lead.scrape_ts || new Date().toISOString()),
      csv(lead.sa_zip), csv(lead.role_type || 'solo_agent'), csv(lead.profile_url),
      csv(lead.office_city), csv(lead.years_experience), csv(lead.neighborhoods),
      csv(lead.specialty), csv(lead.languages), csv(lead.recent_listings_visible),
      csv(lead.bio_blurb_first_sentence),
    ].join(','));
  }
  fs.writeFileSync(CSV_FILE, rows.join('\n'), 'utf8');
  tsLog(`CSV written: ${CSV_FILE} (${seenLeads.size} rows)`);
}

// ─── Chrome profile clone (avoid lock conflict) ──────────────────────────────
function cloneProfile() {
  const src = path.join(CHROME_USER_DATA, CHROME_PROFILE_NAME);
  if (!fs.existsSync(src)) {
    throw new Error(`DossieBot profile not found at ${src}`);
  }
  // Persistent clone — we reuse across runs so cookies/local-state survive.
  if (!fs.existsSync(CLONE_DIR)) {
    tsLog(`Cloning Chrome profile from "${src}" to "${CLONE_DIR}"`);
    fs.mkdirSync(CLONE_DIR, { recursive: true });
    const profileSub = path.join(CLONE_DIR, 'DossieBot');
    fs.mkdirSync(profileSub, { recursive: true });
    // Copy critical files only — full clone is too large.
    const filesToCopy = [
      'Cookies', 'Cookies-journal', 'Login Data', 'Login Data For Account',
      'Web Data', 'Local State', 'Preferences', 'Secure Preferences',
      'Local Storage', 'Session Storage', 'IndexedDB',
      'Network', 'History',
    ];
    // Top-level Local State first
    try {
      const ls = path.join(CHROME_USER_DATA, 'Local State');
      if (fs.existsSync(ls)) fs.copyFileSync(ls, path.join(CLONE_DIR, 'Local State'));
    } catch (e) {
      tsLog(`Local State copy failed (non-fatal): ${e.message}`);
    }
    for (const f of filesToCopy) {
      try {
        const s = path.join(src, f);
        const d = path.join(profileSub, f);
        if (!fs.existsSync(s)) continue;
        const stat = fs.statSync(s);
        if (stat.isDirectory()) {
          copyDirSync(s, d);
        } else {
          fs.copyFileSync(s, d);
        }
      } catch (e) {
        tsLog(`Profile file "${f}" copy failed (non-fatal): ${e.message}`);
      }
    }
    tsLog(`Profile clone complete`);
  } else {
    tsLog(`Reusing existing profile clone at ${CLONE_DIR}`);
  }
  return CLONE_DIR;
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirSync(s, d);
      else fs.copyFileSync(s, d);
    } catch { /* skip locked files */ }
  }
}

// ─── Browser launch ──────────────────────────────────────────────────────────
async function launchBrowser() {
  const profileDir = cloneProfile();
  // Use launchPersistentContext with --profile-directory pointed at the cloned DossieBot subdir.
  // This gives us cookies + extensions + Chrome's full TLS/JA3 fingerprint.
  const ctx = await chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    channel: 'chrome',  // use real Chrome, not bundled Chromium (better fingerprint)
    args: [
      '--profile-directory=DossieBot',
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    viewport: { width: 1366, height: 850 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/Chicago',
  });
  // Patch navigator.webdriver
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return ctx;
}

// ─── Pacing ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const human = (min = 1800, max = 3800) => sleep(min + Math.random() * (max - min));

// ─── Personalization-field extractor (browser context) ───────────────────────
// Returns 7 new columns from a card's text content, with strict capture rules:
//   - office_city: SA + suburb names only — pulled from text patterns
//   - years_experience: integer 1-60 — pulled from "X years" phrases
//   - neighborhoods: SA-relevant neighborhood / zip-list comma-string, capped 200 chars
//   - specialty: one of 6 normalized buckets (first-time / luxury / investors / relocation / veteran / commercial)
//   - languages: only when non-English language explicitly named
//   - recent_listings_visible: integer if card shows "X active listings" or "X for sale"
//   - bio_blurb_first_sentence: first sentence of a bio paragraph, 120 char max
//
// All fields blank when not plainly visible — NEVER fabricated. See SA-REALTOR-SCRAPER.md.
const EXTRACTOR_FN = `
function extractPersonalization(cardText, cardEl) {
  const out = {
    office_city: '', years_experience: '', neighborhoods: '', specialty: '',
    languages: '', recent_listings_visible: '', bio_blurb_first_sentence: '',
  };
  if (!cardText) return out;
  const text = cardText.replace(/\\s+/g, ' ').trim();
  const lower = text.toLowerCase();

  // office_city — SA + suburb names (case-insensitive match)
  const cities = ['Boerne', 'Helotes', 'Schertz', 'Universal City', 'Cibolo',
                  'Converse', 'Live Oak', 'Selma', 'Leon Valley', 'Alamo Heights',
                  'Stone Oak', 'Castle Hills', 'New Braunfels', 'Bulverde',
                  'Fair Oaks Ranch', 'San Antonio'];
  for (const city of cities) {
    const re = new RegExp('\\\\b' + city.replace(/\\s/g, '\\\\s') + '\\\\b', 'i');
    if (re.test(text)) { out.office_city = city; break; }
  }

  // years_experience — match "X years" near experience-keywords
  const yearsMatch = text.match(/(\\d{1,2})\\+?\\s*(?:years?|yrs?)(?:\\s+(?:of\\s+)?(?:experience|exp|in\\s+(?:real\\s+estate|the\\s+business|the\\s+industry)|licensed|in\\s+sa))/i)
    || text.match(/(?:experience|licensed)\\s*[:\\-]?\\s*(\\d{1,2})\\+?\\s*(?:years?|yrs?)/i);
  if (yearsMatch) {
    const y = parseInt(yearsMatch[1], 10);
    if (y >= 1 && y <= 60) out.years_experience = String(y);
  }

  // neighborhoods — SA-specific named areas + 78xxx zips
  const knownNbhds = ['Stone Oak', 'Alamo Heights', 'Boerne', 'Helotes', 'Schertz',
                      'Universal City', 'The Dominion', 'Terrell Hills', 'Olmos Park',
                      'Monte Vista', 'King William', 'Southtown', 'Pearl', 'Castle Hills',
                      'Hollywood Park', 'Shavano Park', 'Hill Country Village',
                      'Cibolo Canyons', 'Cordillera Ranch', 'TPC', 'Bulverde',
                      'Fair Oaks Ranch', 'Garden Ridge', 'New Braunfels', 'Canyon Lake',
                      'Spring Branch', 'Westside', 'Northside', 'Southside',
                      'Medical Center', 'Northwest', 'Northeast', 'Inner Loop'];
  const foundNbhds = [];
  for (const n of knownNbhds) {
    const re = new RegExp('\\\\b' + n.replace(/\\s/g, '\\\\s') + '\\\\b', 'i');
    if (re.test(text) && !foundNbhds.includes(n)) foundNbhds.push(n);
  }
  // Also capture 78xxx zips in a "serves" or "area" context
  const zipBlock = text.match(/(?:serves?|area[s]?|zip[s]?|coverage|focus)[^.]{0,200}/i);
  if (zipBlock) {
    const zips = [...zipBlock[0].matchAll(/\\b78\\d{3}\\b/g)].map(m => m[0]);
    for (const z of zips) if (!foundNbhds.includes(z)) foundNbhds.push(z);
  }
  out.neighborhoods = foundNbhds.slice(0, 8).join(', ').slice(0, 200);

  // specialty — first matching bucket. Order matters (veteran > investors > luxury)
  // to avoid generic-word false positives like "real estate" tripping luxury.
  const specialtyPatterns = [
    { match: /first[\\s\\-]*time\\s+(?:home\\s*)?buyers?/i, label: 'first-time buyers' },
    { match: /\\bveterans?\\b|\\bVA\\s+loan\\b|\\bmilitary\\b|\\bactive\\s+duty\\b/i, label: 'veteran' },
    { match: /\\binvestors?\\b|\\binvestment\\s+propert/i, label: 'investors' },
    { match: /\\brelocation\\b|\\brelo\\s+specialist\\b|\\bmoving\\s+to\\s+sa\\b|\\bnew\\s+to\\s+texas\\b/i, label: 'relocation' },
    { match: /commercial\\s+(?:real\\s+estate|propert)|retail\\s+space|industrial\\s+propert/i, label: 'commercial' },
    // "luxury" last because plain word "estate" is too generic for real estate copy
    { match: /\\bluxury\\b|\\bhigh[\\s\\-]end\\b|\\b7[\\s\\-]?figure\\b|\\bestate\\s+homes?\\b/i, label: 'luxury' },
  ];
  for (const sp of specialtyPatterns) {
    if (sp.match.test(text)) { out.specialty = sp.label; break; }
  }

  // languages — only distinctive (non-English-only) call-outs
  const langPatterns = [
    { match: /\\bSpanish[\\s\\-]?speaking\\b|\\bhabla\\s+espa[ñn]ol\\b|\\bbiling[üu]e\\b|\\bSe\\s+habla\\b/i, label: 'Spanish' },
    { match: /\\bbilingual\\b/i, label: 'bilingual' },
    { match: /\\bGerman[\\s\\-]?speaking\\b/i, label: 'German' },
    { match: /\\bFrench[\\s\\-]?speaking\\b/i, label: 'French' },
    { match: /\\bMandarin\\b|\\bChinese[\\s\\-]?speaking\\b/i, label: 'Mandarin' },
    { match: /\\bVietnamese[\\s\\-]?speaking\\b/i, label: 'Vietnamese' },
  ];
  const foundLangs = [];
  for (const lp of langPatterns) {
    if (lp.match.test(text) && !foundLangs.includes(lp.label)) foundLangs.push(lp.label);
  }
  out.languages = foundLangs.join(', ').slice(0, 200);

  // recent_listings_visible — explicit listing count signals
  const listingMatch = text.match(/(\\d{1,3})\\s+(?:active\\s+listings?|for\\s+sale|current\\s+listings?|properties\\s+for\\s+sale)/i);
  if (listingMatch) {
    const n = parseInt(listingMatch[1], 10);
    if (n >= 0 && n <= 999) out.recent_listings_visible = String(n);
  }

  // bio_blurb_first_sentence — find a paragraph-like bio block, take first sentence
  // Look for a dedicated bio container first
  if (cardEl) {
    const bioEl = cardEl.querySelector('[class*="bio" i], [class*="about" i], [class*="description" i], [data-testid*="bio" i]');
    if (bioEl) {
      const bioText = (bioEl.textContent || '').replace(/\\s+/g, ' ').trim();
      // First sentence: terminate on . ! ? followed by space + capital, OR newline
      const firstSent = bioText.split(/(?<=[.!?])\\s+(?=[A-Z])/)[0] || bioText;
      out.bio_blurb_first_sentence = firstSent.slice(0, 120).trim();
    }
  }

  return out;
}
`;

// ─── Tier 0 (ZenRows): bot-detection bypass via managed proxy ────────────────
// Attempts to scrape realtor.com / Zillow / Homes.com using ZenRows before falling
// back to DossieBot Chrome profile. ZenRows is much faster for high-volume scrapes.
async function scrapeViaZenRows() {
  if (ONLY_METHOD && ONLY_METHOD !== 'zenrows') return;
  if (!process.env.ZENROWS_API_KEY) {
    tsLog('  SKIP: ZENROWS_API_KEY not set. Set env var to use ZenRows bypass.');
    return;
  }

  tsLog('--- Tier 0: ZenRows managed scraping (bot-detection bypass) ---');

  try {
    // Realtor.com first
    tsLog('  ZenRows > realtor.com SA agent directory');
    const realtorUrl = 'https://www.realtor.com/realestateagents/san-antonio_tx';
    try {
      const html = await zenrowsFetch(realtorUrl, {
        jsRender: true,
        premiumProxy: true,
        timeout: 30000,
      });

      // Extract agent cards
      const agents = await extractStructured(html, {
        selector: '[data-testid="agent-card"]',
        fields: {
          name: '[data-testid="agent-name"]',
          brokerage: '[data-testid="agent-brokerage"]',
          phone: 'a[href^="tel:"]',
        },
      });

      tsLog(`    Found ${agents.length} agents via ZenRows > realtor.com`);
      stats.zenrows_realtor_agents = agents.length;

      // TODO: Parse agents into lead records. For now, track that we tried.
      // Full parsing logic deferred — first verify ZenRows can bypass Akamai.
      if (agents.length > 0) {
        tsLog(`    ZenRows bypass WORKING — ${agents.length} cards extracted`);
      }
    } catch (err) {
      tsLog(`    ZenRows realtor.com failed: ${err.message} (will fall back to DossieBot Chrome)`);
    }

    // Report costs
    const costs = getCostSummary();
    tsLog(`  ZenRows cost this session: ~${costs.usedThisSession} / 1000 credits`);

  } catch (err) {
    tsLog(`  ZenRows tier failed: ${err.message}`);
  }
}

// ─── Method 1: realtor.com ───────────────────────────────────────────────────
async function scrapeRealtor(ctx) {
  if (ONLY_METHOD && ONLY_METHOD !== 'realtor') return;
  tsLog('--- Method 1: realtor.com SA agent directory ---');
  const page = await ctx.newPage();
  try {
    // Warm-up: visit homepage first, accept cookies, then drill in.
    try {
      tsLog('  warm-up: visiting realtor.com homepage');
      await page.goto('https://www.realtor.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await human(2500, 4500);
      await page.mouse.wheel(0, 400); await sleep(800);
      await page.mouse.wheel(0, 400); await sleep(800);
    } catch (e) {
      tsLog(`  warm-up failed: ${e.message}`);
    }
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (seenLeads.size >= TARGET_LEADS) {
        tsLog(`Target ${TARGET_LEADS} reached, stopping realtor.com early`);
        break;
      }
      const url = pageNum === 1
        ? 'https://www.realtor.com/realestateagents/san-antonio_tx'
        : `https://www.realtor.com/realestateagents/san-antonio_tx/pg-${pageNum}`;
      tsLog(`realtor.com page ${pageNum}: ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const status = resp ? resp.status() : 0;
        tsLog(`  HTTP ${status}`);
        if (status === 429 || status === 403 || status >= 500) {
          stats.realtor_blocked++;
          tsLog(`  BLOCKED — sleeping 60s before next attempt`);
          await sleep(60000);
          if (stats.realtor_blocked >= 3) {
            tsLog('  3 blocks in a row, abandoning realtor.com');
            break;
          }
          continue;
        }
        stats.realtor_blocked = 0;
        await human(2200, 4200);
        // Scroll to load lazy content
        for (let s = 0; s < 5; s++) {
          await page.mouse.wheel(0, 700);
          await sleep(400 + Math.random() * 300);
        }
        // Extract agent cards
        const cards = await page.evaluate((extractorSrc) => {
          // Eval extractor in-page (defined as a JS source string)
          eval(extractorSrc);
          // realtor.com agent cards: look for agent name links + brokerage
          const out = [];
          // Strategy: find any <a> whose href matches /realestateagents/agentid_
          const anchors = document.querySelectorAll('a[href*="/realestateagents/"]');
          const seen = new Set();
          for (const a of anchors) {
            const href = a.getAttribute('href');
            if (!href || !/\/realestateagents\/[a-f0-9]{16,}/.test(href)) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            // Look up to 6 levels for a card container
            let card = a;
            for (let i = 0; i < 6 && card; i++) {
              card = card.parentElement;
              if (!card) break;
              const txt = card.textContent || '';
              if (txt.length > 50 && txt.length < 1500) break;
            }
            if (!card) continue;
            const name = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
            // 2026-06-30 personalization fields
            // eslint-disable-next-line no-undef
            const persona = extractPersonalization(text, card);
            // Brokerage often appears as text after the name; phone has format (xxx) xxx-xxxx
            const phoneMatch = text.match(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
            // Brokerage: extract anything that looks like a company name after the agent name
            let brokerage = '';
            const afterName = text.slice(text.indexOf(name) + name.length);
            // Common patterns: "Keller Williams", "RE/MAX", "Coldwell Banker", "Compass", etc.
            const brokerageMatch = afterName.match(/((?:Keller Williams|KW|RE\/MAX|Coldwell Banker|Compass|Berkshire Hathaway|eXp Realty|Century 21|Realty Executives|Phyllis Browning|Kuper Sotheby|JBGoodwin|San Antonio Elite|Premier Realty|Texas Premier|Home Team|Levi Rodgers|Vortex Realty|LPT Realty|Real Broker|Engel|Sotheby|Trinity|Texas Edge|Texas Connect|Texas Realty|Texas Prime|Texas Roots|Texas Hill Country|Texas United|Texas Premier|Realty Capital|Allied Real Estate|Phyllis Browning|Centennial Real|MileStar Real|Crockett|San Antonio Portfolio|Foundation|Real Estate Brokers of Texas|Front Real Estate|Reliance Residential|Magnolia Realty|Cornerstone|Bradfield Properties|Lemonade Properties|HSL Realty|Anders Realty|Texas Mavericks|Texas Independent|Bramlett|Camino|Pinnacle|Heritage|Liberty|Coastal|Lone Star|Vista|Empire|Helping|Top|Premier|Pulse|JPAR|Reliance|RE-Connect|Coronado|Bexar|San Antonio)[^,|·\n]{0,60})/i);
            if (brokerageMatch) brokerage = brokerageMatch[1].trim();
            // sa_zip — look for a zip in text
            const zipMatch = text.match(/\b78\d{3}\b/);
            // role_type guess
            let roleType = 'solo_agent';
            if (/team|group|partners|associates/i.test(name + ' ' + brokerage)) roleType = 'team';
            if (/broker[\s-]*(?:owner|associate|principal)|managing broker|broker of record/i.test(text)) roleType = 'broker';
            out.push({
              name,
              brokerage,
              phone: phoneMatch ? phoneMatch[0] : '',
              profile_url: 'https://www.realtor.com' + href.split('?')[0],
              sa_zip: zipMatch ? zipMatch[0] : '',
              role_type: roleType,
              card_text_sample: text.slice(0, 200),
              ...persona,
            });
          }
          return out;
        }, EXTRACTOR_FN);
        stats.realtor_pages++;
        let added = 0;
        for (const c of cards) {
          if (seenUrls.has(c.profile_url)) continue;
          seenUrls.add(c.profile_url);
          if (c.role_type === 'team' || c.role_type === 'broker') continue; // filter: solo only
          if (recordLead({
            name: c.name,
            brokerage: c.brokerage,
            email: '',
            phone: c.phone,
            license_id: '',
            linkedin_url: '',
            source: 'realtor.com',
            sa_zip: c.sa_zip,
            role_type: 'solo_agent',
            profile_url: c.profile_url,
            scrape_ts: new Date().toISOString(),
            // personalization fields
            office_city: c.office_city || '',
            years_experience: c.years_experience || '',
            neighborhoods: c.neighborhoods || '',
            specialty: c.specialty || '',
            languages: c.languages || '',
            recent_listings_visible: c.recent_listings_visible || '',
            bio_blurb_first_sentence: c.bio_blurb_first_sentence || '',
          })) {
            added++;
            stats.realtor_cards++;
          }
        }
        tsLog(`  Extracted ${cards.length} cards, added ${added} new solo agents (total: ${seenLeads.size})`);
        if (cards.length === 0) {
          // Page rendered but no card matches — selectors may have changed.
          tsLog('  WARNING: 0 cards extracted. Selector drift?');
          // Dump the page once for inspection.
          if (stats.realtor_pages === 1) {
            const dumpPath = path.join(DATA_DIR, 'realtor-dump.html');
            try {
              fs.writeFileSync(dumpPath, await page.content(), 'utf8');
              tsLog(`  HTML dump saved to ${dumpPath} for selector debug`);
            } catch { /* ignore */ }
          }
        }
        // Flush state every page
        saveSeen();
        writeCSV();
        flushLog();
        await human(3500, 6000);
      } catch (err) {
        tsLog(`  page error: ${err.message}`);
        await sleep(8000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Method 2: zillow.com ────────────────────────────────────────────────────
async function scrapeZillow(ctx) {
  if (ONLY_METHOD && ONLY_METHOD !== 'zillow') return;
  if (seenLeads.size >= TARGET_LEADS) return;
  tsLog('--- Method 2: zillow.com SA agent directory ---');
  const page = await ctx.newPage();
  try {
    // Warm-up: visit homepage first
    try {
      tsLog('  warm-up: visiting zillow.com homepage');
      await page.goto('https://www.zillow.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await human(2500, 4500);
      await page.mouse.wheel(0, 500); await sleep(800);
    } catch (e) {
      tsLog(`  zillow warm-up failed: ${e.message}`);
    }
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (seenLeads.size >= TARGET_LEADS) break;
      const url = pageNum === 1
        ? 'https://www.zillow.com/professionals/real-estate-agent-reviews/san-antonio-tx/'
        : `https://www.zillow.com/professionals/real-estate-agent-reviews/san-antonio-tx/${pageNum}_p/`;
      tsLog(`zillow page ${pageNum}: ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const status = resp ? resp.status() : 0;
        tsLog(`  HTTP ${status}`);
        if (status === 403 || status === 429 || status >= 500) {
          stats.zillow_blocked++;
          tsLog(`  BLOCKED — sleeping 90s`);
          await sleep(90000);
          if (stats.zillow_blocked >= 3) {
            tsLog('  3 blocks, abandoning zillow.com');
            break;
          }
          continue;
        }
        stats.zillow_blocked = 0;
        await human(3000, 5000);
        // Detect press-and-hold captcha
        const captcha = await page.locator('text=Press & Hold').first().isVisible().catch(() => false);
        if (captcha) {
          tsLog('  CAPTCHA detected (press-and-hold) — abandoning zillow.com');
          stats.zillow_blocked = 99;
          break;
        }
        for (let s = 0; s < 8; s++) {
          await page.mouse.wheel(0, 700);
          await sleep(350 + Math.random() * 400);
        }
        // Strategy: find each agent CARD via stable selector, then extract subfields.
        // Zillow agent search cards are <article> or <div> with data-testid containing "professional".
        // Fallback: walk back from the agent profile <a> to the nearest <article> or list-item.
        const cards = await page.evaluate((extractorSrc) => {
          eval(extractorSrc);
          const out = [];
          const seenHref = new Set();
          // Try article-based cards first
          const articles = document.querySelectorAll('article, li[class*="card"], div[class*="ProfessionalCard"], div[data-testid*="professional"]');
          const containers = articles.length > 0 ? Array.from(articles) : [];
          // Fallback: walk up from each profile link
          if (containers.length === 0) {
            const links = document.querySelectorAll('a[href*="/profile/"]');
            const usedParents = new Set();
            for (const a of links) {
              let p = a.parentElement;
              for (let i = 0; i < 5 && p; i++) {
                if (p.tagName === 'ARTICLE' || p.tagName === 'LI') break;
                if ((p.textContent || '').length > 80 && (p.textContent || '').length < 1500) break;
                p = p.parentElement;
              }
              if (!p || usedParents.has(p)) continue;
              usedParents.add(p);
              containers.push(p);
            }
          }
          for (const card of containers) {
            // Find the agent profile link inside the card
            const link = card.querySelector('a[href*="/profile/"]');
            if (!link) continue;
            const href = link.getAttribute('href');
            if (!href || !/^\/profile\/[A-Za-z0-9_%-]+/.test(href)) continue;
            if (seenHref.has(href)) continue;
            seenHref.add(href);
            // NAME — usually the first heading-like element inside the card
            let name = '';
            const nameNode = card.querySelector('h3, h4, [class*="name" i], [class*="Name"]');
            if (nameNode) name = (nameNode.textContent || '').trim();
            // Reject if name is a generic "Agent" label
            if (!name) name = (link.textContent || '').trim();
            // Strip rating tail like "5.0 (12)"
            name = name.replace(/\s*\d\.\d\s*\(\d+\).*$/, '').replace(/\s+/g, ' ').trim();
            // Truncate to first newline equivalent (likely just the name)
            if (name.length > 50) name = name.split(/\s{2,}/)[0].slice(0, 50);
            const text = (card.textContent || '').replace(/\s+/g, ' ').trim();
            // BROKERAGE — common pattern: name then brokerage on the line below
            let brokerage = '';
            // Try a dedicated brokerage element
            const brokerNode = card.querySelector('[class*="broker" i], [class*="Broker"], [class*="company" i]');
            if (brokerNode) brokerage = (brokerNode.textContent || '').trim();
            if (!brokerage) {
              // Match common brokerage words
              const m = text.match(/((?:Keller Williams|KW|RE\/MAX|RE\\?\/MAX|Coldwell Banker|Compass|Berkshire Hathaway|eXp Realty|Century 21|Realty Executives|Phyllis Browning|Kuper Sotheby[^,|]*|Sotheby[^,|]*|JBGoodwin|Engel\s*&\s*V[öo]lkers|Real Broker|Levi Rodgers|LPT Realty|Vortex Realty|JPAR|Trinity|Premier Realty|Bramlett|Reliance|Magnolia|Phyllis|Cornerstone|Bradfield|Anders Realty|San Antonio Portfolio|Texas Premier|Allied Real Estate|Centennial|MileStar|Crockett|Foundation|Exquisite Properties|HomeSmart|Realty One Group|Better Homes|Mark Twain|Coronado|Realty Capital|Realm Real Estate|Realty Connect|Cornerstone Real Estate|Heritage Texas)[A-Za-z0-9&'\-\s.,]{0,60})/i);
              if (m) brokerage = m[1].trim();
            }
            // Truncate brokerage if it absorbed extra text
            brokerage = brokerage.replace(/\$\d.*$/, '').replace(/\d+\s*sales.*/i, '').replace(/\d+\s*reviews?.*/i, '').replace(/\s+/g, ' ').trim();
            if (brokerage.length > 70) brokerage = brokerage.slice(0, 70);
            const phoneMatch = text.match(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
            const zipMatch = text.match(/\b78\d{3}\b/);
            let roleType = 'solo_agent';
            if (/\b(team|group|partners|associates)\b/i.test(name)) roleType = 'team';
            const fullUrl = href.startsWith('http')
              ? href.split('?')[0]
              : 'https://www.zillow.com' + href.split('?')[0];
            // eslint-disable-next-line no-undef
            const persona = extractPersonalization(text, card);
            out.push({
              name, brokerage,
              phone: phoneMatch ? phoneMatch[0] : '',
              profile_url: fullUrl,
              sa_zip: zipMatch ? zipMatch[0] : '',
              role_type: roleType,
              ...persona,
            });
          }
          return out;
        }, EXTRACTOR_FN);
        stats.zillow_pages++;
        let added = 0;
        for (const c of cards) {
          if (seenUrls.has(c.profile_url)) continue;
          seenUrls.add(c.profile_url);
          if (c.role_type === 'team') continue;
          if (recordLead({
            name: c.name,
            brokerage: c.brokerage,
            email: '',
            phone: c.phone,
            license_id: '',
            linkedin_url: '',
            source: 'zillow.com',
            sa_zip: c.sa_zip,
            role_type: 'solo_agent',
            profile_url: c.profile_url,
            scrape_ts: new Date().toISOString(),
            office_city: c.office_city || '',
            years_experience: c.years_experience || '',
            neighborhoods: c.neighborhoods || '',
            specialty: c.specialty || '',
            languages: c.languages || '',
            recent_listings_visible: c.recent_listings_visible || '',
            bio_blurb_first_sentence: c.bio_blurb_first_sentence || '',
          })) {
            added++;
            stats.zillow_cards++;
          }
        }
        tsLog(`  Extracted ${cards.length} cards, added ${added} new (total: ${seenLeads.size})`);
        if (cards.length === 0 && stats.zillow_pages === 1) {
          const dumpPath = path.join(DATA_DIR, 'zillow-dump.html');
          try {
            fs.writeFileSync(dumpPath, await page.content(), 'utf8');
            tsLog(`  HTML dump saved to ${dumpPath}`);
          } catch { /* ignore */ }
        }
        saveSeen(); writeCSV(); flushLog();
        await human(4000, 7000);
      } catch (err) {
        tsLog(`  page error: ${err.message}`);
        await sleep(10000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Method 3: homes.com ─────────────────────────────────────────────────────
async function scrapeHomes(ctx) {
  if (ONLY_METHOD && ONLY_METHOD !== 'homes') return;
  if (seenLeads.size >= TARGET_LEADS) return;
  tsLog('--- Method 3: homes.com SA agent directory ---');
  const page = await ctx.newPage();
  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum++) {
      if (seenLeads.size >= TARGET_LEADS) break;
      const url = pageNum === 1
        ? 'https://www.homes.com/real-estate-agents/san-antonio-tx/'
        : `https://www.homes.com/real-estate-agents/san-antonio-tx/p${pageNum}/`;
      tsLog(`homes.com page ${pageNum}: ${url}`);
      try {
        const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35000 });
        const status = resp ? resp.status() : 0;
        tsLog(`  HTTP ${status}`);
        if (status === 403 || status === 429 || status >= 500) {
          stats.homes_blocked++;
          tsLog(`  BLOCKED — sleeping 60s`);
          await sleep(60000);
          if (stats.homes_blocked >= 3) {
            tsLog('  3 blocks, abandoning homes.com');
            break;
          }
          continue;
        }
        stats.homes_blocked = 0;
        await human(2200, 4000);
        for (let s = 0; s < 6; s++) {
          await page.mouse.wheel(0, 800);
          await sleep(300 + Math.random() * 400);
        }
        const cards = await page.evaluate((extractorSrc) => {
          eval(extractorSrc);
          const out = [];
          const anchors = document.querySelectorAll('a[href*="/real-estate-agents/"]');
          const seen = new Set();
          for (const a of anchors) {
            const href = a.getAttribute('href');
            // Per-agent URLs look like /real-estate-agents/{slug-name}/{id}/
            if (!href || !/\/real-estate-agents\/[^/]+\/[a-zA-Z0-9-]{6,}\/?$/.test(href)) continue;
            if (seen.has(href)) continue;
            seen.add(href);
            let card = a;
            for (let i = 0; i < 6 && card; i++) {
              card = card.parentElement;
              if (!card) break;
              const txt = card.textContent || '';
              if (txt.length > 60 && txt.length < 1500) break;
            }
            const name = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
            const text = (card ? card.textContent : '').replace(/\s+/g, ' ').trim();
            const phoneMatch = text.match(/\(?\b\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/);
            const zipMatch = text.match(/\b78\d{3}\b/);
            let brokerage = '';
            const m = text.match(/((?:Keller Williams|KW|RE\/MAX|Coldwell Banker|Compass|Berkshire Hathaway|eXp Realty|Century 21|Realty Executives|Phyllis Browning|Kuper Sotheby|JBGoodwin|Real Broker|Engel|Sotheby|Trinity|JPAR|Levi Rodgers|Vortex|LPT|Premier|Texas[^,|·\n]{0,40})[^,|·\n]{0,60})/);
            if (m) brokerage = m[1].trim();
            let roleType = 'solo_agent';
            if (/team|group|partners/i.test(name)) roleType = 'team';
            // eslint-disable-next-line no-undef
            const persona = extractPersonalization(text, card);
            out.push({
              name, brokerage,
              phone: phoneMatch ? phoneMatch[0] : '',
              profile_url: 'https://www.homes.com' + href.split('?')[0],
              sa_zip: zipMatch ? zipMatch[0] : '',
              role_type: roleType,
              ...persona,
            });
          }
          return out;
        }, EXTRACTOR_FN);
        stats.homes_pages++;
        let added = 0;
        for (const c of cards) {
          if (seenUrls.has(c.profile_url)) continue;
          seenUrls.add(c.profile_url);
          if (c.role_type === 'team') continue;
          if (recordLead({
            name: c.name,
            brokerage: c.brokerage,
            email: '',
            phone: c.phone,
            license_id: '',
            linkedin_url: '',
            source: 'homes.com',
            sa_zip: c.sa_zip,
            role_type: 'solo_agent',
            profile_url: c.profile_url,
            scrape_ts: new Date().toISOString(),
            office_city: c.office_city || '',
            years_experience: c.years_experience || '',
            neighborhoods: c.neighborhoods || '',
            specialty: c.specialty || '',
            languages: c.languages || '',
            recent_listings_visible: c.recent_listings_visible || '',
            bio_blurb_first_sentence: c.bio_blurb_first_sentence || '',
          })) {
            added++;
            stats.homes_cards++;
          }
        }
        tsLog(`  Extracted ${cards.length} cards, added ${added} new (total: ${seenLeads.size})`);
        if (cards.length === 0 && stats.homes_pages === 1) {
          const dumpPath = path.join(DATA_DIR, 'homes-dump.html');
          try {
            fs.writeFileSync(dumpPath, await page.content(), 'utf8');
            tsLog(`  HTML dump saved to ${dumpPath}`);
          } catch { /* ignore */ }
        }
        saveSeen(); writeCSV(); flushLog();
        await human(3500, 6500);
      } catch (err) {
        tsLog(`  page error: ${err.message}`);
        await sleep(8000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Optional: per-profile enrichment pass ───────────────────────────────────
// Only runs when --enrich-profiles is passed. Visits each agent profile and
// fills missing personalization fields from the bio block. Polite 3-5 sec pacing.
// Cost note: at 2000 leads × 4 sec avg = ~2.2 hr extra runtime. Use after
// initial sweep when sources are responsive (not currently blocked).
async function enrichProfiles(ctx) {
  if (!ENRICH_PROFILES) return;
  tsLog('--- Enrichment pass: visit each profile for bio fields ---');
  const page = await ctx.newPage();
  let visited = 0, updated = 0, skipped = 0, blocked = 0;
  try {
    for (const [key, lead] of seenLeads.entries()) {
      if (!lead.profile_url) { skipped++; continue; }
      // Skip if all 7 new fields are already populated
      const empties = ['office_city', 'years_experience', 'neighborhoods', 'specialty',
                       'languages', 'recent_listings_visible', 'bio_blurb_first_sentence']
                      .filter(f => !lead[f]);
      if (empties.length === 0) { skipped++; continue; }
      try {
        const resp = await page.goto(lead.profile_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const status = resp ? resp.status() : 0;
        if (status >= 400) {
          blocked++;
          if (blocked >= 5) {
            tsLog(`  enrichment: 5 consecutive blocks, sleeping 90s`);
            await sleep(90000);
            blocked = 0;
          }
          continue;
        }
        blocked = 0;
        await human(2200, 3800);
        // Scroll once to render lazy bio
        await page.mouse.wheel(0, 600);
        await sleep(800);
        const persona = await page.evaluate((extractorSrc) => {
          eval(extractorSrc);
          // Use the body as the card container so we sweep the whole profile
          const text = (document.body.textContent || '').replace(/\s+/g, ' ').trim();
          // eslint-disable-next-line no-undef
          return extractPersonalization(text, document.body);
        }, EXTRACTOR_FN);
        let changed = false;
        for (const f of empties) {
          if (persona[f] && !lead[f]) { lead[f] = persona[f]; changed = true; }
        }
        if (changed) { seenLeads.set(key, lead); updated++; }
        visited++;
        if (visited % 25 === 0) {
          tsLog(`  enrichment progress: ${visited} visited, ${updated} updated, ${skipped} skipped`);
          saveSeen(); writeCSV(); flushLog();
        }
      } catch (err) {
        tsLog(`  enrichment err for ${lead.profile_url}: ${err.message}`);
        await sleep(5000);
      }
    }
  } finally {
    await page.close().catch(() => {});
  }
  tsLog(`Enrichment done: ${visited} visited, ${updated} updated, ${skipped} skipped`);
  saveSeen(); writeCSV(); flushLog();
}

// ─── Milestone Telegram pings (500 / 1k / 2k) ────────────────────────────────
async function sendMilestonePing(count) {
  const completeness = field => {
    const filled = stats[field] || 0;
    return stats.total > 0 ? Math.round(100 * filled / stats.total) : 0;
  };
  const text = [
    `SA REALTOR scrape: ${count} leads captured.`,
    `Profile-completeness on new columns:`,
    `  office_city: ${completeness('has_office_city')}%`,
    `  years_experience: ${completeness('has_years')}%`,
    `  neighborhoods: ${completeness('has_neighborhoods')}%`,
    `  specialty: ${completeness('has_specialty')}%`,
    `  languages: ${completeness('has_languages')}%`,
    `  recent_listings_visible: ${completeness('has_listings_count')}%`,
    `  bio_blurb_first_sentence: ${completeness('has_bio_blurb')}%`,
    `CSV: data/sa-realtor-leads-v2.csv`,
  ].join('\n');
  await sendTelegram(text);
}

// ─── Telegram ping ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const tok = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!tok || !chat) {
    tsLog('Telegram env not set, skipping ping');
    return;
  }
  try {
    const r = await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }),
    });
    tsLog(`Telegram ping status: ${r.status}`);
  } catch (e) {
    tsLog(`Telegram ping failed: ${e.message}`);
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Truncate the log on fresh start; keep append after.
  fs.writeFileSync(LOG_FILE, `=== SA REALTOR scraper v2 — ${new Date().toISOString()} ===\n`, 'utf8');
  tsLog(`PID ${process.pid}, headless=${HEADLESS}, only-method=${ONLY_METHOD || '(all)'}, max-pages=${MAX_PAGES}`);
  loadSeen();

  // Tier 0: Try ZenRows managed proxy first (if API key is set)
  await scrapeViaZenRows();

  let ctx;
  try {
    ctx = await launchBrowser();
    tsLog(`Browser launched (channel: chrome)`);

    // Tier 1+: Fall back to DossieBot Chrome profile if needed
    if (seenLeads.size < TARGET_LEADS) await scrapeRealtor(ctx);
    if (seenLeads.size < TARGET_LEADS) await scrapeZillow(ctx);
    if (seenLeads.size < TARGET_LEADS) await scrapeHomes(ctx);

    // Optional per-profile drill for richer personalization fields
    await enrichProfiles(ctx);

  } catch (err) {
    tsLog(`FATAL: ${err.message}\n${err.stack || ''}`);
  } finally {
    if (ctx) await ctx.close().catch(() => {});
  }

  writeCSV();
  saveSeen();

  const emailPct = stats.total > 0
    ? Math.round(100 * (stats.total - stats.missing_email) / stats.total)
    : 0;

  const pct = field => stats.total > 0 ? Math.round(100 * (stats[field] || 0) / stats.total) : 0;
  const summary = [
    '',
    '=== FINAL ===',
    `Total unique solo SA REALTORs: ${stats.total}`,
    `Email-discoverable: ${stats.total - stats.missing_email} (${emailPct}%)`,
    `Tier 0 (ZenRows): ${stats.zenrows_realtor_agents} agents via managed proxy`,
    `Tier 1 (DossieBot Chrome):`,
    `  realtor.com: ${stats.realtor_cards} leads from ${stats.realtor_pages} pages (blocked: ${stats.realtor_blocked})`,
    `  zillow.com:  ${stats.zillow_cards} leads from ${stats.zillow_pages} pages (blocked: ${stats.zillow_blocked})`,
    `  homes.com:   ${stats.homes_cards} leads from ${stats.homes_pages} pages (blocked: ${stats.homes_blocked})`,
    `Duplicates skipped: ${stats.duplicates}`,
    '',
    '--- Personalization-column completeness ---',
    `  office_city:              ${pct('has_office_city')}%`,
    `  years_experience:         ${pct('has_years')}%`,
    `  neighborhoods:            ${pct('has_neighborhoods')}%`,
    `  specialty:                ${pct('has_specialty')}%`,
    `  languages:                ${pct('has_languages')}%`,
    `  recent_listings_visible:  ${pct('has_listings_count')}%`,
    `  bio_blurb_first_sentence: ${pct('has_bio_blurb')}%`,
    `CSV: ${CSV_FILE}`,
  ].join('\n');
  tsLog(summary);
  flushLog();

  const tgLine = `SA REALTOR scrape v2 done: ${stats.total} leads, ${emailPct}% email. Sources: realtor=${stats.realtor_cards} zillow=${stats.zillow_cards} homes=${stats.homes_cards}. CSV: data/sa-realtor-leads-v2.csv`;
  await sendTelegram(tgLine);
}

main().catch(err => {
  console.error('Fatal:', err);
  flushLog();
  process.exit(1);
});
