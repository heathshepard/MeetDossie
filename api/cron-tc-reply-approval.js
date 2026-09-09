'use strict';

// Vercel Serverless Function: /api/cron-tc-reply-approval
//
// Comment-reply approval loop for the TC discovery campaign. Heath's spec,
// verbatim: "I want a watcher and when a comment comes in I get a telegram
// notification with the post (for context), the comment, and a proposed reply
// that I can edit if necessary and an approve button."
//
// For every NEW row in tc_discovery_responses this cron:
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
// TWO THREAD ROLES (2026-09-08 extension — replies on OTHER people's posts):
//   thread_role='host'  — a comment on Heath's OWN campaign post (harvested by
//      scripts/harvest-tc-discovery-responses.js). He's the host; a reply from
//      him is expected. Context joins group_posts.
//   thread_role='guest' — a reply to a comment HEATH left on someone else's
//      post (detected by scripts/watch-guest-thread-replies.js, registry in
//      comment_watchlist). He's a guest in their thread: the draft must not
//      hijack it, and the tone differs depending on whether the reply came
//      from the POST AUTHOR (their house) or a third party. Context joins
//      comment_watchlist (original post snapshot + Heath's own comment).
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
const voiceGuard = require('./_lib/heath-voice-guard');

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
const DRAFT_PROMPT = (post, comment, recentOpeners = []) => `You are drafting a Facebook COMMENT REPLY for Heath Shepard, a Texas REALTOR. He posted a peer-discussion question in an agent group and ${comment.commenter_name} answered. He wants to reply.

HARD RULES:
- NEVER mention Dossie, any software, any product, any link. Heath is a working agent talking to peers. Zero pitch. Zero selling.
- Respond to the SPECIFIC thing they said — reference their actual words/details, never a generic "thanks for sharing". Reference it by ENGAGING with it (agreeing, adding to it, pushing back a little), not by complimenting it first.
- A follow-up question is OPTIONAL, not required — only ask one if you'd genuinely want to know more. Often the better reply just answers or adds his own experience and stops.
- First name only if you address them at all (optional).

${voiceGuard.VOICE_PROMPT_BLOCK}
${voiceGuard.buildRecentOpenersBlock(recentOpeners)}
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

// Guest-thread variant: Heath commented on SOMEONE ELSE'S post and got a
// reply there. He's a guest, not the host — the draft must read the room:
// gracious to the post author in their own thread, peer-warm to a third
// party, and never thread-hijacking. Same zero-pitch rules.
const GUEST_DRAFT_PROMPT = (guest, comment, recentOpeners = []) => {
  const postAuthor = guest.post_author || 'the post author';
  const fromAuthor = guest.replyIsFromPostAuthor;
  return `You are drafting a Facebook COMMENT REPLY for Heath Shepard, a Texas REALTOR. IMPORTANT: this is NOT Heath's post. ${postAuthor} posted in "${guest.group_name || 'a Facebook group'}", Heath left a comment on THEIR post, and ${comment.commenter_name} replied to Heath's comment. Heath is a GUEST in this thread.

${fromAuthor
    ? `${comment.commenter_name} IS the post author — this is their thread and their conversation. Be gracious and deferential to their framing: engage with what THEY said, add one useful thought at most, and let them keep the floor.`
    : `${comment.commenter_name} is a third party who joined the conversation under Heath's comment. Peer-to-peer directness is right, but remember whose post it is — keep it brief and don't turn ${postAuthor}'s thread into Heath's own discussion.`}

HARD RULES:
- NEVER mention Dossie, any software, any product, any link. Heath is a working agent talking to peers. Zero pitch. Zero selling.
- Respond to the SPECIFIC thing they said by engaging with it — agreeing, adding to it, or pushing back a little. Never a generic "thanks" and never compliment it before you engage.
- A question is OPTIONAL and rare here — in someone else's thread a plain statement is usually the better close.
- First name only if you address them at all (optional).

${voiceGuard.VOICE_PROMPT_BLOCK}
${voiceGuard.buildRecentOpenersBlock(recentOpeners)}
ALSO classify the reply first. hostile=true if it is hostile toward Heath, accuses him of being an ad / bot / AI / astroturf / data-mining, or is aggressive enough that an automated-drafted reply would be risky. When hostile=true, set reply to "".

