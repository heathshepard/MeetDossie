const { withTelemetry } = require('./_lib/cron-telemetry.js');

'use strict';

// api/cron-competitor-intel.js
//
// Weekly competitor intelligence digest.
// Fetches public pages for DealDock, ListedKit, Done Deal, and top TC software
// search results. Extracts pricing mentions and notable claims.
// Sends a Telegram digest to DossieMarketingBot.
//
// Schedule: Sundays 14:00 UTC (8AM CST) via cron-job.org
// Auth: CRON_SECRET bearer token
// Env vars: TELEGRAM_MARKETING_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Targets: URL + label + what to look for
const TARGETS = [
  {
    label: 'DealDock',
    urls: [
      'https://dealdock.io/pricing',
      'https://dealdock.io',
    ],
    keywords: ['price', 'pricing', 'per month', '/mo', '/year', 'plan', 'free', 'trial', 'features'],
  },
  {
    label: 'ListedKit',
    urls: [
      'https://listedkit.com/pricing',
      'https://listedkit.com',
    ],
    keywords: ['price', 'pricing', 'per month', '/mo', 'plan', 'transaction coordinator', 'TC'],
  },
  {
    label: 'Done Deal TC',
    urls: [
      'https://donedealtc.com',
      'https://donedealtc.com/pricing',
    ],
    keywords: ['price', 'pricing', 'Texas', 'TC software', 'per month', '/mo'],
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────
async function fetchPage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DossieBot/1.0)',
        Accept: 'text/html',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return { url, ok: false, status: res.status, text: null };
    const text = await res.text();
    return { url, ok: true, status: res.status, text };
  } catch (err) {
    return { url, ok: false, status: 0, text: null, error: err.message };
  }
}

function extractPricingMentions(html, keywords) {
  if (!html) return [];

  // Strip HTML tags and normalize whitespace
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

  const sentences = stripped.split(/[.!?\n]/);
  const matches = [];

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    const hasKeyword = keywords.some((kw) => lower.includes(kw.toLowerCase()));
    if (!hasKeyword) continue;
    const trimmed = sentence.trim();
    if (trimmed.length < 10 || trimmed.length > 300) continue;
    // Filter out obvious noise (nav items, short fragments)
    if (trimmed.split(' ').length < 3) continue;
    matches.push(trimmed);
  }

  // Dedupe and cap at 3 most relevant
  const unique = [...new Set(matches)].slice(0, 3);
  return unique;
}

async function gatherIntel() {
  const results = [];

  for (const target of TARGETS) {
    const mentions = [];
    let fetched = false;

    for (const url of target.urls) {
      const page = await fetchPage(url);
      if (page.ok && page.text) {
        const extracted = extractPricingMentions(page.text, target.keywords);
        mentions.push(...extracted);
        fetched = true;
        break; // Got a page, no need to try fallback URL
      }
    }

    results.push({
      label: target.label,
      fetched,
      mentions: [...new Set(mentions)].slice(0, 3),
    });
  }

  return results;
}

function buildDigest(results) {
  const date = new Date().toLocaleDateString('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  const lines = [`Competitor Intel - ${date}`];

  let hasAnyMentions = false;

  for (const { label, fetched, mentions } of results) {
    if (!fetched) {
      lines.push(`\n${label}: site unreachable`);
      continue;
    }
    if (mentions.length === 0) {
      lines.push(`\n${label}: fetched, no pricing data found`);
      continue;
    }
    hasAnyMentions = true;
    lines.push(`\n${label}:`);
    for (const m of mentions) {
      // Keep each mention brief
      const snippet = m.length > 120 ? m.slice(0, 117) + '...' : m;
      lines.push(`- ${snippet}`);
    }
  }

  if (!hasAnyMentions) {
    lines.push('\nNo pricing changes detected. Sites may have JS-rendered pricing (manual check recommended).');
  }

  // Telegram cap: 500 chars for digest
  let full = lines.join('\n');
  if (full.length > 480) {
    full = full.slice(0, 477) + '...';
  }
  return full;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('[cron-competitor-intel] Telegram not configured');
    return false;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    }),
  });
  const data = await res.json().catch(() => null);
  return data?.ok === true;
}

// ── handler ──────────────────────────────────────────────────────────────────
module.exports = withTelemetry('cron-competitor-intel', async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'method not allowed' });
  }

  // Auth check
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    console.warn('[cron-competitor-intel] unauthorized request');
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  console.log('[cron-competitor-intel] starting run');

  try {
    const intel = await gatherIntel();
    const digest = buildDigest(intel);

    console.log('[cron-competitor-intel] digest:', digest);

    const sent = await sendTelegram(digest);

    return res.status(200).json({
      ok: true,
      sent,
      competitors: intel.map(({ label, fetched, mentions }) => ({
        label,
        fetched,
        mention_count: mentions.length,
      })),
    });
  } catch (err) {
    console.error('[cron-competitor-intel] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});
