'use strict';

// Vercel Serverless Function: /api/cron-comment-opp-approval
//
// Part 2 (score -> draft -> approve) of the DAILY comment-opportunity
// pipeline. scripts/fb-comment-hunt-daily.js inserts candidate posts from the
// genuinely active agent/TC groups at status='found'; this cron:
//   1. Expires candidates older than 48h that Heath never saw (commenting on
//      a dead thread reads as bot behavior).
//   2. Scores each candidate 0-100 and drafts a comment in ONE Claude call.
//      SELECTION BAR (Heath, 2026-09-08, verbatim): "doesn't need to be
//      picky... we just have to add value to people's posts." Heath is an
//      experienced working REALTOR, landlord, and investor — the bar is "can
//      he say something genuinely useful here?", NOT "is this in his
//      TREC/contracts lane". Low scores -> 'rejected', never notified.
//   3. Sends the BEST candidates to Heath via DossieMarketingBot with
//      Approve / Edit / Skip buttons (the proven tcreply_* loop; callbacks
//      oppc_approve / oppc_edit / oppc_skip land in api/telegram-webhook.js).
//      Message context is deliberately BRIEF — who posted, what they said
//      (quoted), the group, age, comment count, and the draft. Heath asked
//      for three lines of context, not five paragraphs.
//
// The actual Facebook post happens LOCALLY via
// scripts/fb-comment-opp-poster.js (needs the DossieBot-Sage Chrome profile —
// serverless can't reach it). Budget: comment-caps.js 'facebook_auto',
// 8/day, 45-60 min varied spacing. NOTHING posts without status='approved',
// which only Heath's explicit tap/edit can set.
//
// SUPPRESSION CONTRACT: this cron is in telegram-gate ALWAYS_ALLOW, but if
// the gate ever eats a send anyway ('strict' mode), the row is NOT advanced
// to 'notified' — score+draft are stored and the send retries next tick. A
// suppressed notification must never look delivered (the 3-week
// video_library incident).
//
// Draft idempotency: score/draft persist across retries, so a failed or
// suppressed send never re-bills the Claude call.
//
// Auth: x-vercel-cron header or Bearer ${CRON_SECRET}.
// Schedule: vercel.json — */30 * * * *.
//
// Owner: Carter, 2026-09-08

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-comment-opp-approval');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Same bot as the tcreply approval flow so buttons route to the existing
// telegram-webhook handler.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DRAFT_MODEL = 'claude-sonnet-5';
const SCORE_PER_RUN = 8;       // Claude calls per tick (30-min cadence clears a full scan-day in a few hours)
const MAX_NOTIFY_PER_RUN = 5;  // don't machine-gun Heath's Telegram
const DAILY_NOTIFY_CAP = 12;   // a few above the 8/day post budget so skips don't starve the day
const MIN_SCORE = 55;          // below this the honest comment would be filler
const EXPIRE_HOURS = 48;

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// ─── Score + draft (one Claude call per candidate) ───────────────────────────
//
// Heath's voice from memory/heath-email-voice-profile.md and
// memory/heath-client-text-voice-profile.md: SHORT (1-3 sentences), warm,
// casual, zero corporate jargon, no hashtags, no sign-off.

