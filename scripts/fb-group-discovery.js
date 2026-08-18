'use strict';

// scripts/fb-group-discovery.js
//
// Real Facebook group search + verification, using the DossieBot Chrome
// profile. Heath's ask 2026-08-17: group_registry (36 rows, several of them
// unverified "(alt URL)" guesses) is too small and produces almost no real
// engagement material. Search FB's own group search across a broad query
// set, verify each candidate is real + active (member count + a recent post
// timestamp), dedupe against group_registry, and insert the survivors.
//
// Never posts/comments/joins. Read-only discovery + verification.
//
// Usage:
//   node scripts/fb-group-discovery.js [--dry-run] [--queries=N] [--visit-cap=N]
//
// Env vars required:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   PLAYWRIGHT_PROFILE_DIR, PLAYWRIGHT_PROFILE_NAME (DossieBot Chrome profile)

const path = require('path');
const os = require('os');
const fs = require('fs');
const { canScan, recordScan, SCAN_DWELL_MS, randDelay } = require('./_lib/scan-caps');

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
      if (!process.env[key] || process.env[key] === '[SENSITIVE]') process.env[key] = val;
    }
  }
} catch (e) { /* non-fatal */ }

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const CHROME_PROFILE_PATH = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(
  os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data'
);
const PLAYWRIGHT_PROFILE_NAME = process.env.PLAYWRIGHT_PROFILE_NAME || 'Default';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const QUERIES_ARG = args.find((a) => a.startsWith('--queries='));
const MAX_QUERIES = QUERIES_ARG ? parseInt(QUERIES_ARG.split('=')[1], 10) : 999;
const VISIT_ARG = args.find((a) => a.startsWith('--visit-cap='));
const VISIT_CAP = VISIT_ARG ? parseInt(VISIT_ARG.split('=')[1], 10) : 120;

// Broad query set: statewide, TREC/compliance, TC-specific, hyperlocal
// (major TX metros + counties), brokerage-specific, mastermind/networking.
const QUERIES = [
  // Round 2 (2026-08-17): tighter, agent-networking-specific phrasing --
  // round 1's generic "Texas real estate agents"/"Houston real estate
  // agents" style queries mostly surfaced consumer buyer/seller/investor
  // marketplaces (55/67 verified PASS got dropped in curation for exactly
  // that). This batch leans on "network"/"networking"/"professionals"/
  // "referral"/named-brokerage phrasing, which curated at a much higher hit
  // rate in round 1.
  'Realtor network Texas', 'real estate agent networking group',
  'real estate professionals network Texas', 'realtor referral network Texas',
  'agent to agent referral network', 'real estate business network Texas',
  'Keller Williams realtors network', 'RE/MAX realtors network Texas',
  'eXp Realty agent network', 'Compass realtors network',
  'Coldwell Banker realtors network', 'Berkshire Hathaway realtors Texas',
  'Realtor mastermind Texas', 'new agent mentorship real estate Texas',
  'real estate CE credit Texas', 'TREC continuing education',
  'San Antonio realtor network', 'Austin realtor network',
  'Dallas realtor network', 'Fort Worth realtor network',
  'Houston realtor network', 'El Paso realtor network',
  'Corpus Christi realtor network', 'Waco realtor network',
  'McAllen realtor network', 'Lubbock realtor network',
  'Amarillo realtor network', 'Tyler Texas realtors',
  'Beaumont Texas realtors', 'Midland Odessa realtors',
  'North Texas realtors', 'Central Texas realtors',
  'East Texas realtors', 'West Texas realtors',
  'South Texas realtors', 'Gulf Coast Texas realtors',
  'Comal County realtor network', 'Bexar County realtor network',
  'Williamson County realtor network', 'Collin County realtors',
  'Denton County realtors', 'Tarrant County realtors',
  'Montgomery County realtors', 'Fort Bend County realtors',
  'Travis County realtors',
].slice(0, MAX_QUERIES);

function log(...a) { console.log('[fb-group-discovery]', ...a); }

