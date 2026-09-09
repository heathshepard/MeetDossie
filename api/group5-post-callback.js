'use strict';

// api/group5-post-callback.js
//
// Vercel serverless handler for the daily 5-group-post pipeline's
// DossieMarketingBot inline keyboard callbacks: gp5_approve / gp5_edit /
// gp5_skip. Called from api/telegram-webhook.js, same pattern as
// api/group-post-callback.js (the OLDER 32-group rotation campaign) and
// api/cron-comment-opp-approval.js's oppc_* flow — but this is a SEPARATE
// handler (distinct callback prefix) so the old campaign's "first_comment
// must mention Dossie" validator, which does not apply to this value-only
// pipeline, never runs against these rows.
//
// gp5_approve: status='draft' -> 'approved' (guarded so a double-tap can't
//              re-approve). scripts/fb-group5-post-queue.js picks it up on
//              the next Task Scheduler tick.
// gp5_edit:    prompts Heath to reply with revised text (GP5_EDIT_PROMPT_*
//              handled in api/telegram-webhook.js's reply router). His
//              reply becomes post_body AND approves in the same step.
// gp5_skip:    status -> 'skipped'. Terminal.
//
// Owner: Carter, 2026-09-09

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function supabaseFetch(urlPath, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${urlPath}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function fetchGroup5Post(postId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&pipeline=eq.daily5&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

/**
 * @param {string} action  'gp5_approve' | 'gp5_edit' | 'gp5_skip'
 * @param {string} postId
 * @param {function} answerCallback  (callbackId, text) => Promise
 * @param {function} editMessage     (chatId, messageId, text) => Promise
 * @param {function} sendMessage     (chatId, text) => Promise (used only for gp5_edit)
 * @param {string} editPromptText    the full force-reply prompt text (built by
 *   the caller from its own GP5_EDIT_PROMPT_PREFIX/SUFFIX constants, same
 *   pattern as OPPC_EDIT_PROMPT_PREFIX/SUFFIX) — this module never hardcodes
 *   the sentinel string so telegram-webhook.js stays the single owner of the
 *   reply-routing contract.
 * @param {string} callbackId
 * @param {string} chatId
 * @param {string} messageId
 * @param {string} originalMessageText
 */
async function handleGroup5PostCallback(action, postId, deps) {
  const {
    answerCallback, editMessage, sendMessage, editPromptText,
    callbackId, chatId, messageId, originalMessageText,
  } = deps;

  const post = await fetchGroup5Post(postId);
  const originalBody = originalMessageText || '';

  if (!post) {
    if (callbackId) await answerCallback(callbackId, 'Post not found');
    return { ok: false, reason: 'not_found' };
  }

  if (action === 'gp5_edit') {
    if (post.status !== 'draft' && post.status !== 'approved') {
      if (callbackId) await answerCallback(callbackId, `Too late — already ${post.status}`);
      return { ok: false, reason: 'too_late' };
    }
    if (sendMessage) await sendMessage(chatId, editPromptText);
    if (callbackId) await answerCallback(callbackId, 'Reply with the revised post');
    return { ok: true, action: 'edit_prompted' };
  }

  if (post.status !== 'draft') {
    if (callbackId) await answerCallback(callbackId, `Already ${post.status}`);
    return { ok: false, reason: 'already_handled', status: post.status };
  }

  const nowIso = new Date().toISOString();

  if (action === 'gp5_approve') {
    // Guard on status=eq.draft so a double-tap can't double-approve.
    const patch = await supabaseFetch(
      `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&status=eq.draft`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ status: 'approved', approved_at: nowIso, auto_post_at: nowIso }),
      },
    );
    const won = patch.ok && Array.isArray(patch.data) && patch.data.length > 0;
    const tail = won
      ? 'Approved — posts on the next local queue-runner tick (5/day budget, 18-24 min varied spacing; queued if over cap or spacing).'
      : 'Already handled.';
    if (chatId && messageId) await editMessage(chatId, messageId, `${originalBody}\n\n${tail}`);
    if (callbackId) await answerCallback(callbackId, won ? 'Approved' : 'Already handled');
    return { ok: won, action: 'approved' };
  }

  if (action === 'gp5_skip') {
    await supabaseFetch(
      `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&status=eq.draft`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ status: 'skipped', updated_at: nowIso }),
      },
    );
    if (chatId && messageId) await editMessage(chatId, messageId, `${originalBody}\n\nSkipped.`);
    if (callbackId) await answerCallback(callbackId, 'Skipped');
    return { ok: true, action: 'skipped' };
  }

  if (callbackId) await answerCallback(callbackId, 'Unknown action');
  return { ok: false, reason: 'unknown_action' };
}

module.exports = { handleGroup5PostCallback, fetchGroup5Post };