const SCORE_PROMPT = (row) => `You are screening a Facebook group post as a comment opportunity for Heath Shepard, and drafting the comment if it is one.

WHO HEATH IS: an experienced working Texas REALTOR (Keller Williams, San Antonio), a landlord, and an investor. He can add genuine value on far more than contract mechanics: pricing and comps, negotiation, inspections, appraisals, lenders and financing, title, vendors and contractors, showings, listing prep, rentals and property management, market conditions, buyer/seller psychology, builders and new construction, transaction coordination and paperwork, TREC forms and deadlines, option periods, earnest money, disclosures, MLS, and plain business-building/lead-gen as a working agent.

THE BAR (loose on purpose): "Can he say something genuinely useful here?" It does NOT have to be his specialty and does NOT have to be a question — adding a real angle to someone's observation counts. Specific encouragement and peer solidarity count too (a new TC two weeks in doesn't need a TREC citation; she needs someone who's worked with TCs to tell her which habit matters). Never comment just to hit a number — if the honest comment would be filler, score it low.

SCORE 0-100. High = recent-feeling real question or real problem, few existing comments so Heath's would be seen, and he can say something specific. Low/zero = listing promo, "just closed!" brag, recruiting pitch, meme, politics, thread already thoroughly answered, or nothing genuinely useful to add.

IF SCORE >= ${MIN_SCORE}, DRAFT THE COMMENT. HARD RULES:
- NEVER mention Dossie, any software, any product, any link. Zero pitch. Zero selling. He is a working agent talking to peers.
- Never argue, never correct harshly, never lecture.
- 1 to 3 sentences TOTAL. Warm, casual, like a real agent thumb-typing between showings. No hashtags, no sign-off, no corporate phrasing, plain ASCII. Clean spelling.
- SPECIFIC and useful — never a generic "great post!" or "following!". Every comment must actually say something.
- Heath's real recent experience, usable ONLY where it genuinely applies (never force these in): the Friday-execution option-fee trap; TREC Paragraph 5.A(2) weekend rollover on earnest/option money delivery; a blank Paragraph 21 notices section costing title three days; estate sales being exempt from the seller's disclosure notice.

RAW SCRAPE of the post (includes Facebook UI noise — reaction counts, "Like Reply", etc. — ignore that noise):
Group: ${row.group_name}
Author: ${row.author_name || 'unknown'}
Rendered age: ${row.post_age_raw || 'unknown'} · existing comments: ${row.comment_count ?? 'unknown'}
"""
${String(row.post_text || '').slice(0, 1800)}
"""

Return ONLY JSON: {"score": 0-100, "reasons": "one short line", "comment": "the draft, or empty string if score < ${MIN_SCORE}"}`;

async function scoreAndDraft(row) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 500,
      messages: [{ role: 'user', content: SCORE_PROMPT(row) }],
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`claude ${res.status}: ${err.slice(0, 150)}`);
  }
  const json = await res.json();
  const text = ((json?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in score response');
  const parsed = JSON.parse(match[0]);
  const score = Math.max(0, Math.min(100, Number(parsed.score) || 0));
  return {
    score,
    reasons: String(parsed.reasons || '').slice(0, 300),
    comment: String(parsed.comment || '').trim(),
  };
}

// ─── Telegram message — BRIEF by explicit request ────────────────────────────

function quoteSnippet(text) {
  // Strip the leading UI noise lines (author name, group name, timestamps)
  // best-effort: take the longest line-run of the scrape as the post body.
  const cleaned = String(text || '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 220);
}

function buildOppMessage(row) {
  const meta = [
    row.post_age_raw || null,
    row.comment_count != null ? `${row.comment_count} comments` : null,
    row.score != null ? `score ${row.score}` : null,
  ].filter(Boolean).join(' · ');
  return [
    `COMMENT OPP — ${row.group_name}${meta ? ` · ${meta}` : ''}`,
    `${row.author_name || 'Someone'}: "${quoteSnippet(row.post_text)}"`,
    '',
    `DRAFT: ${String(row.comment_draft || '')}`,
    row.post_url || '',
  ].join('\n').slice(0, 4090);
}

function oppKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `oppc_approve:${rowId}` },
      { text: 'Edit', callback_data: `oppc_edit:${rowId}` },
      { text: 'Skip', callback_data: `oppc_skip:${rowId}` },
    ]],
  };
}

