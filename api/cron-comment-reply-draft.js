'use strict';

// api/cron-comment-reply-draft.js
// =============================================================================
// Drafts replies to inbound comments ingested by cron-comment-monitor.js and
// pushes each one to DossieMarketingBot for approval.
//
// This cron NEVER talks to a real person. It writes a draft onto the row and
// sends Heath a Telegram card. Posting is a separate cron behind a separate
// kill switch.
//
// ─── THE THREE GATES, IN ORDER ───────────────────────────────────────────────
//
// 1. ESCALATION (scripts/_lib/auto-reply-risk-classifier.js).
//    fb-engagement-thread-close-policy.md, Heath-approved 2026-09-08:
//    "Any thread that reaches a pricing question or a demo request. Draft it,
//    notify him, do not post on approval-by-default."
//    An escalated row is marked escalated=true and goes to Telegram with a
//    HEATH'S CALL header and no auto-approve path. It is never auto-replied
//    no matter what the kill switch says.
//
// 2. CONTENT GATES (scripts/_lib/auto-reply-content-gates.js).
//    Pricing figures, unverified war stories, unverified Dossie capability
//    claims, voice violations, length. A draft that fails is held for Heath
//    with the failures named on the row, never silently shipped.
//
// 3. VOICE (api/_lib/heath-voice-guard.js, already inside gate 2).
//    heath-group-comment-voice.md: his drafts read as AI — enthusiasm opener
//    plus a question, every time. Three in a row is a machine. The prompt
//    carries the recent-openers block so structure varies ACROSS drafts, not
//    just within one, which is the failure mode he actually named.
//
// ─── WHOSE VOICE ─────────────────────────────────────────────────────────────
// A comment on the MeetDossie brand accounts is answered in Dossie's voice
// (she/her, warm, capable, never corporate). A comment on Heath's realtor
// accounts is answered in HIS voice (short, dry, contractions, no enthusiasm
// opener). Using one prompt for both is how a brand account ends up talking
// like a person and a person ends up talking like a brand.
//
// Schedule: */30. Owner: Atlas, 2026-09-25.
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const voiceGuard = require('./_lib/heath-voice-guard.js');
const { classifyCommentRisk } = require('../scripts/_lib/auto-reply-risk-classifier.js');
const { checkContentGates } = require('../scripts/_lib/auto-reply-content-gates.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const DRAFT_MODEL = 'claude-sonnet-4-5';
const MAX_PER_RUN = 8;

// Zernio account ids -> whose voice answers. Verified against GET /v1/accounts
// on 2026-09-25. An account not listed here falls back to 'dossie', which is
// the conservative default: brand voice never claims to be Heath personally.
const HEATH_REALTOR_ACCOUNTS = new Set([
  '6a8469d677555aae017735a1', // instagram  heathshepardrealtor
  '6a8469f177555aae01775798', // facebook   HeathShepardRealtor
  '6a846a0c77555aae017776e3', // youtube    shepardrealestatesolutions
]);

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data, raw: text ? text.slice(0, 300) : '' };
}

// ─── Prompts ──────────────────────────────────────────────────────────────────

const DOSSIE_PROMPT = (row, recentOpeners) => `You are drafting a reply to a comment on a MeetDossie social post. Dossie is an AI transaction coordinator for Texas REALTORS. Dossie is always "she/her" — warm, capable, never corporate.

HARD RULES:
- Reply in DOSSIE's voice, not Heath's. Never claim to be Heath.
- Respond to the SPECIFIC thing they said. No generic "thanks for the comment".
- NEVER state a price, a plan name, or a dollar figure. Never promise a demo.
- NEVER claim a capability. Do not say Dossie pulls MLS data or comps, texts clients, sends email automatically, gets documents signed, or uploads to a brokerage portal. She drafts and the member sends.
- One or two sentences. No hashtags. No em-dash, no " - " as a beat. ASCII only.
- A question at the end is OPTIONAL and should be rare. Often the better reply answers and stops.

${voiceGuard.buildRecentOpenersBlock(recentOpeners)}
ALSO classify first. hostile=true if the comment is hostile, is spam, accuses the account of being a bot/AI/scam, or is aggressive enough that an automated draft would be risky. When hostile=true set reply to "".

THE POST they commented on (${row.platform}):
"""
${String(row.post_excerpt || '(post text unavailable)').slice(0, 700)}
"""

COMMENT by ${row.commenter_name || row.commenter_handle || 'someone'}:
"""
${String(row.original_comment || '').slice(0, 900)}
"""

Return ONLY JSON: {"hostile": boolean, "hostile_reason": "short reason or empty", "reply": "the reply text or empty"}`;

