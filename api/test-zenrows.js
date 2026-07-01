/**
 * TEMPORARY DIAGNOSTIC — verify ZENROWS_API_KEY works end-to-end from Vercel env.
 *
 * DELETE THIS FILE after Atlas confirms PASS. This is a one-off route to prove
 * the ZenRows bypass returns real Realtor.com HTML with agent cards. Not for
 * long-term use. Gated behind CRON_SECRET so random visitors can't burn credits.
 *
 * Usage:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *     https://<staging-preview-url>/api/test-zenrows
 *
 * Response shape:
 *   { status, http_status, agent_count, credits_used_estimate, credits_left,
 *     error_if_any, sample_first_3_names, target_url, html_bytes }
 */

'use strict';

const ZENROWS_ENDPOINT = 'https://api.zenrows.com/v1/';
const TARGET_URL = 'https://www.realtor.com/realestateagents/san-antonio_tx';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  // Auth gate — CRON_SECRET only. No public access, no credit drain.
  const CRON_SECRET = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!CRON_SECRET || bearer !== CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY || '';
  if (!ZENROWS_API_KEY) {
    return res.status(500).json({
      status: 'FAIL',
      error_if_any: 'ZENROWS_API_KEY env var not set on this deployment',
    });
  }

  const params = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: TARGET_URL,
    js_render: 'true',
    premium_proxy: 'true',
  });

  let httpStatus = null;
  let creditsLeft = null;
  let html = '';
  let errorMsg = null;

  try {
    const response = await fetch(`${ZENROWS_ENDPOINT}?${params.toString()}`);
    // ZenRows uses x-statuscode to convey target-site status; response.status is the wrapper
    httpStatus = parseInt(response.headers.get('x-statuscode') || String(response.status), 10);
    const creditsHdr = response.headers.get('x-credit-left');
    creditsLeft = creditsHdr && !isNaN(creditsHdr) ? parseInt(creditsHdr, 10) : null;
    html = await response.text();

    // Non-2xx from wrapper = ZenRows-level failure (bad key, out of credits, etc.)
    if (!response.ok) {
      errorMsg = `ZenRows wrapper returned ${response.status}: ${html.slice(0, 300)}`;
    }
  } catch (err) {
    errorMsg = `Fetch threw: ${err.message}`;
  }

  // Count agent cards. Realtor.com uses several patterns; try the common ones.
  // Heuristics — we count whichever selector fires. Cheap regex, no jsdom dep needed for diagnostic.
  const patterns = [
    /data-testid="agent-card"/g,
    /data-testid="component_agentCard"/g,
    /class="[^"]*agent-list-card[^"]*"/g,
    /class="[^"]*agent_card[^"]*"/g,
    /data-testid="agent-name"/g,
    /"agentName":/g,
    /"person":\s*\{/g,
    /itemtype="[^"]*schema\.org\/RealEstateAgent"/g,
    /class="[^"]*AgentCard[^"]*"/g,
    /class="[^"]*jsx-\d+ [^"]*agent[^"]*"/gi,
    /"agent_rating":/g,
    /"advertiser_id":/g,
  ];
  let agentCount = 0;
  let matchedPattern = null;
  for (const pat of patterns) {
    const matches = html.match(pat);
    if (matches && matches.length > agentCount) {
      agentCount = matches.length;
      matchedPattern = pat.source;
    }
  }

  // Sample first 3 names — try a couple of common patterns
  const sampleNames = [];
  const nameRegexes = [
    /data-testid="agent-name"[^>]*>([^<]{2,80})</g,
    /class="[^"]*agent-name[^"]*"[^>]*>([^<]{2,80})</g,
    /itemprop="name"[^>]*>([^<]{2,80})</g,
  ];
  for (const rx of nameRegexes) {
    let m;
    while ((m = rx.exec(html)) !== null && sampleNames.length < 3) {
      const name = m[1].trim();
      if (name && !sampleNames.includes(name)) sampleNames.push(name);
    }
    if (sampleNames.length >= 3) break;
  }

  const creditsUsedEstimate = creditsLeft != null
    ? `roughly 10 (credits-left header: ${creditsLeft})`
    : 'unknown (no x-credit-left header)';

  const pass = !errorMsg && httpStatus === 200 && agentCount > 0;

  // Debug helpers — snippets of the HTML so we can see what selectors to update
  const titleMatch = html.match(/<title[^>]*>([^<]{0,200})<\/title>/i);
  const pageTitle = titleMatch ? titleMatch[1].trim() : null;
  const hasAgentWord = /agent/i.test(html);
  const looksLikeCaptcha = /captcha|are you a human|blocked|access denied/i.test(html);

  // First 400 chars of body, first 400 chars around first occurrence of "agent"
  const bodyStart = html.slice(0, 400);
  const agentIdx = html.toLowerCase().indexOf('agent');
  const agentSnippet = agentIdx >= 0
    ? html.slice(Math.max(0, agentIdx - 80), agentIdx + 400)
    : null;

  return res.status(200).json({
    status: pass ? 'PASS' : 'FAIL',
    http_status: httpStatus,
    agent_count: agentCount,
    matched_pattern: matchedPattern,
    credits_used_estimate: creditsUsedEstimate,
    credits_left: creditsLeft,
    error_if_any: errorMsg,
    sample_first_3_names: sampleNames,
    target_url: TARGET_URL,
    html_bytes: html.length,
    page_title: pageTitle,
    looks_like_captcha: looksLikeCaptcha,
    has_agent_word: hasAgentWord,
    body_start_400: bodyStart,
    agent_snippet_400: agentSnippet,
    note: 'Temporary diagnostic route. Delete after PASS.',
  });
}
