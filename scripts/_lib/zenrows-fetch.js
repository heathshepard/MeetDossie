'use strict';

/**
 * ZenRows Managed Scraping API Wrapper
 *
 * Provides a unified interface for scraping bot-protected sites using ZenRows.
 * Handles rate-limiting, retry logic, and cost tracking.
 *
 * Setup:
 *   1. Sign up at https://www.zenrows.com/signup (free trial, no card, 1k requests)
 *   2. Copy API key from dashboard
 *   3. Set ZENROWS_API_KEY in Vercel env vars
 *
 * Usage:
 *   const { zenrowsFetch, extractStructured } = require('./_lib/zenrows-fetch');
 *   const html = await zenrowsFetch('https://www.realtor.com/...');
 *   const agents = await extractStructured(html, {
 *     selector: '[data-testid="agent-card"]',
 *     fields: { name: '[data-testid="agent-name"]', brokerage: '...' }
 *   });
 *
 * Cost:
 *   - Free trial: 1,000 requests
 *   - Premium proxy (standard on free trial): ~10 credits per request
 *   - JS rendering: included
 *   - Retry (429 from ZenRows): automatic, costs extra credits
 *
 * Constraints:
 *   - Do NOT use for authenticated endpoints (login-required pages)
 *   - DO use for: Realtor.com, Zillow, Homes.com, news sites, public agent profiles
 *   - Fallback to raw Playwright for simple sites without bot detection
 */

const ZENROWS_ENDPOINT = 'https://api.zenrows.com/v1/';
const ZENROWS_API_KEY = process.env.ZENROWS_API_KEY || '';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 5000;

let costThisSession = 0;

/**
 * Fetch a URL via ZenRows, handling retries and errors.
 *
 * @param {string} url - Target URL to scrape
 * @param {Object} options
 * @param {boolean} options.jsRender - Enable JS rendering (default: true)
 * @param {boolean} options.premiumProxy - Use premium proxy (default: true)
 * @param {number} options.timeout - Request timeout in ms (default: 30000)
 * @returns {Promise<string>} Raw HTML
 * @throws {Error} If no API key, max retries exceeded, or HTTP error
 */