const HEATH_PROMPT = (row, recentOpeners) => `You are drafting a reply to a comment on Heath Shepard's own realtor social post. Heath is a working Texas REALTOR at Keller Williams in San Antonio / Boerne.

HARD RULES:
- Reply in HEATH's voice. He is a working agent, not a founder doing discovery.
- Respond to the SPECIFIC thing they said by engaging with it, not by complimenting it first.
- NEVER state a price, a commission figure, or a dollar amount.
- NEVER pitch Dossie or any software on his realtor account.
- Short. Often one or two sentences, sometimes a fragment. Contractions always.
- No em-dash and no " - " as a beat. ASCII only. No hashtags.
- A question at the end is OPTIONAL. Sometimes agree and stop.

${voiceGuard.VOICE_PROMPT_BLOCK}
${voiceGuard.buildRecentOpenersBlock(recentOpeners)}
ALSO classify first. hostile=true if the comment is hostile, spam, or accusatory. When hostile=true set reply to "".

HIS POST (${row.platform}):
"""
${String(row.post_excerpt || '(post text unavailable)').slice(0, 700)}
"""

COMMENT by ${row.commenter_name || row.commenter_handle || 'someone'}:
"""
${String(row.original_comment || '').slice(0, 900)}
"""

Return ONLY JSON: {"hostile": boolean, "hostile_reason": "short reason or empty", "reply": "the reply text or empty"}`;

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
  if (!res.ok) throw new Error(`claude ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const json = await res.json();
  const text = (json.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('').trim();
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('no JSON in draft response');
  const parsed = JSON.parse(match[0]);
  return {
    hostile: parsed.hostile === true,
    hostileReason: String(parsed.hostile_reason || '').slice(0, 200),
    reply: String(parsed.reply || '').trim(),
  };
}

async function draftFor(row, recentOpeners) {
  const isHeath = HEATH_REALTOR_ACCOUNTS.has(String(row.account_id || ''));
  const base = isHeath ? HEATH_PROMPT(row, recentOpeners) : DOSSIE_PROMPT(row, recentOpeners);
  let result = await callDraftModel(base);
  if (result.hostile || !result.reply) return { ...result, owner: isHeath ? 'heath' : 'dossie' };

  // One retry with explicit feedback if the voice guard trips. Never ship a
  // known violation, never loop.
  const check = voiceGuard.checkVoiceCompliance(result.reply);
  if (!check.ok) {
    try {
      const retried = await callDraftModel(
        `${base}\n\nYOUR PREVIOUS DRAFT VIOLATED THE VOICE RULES (${check.violations.join(', ')}): "${result.reply}"\nRewrite it. No banned phrase, no em-dash or " - " beat, and do not just tack a question on the end. Same JSON shape.`,
      );
      if (!retried.hostile && retried.reply) result = retried;
    } catch { /* keep the first draft; Heath reviews every one anyway */ }
  }
  return { ...result, owner: isHeath ? 'heath' : 'dossie' };
}

// ─── Telegram ─────────────────────────────────────────────────────────────────

function buildCard(row, draft, verdict, gateFailures) {
  const who = row.commenter_name || row.commenter_handle || 'someone';
  const link = row.comment_url || row.post_permalink || '(no link captured)';
  const head = row.escalated
    ? `INBOUND COMMENT - HEATH'S CALL (${verdict.category}) - ${row.platform}`
    : `INBOUND COMMENT - ${row.platform}`;

  const lines = [
    head,
    '',
    'POST:',
    String(row.post_excerpt || '(unavailable)').slice(0, 300),
    '',
    `COMMENT from ${who}:`,
    String(row.original_comment || '').slice(0, 900),
    '',
  ];

  if (row.escalated) {
    lines.push(
      `Escalated: ${verdict.reason || verdict.category}.`,
      'Per the thread-close policy a pricing or demo question is yours to answer. Nothing auto-posts here.',
      '',
    );
  }
  if (gateFailures && gateFailures.length) {
    lines.push(`HELD by content gates: ${gateFailures.map((f) => f.code).join(', ')}`, '');
  }
  lines.push('PROPOSED REPLY:', draft || '(no draft)', '', `LINK: ${link}`);
  lines.push('', 'Approve queues it for posting via the Zernio API. Nothing posts while the zernio_comment_replies flag is off.');
  return lines.join('\n').slice(0, 4090);
}

async function sendCard(row, text, withButtons) {
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    disable_web_page_preview: true,
  };
  if (withButtons) {
    body.reply_markup = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `zcr_approve:${row.id}` },
        { text: 'Edit', callback_data: `zcr_edit:${row.id}` },
        { text: 'Skip', callback_data: `zcr_skip:${row.id}` },
      ]],
    };
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_MARKETING_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await res.text();
  if (!res.ok) return { ok: false, error: t.slice(0, 200) };
  let parsed = null;
  try { parsed = JSON.parse(t); } catch { /* message went out; id is a nicety */ }
  return { ok: true, messageId: parsed && parsed.result && parsed.result.message_id };
}