async function telegramSend(text, replyMarkup) {
  const body = { chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  return { ok: res.ok && data?.ok === true, status: res.status, data, raw };
}

// ─── Core pass (exported for the regression test — deps injectable) ──────────

/**
 * Expire stale candidates, score+draft new ones, notify Heath about the best.
 * State only advances to 'notified' on a DELIVERED send.
 *
 * @param {object} deps { sbFetch, score, send, isSuppressed, log, now }
 * @returns {Promise<{expired:number, scored:number, rejected:number, notified:number, errors:Array}>}
 */
async function processOpportunities(deps) {
  const {
    sbFetch = supabaseFetch,
    score = scoreAndDraft,
    send = telegramSend,
    isSuppressed = wasSuppressed,
    log = console,
    now = () => new Date(),
  } = deps || {};

  const out = { expired: 0, scored: 0, rejected: 0, notified: 0, errors: [] };
  const nowIso = now().toISOString();

  // 1. Expire never-notified candidates past the freshness window.
  const cutoff = new Date(now().getTime() - EXPIRE_HOURS * 3600000).toISOString();
  const exp = await sbFetch(
    `/rest/v1/comment_opportunities?status=eq.found&found_at=lt.${encodeURIComponent(cutoff)}`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ status: 'expired', updated_at: nowIso }),
    },
  );
  if (exp.ok && Array.isArray(exp.data)) out.expired = exp.data.length;

  // 2. Score + draft unscored candidates (oldest first so nothing rots).
  const { ok: sOk, data: sData } = await sbFetch(
    '/rest/v1/comment_opportunities?status=eq.found&score=is.null'
    + '&select=id,group_name,author_name,post_text,post_age_raw,comment_count,post_url'
    + `&order=found_at.asc&limit=${SCORE_PER_RUN}`,
  );
  if (!sOk) {
    out.errors.push({ step: 'load_unscored' });
    return out;
  }
  for (const row of (Array.isArray(sData) ? sData : [])) {
    try {
      const d = await score(row);
      const reject = d.score < MIN_SCORE || !d.comment;
      await sbFetch(`/rest/v1/comment_opportunities?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          score: d.score,
          score_reasons: d.reasons,
          comment_draft: d.comment || null,
          ...(reject ? { status: 'rejected' } : {}),
          updated_at: now().toISOString(),
        }),
      });
      out.scored++;
      if (reject) out.rejected++;
    } catch (err) {
      log.error(`[cron-comment-opp-approval] score failed for ${row.id}: ${err.message}`);
      out.errors.push({ id: row.id, step: 'score', error: err.message });
    }
  }

  // 3. Notify Heath about the best drafted candidates, capped per-run and
  //    per-day. Suppressed sends NEVER advance state.
  const dayStart = `${nowIso.slice(0, 10)}T00:00:00Z`;
  const { data: notifiedToday } = await sbFetch(
    `/rest/v1/comment_opportunities?notified_at=gte.${encodeURIComponent(dayStart)}&select=id`,
  );
  const remainingToday = DAILY_NOTIFY_CAP - (Array.isArray(notifiedToday) ? notifiedToday.length : 0);
  if (remainingToday <= 0) return out;

  const { ok: nOk, data: nData } = await sbFetch(
    '/rest/v1/comment_opportunities?status=eq.found&comment_draft=not.is.null'
    + `&score=gte.${MIN_SCORE}&notified_at=is.null`
    + '&select=id,group_name,author_name,post_text,post_age_raw,comment_count,post_url,score,comment_draft'
    + `&order=score.desc&limit=${Math.min(MAX_NOTIFY_PER_RUN, remainingToday)}`,
  );
  if (!nOk) {
    out.errors.push({ step: 'load_notify' });
    return out;
  }
  for (const row of (Array.isArray(nData) ? nData : [])) {
    const sendRes = await send(buildOppMessage(row), oppKeyboard(row.id));
    if (!sendRes.ok) {
      out.errors.push({ id: row.id, step: 'send', status: sendRes.status });
      continue;
    }
    // NEVER advance state on a suppressed send — Heath did not see it.
    if (isSuppressed(sendRes.data)) {
      log.warn(`[cron-comment-opp-approval] send for ${row.id} SUPPRESSED by telegram-gate — NOT stamping notified_at`);
      out.errors.push({ id: row.id, step: 'send', error: 'suppressed_by_telegram_gate' });
      continue;
    }
    const stampIso = now().toISOString();
    await sbFetch(`/rest/v1/comment_opportunities?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: 'notified',
        notified_at: stampIso,
        telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null,
        updated_at: stampIso,
      }),
    });
    out.notified++;
  }

  return out;
}

module.exports = withTelemetry('cron-comment-opp-approval', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'telegram env not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(200).json({ ok: true, skipped: true, reason: 'ANTHROPIC_API_KEY not configured' });
  }

  const result = await processOpportunities({});
  console.log('[cron-comment-opp-approval]', JSON.stringify(result));
  return res.status(200).json({ ok: true, ...result });
});

module.exports.processOpportunities = processOpportunities;
module.exports.buildOppMessage = buildOppMessage;
module.exports.oppKeyboard = oppKeyboard;
module.exports.MIN_SCORE = MIN_SCORE;
module.exports.DAILY_NOTIFY_CAP = DAILY_NOTIFY_CAP;
