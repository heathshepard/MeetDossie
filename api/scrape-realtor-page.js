/**
 * SA REALTOR page scraper — one page per invocation.
 *
 * Fetches a Realtor.com agent-directory page via ZenRows (Akamai bypass) and
 * extracts full agent records from the embedded __NEXT_DATA__ / JSON blobs.
 *
 * Auth: Bearer CRON_SECRET.
 *
 * Query params:
 *   ?url=<full realtor.com agent directory URL>
 *   OR
 *   ?zip=<SA zip>&page=<n>    -> constructs the URL for you
 *   ?debug=1                   -> also returns rawSnippet (first 2000 chars of any embedded JSON)
 *
 * Response:
 *   { status, http_status, agent_count, agents:[{name,brokerage,phone,city,profile_url,agent_id,source}...],
 *     credits_left, html_bytes, target_url, error_if_any }
 *
 * Cost: 1 ZenRows premium proxy call per invocation (~10 credits).
 */

'use strict';

const ZENROWS_ENDPOINT = 'https://api.zenrows.com/v1/';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!CRON_SECRET || bearer !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY || '';
  if (!ZENROWS_API_KEY) {
    return res.status(500).json({ status: 'FAIL', error_if_any: 'ZENROWS_API_KEY not set' });
  }

  // Resolve target URL from either ?url= or ?zip=+?page=
  let targetUrl = req.query.url;
  if (!targetUrl) {
    const zip = req.query.zip;
    const page = parseInt(req.query.page || '1', 10);
    if (zip) {
      // Realtor.com pattern: /realestateagents/<city>_<state>/pg-<n>  works but zip search is different:
      // /realestateagents/<zip>  is a redirect. Use the city-page pattern for now.
      targetUrl = page === 1
        ? `https://www.realtor.com/realestateagents/${zip}`
        : `https://www.realtor.com/realestateagents/${zip}/pg-${page}`;
    } else {
      const city = req.query.city || 'san-antonio_tx';
      targetUrl = page === 1
        ? `https://www.realtor.com/realestateagents/${city}`
        : `https://www.realtor.com/realestateagents/${city}/pg-${page}`;
    }
  }

  const debug = req.query.debug === '1';
  const returnRaw = req.query.raw === '1'; // Sage generic-scrape mode — returns raw HTML for arbitrary pages
  const noJs = req.query.no_js === '1'; // skip JS rendering for lighter/faster fetches
  const premium = req.query.premium !== '0'; // default premium on

  const params = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: targetUrl,
    js_render: noJs ? 'false' : 'true',
    premium_proxy: premium ? 'true' : 'false',
  });

  let httpStatus = null;
  let creditsLeft = null;
  let html = '';
  let errorMsg = null;

  try {
    const response = await fetch(`${ZENROWS_ENDPOINT}?${params.toString()}`);
    httpStatus = parseInt(response.headers.get('x-statuscode') || String(response.status), 10);
    const creditsHdr = response.headers.get('x-credit-left');
    creditsLeft = creditsHdr && !isNaN(creditsHdr) ? parseInt(creditsHdr, 10) : null;
    html = await response.text();
    if (!response.ok) {
      errorMsg = `ZenRows wrapper returned ${response.status}: ${html.slice(0, 300)}`;
    }
  } catch (err) {
    errorMsg = `Fetch threw: ${err.message}`;
  }

  const agents = extractAgents(html, targetUrl);

  const debugFields = {};
  if (debug) {
    // Return the __NEXT_DATA__ script contents (first 3000 chars)
    const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]{0,20000})<\/script>/);
    debugFields.next_data_first_3000 = nextDataMatch ? nextDataMatch[1].slice(0, 3000) : null;
    // Return snippets of all "agentName" occurrences
    const occ = [];
    let idx = 0;
    while (idx < html.length && occ.length < 5) {
      const i = html.indexOf('"agentName"', idx);
      if (i < 0) break;
      occ.push(html.slice(i, i + 400));
      idx = i + 1;
    }
    debugFields.agent_name_snippets = occ;
    // If there's a JSON with "agents":[
    const agentsArrIdx = html.indexOf('"agents":[');
    if (agentsArrIdx >= 0) {
      debugFields.agents_array_snippet = html.slice(agentsArrIdx, agentsArrIdx + 1500);
    }
    // Search for other likely keys
    for (const key of ['"person":', '"advertiser_id":', '"agent_rating":', '"agentList":', '"searchResults":']) {
      const j = html.indexOf(key);
      if (j >= 0) debugFields[`snippet_${key.replace(/[":]/g, '')}`] = html.slice(j, j + 500);
    }
  }

  return res.status(200).json({
    status: errorMsg ? 'FAIL' : (agents.length > 0 ? 'PASS' : 'EMPTY'),
    http_status: httpStatus,
    target_url: targetUrl,
    html_bytes: html.length,
    agent_count: agents.length,
    credits_left: creditsLeft,
    error_if_any: errorMsg,
    agents,
    ...(returnRaw ? { raw_html: html } : {}),
    ...debugFields,
  });
}