async function zenrowsFetch(url, options = {}) {
  if (!ZENROWS_API_KEY) {
    throw new Error('ZENROWS_API_KEY not set. Sign up at https://www.zenrows.com/signup and set env var.');
  }

  const {
    jsRender = true,
    premiumProxy = true,
    timeout = 30000,
  } = options;

  const params = new URLSearchParams({
    apikey: ZENROWS_API_KEY,
    url: url,
    js_render: jsRender ? 'true' : 'false',
    premium_proxy: premiumProxy ? 'true' : 'false',
  });

  let lastError;
  let attempt = 0;

  while (attempt <= MAX_RETRIES) {
    attempt++;
    try {
      const response = await fetch(
        `${ZENROWS_ENDPOINT}?${params.toString()}`,
        { timeout }
      );

      // ZenRows returns 200 even on target-site errors; check X-StatusCode header
      const statusCode = response.headers.get('x-statuscode') || response.status;
      const costStr = response.headers.get('x-credit-left') || '0';

      // Track credits
      if (costStr && !isNaN(costStr)) {
        const creditsLeft = parseInt(costStr, 10);
        costThisSession = Math.max(0, 1000 - creditsLeft); // rough estimate
      }

      // 429 from ZenRows = too many requests, retry
      if (statusCode === 429 && attempt <= MAX_RETRIES) {
        console.warn(`[ZenRows] 429 Too Many Requests (attempt ${attempt}/${MAX_RETRIES}). Waiting ${RETRY_DELAY_MS}ms...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // 403/401 from target site = blocked despite proxy
      if (statusCode === 403 || statusCode === 401) {
        throw new Error(`Target site returned ${statusCode} (bot detection triggered or auth required). Falling back to raw Playwright.`);
      }

      // 404 or other client errors = real error, don't retry
      if (statusCode >= 400 && statusCode < 500) {
        throw new Error(`Target site returned ${statusCode}.`);
      }

      // 5xx = server error, could be transient
      if (statusCode >= 500 && attempt <= MAX_RETRIES) {
        console.warn(`[ZenRows] Target returned ${statusCode} (attempt ${attempt}/${MAX_RETRIES}). Retrying...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }

      // Success
      const html = await response.text();
      console.log(`[ZenRows] Fetched ${url} (${statusCode}, ${html.length} bytes, credits used: ~${1000 - parseInt(costStr || '1000', 10)})`);
      return html;

    } catch (err) {
      lastError = err;
      if (attempt <= MAX_RETRIES) {
        console.warn(`[ZenRows] Attempt ${attempt} failed: ${err.message}. Retrying...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }

  throw new Error(
    `ZenRows fetch failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message || 'unknown error'}`
  );
}

/**
 * Extract structured data from HTML using CSS selectors.
 *
 * Attempts to use jsdom if available; falls back to a basic regex-based parser.
 * The regex fallback is lower-fidelity but requires no additional dependencies.
 *
 * @param {string} html - HTML string
 * @param {Object} spec - Extraction specification
 * @param {string} spec.selector - CSS selector for repeated elements (e.g., card selector)
 * @param {Object} spec.fields - Map of field names to CSS selectors within each element
 * @returns {Promise<Array>} Array of objects with extracted data
 *
 * Example:
 *   const agents = await extractStructured(html, {
 *     selector: '[data-testid="agent-card"]',
 *     fields: {
 *       name: '[data-testid="agent-name"]',
 *       brokerage: '[data-testid="agent-brokerage"]',
 *       phone: '.phone-number'
 *     }
 *   });
 */
async function extractStructured(html, spec) {
  const { selector, fields } = spec;

  if (!selector || !fields || Object.keys(fields).length === 0) {
    throw new Error('extractStructured requires selector and fields object');
  }

  // Try jsdom first (more accurate)
  try {
    const { JSDOM } = await import('jsdom');
    const dom = new JSDOM(html);
    const { document } = dom.window;

    const results = [];
    const elements = document.querySelectorAll(selector);

    for (const element of elements) {
      const row = {};
      for (const [fieldName, fieldSelector] of Object.entries(fields)) {
        const fieldEl = element.querySelector(fieldSelector);
        row[fieldName] = fieldEl?.textContent?.trim() || '';
      }
      // Only add if at least one field has content
      if (Object.values(row).some(v => v)) {
        results.push(row);
      }
    }

    return results;
  } catch (jsdomErr) {
    // Fallback: basic regex extraction (assumes simple HTML structure)
    console.warn('[ZenRows] jsdom not available, using regex fallback for extraction');

    // Convert CSS selectors to rough regex patterns (very limited)
    // This handles simple data-testid selectors but won't work for complex CSS
    const results = [];

    // Extract data-testid="agent-card" sections
    const testIdPattern = selector.includes('data-testid=')
      ? new RegExp(`<[^>]+data-testid="${selector.match(/data-testid="([^"]+)"/)?.[1] || ''}[^>]*>([\\s\\S]*?)</[^>]+>`, 'g')
      : null;

    if (testIdPattern) {
      let match;
      while ((match = testIdPattern.exec(html)) !== null) {
        const cardHtml = match[2] || '';
        const row = {};

        for (const [fieldName, fieldSelector] of Object.entries(fields)) {
          let value = '';

          // Try to match data-testid in field selector
          if (fieldSelector.includes('data-testid=')) {
            const testId = fieldSelector.match(/data-testid="([^"]+)"/)?.[1];
            if (testId) {
              const fieldMatch = cardHtml.match(new RegExp(`data-testid="${testId}"[^>]*>([^<]+)<`));
              value = fieldMatch?.[1]?.trim() || '';
            }
          } else if (fieldSelector.includes('href^=')) {
            // Phone link: href^="tel:"
            const phoneMatch = cardHtml.match(/href="tel:([^"]+)"/);
            value = phoneMatch?.[1]?.trim() || '';
          } else if (fieldSelector.startsWith('.')) {
            // Class selector
            const className = fieldSelector.slice(1);
            const classMatch = cardHtml.match(new RegExp(`class="[^"]*${className}[^"]*"[^>]*>([^<]+)<`));
            value = classMatch?.[1]?.trim() || '';
          }

          row[fieldName] = value;
        }

        if (Object.values(row).some(v => v)) {
          results.push(row);
        }
      }
    }

    return results;
  }
}

/**
 * Get cost summary for the current session.
 *
 * @returns {Object} { usedThisSession, estimatedCreditsLeft }
 */
function getCostSummary() {
  return {
    usedThisSession: costThisSession,
    estimatedCreditsLeft: 1000 - costThisSession,
    freeTrialLimit: 1000,
  };
}

module.exports = {
  zenrowsFetch,
  extractStructured,
  getCostSummary,
};
