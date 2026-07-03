// Vercel Serverless Function: /api/cron-weekly-newsletter-draft
//
// Thursday 8 AM CDT (13:00 UTC). Generates the weekly newsletter draft using the
// same Haiku prompt + HTML rendering as the Friday cron. Stores in newsletter_drafts
// table for Heath's review. Sends email to heath@meetdossie.com + Telegram to his
// chat so he can APPROVE / EDIT / REGEN before Friday auto-send.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 13 * * 4" (13:00 UTC Thursday = 8:00 AM CDT).
//
// Idempotency: UPSERT on week_iso. If a draft already exists for this week, it's
//   regenerated (same behavior as REGEN command).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '7874782923';

const ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';
const HEATH_EMAIL = 'heath@meetdossie.com';

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

// ─── Date helpers (matches cron-weekly-newsletter.js) ──────────────────

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weekRangeLabel(now = new Date()) {
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

// ─── Hash helper ─────────────────────────────────────────────────────

function hashString(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// ─── WEEKLY-IMPROVEMENTS.md parser (same as cron-weekly-newsletter.js) ──

function extractLatestWeekSection(raw) {
  if (!raw) return { weekHeader: null, body: null };
  const sections = raw.split(/\n##\s+/m);
  if (sections.length < 2) return { weekHeader: null, body: null };
  const first = sections[1];
  const lines = first.split('\n');
  const weekHeader = (lines[0] || '').trim();
  let bodyLines = lines.slice(1);
  const notesIdx = bodyLines.findIndex((l) => /^\*\*Notes from Heath/i.test(l.trim()));
  if (notesIdx >= 0) bodyLines = bodyLines.slice(0, notesIdx);
  const body = bodyLines.join('\n').trim();
  return { weekHeader, body };
}

// ─── Anthropic (Haiku) rewriter (same as cron-weekly-newsletter.js) ────

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
  // Sonnet 5 extended thinking prepends `thinking` block; iterate all text blocks.
  const content = ((data?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  if (!content) throw new Error('Anthropic returned no content block');
  const stripped = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(stripped); } catch (e) {
    throw new Error(`Anthropic JSON parse failed: ${e.message}`);
  }
  return parsed;
}

// ─── HTML rendering (same as cron-weekly-newsletter.js) ─────────────────

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

// ─── Telegram ─────────────────────────────────────────────────────────────

async function sendTelegram(chat_id, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'HTML' }),
  });
  const data = await r.json();
  return { ok: r.ok, status: r.status, data };
}

// ─── Source file load ────────────────────────────────────────────────

function loadImprovementsFile() {
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

// ─── Draft storage ───────────────────────────────────────────────────────

async function upsertDraft(week_iso, { content_html, content_text, subject, source_md_hash }) {
  const r = await supabaseFetch('/rest/v1/newsletter_drafts', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({
      week_iso,
      content_html,
      content_text,
      subject,
      source_md_hash,
      status: 'pending_review',
      generated_at: new Date().toISOString(),
      reviewed_at: null,
      approved_at: null,
      sent_at: null,
    }),
  });
  if (!r.ok) {
    console.error('[cron-weekly-newsletter-draft] upsert failed', r.status, r.data);
    throw new Error(`newsletter_drafts upsert ${r.status}`);
  }
  return r.data?.[0] || { week_iso };
}

// ─── Audit logging ───────────────────────────────────────────────────────

async function logAudit(action, resource_id, metadata) {
  await supabaseFetch('/rest/v1/audit_logs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify([{ action, resource_type: 'newsletter', resource_id, metadata }]),
  });
}

// ─── Handler ─────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-weekly-newsletter-draft', async function handler(req, res) {
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

    // Load file
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

    // Rewrite via Haiku
    let rewritten;
    try {
      rewritten = await callAnthropic(buildPromptForRewrite({ weekHeader, body }));
    } catch (err) {
      console.error('[cron-weekly-newsletter-draft] Anthropic failed:', err.message);
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
    const text = `${rewritten.greeting}\n\n${items.map((i) => `${i.header}\n${i.body}`).join('\n\n')}\n\n${rewritten.closing}`;
    const source_md_hash = hashString(contents);

    // Store draft
    const draft = await upsertDraft(weekKey, { content_html: html, content_text: text, subject, source_md_hash });

    // Send email to Heath
    await sendResend(HEATH_EMAIL, `[DRAFT] ${subject}`, html);

    // Send Telegram to Heath
    const telegramText = `📰 <b>Thursday newsletter draft ready for proofreading.</b>\n\nWeek: ${weekRange}\n\nReply <code>APPROVE</code> to lock, <code>EDIT [text]</code> to change, or <code>REGEN</code> to refresh from updated WEEKLY-IMPROVEMENTS.md.\n\nDefault approves Friday 7 AM if untouched.`;
    await sendTelegram(TELEGRAM_CHAT_ID, telegramText);

    // Audit
    await logAudit('newsletter_draft_generated', weekKey, {
      items_count: items.length,
      week_range: weekRange,
    });

    return res.status(200).json({
      ok: true,
      week_key: weekKey,
      week_range: weekRange,
      items_count: items.length,
      draft_id: draft.id,
    });
  } catch (err) {
    console.error('[cron-weekly-newsletter-draft] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
