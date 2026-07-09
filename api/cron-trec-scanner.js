// Vercel Serverless Function: /api/cron-trec-scanner
//
// TREC.gov nightly scanner. Fetches TREC news, rules, and forms pages,
// diffs against last-scanned snapshot, and when ANY change is detected
// asks Claude to summarize what changed, effective date, affected forms,
// and severity. Writes to public.trec_updates.
//
// Real differentiator vs Lone Wolf: Dossie tells founding members about
// TREC changes BEFORE they hit their contracts.
//
// SV-TREC-SCANNER-001 (Atlas, 2026-07-08).
//
// Schedule: 0 8 * * * (3am CT — 8am UTC) via vercel.json.
//
// Auth: Vercel cron header OR Authorization: Bearer $CRON_SECRET.
//
// Env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   ANTHROPIC_API_KEY  (Claude summarizer)
//   CRON_SECRET
//
// Test mode:
//   ?inject=fake-update  → synthesizes a single test row into trec_updates
//                          so the alert pipeline can be exercised end to end
//                          without waiting for TREC to actually change.
//                          Test rows have synthetic=true and are auto-purged
//                          after 24h by cron-trec-member-alerts.
//
// Rate-limit / etiquette:
//   - User-Agent identifies Dossie
//   - Small delay between page fetches (400ms)
//   - No aggressive re-fetching (once per day)
//   - Respects TREC's public robots.txt (we only hit pages that a browser hits)

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const crypto = require('crypto');

const CRON_SECRET = process.env.CRON_SECRET;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const USER_AGENT = 'Dossie-TREC-Watch/1.0 (+https://meetdossie.com; heath@meetdossie.com)';

// Pages we monitor. source_type helps downstream classification.
const TARGETS = [
  {
    url: 'https://www.trec.texas.gov/announcements',
    type: 'trec_news',
    label: 'TREC Announcements',
  },
  {
    url: 'https://www.trec.texas.gov/agency-information/rules-and-laws',
    type: 'trec_rules',
    label: 'TREC Rules & Laws',
  },
  {
    url: 'https://www.trec.texas.gov/forms',
    type: 'trec_form_change',
    label: 'TREC Forms Library',
  },
];

function isAuthed(req) {
  if (req.headers['x-vercel-cron']) return true;
  const auth = req.headers['authorization'] || req.headers['Authorization'];
  if (CRON_SECRET && auth === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s || '').digest('hex');
}

// Fetch a page as a real browser would. Return { ok, status, html, bytes }.
async function fetchPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: controller.signal,
    });
    const html = await res.text();
    return { ok: res.ok, status: res.status, html, bytes: html.length };
  } catch (e) {
    return { ok: false, status: 0, html: '', bytes: 0, error: e.message };
  } finally {
    clearTimeout(timer);
  }
}

// Strip HTML down to text for hashing (avoids trivial layout-only churn).
// Removes scripts, styles, and normalizes whitespace.
function normalizeForHash(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pgGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`pgGet ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

async function pgPost(path, body, prefer = 'return=representation') {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: prefer,
    },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`pgPost ${path}: ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}

async function loadSnapshot(url) {
  const rows = await pgGet(`trec_page_snapshots?source_url=eq.${encodeURIComponent(url)}&select=content_hash,raw_html`);
  return rows[0] || null;
}

async function saveSnapshot(url, hash, html, bytes) {
  await pgPost(
    'trec_page_snapshots?on_conflict=source_url',
    { source_url: url, content_hash: hash, raw_html: html.slice(0, 500000), bytes, fetched_at: new Date().toISOString() },
    'resolution=merge-duplicates,return=minimal'
  );
}