/**
 * Extract agent records from a Realtor.com agent-directory page HTML.
 *
 * Realtor.com uses Next.js and embeds structured data in a <script id="__NEXT_DATA__"> tag.
 * The structure varies by page version; this function tries multiple extraction strategies
 * and returns whatever it can find.
 *
 * @param {string} html - Raw HTML from the page
 * @param {string} sourceUrl - The URL that was scraped (for source attribution)
 * @returns {Array<Object>} - Array of agent records
 */
function extractAgents(html, sourceUrl) {
  const results = [];
  const seen = new Set();

  if (!html || html.length < 1000) return results;

  // Strategy 1: __NEXT_DATA__ JSON blob (older Realtor.com pages)
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const arr = findAgentArraysDeep(data);
      for (const a of arr) {
        const r = normalizeAgent(a, sourceUrl);
        if (r && r.name && !seen.has(r.dedupe_key)) { seen.add(r.dedupe_key); results.push(r); }
      }
      if (results.length > 0) return results;
    } catch { /* fall through */ }
  }

  // Strategy 2: Find "agents":[ ... ] arrays using proper bracket balancing.
  // Realtor.com (current) uses Apollo GraphQL — the payload is inline JSON in a
  // <script> tag as a string. The `"agents":[` array holds the actual list.
  // Occurrence count: usually just 1 per page.
  let searchFrom = 0;
  while (searchFrom < html.length) {
    const startKey = html.indexOf('"agents":[', searchFrom);
    if (startKey < 0) break;
    const arrStart = startKey + '"agents":'.length; // points at '['
    const arrEnd = findMatchingBracket(html, arrStart);
    if (arrEnd < 0) break;
    const arrayJson = html.slice(arrStart, arrEnd + 1);
    searchFrom = arrEnd + 1;
    // Try to parse
    try {
      const parsed = JSON.parse(arrayJson);
      if (Array.isArray(parsed)) {
        for (const a of parsed) {
          const r = normalizeAgent(a, sourceUrl);
          if (r && r.name && !seen.has(r.dedupe_key)) { seen.add(r.dedupe_key); results.push(r); }
        }
      }
    } catch {
      // Some payloads escape the JSON inside a JS string literal — try unescaping
      try {
        const unescaped = arrayJson
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\')
          .replace(/\\n/g, '\n');
        const parsed = JSON.parse(unescaped);
        if (Array.isArray(parsed)) {
          for (const a of parsed) {
            const r = normalizeAgent(a, sourceUrl);
            if (r && r.name && !seen.has(r.dedupe_key)) { seen.add(r.dedupe_key); results.push(r); }
          }
        }
      } catch { /* skip this array */ }
    }
  }
  if (results.length > 0) return results;

  // Strategy 3: Regex fallback — individual agent JSON objects.
  // Matches the Realtor.com Apollo shape: {"id":"...","fullname":"...","broker":{"name":"..."},"office":{"name":"..."},"listing_stats":{...}}
  const objRegex = /"id"\s*:\s*"([a-f0-9]{16,32})"[\s\S]{0,3000}?"fullname"\s*:\s*"([^"]{2,120})"[\s\S]{0,3000}?"(?:broker|office)"\s*:\s*\{[\s\S]{0,300}?"name"\s*:\s*"([^"]{0,150})"/g;
  let m;
  while ((m = objRegex.exec(html)) !== null) {
    const id = m[1];
    const name = m[2].trim().replace(/\s+/g, ' ');
    const brokerage = m[3].trim().replace(/\s+/g, ' ');
    if (!name || name.length < 3) continue;
    const key = `${name.toLowerCase()}|${brokerage.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Try to extract for_sale / recently_sold counts + first-listing city from surrounding context
    const ctx = html.slice(m.index, m.index + 5000);
    const forSaleMatch = ctx.match(/"for_sale"\s*:\s*\{[^}]*?"count"\s*:\s*(\d{1,4})/);
    const soldMatch = ctx.match(/"recently_sold_annual"\s*:\s*\{[^}]*?"count"\s*:\s*(\d{1,4})/);
    const cityMatch = ctx.match(/"city"\s*:\s*"([^"]{2,60})"[^{]*?"state_code"\s*:\s*"TX"/);
    const zipMatch = ctx.match(/"postal_code"\s*:\s*"?(78\d{3})"?/);
    results.push({
      name,
      brokerage,
      phone: '',
      city: cityMatch ? cityMatch[1] : '',
      zip: zipMatch ? zipMatch[1] : '',
      email: '',
      profile_url: `https://www.realtor.com/realestateagents/${id}`,
      agent_id: id,
      bio_first_sentence: '',
      listings_for_sale: forSaleMatch ? parseInt(forSaleMatch[1], 10) : null,
      recently_sold_annual: soldMatch ? parseInt(soldMatch[1], 10) : null,
      source: 'zenrows_realtor',
      scraped_from: sourceUrl,
      dedupe_key: key,
    });
  }

  return results;
}

