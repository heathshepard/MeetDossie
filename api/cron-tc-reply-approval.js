'use strict';

// Vercel Serverless Function: /api/cron-tc-reply-approval
//
// Comment-reply approval loop for the TC discovery campaign. Heath's spec,
// verbatim: "I want a watcher and when a comment comes in I get a telegram
// notification with the post (for context), the comment, and a proposed reply
// that I can edit if necessary and an approve button."
//
// For every NEW row in tc_discovery_responses (harvested by
// scripts/harvest-tc-discovery-responses.js) this cron:
//   1. Classifies the comment. Hostile / astroturf-accusation comments get NO
//      draft — they're flagged to Heath for personal judgment.
//   2. Drafts a reply in Heath's voice: thank them for the SPECIFIC thing they
//      said, ask ONE follow-up probe for second-level detail, 1-3 sentences.
//      NEVER mentions Dossie, never pitches, never links — Heath is a working
//      agent asking peers.
//   3. Sends ONE Telegram message per comment via DossieMarketingBot: the post
//      (context), the comment verbatim with the commenter's name, the proposed
//      reply, and Approve / Edit / Skip buttons.
//
// Approve/Edit/Skip callbacks land in api/telegram-webhook.js
// (tcreply_approve / tcreply_edit / tcreply_skip). The actual Facebook post
// happens LOCALLY via `node scripts/fb-group-commenter.js --tc-reply-queue`
// (needs the DossieBot-Sage Chrome profile — serverless can't reach it).
//
// SUPPRESSION CONTRACT: this cron is in telegram-gate ALWAYS_ALLOW, but if the
// gate ever eats a send anyway ('strict' mode), the row is NOT advanced to
// 'notified' — drafts are stored and the send retries next tick. A suppressed
// notification must never look delivered (the 3-week video_library incident).
//
// Draft idempotency: rows keep their stored reply_draft across retries, so a
// failed/suppressed send never re-bills the Claude call.
//
// Auth: x-vercel-cron header or Bearer ${CRON_SECRET}.
// Schedule: vercel.json — */30 * * * *.
//
// Owner: Carter, 2026-09-08

const telegramGate = require('./_lib/telegram-gate');
telegramGate.install('cron-tc-reply-approval');
const { wasSuppressed } = telegramGate;

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
// Approval flow uses DossieMarketingBot (same as the post-approval flow) so
// the buttons route to the existing telegram-webhook handler.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DRAFT_MODEL = 'claude-sonnet-5';
const MAX_PER_RUN = 5;

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

// ─── Draft + classify (one Claude call) ──────────────────────────────────────

// Heath's voice, distilled from memory/heath-email-voice-profile.md and
// memory/heath-client-text-voice-profile.md: SHORT (1-3 sentences), warm,
// casual, zero corporate jargon, exclamation points when genuinely pleased,
// no hashtags, no sign-off. Draft clean — never manufacture his typos.
const DRAFT_PROMPT = (post, comment) => `You are drafting a Facebook COMMENT REPLY for Heath Shepard, a Texas REALTOR. He posted a peer-discussion question in an agent group and ${comment.commenter_name} answered. He wants to reply.

HARD RULES:
- NEVER mention Dossie, any software, any product, any link. Heath is a working agent talking to peers. Zero pitch. Zero selling.
- Thank them for the SPECIFIC thing they said — reference their actual words/details, never a generic "thanks for sharing".
- Ask exactly ONE follow-up question probing for second-level detail on what they described.
- 1 to 3 sentences TOTAL. Short, warm, casual, like a real agent thumb-typing. No hashtags, no sign-off, no corporate phrasing. Clean spelling.
- First name only if you address them at all (optional).

ALSO classify the comment first. hostile=true if the comment is hostile toward Heath, accuses the post of being an ad / bot / AI / astroturf / data-mining, or is aggressive enough that an automated-drafted reply would be risky. When hostile=true, set reply to "".

HEATH'S POST (in "${post.group_name || 'a Facebook group'}"):
"""
${String(post.post_body || '').slice(0, 900)}
"""

COMMENT by ${comment.commenter_name}:
"""
${String(comment.comment_text || '').slice(0, 900)}
"""

Return ONLY JSON: {"hostile": boolean, "hostile_reason": "short reason or empty", "reply": "the reply text or empty"}`;

async function draftReply(post, comment) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DRAFT_MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: DRAFT_PROMPT(post, comment) }],
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
  if (!match) throw new Error('no JSON in draft response');
  const parsed = JSON.parse(match[0]);
  return {
    hostile: parsed.hostile === true,
    hostileReason: String(parsed.hostile_reason || '').slice(0, 200),
    reply: String(parsed.reply || '').trim(),
  };
}

// ─── Telegram message ────────────────────────────────────────────────────────

function buildApprovalMessage(post, row) {
  const lines = [
    `TC DISCOVERY COMMENT — ${post.group_name || row.source_group || 'unknown group'}${row.question_id ? ` [${row.question_id}]` : ''}`,
    '',
    'POST (context):',
    String(post.post_body || '(post body unavailable)').slice(0, 500),
    '',
    `COMMENT from ${row.commenter_name}:`,
    String(row.comment_text || '').slice(0, 900),
    '',
    'PROPOSED REPLY:',
    String(row.reply_draft || ''),
    '',
    'Approve posts it under their comment (FB cap 5/day — queued if over). Edit: reply to the prompt with your text.',
  ];
  return lines.join('\n').slice(0, 4090);
}

