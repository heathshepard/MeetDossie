'use strict';

// scripts/_lib/group-post-dedup.js
//
// No-repeat-in-a-group-within-30-days dedupe for the daily 5-group-post
// pipeline. Two layers, same spirit as comment_opportunities.post_hash:
//   1. EXACT match  -- normalized md5 hash of the post body (the DB
//      generated column group_posts.content_hash mirrors this exact
//      normalization so a live DB-level check is also possible).
//   2. NEAR-DUP match -- word-overlap similarity against every post in the
//      same group from the last 30 days, PLUS same hook_type (content
//      format) reused in the same group inside the window, which reads as
//      repetitive even when Claude phrases it differently.
//
// Pure functions, no network — the caller (api/_lib/daily-group5-post-
// generator.js) supplies "recent posts in this group" already queried.
//
// Owner: Carter, 2026-09-09

const crypto = require('crypto');

const DEDUPE_WINDOW_DAYS = 30;
const SIMILARITY_THRESHOLD = 0.55; // word-overlap ratio above this = near-dup

function normalizeBody(text) {
  return String(text || '').trim().replace(/\s+/g, ' ');
}

function hashBody(text) {
  return crypto.createHash('md5').update(normalizeBody(text)).digest('hex');
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'is',
  'are', 'was', 'were', 'be', 'been', 'i', 'my', 'me', 'you', 'your', 'it',
  'its', 'this', 'that', 'with', 'at', 'as', 'so', 'if', 'just', 'not',
]);

function wordSet(text) {
  return new Set(
    normalizeBody(text)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard word-overlap ratio, 0-1. */
function wordOverlapRatio(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) if (setB.has(w)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * @param {string} newBody
 * @param {string} newHookType
 * @param {Array<{post_body:string, hook_type:string, created_at:string}>} recentPosts
 *   Posts already filtered to the SAME group and within the dedupe window.
 * @returns {{ duplicate: boolean, reason?: string, matchedAgainst?: object }}
 */
function checkDuplicate(newBody, newHookType, recentPosts) {
  const newHash = hashBody(newBody);
  const rows = Array.isArray(recentPosts) ? recentPosts : [];

  for (const row of rows) {
    if (hashBody(row.post_body) === newHash) {
      return { duplicate: true, reason: 'exact_body_match', matchedAgainst: row };
    }
  }

  for (const row of rows) {
    const ratio = wordOverlapRatio(newBody, row.post_body);
    if (ratio >= SIMILARITY_THRESHOLD) {
      return {
        duplicate: true,
        reason: `near_duplicate_body:${ratio.toFixed(2)}`,
        matchedAgainst: row,
      };
    }
  }

  if (newHookType) {
    const sameHook = rows.find((row) => row.hook_type === newHookType);
    if (sameHook) {
      return { duplicate: true, reason: `hook_reused:${newHookType}`, matchedAgainst: sameHook };
    }
  }

  return { duplicate: false };
}

/** Filters a full post list down to "same group, inside the dedupe window". */
function withinDedupeWindow(posts, groupKey, now = new Date()) {
  const cutoff = new Date(now.getTime() - DEDUPE_WINDOW_DAYS * 24 * 3600 * 1000);
  return (Array.isArray(posts) ? posts : []).filter(
    (p) => p.group_key === groupKey && new Date(p.created_at) >= cutoff,
  );
}

module.exports = {
  DEDUPE_WINDOW_DAYS,
  SIMILARITY_THRESHOLD,
  hashBody,
  wordOverlapRatio,
  checkDuplicate,
  withinDedupeWindow,
};
