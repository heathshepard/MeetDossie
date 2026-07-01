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

  const params = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: targetUrl,
    js_render: 'true',
    premium_proxy: 'true',
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

  // Strategy 1: __NEXT_DATA__ JSON blob
  const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const agents = findAgentArraysDeep(data);
      for (const a of agents) {
        const record = normalizeAgent(a, sourceUrl);
        if (record && record.name && !seen.has(record.dedupe_key)) {
          seen.add(record.dedupe_key);
          results.push(record);
        }
      }
      if (results.length > 0) return results;
    } catch (e) {
      // Fall through to regex strategies
    }
  }

  // Strategy 2: Inline JSON script blocks (some Next.js pages hydrate via multiple scripts)
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
  let sm;
  while ((sm = scriptRegex.exec(html)) !== null) {
    const script = sm[1];
    if (!script.includes('agentName') && !script.includes('"person"') && !script.includes('advertiser_id')) continue;
    // Look for a JSON object hosting an agents array
    const agentsArrayMatch = script.match(/"agents"\s*:\s*(\[[\s\S]*?\])(?=,\s*"[a-z_]|})/);
    if (agentsArrayMatch) {
      try {
        const arr = JSON.parse(agentsArrayMatch[1]);
        for (const a of arr) {
          const r = normalizeAgent(a, sourceUrl);
          if (r && r.name && !seen.has(r.dedupe_key)) {
            seen.add(r.dedupe_key);
            results.push(r);
          }
        }
      } catch { /* ignore */ }
    }
  }
  if (results.length > 0) return results;

  // Strategy 3: Regex over the full HTML for individual "agentName" JSON fragments.
  // Realtor.com sometimes emits each agent as a discrete JSON block.
  //   "agentName":"Jane Doe","brokerage":{"name":"XYZ Realty",...},"phone":"210-555-1234",...
  const agentBlockRegex = /"agentName"\s*:\s*"([^"]{2,80})"[\s\S]{0,2500}?(?:"brokerage"\s*:\s*(?:"([^"]{0,150})"|\{[\s\S]{0,500}?"name"\s*:\s*"([^"]{0,150})"))?[\s\S]{0,1500}?(?:"phones?"\s*:\s*(?:\[[\s\S]{0,300}?"number"\s*:\s*"([^"]{7,20})"|"([^"]{7,20})"))?[\s\S]{0,500}?(?:"advertiser_id"\s*:\s*(?:"([^"]{4,40})"|(\d{4,40})))?/g;
  let m;
  while ((m = agentBlockRegex.exec(html)) !== null) {
    const name = m[1].trim();
    const brokerage = (m[2] || m[3] || '').trim();
    const phone = (m[4] || m[5] || '').trim();
    const advId = (m[6] || m[7] || '').trim();
    const key = `${name.toLowerCase()}|${brokerage.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      name,
      brokerage,
      phone: normalizePhone(phone),
      city: 'San Antonio',
      email: '',
      profile_url: advId ? `https://www.realtor.com/realestateagents/${advId}` : '',
      agent_id: advId,
      source: 'zenrows_realtor',
      dedupe_key: key,
    });
  }

  return results;
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
  const name = (a.agentName || a.full_name || a.name || a.person?.name || '').trim();
  if (!name || name.length < 3) return null;

  // Brokerage — several shapes
  let brokerage = '';
  if (typeof a.brokerage === 'string') brokerage = a.brokerage;
  else if (a.brokerage?.name) brokerage = a.brokerage.name;
  else if (a.office?.name) brokerage = a.office.name;
  else if (a.broker?.name) brokerage = a.broker.name;
  else if (a.brokerageName) brokerage = a.brokerageName;
  brokerage = String(brokerage || '').trim();

  // Phone — several shapes
  let phone = '';
  if (typeof a.phone === 'string') phone = a.phone;
  else if (a.phone?.number) phone = a.phone.number;
  else if (Array.isArray(a.phones) && a.phones[0]) phone = a.phones[0].number || a.phones[0];
  else if (a.office?.phones?.[0]?.number) phone = a.office.phones[0].number;
  else if (a.office?.phone_list?.phone_1?.number) phone = a.office.phone_list.phone_1.number;
  phone = normalizePhone(String(phone || '').trim());

  // City
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

  // Agent ID / profile URL
  const advId = String(a.advertiser_id || a.person?.advertiser_id || a.id || '').trim();
  const slug = a.slogan || a.web_url || '';
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
