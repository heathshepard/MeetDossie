// Vercel Serverless Function: /api/cron-weekly-newsletter
//
// Friday 10am CDT (15:00 UTC). Reads WEEKLY-IMPROVEMENTS.md, takes the most
// recent week's section, asks Claude Haiku to rewrite each improvement in
// plain English (USER BENEFIT, no jargon, drop internal/admin changes), then
// emails the digest via Resend to every active paying customer (non-demo,
// non-heath.shepard@*) PLUS heath@meetdossie.com.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 15 * * 5" (15:00 UTC Friday = 10:00 AM CDT).
//
// Idempotency: writes an audit_logs row (action='weekly_newsletter_sent',
//   resource_type='newsletter', resource_id=ISO week key e.g. '2026-W20').
//   On second fire in the same week, exits early with skipped=true.
//
// Customer filter mirrors cron-morning-brief.js / cron-email-digest.js.

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';
const HEATH_CC_EMAIL = 'heath@meetdossie.com';

const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';
const BRAND_BORDER = '#E8E0D8';

// ─── Supabase REST helper ────────────────────────────────────────────────

async function supabaseFetch(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// ─── Customer filter (matches cron-morning-brief.js / cron-email-digest.js) ──

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath.shepard@')) return true;
  if (e.includes('demo')) return true;
  return false;
}

async function loadActiveCustomers() {
  const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id,plan,status');
  if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
  const subs = subResp.data || [];
  if (subs.length === 0) return [];

  const userIds = subs.map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return [];

  const filter = userIds.map((id) => `"${id}"`).join(',');
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,full_name,is_demo`,
  );
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);
  const profilesById = new Map((profResp.data || []).map((p) => [p.id, p]));

  const out = [];
  for (const s of subs) {
    const p = profilesById.get(s.user_id);
    if (!p) continue;
    if (p.is_demo) continue;
    if (isExcludedEmail(p.email)) continue;
    out.push({
      user_id: s.user_id,
      email: p.email,
      first_name: (p.full_name || p.email || '').split(/[\s.@]/)[0] || 'there',
    });
  }
  return out;
}

// ─── Date helpers ────────────────────────────────────────────────────────

// Returns ISO 8601 week key like '2026-W20'. Used as idempotency resource_id.
function isoWeekKey(date) {
  // Copy date so we don't mutate
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Set to nearest Thursday: current date + 4 - current day number
  // Make Sunday's day number 7
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

// Human-readable date-range label for subject + email body.
// Pass an explicit "now" so we can keep it stable; defaults to current time.
function weekRangeLabel(now = new Date()) {
  // Friday → previous Friday window (last 7 days inclusive of today).
  const end = new Date(now);
  const start = new Date(now);
  start.setUTCDate(end.getUTCDate() - 6);
  const fmt = (d) => new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    month: 'short',
    day: 'numeric',
  }).format(d);
  return `${fmt(start)}–${fmt(end)}`;
}

// ─── WEEKLY-IMPROVEMENTS.md parser ───────────────────────────────────────

// File structure (see WEEKLY-IMPROVEMENTS.md):
//   # heading
//   intro paragraphs
//   ---
//   ## Week of May 13–20, 2026   ← H2 = a week section
//   **Category**                 ← bold = category header
//   - item                       ← improvement bullet
//   - item (may span multiple lines until next blank line)
//   ## Week of May 6–12, 2026
//   ...
//
// Strategy: split on /^## /m, take the first non-empty section (which is the
// most recent — file is written newest-on-top per the existing entry), strip
// the category headers + "Notes from Heath" trailing block, and return the
// raw bullet text as one string. Claude Haiku does the rest.
function extractLatestWeekSection(raw) {
  if (!raw) return { weekHeader: null, body: null };
  // Split on H2 headers
  const sections = raw.split(/\n##\s+/m);
  // sections[0] is everything before the first ## (file intro). Skip it.
  if (sections.length < 2) return { weekHeader: null, body: null };
  const first = sections[1]; // newest week
  // first looks like: "Week of May 13–20, 2026\n\n**App + mobile**\n- ..."
  const lines = first.split('\n');
  const weekHeader = (lines[0] || '').trim();
  // Drop trailing "Notes from Heath" section if present (it's a private TODO
  // block, never customer-facing).
  let bodyLines = lines.slice(1);
  const notesIdx = bodyLines.findIndex((l) => /^\*\*Notes from Heath/i.test(l.trim()));
  if (notesIdx >= 0) bodyLines = bodyLines.slice(0, notesIdx);
  const body = bodyLines.join('\n').trim();
  return { weekHeader, body };
}

// ─── Anthropic (Haiku) rewriter ──────────────────────────────────────────

function buildPromptForRewrite({ weekHeader, body }) {
  return `You are writing a weekly customer email for Dossie, an AI transaction coordinator for Texas REALTORS.

Below is the raw weekly changelog (already written in semi-customer-friendly language). Your job is to:

1. Turn each bullet into ONE plain-English paragraph (max 5 sentences) that frames the change as a USER BENEFIT — what changed for the agent, not what changed internally.
2. Skip anything that is purely internal/admin (e.g. admin dashboard tweaks, cron noise fixes, code refactors, "we" engineering work). Only include things the customer would actually feel.
3. Group items under short, friendly headers (e.g. "Mobile got a serious upgrade", "Scanning is smarter now", "The compliance report is friendlier").
4. Warm, direct, founder voice. No jargon (no "bundle", "API", "useEffect", "z-index", "TypeScript", etc.). No code references. No git/commit talk.
5. Use plain ASCII only — no em-dashes, no en-dashes, no curly quotes. Use straight hyphens and straight quotes.

Return STRICT JSON in this exact shape (no markdown fence, no commentary):

{
  "greeting": "Short greeting line, 1-2 sentences. Warm and human.",
  "items": [
    { "header": "Short header (max 6 words)", "body": "1-5 sentence paragraph framing the benefit." }
  ],
  "closing": "Short closing line, 1-2 sentences."
}

If after filtering there are zero customer-facing items, return:
{ "greeting": "", "items": [], "closing": "" }

Week being summarized: ${weekHeader || 'this week'}

Raw changelog:
"""
${body}
"""`;
}

async function callAnthropic(prompt) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${text.slice(0, 300)}`);
  }
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Anthropic non-JSON response'); }
  const content = data?.content?.[0]?.text;
  if (!content) throw new Error('Anthropic returned no content block');
  // The model sometimes wraps JSON in a code fence — strip it defensively.
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(stripped); } catch (e) {
    throw new Error(`Anthropic JSON parse failed: ${e.message}. Raw: ${stripped.slice(0, 200)}`);
  }
  return parsed;
}

