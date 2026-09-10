'use strict';

// api/listing-group-post-callback.js
//
// Vercel serverless handler for the listing-marketing rotation's Tier-2
// (FB Group) DossieMarketingBot inline keyboard callbacks: lst_approve /
// lst_edit / lst_skip. Called from api/telegram-webhook.js. Modeled
// directly on api/group5-post-callback.js (gp5_*) -- SEPARATE callback
// prefix and pipeline filter ('listing-groups' vs 'daily5') so the two
// pipelines' Telegram flows never cross-match each other's rows.
//
// lst_approve: status='draft' -> 'approved', guarded so a double-tap can't
//              re-approve. scripts/fb-listing-group-post-queue.js picks it
//              up on the next local queue-runner tick.
// lst_edit:    prompts Heath to reply with revised text (LST_EDIT_PROMPT_*
//              handled in api/telegram-webhook.js's reply router). His
//              reply becomes post_body AND approves in the same step, but
//              ONLY if it still passes the listing compliance gate (TREC
//              attribution + owner disclosure, same as generation time).
// lst_skip:    status -> 'skipped'. Terminal.
//
// Owner: Carter, 2026-09-10

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

async function fetchListingGroupPost(postId) {
  const { ok, data } = await supabaseFetch(
    `/rest/v1/group_posts?id=eq.${encodeURIComponent(postId)}&pipeline=eq.listing-groups&limit=1`,
  );
  if (!ok || !Array.isArray(data) || !data.length) return null;
  return data[0];
}

/**
 * @param {string} action  'lst_approve' | 'lst_edit' | 'lst_skip'
 * @param {string} postId
 * @param {object} deps  same shape as handleGroup5PostCallback's deps
 */
async function handleListingGroupPostCallback(action, postId, deps) {
  const {
    answerCallback, editMessage, sendMessage, editPromptText,
    callbackId, chatId, messageId, originalMessageText,
  } = deps;

  const post = await fetchListingGroupPost(postId);
  const originalBody = originalMessageText || '';

  if (!post) {
    if (callbackId) await answerCallback(callbackId, 'Listing post not found');
    return { ok: false, reason: 'not_found' };
  }

  if (action === 'lst_edit') {
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

  if (action === 'lst_approve') {
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
      ? 'Approved — posts on the next local queue-runner tick (3/day budget, 30-40 min varied spacing; queued if over cap or spacing).'
      : 'Already handled.';
    if (chatId && messageId) await editMessage(chatId, messageId, `${originalBody}\n\n${tail}`);
    if (callbackId) await answerCallback(callbackId, won ? 'Approved' : 'Already handled');
    return { ok: won, action: 'approved' };
  }

  if (action === 'lst_skip') {
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

module.exports = { handleListingGroupPostCallback, fetchListingGroupPost };
