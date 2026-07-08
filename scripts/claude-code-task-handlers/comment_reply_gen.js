// scripts/claude-code-task-handlers/comment_reply_gen.js
//
// Handler for the cron-comment-monitor draft reply flow.
// Reads one inbound comment, drafts a warm 1-2 sentence Dossie reply via
// `claude --print` (Max-billed), writes it back to social_comment_replies.
//
// Contract:
//   payload: {
//     reply_row_id:      uuid (required) — public.social_comment_replies.id
//     platform:          string
//     post_persona:      string
//     post_hook:         string
//     post_content:      string
//     commenter_handle:  string
//     original_comment:  string
//   }
//
// Owner: Atlas, 2026-07-08.

'use strict';

const { runClaude, extractJsonTail, sbFetch } = require('./_lib/claude-spawn.js');

function buildPrompt(p) {
  return [
    `# Draft a Dossie comment reply`,
    ``,
    `You are drafting a warm 1-2 sentence reply from Dossie's team account on a REALTOR social post.`,
    ``,
    `## Post the commenter is responding to`,
    `Platform: ${p.platform}`,
    `Persona (post author voice): ${p.post_persona || 'brenda'}`,
    `Hook: ${p.post_hook || ''}`,
    `Body: ${(p.post_content || '').slice(0, 800)}`,
    ``,
    `## The comment we're replying to`,
    `From @${p.commenter_handle || '(unknown)'}: "${(p.original_comment || '').slice(0, 800)}"`,
    ``,
    `## Rules`,
    `- Warm, human, peer-to-peer. Not corporate. Not sales-y.`,
    `- 1-2 sentences maximum. Never longer.`,
    `- Never emoji-spam. One emoji max, only if it truly fits.`,
    `- Never link. Never say "DM us." Never say "check the link in bio."`,
    `- Never invent facts. If you don't know something, ask a warm follow-up question.`,
    `- If the comment is obvious spam / bot / crypto scam / promo / gibberish, mark is_spam=true and reply_text="".`,
    ``,
    `## Return ONLY this JSON on the last line`,
    ``,
    `{"is_spam": true|false, "reply_text": "<the 1-2 sentence reply, empty string if spam>", "reason": "<one short line explaining the choice>"}`,
  ].join('\n');
}

module.exports = async function commentReplyGen({ payload, task_id, log }) {
  if (!payload || !payload.reply_row_id) {
    return { ok: false, summary: 'reply_row_id required', error: 'missing_reply_row_id' };
  }
  if (!payload.original_comment) {
    return { ok: false, summary: 'original_comment required', error: 'missing_original_comment' };
  }

  log(`comment_reply_gen row=${payload.reply_row_id} platform=${payload.platform}`);

  const prompt = buildPrompt(payload);
  const runResult = await runClaude(prompt, { model: 'sonnet', timeoutMs: 3 * 60 * 1000, log });
  if (!runResult.ok) {
    return {
      ok: false,
      summary: `claude call failed: ${runResult.error}`,
      error: runResult.error,
    };
  }

  const parsed = extractJsonTail(runResult.raw);
  if (!parsed) {
    // Mark the row as failed so it doesn't get retried forever.
    await sbFetch(`social_comment_replies?id=eq.${payload.reply_row_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        reply_status: 'failed',
        error_message: `json_parse_failed: ${runResult.raw.slice(-300)}`,
      }),
    });
    return { ok: false, summary: 'json_parse_failed', error: 'json_parse_failed' };
  }

  const isSpam = Boolean(parsed.is_spam);
  const replyText = String(parsed.reply_text || '').trim().slice(0, 600);

  if (isSpam || !replyText) {
    await sbFetch(`social_comment_replies?id=eq.${payload.reply_row_id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        is_spam: true,
        reply_status: 'skipped_spam',
        reply_text: '',
      }),
    });
    return {
      ok: true,
      summary: `skipped as spam: ${parsed.reason || ''}`,
      result: { skipped: true, is_spam: true },
    };
  }

  await sbFetch(`social_comment_replies?id=eq.${payload.reply_row_id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      reply_text: replyText,
      reply_status: 'draft',
    }),
  });

  return {
    ok: true,
    summary: `reply drafted (${replyText.length} chars): "${replyText.slice(0, 80)}"`,
    result: { reply_text: replyText, reason: parsed.reason, max_billed: true },
  };
};