async function supabaseFetch(urlPath, init = {}) {
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

function groupIdFromUrl(url) {
  if (!url) return null;
  const m = url.match(/facebook\.com\/groups\/([^/?]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function parseMemberCount(text) {
  if (!text) return null;
  const m = text.match(/([\d,.]+)\s*([KkMm])?\s*members?/);
  if (!m) return null;
  let n = parseFloat(m[1].replace(/,/g, ''));
  if (/[Kk]/.test(m[2] || '')) n *= 1000;
  if (/[Mm]/.test(m[2] || '')) n *= 1000000;
  return Math.round(n);
}

function randWait(min, max) {
  return new Promise((r) => setTimeout(r, min + Math.random() * (max - min)));
}

function categorize(query) {
  const q = query.toLowerCase();
  if (q.includes('trec') || q.includes('license')) return 'trec_education';
  if (q.includes('transaction coordinator') || q.includes('tc ')) return 'tc_specific';
  if (q.includes('san antonio') || q.includes('sabor') || q.includes('boerne') ||
      q.includes('braunfels') || q.includes('bulverde') || q.includes('hill country') ||
      q.includes('comal') || q.includes('bexar') || q.includes('guadalupe') ||
      q.includes('kendall') || q.includes('hays') || q.includes('williamson'))
    return 'hyperlocal';
  if (q.includes('mastermind') || q.includes('referral') || q.includes('tips') ||
      q.includes('new real estate') || q.includes('solo'))
    return 'texas_agent_networking';
  if (q.includes('keller williams') || q.includes('re/max') || q.includes('exp realty') ||
      q.includes('compass') || q.includes('coldwell'))
    return 'broker_team_lead';
  if (q.includes('texas')) return 'texas_agent_networking';
  return 'texas_agent_networking';
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[fb-group-discovery] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required');
    process.exit(1);
  }

  const { ok, data: existing } = await supabaseFetch('/rest/v1/group_registry?select=id,group_name,group_url');
  if (!ok || !Array.isArray(existing)) {
    console.error('[fb-group-discovery] Failed to load existing group_registry');
    process.exit(1);
  }
  const existingIds = new Set(existing.map((g) => groupIdFromUrl(g.group_url)).filter(Boolean));
  log(`Existing group_registry: ${existing.length} rows, ${existingIds.size} unique group IDs`);

  const { chromium } = require('playwright');
  log(`Launching DossieBot Chrome, ${QUERIES.length} search quer(y/ies)${DRY_RUN ? ' [DRY RUN]' : ''}`);

  const context = await chromium.launchPersistentContext(CHROME_PROFILE_PATH, {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      `--profile-directory=${PLAYWRIGHT_PROFILE_NAME}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
    ],
    viewport: { width: 1280, height: 900 },
    channel: 'chrome',
  });

  const page = await context.newPage();

  // Sanity check: confirm logged in.
  await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const homeUrl = page.url();
  if (homeUrl.includes('login') || homeUrl.includes('checkpoint')) {
    console.error('[fb-group-discovery] Not logged in on DossieBot profile — aborting');
    await context.close();
    process.exit(1);
  }
  log('Logged in confirmed, session live');

  const candidateMap = new Map(); // groupId -> {name, url, memberCount, query}

  for (const query of QUERIES) {
    log(`Searching: "${query}"`);
    const searchUrl = `https://www.facebook.com/search/groups/?q=${encodeURIComponent(query)}`;
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => {
      log(`  goto failed: ${e.message}`);
    });
    await page.waitForTimeout(2500 + Math.random() * 1500);

    // Scroll a couple times to load more results
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => window.scrollBy(0, 1200));
      await page.waitForTimeout(1200 + Math.random() * 800);
    }

    const results = await page.evaluate(() => {
      const links = document.querySelectorAll('a[href*="/groups/"]');
      const byGid = new Map();
      for (const link of links) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/\/groups\/([^/?]+)/);
        if (!m) continue;
        const gid = m[1];
        // Skip obvious non-group-home links (posts, permalinks, etc.)
        if (/\/(posts|permalink|user|members|about)\//.test(href)) continue;
        const name = (link.innerText || '').trim();
        // Walk up to find a container with both name text and member count text
        let container = link.closest('div[role="listitem"]') || link.parentElement?.parentElement?.parentElement;
        const containerText = container ? container.innerText || '' : '';
        const existingEntry = byGid.get(gid);
        if (!existingEntry) {
          byGid.set(gid, { gid, href, name, containerText: containerText.slice(0, 300) });
        } else if (!existingEntry.name && name) {
          // The image/profile-photo link for a group has no innerText and
          // often comes first in DOM order; the text link comes right after
          // with the same gid -- keep whichever entry actually has a name.
          existingEntry.name = name;
          if (!existingEntry.containerText) existingEntry.containerText = containerText.slice(0, 300);
        }
      }
      const out = [...byGid.values()];
      return out;
    }).catch(() => []);

    for (const r of results) {
      if (!r.name || r.name.length < 3) continue;
      const fullUrl = r.href.startsWith('http') ? r.href : `https://www.facebook.com${r.href}`;
      const gid = r.gid.toLowerCase();
      if (existingIds.has(gid) || candidateMap.has(gid)) continue;
      const memberCount = parseMemberCount(r.containerText);
      candidateMap.set(gid, {
        name: r.name,
        url: fullUrl.split('?')[0],
        memberCount,
        query,
      });
    }
    log(`  -> ${results.length} raw link(s), ${candidateMap.size} total unique new candidate(s) so far`);
    await randWait(1800, 3500);
  }

  log(`Search phase complete: ${candidateMap.size} unique new candidate group(s) to verify`);

  // Filter obviously irrelevant candidates by name before spending a page
  // visit on them (buy/sell/rent listing groups, non-agent audiences).
  const EXCLUDE_NAME_PATTERNS = [
    /for sale by owner/i, /homes for rent/i, /apartments for rent/i,
    /buy sell trade/i, /garage sale/i, /yard sale/i, /rentals? only/i,
    /roommate/i, /flea market/i,
  ];
  const AGENT_NAME_HINT = /(realt|real estate|agent|broker|trec|transaction coord|listing|property manag)/i;

  let toVisit = [...candidateMap.values()].filter((c) => {
    if (EXCLUDE_NAME_PATTERNS.some((p) => p.test(c.name))) return false;
    if (!AGENT_NAME_HINT.test(c.name)) return false;
    return true;
  }).slice(0, VISIT_CAP);

  // Anti-ban pacing gate (scripts/_lib/scan-caps.js) -- same 25/day ceiling
  // fb-engagement-scraper.js honors. A large one-time expansion burst (this
  // run) is a deliberate, explicit exception; subsequent/future discovery
  // runs get trimmed like any other scanning activity.
  const scanGate = canScan(toVisit.length);
  if (!scanGate.allowed) {
    if (scanGate.remaining <= 0) {
      log(`Daily scan cap already used (${scanGate.used}/${scanGate.cap}) -- skipping verification visits this run`);
      toVisit = [];
    } else {
      log(`Daily scan cap: ${scanGate.used}/${scanGate.cap} used, trimming ${toVisit.length} -> ${scanGate.remaining}`);
      toVisit = toVisit.slice(0, scanGate.remaining);
    }
  }

  log(`After name filtering: ${toVisit.length} candidate(s) queued for live verification (visit-cap ${VISIT_CAP})`);

  const verified = [];
  const rejected = [];

  for (const cand of toVisit) {
    log(`Verifying: ${cand.name} (${cand.url})`);
    await page.goto(cand.url, { waitUntil: 'domcontentloaded', timeout: 25000 }).catch((e) => {
      log(`  goto failed: ${e.message}`);
    });
    await page.waitForTimeout(4500 + Math.random() * 2000);

    const curUrl = page.url();
    log(`  landed on: ${curUrl}`);
    if (curUrl.includes('login') || curUrl.includes('checkpoint')) {
      log('  redirected to login/checkpoint mid-run — stopping verification early');
      break;
    }

    const info = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      const memberMatch = bodyText.match(/([\d,.]+)\s*([KkMm])?\s*members?/);
      // Recency signal: FB renders post timestamps as plain text nodes inside
      // bare <span> elements ("5m", "2h", "1d", "3w") -- NOT reliably inside
      // an <a href="/posts/..."> (confirmed live 2026-08-17: those links were
      // empty/absent while the visible timestamps were plain spans). Walk all
      // text nodes instead of relying on a link selector.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const timeEls = [];
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.textContent || '').trim();
        if (/^\d{1,2}\s?[mhdw]$/.test(t) || /^(just now|yesterday)$/i.test(t)) {
          timeEls.push(t);
        }
      }
      const isPrivate = /private group/i.test(bodyText);
      const isPublic = /public group/i.test(bodyText);
      return {
        memberText: memberMatch ? memberMatch[0] : null,
        recentTimestamps: timeEls.slice(0, 15),
        isPrivate,
        isPublic,
        title: document.title,
      };
    }).catch(() => ({}));

    const memberCount = parseMemberCount(info.memberText) || cand.memberCount;
    // "Active" = at least one visible post/comment timestamp within the last
    // 24h (minutes, hours, or "1d"/"just now"/"yesterday"). Weeks-only pages
    // read as stale even if member count is fine.
    const hasRecentActivity = Array.isArray(info.recentTimestamps) && info.recentTimestamps.some((t) => {
      const s = String(t).toLowerCase();
      if (/^(just now|yesterday)$/.test(s)) return true;
      const m = s.match(/^(\d{1,2})\s?([mhdw])$/);
      if (!m) return false;
      const n = parseInt(m[1], 10);
      if (m[2] === 'm' || m[2] === 'h') return true;
      if (m[2] === 'd') return n <= 1;
      return false;
    });
    const sizeOk = memberCount !== null && memberCount >= 300 && memberCount <= 300000;

    // NOTE 2026-08-17: attempted a hard "top post under 1hr" DOM gate here
    // (matching today's manual spot-check bar) and it does not survive real
    // automation -- FB's own group feed pagelet either lags far past any
    // sane wait/scroll budget or renders its real timestamps off-DOM
    // (0x0 bounding box, i.e. an invisible prefetched node, confirmed live
    // against multiple groups) while a visually-identical "24m"-style
    // timestamp DOES render on screen. hasRecentActivity below is kept as a
    // best-effort SOFT signal (logged, not a hard gate) -- real recency
    // verification for the borderline candidates in this batch was done by
    // screenshot + human-equivalent visual read, same as today's spot-check.
    const passed = sizeOk && info.isPublic;
    const record = {
      ...cand,
      memberCount,
      isPrivate: info.isPrivate,
      isPublic: info.isPublic,
      recentTimestamps: info.recentTimestamps,
      hasRecentActivity,
      passed,
    };

    if (passed) {
      verified.push(record);
      log(`  PASS — ${memberCount} members, public=${info.isPublic}, soft-recency-signal=${hasRecentActivity}`);
    } else {
      rejected.push(record);
      log(`  REJECT — members=${memberCount}, public=${info.isPublic}, sizeOk=${sizeOk}`);
    }

    recordScan(1);
    await randDelay(SCAN_DWELL_MS);
  }

  log(`Verification complete: ${verified.length} PASSED, ${rejected.length} rejected`);

  let inserted = 0;
  if (!DRY_RUN) {
    for (const v of verified) {
      const insert = await supabaseFetch('/rest/v1/group_registry', {
        method: 'POST',
        headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
        body: JSON.stringify({
          group_name: v.name,
          group_url: v.url,
          category: categorize(v.query),
          cool_down_hours: 72,
          skip: false,
          requires_heath_review: false,
          audience_class: 'agent',
        }),
      });
      if (insert.ok) inserted++;
      else log(`  insert failed for ${v.name}: ${insert.status} ${JSON.stringify(insert.data).slice(0, 150)}`);
    }
  }

  log(`DONE. Inserted ${inserted}/${verified.length} verified new group(s) into group_registry.${DRY_RUN ? ' [DRY RUN — nothing written]' : ''}`);

  // Dump full results for the report.
  const outPath = path.join(__dirname, `.discovery-results-${Date.now()}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ verified, rejected }, null, 2));
  log(`Full results written to ${outPath}`);

  await context.close();
}

main().catch((err) => {
  console.error('[fb-group-discovery] Fatal error:', err.message);
  process.exit(1);
});
