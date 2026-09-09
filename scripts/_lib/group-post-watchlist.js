'use strict';

// scripts/_lib/group-post-watchlist.js
//
// Extracted from scripts/fb-group-poster.js (2026-09-09, Carter) so the
// comment_watchlist handoff for a posted GROUP POST is independently
// testable without invoking the CLI script (which parses argv and exits
// the process at module load if --post-id is missing, and launches real
// Playwright/Chrome on require — not something a regression test should
// touch).
//
// Behavior is unchanged from the inline version fb-group-poster.js has run
// since 2026-08-28 (Sage): on ANY confirmed post — legacy group_registry
// rotation campaign OR the daily5 pipeline (api/_lib/daily-group5-post-
// generator.js) — register the thread in comment_watchlist with
// direction='heath_own_post' so scripts/watch-guest-thread-replies.js
// catches replies. This is the pre-existing, CLAUDE.md RULE-4-sanctioned
// exception that posts autonomously, so registration fires on the real
// confirmed post, not on a separate Heath confirmation tap.
//
// Owner: Sage (original), Carter (extraction), 2026-09-09

/**
 * @param {function} sbFetch  (path, init) => Promise<{ok, status, data}>
 * @param {object} post       the group_posts row (needs group_name, post_body)
 * @param {string} postId
 * @param {string} postUrl
 * @returns {Promise<{ok: boolean, id: string|null}>}
 */
async function registerGroupPostWatch(sbFetch, post, postId, postUrl) {
  const res = await sbFetch('/rest/v1/comment_watchlist', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      thread_url: postUrl,
      group_name: post.group_name,
      post_author: 'Heath Shepard',
      direction: 'heath_own_post',
      our_text: post.post_body,
      source_table: 'group_posts',
      source_id: postId,
      posted_at: new Date().toISOString(),
    }),
  });
  const id = res.ok && Array.isArray(res.data) && res.data.length > 0 ? res.data[0].id : null;
  return { ok: res.ok, id };
}

module.exports = { registerGroupPostWatch };