THE ORIGINAL POST by ${postAuthor}:
"""
${String(guest.post_body || '(post text unavailable)').slice(0, 700)}
"""

HEATH'S COMMENT on that post:
"""
${String(guest.our_text || '').slice(0, 700)}
"""

REPLY to Heath by ${comment.commenter_name}:
"""
${String(comment.comment_text || '').slice(0, 900)}
"""

Return ONLY JSON: {"hostile": boolean, "hostile_reason": "short reason or empty", "reply": "the reply text or empty"}`;
};

async function callDraftModel(promptText) {
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
      messages: [{ role: 'user', content: promptText }],
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

/**
 * @param {object} post
 * @param {object} comment
 * @param {object|null} guest
 * @param {string[]} recentOpeners  openers from recently drafted replies, so
 *   this run doesn't repeat the same opening shape (the actual failure mode
 *   Heath named — three drafts with the identical "compliment then
 *   question" structure).
 */
async function draftReply(post, comment, guest = null, recentOpeners = []) {
  const basePrompt = guest ? GUEST_DRAFT_PROMPT(guest, comment, recentOpeners) : DRAFT_PROMPT(post, comment, recentOpeners);
  let result = await callDraftModel(basePrompt);
  if (result.hostile || !result.reply) return result;

  // One retry, with explicit feedback, if the draft still trips the voice
  // guard — never silently ship a violation, but also never loop forever.
  const check = voiceGuard.checkVoiceCompliance(result.reply);
  if (!check.ok) {
    const retryPrompt = `${basePrompt}\n\nYOUR PREVIOUS DRAFT VIOLATED THE VOICE RULES ABOVE (${check.violations.join(', ')}): "${result.reply}"\nRewrite it — no banned phrase, no em-dash or " - " beat, don't just tack a question on the end. Return the same JSON shape.`;
    try {
      const retried = await callDraftModel(retryPrompt);
      if (!retried.hostile && retried.reply) result = retried;
    } catch { /* keep the original draft — Heath reviews every one anyway */ }
  }
  return result;
}

// ─── Telegram message ────────────────────────────────────────────────────────

function buildApprovalMessage(post, row, guest = null) {
  const lines = guest
    ? [
      `REPLY TO YOUR COMMENT — ${guest.group_name || row.source_group || 'unknown group'} (on ${guest.post_author || 'someone'}'s post)`,
      '',
      'THEIR POST (context):',
      String(guest.post_body || '(post text unavailable)').slice(0, 400),
      '',
      'YOUR COMMENT:',
      String(guest.our_text || '(not captured)').slice(0, 400),
      '',
      `REPLY from ${row.commenter_name}${guest.replyIsFromPostAuthor ? ' (the POST AUTHOR)' : ''}:`,
      String(row.comment_text || '').slice(0, 900),
      '',
      'PROPOSED REPLY:',
      String(row.reply_draft || ''),
      '',
      'Approve posts it threaded under their reply (FB reply budget 10/day — queued if over). Edit: reply to the prompt with your text.',
    ]
    : [
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
      'Approve posts it under their comment (FB reply budget 10/day — queued if over). Edit: reply to the prompt with your text.',
    ];
  return lines.join('\n').slice(0, 4090);
}