// Ask Claude to interpret a diff. Returns { title, summary, effective_date,
// affects_forms[], severity, source_url }. If Claude is unavailable, returns
// a conservative fallback record so we still capture the change.
async function summarizeDiff({ target, oldText, newText }) {
  const changeSize = Math.abs((newText || '').length - (oldText || '').length);
  const fallback = {
    title: `${target.label} content changed`,
    summary: `The TREC page at ${target.url} changed since the last scan (${changeSize.toLocaleString()} character delta). Review the source page for details. Source: ${target.url}`,
    effective_date: null,
    affects_forms: [],
    severity: 'informational',
  };

  if (!ANTHROPIC_API_KEY) return fallback;

  // Take a bounded slice — first 8k of each side is more than enough to spot
  // any announcement / effective date / form reference.
  const oldSlice = (oldText || '').slice(0, 8000);
  const newSlice = (newText || '').slice(0, 8000);

  const prompt = `You analyze changes to the Texas Real Estate Commission (TREC) website for Dossie, an AI transaction-coordinator platform for Texas REALTORS.

The page ${target.url} (${target.label}) changed since the last scan.

PREVIOUS TEXT (first 8000 chars, HTML stripped):
"""
${oldSlice || '(empty — first scan)'}
"""

CURRENT TEXT (first 8000 chars, HTML stripped):
"""
${newSlice}
"""

Extract ONE update object as strict JSON:
{
  "title": "short human title, under 80 chars",
  "summary": "2-4 sentence plain-English summary of what changed and why a Texas REALTOR should care. Cite the source URL at the end.",
  "effective_date": "YYYY-MM-DD or null",
  "affects_forms": ["20-18", "40-11", ...],   // TREC form numbers referenced, if any
  "severity": "informational" | "action_required" | "critical"
}

Rules:
- If the diff is trivial (navigation-only, no substantive change), return severity="informational" and title starting with "Minor: ".
- "critical" only if a rule change or form deadline is imminent and directly affects live contracts.
- If NO substantive change is detectable, still return a record with title starting with "No substantive change: " and severity="informational".
- End summary with the literal phrase: "Source: ${target.url}"
- Return ONLY the JSON object. No prose.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) {
      console.warn('[trec-scanner] anthropic error', res.status, await res.text());
      return fallback;
    }
    const j = await res.json();
    const raw = (j.content || [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    // Grab first {...} block defensively
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return fallback;
    const parsed = JSON.parse(m[0]);
    // Guardrails
    if (!parsed.title || !parsed.summary) return fallback;
    if (!/Source:\s*https?:/.test(parsed.summary)) {
      parsed.summary = `${parsed.summary.trim()} Source: ${target.url}`;
    }
    if (!['informational', 'action_required', 'critical'].includes(parsed.severity)) {
      parsed.severity = 'informational';
    }
    return {
      title: String(parsed.title).slice(0, 200),
      summary: String(parsed.summary).slice(0, 2000),
      effective_date: parsed.effective_date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.effective_date) ? parsed.effective_date : null,
      affects_forms: Array.isArray(parsed.affects_forms) ? parsed.affects_forms.slice(0, 20).map(String) : [],
      severity: parsed.severity,
    };
  } catch (e) {
    console.warn('[trec-scanner] anthropic threw', e.message);
    return fallback;
  }
}

async function insertUpdate({ target, analysis, rawContent, fingerprint, synthetic = false }) {
  const row = {
    source_url: target.url,
    source_type: target.type,
    title: analysis.title,
    summary: analysis.summary,
    effective_date: analysis.effective_date,
    affects_forms: analysis.affects_forms,
    severity: analysis.severity,
    raw_content: (rawContent || '').slice(0, 40000),
    llm_analysis: analysis,
    member_notified: false,
    synthetic,
    fingerprint,
  };
  try {
    return await pgPost(
      'trec_updates?on_conflict=fingerprint',
      row,
      'resolution=merge-duplicates,return=representation'
    );
  } catch (e) {
    // On fingerprint conflict without upsert semantics, swallow — already logged
    if (/duplicate key/.test(e.message)) return null;
    throw e;
  }
}

async function handleInject(injectKind) {
  if (injectKind !== 'fake-update') return { injected: 0, note: 'unknown inject kind' };
  const target = {
    url: 'https://www.trec.texas.gov/announcements#synthetic-test',
    type: 'trec_news',
    label: 'Synthetic Test',
  };
  const stamp = new Date().toISOString().slice(0, 16);
  const analysis = {
    title: `SYNTHETIC: TREC 20-18 amendment effective 2026-08-01`,
    summary: `Test injection at ${stamp}. This is a synthetic TREC update used to exercise the member-alert pipeline. In production the summary describes the real diff. Source: ${target.url}`,
    effective_date: '2026-08-01',
    affects_forms: ['20-18', '40-11'],
    severity: 'action_required',
  };
  const fingerprint = `synthetic:${stamp}`;
  const rows = await insertUpdate({
    target,
    analysis,
    rawContent: 'Synthetic test row.',
    fingerprint,
    synthetic: true,
  });
  return { injected: rows ? 1 : 0, id: rows && rows[0] && rows[0].id };
}

async function scanOne(target) {
  const prev = await loadSnapshot(target.url);
  const page = await fetchPage(target.url);
  if (!page.ok) {
    return { url: target.url, status: 'fetch_error', http: page.status, error: page.error || null };
  }
  const normalized = normalizeForHash(page.html);
  const hash = sha256(normalized);
  const prevHash = prev && prev.content_hash;
  const prevText = prev && prev.raw_html ? normalizeForHash(prev.raw_html) : '';

  // First scan: baseline only, no update row.
  if (!prevHash) {
    await saveSnapshot(target.url, hash, page.html, page.bytes);
    return { url: target.url, status: 'baseline', bytes: page.bytes };
  }

  // No change: nothing to do.
  if (prevHash === hash) {
    return { url: target.url, status: 'unchanged', bytes: page.bytes };
  }

  // Change detected → summarize + record.
  const analysis = await summarizeDiff({ target, oldText: prevText, newText: normalized });
  const fingerprint = `${target.type}:${hash.slice(0, 24)}`;
  const inserted = await insertUpdate({
    target,
    analysis,
    rawContent: normalized.slice(0, 40000),
    fingerprint,
    synthetic: false,
  });

  // Roll snapshot forward AFTER insert so a crash mid-run doesn't drop the diff.
  await saveSnapshot(target.url, hash, page.html, page.bytes);
  return {
    url: target.url,
    status: 'changed',
    severity: analysis.severity,
    title: analysis.title,
    inserted_id: inserted && inserted[0] && inserted[0].id,
    bytes: page.bytes,
  };
}

async function handler(req, res) {
  if (!isAuthed(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Synthetic-test hook: ?inject=fake-update
  const inject = req.query && req.query.inject;
  if (inject) {
    const injected = await handleInject(String(inject));
    return res.status(200).json({ ok: true, mode: 'inject', ...injected });
  }

  const results = [];
  for (const target of TARGETS) {
    try {
      const r = await scanOne(target);
      results.push(r);
    } catch (e) {
      console.error('[trec-scanner] scan failed', target.url, e);
      results.push({ url: target.url, status: 'error', error: e.message });
    }
    // Polite pause between requests
    await new Promise((r) => setTimeout(r, 400));
  }

  const changed = results.filter((r) => r.status === 'changed').length;
  const baseline = results.filter((r) => r.status === 'baseline').length;
  const errors = results.filter((r) => r.status === 'error' || r.status === 'fetch_error').length;

  return res.status(200).json({
    ok: true,
    scanned: results.length,
    changed,
    baseline,
    errors,
    results,
    at: new Date().toISOString(),
  });
}

// Chained handler: scan, then call alerts fan-out. One registered cron.
async function chainedHandler(req, res) {
  const scanResults = { scan: null, alerts: null };
  // Capture scan output
  const captured = { status: 200, body: null };
  const fauxRes = {
    status(c) { captured.status = c; return this; },
    json(body) { captured.body = body; return this; },
  };
  try {
    await handler(req, fauxRes);
  } catch (e) {
    captured.status = 500;
    captured.body = { ok: false, error: e.message };
  }
  scanResults.scan = captured.body;

  // Call alerts inline (raw handler, not the wrapped export)
  try {
    const alertsMod = require('./cron-trec-member-alerts.js');
    const alertReq = {
      method: 'GET',
      headers: { authorization: `Bearer ${process.env.CRON_SECRET || ''}` },
      query: {},
    };
    const alertCaptured = { status: 200, body: null };
    const alertRes = {
      status(c) { alertCaptured.status = c; return this; },
      json(body) { alertCaptured.body = body; return this; },
    };
    await alertsMod(alertReq, alertRes);
    scanResults.alerts = alertCaptured.body;
  } catch (e) {
    scanResults.alerts = { ok: false, error: e.message };
  }

  return res.status(200).json({ ok: true, ...scanResults });
}

module.exports = withTelemetry('cron-trec-scanner', chainedHandler);

module.exports.config = {
  maxDuration: 180,
};