/**
 * Find the position of the closing bracket matching the opening bracket at `start`.
 * Handles nested brackets AND string literals (skips brackets inside strings).
 * Returns -1 if no match found.
 */
function findMatchingBracket(html, start) {
  const open = html[start];
  const close = open === '[' ? ']' : open === '{' ? '}' : '';
  if (!close) return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  const max = Math.min(html.length, start + 5_000_000); // 5 MB safety cap
  for (let i = start; i < max; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Recursively walk a JSON object and find arrays that look like agent lists.
 * An "agent-like" object has `agentName` or `name` + (`brokerage` or `advertiser_id`).
 */
function findAgentArraysDeep(node, depth = 0, acc = []) {
  if (depth > 15 || !node) return acc;
  if (Array.isArray(node)) {
    // Is this array full of agent objects?
    let agentish = 0;
    let sampleChecked = 0;
    for (const item of node) {
      if (sampleChecked >= 3) break;
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        sampleChecked++;
        const keys = Object.keys(item);
        if (
          keys.includes('agentName') ||
          keys.includes('advertiser_id') ||
          (keys.includes('name') && (keys.includes('brokerage') || keys.includes('phones') || keys.includes('phone') || keys.includes('office'))) ||
          keys.includes('person')
        ) agentish++;
      }
    }
    if (agentish >= 2 && node.length >= 2) {
      for (const item of node) if (item && typeof item === 'object') acc.push(item);
      return acc; // Found the list; don't descend further
    }
    // Otherwise descend
    for (const item of node) findAgentArraysDeep(item, depth + 1, acc);
    return acc;
  }
  if (typeof node === 'object') {
    for (const k of Object.keys(node)) findAgentArraysDeep(node[k], depth + 1, acc);
  }
  return acc;
}

function normalizeAgent(a, sourceUrl) {
  if (!a || typeof a !== 'object') return null;
  // Realtor.com Apollo shape uses `fullname`; older shapes use `agentName`, `full_name`, `name`
  const name = String(
    a.fullname || a.agentName || a.full_name || a.name ||
    (a.person && (a.person.name || a.person.fullname)) || ''
  ).trim().replace(/\s+/g, ' ');
  if (!name || name.length < 3) return null;

  // Filter out teams / groups — cold email is for solo agents
  const isTeam = /\b(team|group|partners|associates|realty group)\b/i.test(name);

  // Brokerage — Realtor.com Apollo uses `broker.name` (the umbrella) and `office.name`
  // (the local office). Prefer office.name since it's more specific.
  let brokerage = '';
  if (a.office?.name) brokerage = a.office.name;
  else if (a.broker?.name) brokerage = a.broker.name;
  else if (a.brokerage?.name) brokerage = a.brokerage.name;
  else if (typeof a.brokerage === 'string') brokerage = a.brokerage;
  else if (a.brokerageName) brokerage = a.brokerageName;
  brokerage = String(brokerage || '').trim().replace(/\s+/g, ' ');

  // Phone — Realtor.com hides on directory pages; check anyway
  let phone = '';
  if (typeof a.phone === 'string') phone = a.phone;
  else if (a.phone?.number) phone = a.phone.number;
  else if (Array.isArray(a.phones) && a.phones[0]) phone = a.phones[0].number || a.phones[0];
  else if (a.office?.phones?.[0]?.number) phone = a.office.phones[0].number;
  else if (a.office?.phone_list?.phone_1?.number) phone = a.office.phone_list.phone_1.number;
  else if (a.mobile_phone) phone = a.mobile_phone;
  phone = normalizePhone(String(phone || '').trim());

  // City — from address, office.address, or nested listings
  let city = '';
  if (a.address?.city) city = a.address.city;
  else if (a.office?.address?.city) city = a.office.address.city;
  else if (a.city) city = a.city;
  city = String(city || '').trim();

  // ZIP
  let zip = '';
  if (a.address?.postal_code) zip = a.address.postal_code;
  else if (a.office?.address?.postal_code) zip = a.office.address.postal_code;
  else if (a.zip) zip = a.zip;
  zip = String(zip || '').trim();

  // Agent ID / profile URL — Apollo shape uses `id` (mongo-style)
  const advId = String(a.id || a.advertiser_id || a.person?.advertiser_id || a.fulfillment_id || '').trim();
  let profileUrl = '';
  if (a.href) profileUrl = a.href.startsWith('http') ? a.href : `https://www.realtor.com${a.href}`;
  else if (a.web_url) profileUrl = a.web_url.startsWith('http') ? a.web_url : `https://www.realtor.com${a.web_url}`;
  else if (advId) profileUrl = `https://www.realtor.com/realestateagents/${advId}`;

  // Bio — first sentence
  let bio = '';
  if (a.description) bio = a.description;
  else if (a.bio) bio = a.bio;
  else if (a.tagline) bio = a.tagline;
  else if (a.person?.bio) bio = a.person.bio;
  bio = String(bio || '').replace(/\s+/g, ' ').trim();
  const bioFirstSentence = (bio.split(/(?<=[.!?])\s+(?=[A-Z])/)[0] || bio).slice(0, 200);

  // Listing stats — great personalization signals from Apollo payload
  const listingsForSale = a.listing_stats?.for_sale?.count ?? null;
  const soldAnnual = a.listing_stats?.recently_sold_annual?.count ?? null;
  // Pull first recently-sold city as a hint for their focus area
  const soldListings = a.listing_stats?.recently_sold_listing_details?.listings || [];
  let focusCity = '';
  if (soldListings.length > 0 && soldListings[0].city) focusCity = soldListings[0].city;
  if (!city && focusCity) city = focusCity;

  // Rating (peer trust signal, useful for personalization)
  const avgRating = a.ratings_reviews?.average_rating ?? null;
  const reviewCount = a.ratings_reviews?.reviews_count ?? null;
  const recommendationsCount = a.ratings_reviews?.recommendations_count ?? null;

  // Email — rarely present in the SSR blob, but check
  const email = String(a.email || a.person?.email || '').trim();

  const dedupe_key = `${name.toLowerCase()}|${brokerage.toLowerCase()}`;

  return {
    name,
    brokerage,
    phone,
    city,
    zip,
    email,
    profile_url: profileUrl,
    agent_id: advId,
    bio_first_sentence: bioFirstSentence,
    listings_for_sale: listingsForSale,
    recently_sold_annual: soldAnnual,
    avg_rating: avgRating,
    review_count: reviewCount,
    recommendations_count: recommendationsCount,
    is_team: isTeam,
    source: 'zenrows_realtor',
    scraped_from: sourceUrl,
    dedupe_key,
  };
}

function normalizePhone(p) {
  if (!p) return '';
  const digits = String(p).replace(/[^\d]/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits[0] === '1') return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return p;
}