// ─── HTML rendering (matches welcomeEmailHtml brand pattern) ─────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildNewsletterHtml({ greeting, items, closing, weekRange }) {
  const itemsHtml = items.map((it) => `
    <div style="margin: 0 0 22px;">
      <h2 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 22px; line-height: 1.25; color: ${BRAND_NAVY}; margin: 0 0 8px;">${escapeHtml(it.header)}</h2>
      <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0;">${escapeHtml(it.body)}</p>
    </div>
  `).join('');

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
    <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; WEEKLY UPDATE &middot; ${escapeHtml(weekRange)}</div>
    <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 32px; line-height: 1.2; margin: 0 0 18px; color: ${BRAND_NAVY};">What's new in Dossie this week</h1>
    <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">${escapeHtml(greeting)}</p>
    <hr style="border: none; border-top: 1px solid ${BRAND_BORDER}; margin: 0 0 24px;" />
    ${itemsHtml}
    <hr style="border: none; border-top: 1px solid ${BRAND_BORDER}; margin: 8px 0 24px;" />
    <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 16px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 18px;">${escapeHtml(closing)}</p>
    <div style="margin: 28px 0;">
      <a href="https://meetdossie.com/app" style="display: inline-block; padding: 14px 30px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Open Dossie -&gt;</a>
    </div>
    <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 28px 0 4px;">- Dossie</p>
    <p style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; margin-top: 28px; font-size: 13px; color: ${BRAND_MUTED}; line-height: 1.7;">
      Want to suggest what we build next? Reply to this email or vote in the Founding Files Facebook group:
      <a href="https://www.facebook.com/share/g/1P2QL9T42t/" style="color: ${BRAND_CORAL}; text-decoration: none;">facebook.com/share/g/1P2QL9T42t</a>
    </p>
  </div>`;
}

// ─── Resend ──────────────────────────────────────────────────────────────

async function sendResend(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

// ─── Idempotency via audit_logs ──────────────────────────────────────────

async function alreadySentThisWeek(weekKey) {
  const r = await supabaseFetch(
    `/rest/v1/audit_logs?action=eq.weekly_newsletter_sent&resource_type=eq.newsletter&resource_id=eq.${encodeURIComponent(weekKey)}&select=id&limit=1`,
  );
  if (!r.ok) return false; // fail open — better to risk a duplicate than miss the week
  return Array.isArray(r.data) && r.data.length > 0;
}

async function markSentThisWeek(weekKey, metadata) {
  const r = await supabaseFetch('/rest/v1/audit_logs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{
      action: 'weekly_newsletter_sent',
      resource_type: 'newsletter',
      resource_id: weekKey,
      metadata,
    }]),
  });
  if (!r.ok) {
    console.error('[cron-weekly-newsletter] audit_logs insert failed', r.status);
  }
}

// ─── Source file load ────────────────────────────────────────────────────

function loadImprovementsFile() {
  // Try a few common paths — Vercel sometimes runs functions from /var/task
  // and sometimes from the project root depending on bundling. process.cwd()
  // is the project root in serverless functions.
  const candidates = [
    path.join(process.cwd(), 'WEEKLY-IMPROVEMENTS.md'),
    path.join(__dirname, '..', 'WEEKLY-IMPROVEMENTS.md'),
    path.join('/var/task', 'WEEKLY-IMPROVEMENTS.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        return { path: p, contents: fs.readFileSync(p, 'utf8') };
      }
    } catch (err) {
      // continue
    }
  }
  return { path: null, contents: null };
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }
    if (!RESEND_API_KEY) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
    }

    const now = new Date();
    const weekKey = isoWeekKey(now);
    const weekRange = weekRangeLabel(now);

    // Idempotency check — allow override via ?force=1 alongside Bearer auth.
    const isForce = req.query && (req.query.force === '1' || req.query.force === 'true');
    if (!isForce) {
      const sent = await alreadySentThisWeek(weekKey);
      if (sent) {
        return res.status(200).json({
          ok: true,
          skipped: true,
          reason: 'already sent this week',
          week_key: weekKey,
        });
      }
    }

    // Load file.
    const { path: filePath, contents } = loadImprovementsFile();
    if (!contents) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'WEEKLY-IMPROVEMENTS.md not found on disk',
      });
    }

    const { weekHeader, body } = extractLatestWeekSection(contents);
    if (!body || body.length < 20) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'no entries in latest week section',
        file_path: filePath,
      });
    }

    // Rewrite via Haiku.
    let rewritten;
    try {
      rewritten = await callAnthropic(buildPromptForRewrite({ weekHeader, body }));
    } catch (err) {
      console.error('[cron-weekly-newsletter] Anthropic failed:', err.message);
      return res.status(500).json({ ok: false, error: `Anthropic failed: ${err.message}` });
    }

    const items = Array.isArray(rewritten?.items) ? rewritten.items.filter((i) => i && i.header && i.body) : [];
    if (items.length === 0) {
      return res.status(200).json({
        ok: true,
        skipped: true,
        reason: 'no customer-facing items after Haiku filter',
        week_key: weekKey,
      });
    }

    const html = buildNewsletterHtml({
      greeting: rewritten.greeting || `Quick update on what's new in Dossie this week.`,
      items,
      closing: rewritten.closing || `As always — hit reply with anything you want us to build next.`,
      weekRange,
    });
    const subject = `Dossie weekly update — ${weekRange}`;

    // Recipients: active paying customers + Heath.
    const customers = await loadActiveCustomers();
    const toAddresses = customers.map((c) => c.email);
    if (!toAddresses.includes(HEATH_CC_EMAIL)) toAddresses.push(HEATH_CC_EMAIL);

    const sendResults = { sent: 0, failed: 0, errors: [] };
    for (const email of toAddresses) {
      const r = await sendResend(email, subject, html);
      if (r.ok) {
        sendResults.sent++;
      } else {
        sendResults.failed++;
        sendResults.errors.push({ email, status: r.status, raw: (r.raw || '').slice(0, 200) });
        console.error('[cron-weekly-newsletter] resend failed', email, r.status, (r.raw || '').slice(0, 200));
      }
    }

    // Mark sent (only if at least one delivery succeeded — keeps retries safe).
    if (sendResults.sent > 0) {
      await markSentThisWeek(weekKey, {
        recipients_count: toAddresses.length,
        items_count: items.length,
        week_range: weekRange,
        sent: sendResults.sent,
        failed: sendResults.failed,
      });
    }

    return res.status(200).json({
      ok: true,
      week_key: weekKey,
      week_range: weekRange,
      items_count: items.length,
      recipients_count: toAddresses.length,
      sent: sendResults.sent,
      failed: sendResults.failed,
      errors: sendResults.errors,
    });
  } catch (err) {
    console.error('[cron-weekly-newsletter] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