async function handler(req, res) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }
  if (!ANTHROPIC_API_KEY) return res.status(503).json({ ok: false, error: 'anthropic_env_missing' });

  const dryRun = String(req.query.dryRun || '') === '1';

  const pending = await sb(
    'social_comment_replies?reply_status=eq.new&thread_status=eq.open'
    + '&select=id,platform,account_id,external_post_id,comment_external_id,parent_comment_id,'
    + 'commenter_name,commenter_handle,original_comment,post_excerpt,post_permalink,comment_url,comment_created_at'
    + `&order=comment_created_at.desc&limit=${MAX_PER_RUN}`,
  );
  if (!pending.ok) return res.status(500).json({ ok: false, error: `query_failed:${pending.status}` });
  const rows = Array.isArray(pending.data) ? pending.data : [];

  if (rows.length === 0) {
    return res.status(200).json({ ok: true, created: 0, pending: 0, note: 'no new comments awaiting a draft' });
  }

  // Recent openers so structure varies ACROSS drafts — the exact thing Heath
  // caught: three drafts in a row with the identical two-beat shape.
  const recent = await sb(
    'social_comment_replies?reply_text=not.is.null&select=reply_text&order=drafted_at.desc&limit=12',
  );
  const recentOpeners = (Array.isArray(recent.data) ? recent.data : [])
    .map((r) => String(r.reply_text || '')).filter(Boolean);

  let created = 0;
  let escalatedCount = 0;
  let heldCount = 0;
  let hostileCount = 0;
  const errors = [];

  for (const row of rows) {
    try {
      const { hostile, hostileReason, reply, owner } = await draftFor(row, recentOpeners);

      if (hostile || !reply) {
        await sb(`social_comment_replies?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            reply_status: 'flagged',
            escalated: true,
            escalation_reason: hostileReason || 'model produced no draft',
            is_spam: hostile,
            drafted_at: new Date().toISOString(),
          }),
        });
        hostileCount += 1;
        if (!dryRun) await sendCard(row, buildCard({ ...row, escalated: true }, '', { category: 'hostile', reason: hostileReason }, null), false);
        continue;
      }

      // Gate 1 — escalation. Pricing / demo questions are Heath's, always.
      const verdict = await classifyCommentRisk(row.original_comment, reply);
      const escalated = !verdict.eligible;

      // Gate 2 — content gates (fabrication, capability claims, voice, length).
      const gates = checkContentGates(reply);

      const status = (escalated || !gates.pass) ? 'held' : 'drafted';
      if (escalated) escalatedCount += 1;
      if (!gates.pass) heldCount += 1;

      if (dryRun) { created += 1; recentOpeners.unshift(reply); continue; }

      const patch = await sb(`social_comment_replies?id=eq.${row.id}&reply_status=eq.new`, {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({
          reply_text: reply,
          reply_status: status,
          escalated,
          escalation_reason: escalated ? `${verdict.category}: ${verdict.reason}` : null,
          risk_category: verdict.category,
          risk_confidence: verdict.confidence,
          gate_failures: gates.pass ? null : gates.failures,
          drafted_at: new Date().toISOString(),
        }),
      });
      // Guarded on reply_status=eq.new so two overlapping runs cannot both
      // claim the same row and send two Telegram cards for one comment.
      if (!patch.ok || !Array.isArray(patch.data) || patch.data.length === 0) continue;

      const card = buildCard({ ...row, escalated }, reply, verdict, gates.pass ? null : gates.failures);
      // Buttons only when the draft is actually approvable. An escalated or
      // gate-failed row gets the text and no Approve button, so there is no
      // one-tap path from a pricing question to a posted reply.
      const sent = await sendCard(row, card, status === 'drafted');
      if (sent.ok) {
        await sb(`social_comment_replies?id=eq.${row.id}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({
            telegram_message_id: sent.messageId || null,
            telegram_sent_at: new Date().toISOString(),
          }),
        });
      } else {
        errors.push({ id: row.id, stage: 'telegram', error: sent.error });
      }

      created += 1;
      recentOpeners.unshift(reply);
    } catch (err) {
      errors.push({ id: row.id, stage: 'draft', error: err.message });
      await sb(`social_comment_replies?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ error_message: String(err.message).slice(0, 400) }),
      });
    }
  }

  // `created` feeds cron-telemetry's outcome stamp. A run that drafts nothing
  // while comments sit unanswered shows as outcome='zero', not as success.
  return res.status(200).json({
    ok: true,
    created,
    considered: rows.length,
    escalated: escalatedCount,
    held_by_gates: heldCount,
    hostile: hostileCount,
    dry_run: dryRun,
    error_count: errors.length,
    errors: errors.slice(0, 5),
  });
}

module.exports = withTelemetry('cron-comment-reply-draft', handler);
module.exports.handler = handler;
module.exports.HEATH_REALTOR_ACCOUNTS = HEATH_REALTOR_ACCOUNTS;
module.exports.buildCard = buildCard;