function buildFlagMessage(post, row, guest = null) {
  const header = guest
    ? `REPLY TO YOUR COMMENT — FLAGGED, your call (no draft): ${guest.group_name || row.source_group || 'unknown group'} (on ${guest.post_author || 'someone'}'s post)`
    : `TC DISCOVERY COMMENT — FLAGGED, your call (no draft): ${post.group_name || row.source_group || 'unknown group'}${row.question_id ? ` [${row.question_id}]` : ''}`;
  const lines = [
    header,
    '',
    `Reason: ${row.reply_error || 'hostile / astroturf accusation'}`,
    '',
    guest ? 'THEIR POST (context):' : 'POST (context):',
    String((guest ? guest.post_body : post.post_body) || '(post body unavailable)').slice(0, 400),
    ...(guest ? ['', 'YOUR COMMENT:', String(guest.our_text || '(not captured)').slice(0, 400)] : []),
    '',
    `${guest ? 'REPLY' : 'COMMENT'} from ${row.commenter_name}${guest && guest.replyIsFromPostAuthor ? ' (the POST AUTHOR)' : ''}:`,
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
    + `&select=id,group_post_id,post_url,question_id,source_group,commenter_name,comment_text,comment_permalink,reply_status,reply_draft,reply_error,thread_role,watchlist_id`
    + `&order=harvested_at.asc&limit=${MAX_PER_RUN}`,
  );
  if (!ok) {
    out.errors.push({ step: 'load', status });
    return out;
  }
  const rows = Array.isArray(data) ? data : [];
  if (rows.length === 0) return out;

  // Recent opener shapes (last 8 delivered replies) so THIS run doesn't
  // repeat a recently-used opening — grows in-memory as this run drafts
  // more, so three replies drafted in the SAME run also vary from each
  // other (the exact failure Heath caught: 3 in a row, same shape).
  const { data: recentData } = await sbFetch(
    '/rest/v1/tc_discovery_responses?reply_draft=not.is.null&order=updated_at.desc&limit=8&select=reply_draft',
  );
  const recentOpeners = (Array.isArray(recentData) ? recentData : []).map((r) => r.reply_draft).filter(Boolean);

  // Batch-load context: group_posts for host rows, comment_watchlist for
  // guest rows (Heath's outbound comment on someone else's post).
  const postIds = [...new Set(rows.filter((r) => r.thread_role !== 'guest').map((r) => r.group_post_id).filter(Boolean))];
  const postMap = new Map();
  if (postIds.length > 0) {
    const { ok: pOk, data: pData } = await sbFetch(
      `/rest/v1/group_posts?id=in.(${postIds.map(encodeURIComponent).join(',')})&select=id,group_name,post_body,post_url`,
    );
    if (pOk && Array.isArray(pData)) for (const p of pData) postMap.set(p.id, p);
  }
  const watchIds = [...new Set(rows.filter((r) => r.thread_role === 'guest').map((r) => r.watchlist_id).filter(Boolean))];
  const watchMap = new Map();
  if (watchIds.length > 0) {
    const { ok: wOk, data: wData } = await sbFetch(
      `/rest/v1/comment_watchlist?id=in.(${watchIds.map(encodeURIComponent).join(',')})&select=id,group_name,post_author,post_body,our_text,thread_url`,
    );
    if (wOk && Array.isArray(wData)) for (const w of wData) watchMap.set(w.id, w);
  }

  for (const row of rows) {
    const post = postMap.get(row.group_post_id) || { group_name: row.source_group, post_body: null, post_url: row.post_url };
    // Guest context: whose house it is, the post, and Heath's own comment.
    // Tone branches on whether the reply came from the post author.
    let guest = null;
    if (row.thread_role === 'guest') {
      const w = watchMap.get(row.watchlist_id) || {};
      guest = {
        group_name: w.group_name || row.source_group,
        post_author: w.post_author || null,
        post_body: w.post_body || null,
        our_text: w.our_text || null,
        replyIsFromPostAuthor: !!(w.post_author
          && String(w.post_author).trim().toLowerCase() === String(row.commenter_name || '').trim().toLowerCase()),
      };
    }
    try {
      // 1. Draft (skip if already drafted or already flagged).
      if (row.reply_status === 'new' && !row.reply_draft) {
        const d = await draft(post, row, guest, recentOpeners);
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
          // So the NEXT draft in this same run also varies (not just against
          // DB history) — the failure Heath caught was 3-in-a-row same run.
          recentOpeners.unshift(d.reply);
        }
      }

      // 2. Notify.
      const isFlag = row.reply_status === 'flagged';
      const text = isFlag ? buildFlagMessage(post, row, guest) : buildApprovalMessage(post, row, guest);
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
module.exports.DRAFT_PROMPT = DRAFT_PROMPT;
module.exports.GUEST_DRAFT_PROMPT = GUEST_DRAFT_PROMPT;
module.exports.draftReply = draftReply;