function buildFlagMessage(post, row) {
  const lines = [
    `TC DISCOVERY COMMENT — FLAGGED, your call (no draft): ${post.group_name || row.source_group || 'unknown group'}${row.question_id ? ` [${row.question_id}]` : ''}`,
    '',
    `Reason: ${row.reply_error || 'hostile / astroturf accusation'}`,
    '',
    'POST (context):',
    String(post.post_body || '(post body unavailable)').slice(0, 500),
    '',
    `COMMENT from ${row.commenter_name}:`,
    String(row.comment_text || '').slice(0, 900),
    '',
    'Nothing will be drafted or posted for this one. Reply manually on Facebook if you want to engage.',
    row.comment_permalink ? row.comment_permalink : (row.post_url || ''),
  ];
  return lines.join('\n').slice(0, 4090);
}

function approvalKeyboard(rowId) {
  return {
    inline_keyboard: [[
      { text: 'Approve', callback_data: `tcreply_approve:${rowId}` },
      { text: 'Edit', callback_data: `tcreply_edit:${rowId}` },
      { text: 'Skip', callback_data: `tcreply_skip:${rowId}` },
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
 * Process pending rows: draft where needed, notify Heath, advance state.
 * State only advances to 'notified'/'flagged'+notified_at on a DELIVERED send.
 *
 * @param {object} deps { sbFetch, draft, send, isSuppressed, log }
 * @returns {Promise<{drafted:number, notified:number, flagged:number, errors:Array}>}
 */
async function processPendingReplies(deps) {
  const {
    sbFetch = supabaseFetch,
    draft = draftReply,
    send = telegramSend,
    isSuppressed = wasSuppressed,
    log = console,
  } = deps || {};

  const out = { drafted: 0, notified: 0, flagged: 0, errors: [] };

  // Rows awaiting draft or (re)send: 'new' (maybe with a stored draft from a
  // suppressed/failed earlier send) and 'flagged' rows never delivered.
  const { ok, data, status } = await sbFetch(
    '/rest/v1/tc_discovery_responses'
    + '?reply_status=in.(new,flagged)&reply_notified_at=is.null&is_own_comment=eq.false'
    + `&select=id,group_post_id,post_url,question_id,source_group,commenter_name,comment_text,comment_permalink,reply_status,reply_draft,reply_error`
    + `&order=harvested_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!ok) {
    out.errors.push({ step: 'load', status });
    return out;
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  // Batch-load the source posts for context.
  const postIds = [...new Set(rows.map((r) => r.group_post_id).filter(Boolean))];
  const postMap = new Map();
  if (postIds.length > 0) {
    const { ok: pOk, data: pData } = await sbFetch(
      `/rest/v1/group_posts?id=in.(${postIds.map(encodeURIComponent).join(',')})&select=id,group_name,post_body,post_url`,
    );
    if (pOk && Array.isArray(pData)) for (const p of pData) postMap.set(p.id, p);
  }

  for (const row of rows) {
    const post = postMap.get(row.group_post_id) || { group_name: row.source_group, post_body: null, post_url: row.post_url };
    try {
      // 1. Draft (skip if already drafted or already flagged).
      if (row.reply_status === 'new' && !row.reply_draft) {
        const d = await draft(post, row);
        if (d.hostile) {
          row.reply_status = 'flagged';
          row.reply_error = `hostile/astroturf: ${d.hostileReason || 'flagged by classifier'}`;
          // Persist the flag BEFORE the send so a crash can't re-draft it as benign.
          await sbFetch(`/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ reply_status: 'flagged', reply_error: row.reply_error, updated_at: new Date().toISOString() }),
          });
          out.flagged++;
        } else {
          if (!d.reply) throw new Error('empty draft for non-hostile comment');
          row.reply_draft = d.reply;
          await sbFetch(`/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ reply_draft: d.reply, updated_at: new Date().toISOString() }),
          });
          out.drafted++;
        }
      }

      // 2. Notify.
      const isFlag = row.reply_status === 'flagged';
      const text = isFlag ? buildFlagMessage(post, row) : buildApprovalMessage(post, row);
      const markup = isFlag ? null : approvalKeyboard(row.id);
      const sendRes = await send(text, markup);
      if (!sendRes.ok) {
        out.errors.push({ id: row.id, step: 'send', status: sendRes.status });
        continue;
      }
      // NEVER advance state on a suppressed send — Heath did not see it.
      if (isSuppressed(sendRes.data)) {
        log.warn(`[cron-tc-reply-approval] send for ${row.id} SUPPRESSED by telegram-gate — NOT stamping reply_notified_at`);
        out.errors.push({ id: row.id, step: 'send', error: 'suppressed_by_telegram_gate' });
        continue;
      }

      const nowIso = new Date().toISOString();
      const patch = {
        reply_notified_at: nowIso,
        reply_telegram_message_id: sendRes.data?.result?.message_id != null ? String(sendRes.data.result.message_id) : null,
        updated_at: nowIso,
      };
      if (!isFlag) patch.reply_status = 'notified';
      await sbFetch(`/rest/v1/tc_discovery_responses?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      out.notified++;
    } catch (err) {
      log.error(`[cron-tc-reply-approval] row ${row.id} failed: ${err.message}`);
      out.errors.push({ id: row.id, step: 'process', error: err.message });
    }
  }

  return out;
}

module.exports = withTelemetry('cron-tc-reply-approval', async function handler(req, res) {
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

  const result = await processPendingReplies({});
  console.log('[cron-tc-reply-approval]', JSON.stringify(result));
  return res.status(200).json({ ok: true, ...result });
});

module.exports.processPendingReplies = processPendingReplies;
module.exports.buildApprovalMessage = buildApprovalMessage;
module.exports.buildFlagMessage = buildFlagMessage;
module.exports.approvalKeyboard = approvalKeyboard;
