#!/usr/bin/env node

/**
 * Backfill Script: post_analytics Content Enrichment
 *
 * One-time script to populate hook, hook_type, cta_type, topic, persona fields
 * in post_analytics rows from their corresponding social_posts rows.
 *
 * Safe to run multiple times (idempotent via WHERE clauses).
 *
 * Usage:
 *   node scripts/backfill-post-analytics-fields.js
 */

const fetch = require('node-fetch');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data, text };
}

async function main() {
  console.log('[backfill] Starting post_analytics content enrichment...');

  try {
    // Step 1: Fetch all post_analytics rows where hook IS NULL (not yet backfilled)
    console.log('[backfill] Fetching post_analytics rows with missing fields...');
    const analyticsRes = await supabaseFetch(
      '/rest/v1/post_analytics?hook=is.null&select=id,social_post_id&order=fetched_at.desc&limit=1000'
    );

    if (!analyticsRes.ok) {
      console.error('[backfill] Failed to fetch post_analytics:', analyticsRes.status, analyticsRes.text.slice(0, 200));
      process.exit(1);
    }

    const rows = Array.isArray(analyticsRes.data) ? analyticsRes.data : [];
    console.log(`[backfill] Found ${rows.length} post_analytics rows needing enrichment`);

    if (rows.length === 0) {
      console.log('[backfill] No rows to backfill. Done.');
      process.exit(0);
    }

    // Step 2: Fetch the social_posts data for all these IDs
    const socialPostIds = rows.map(r => r.social_post_id).filter(Boolean);
    console.log(`[backfill] Fetching source data from ${socialPostIds.length} social_posts...`);

    const idFilter = socialPostIds.map(id => `"${id}"`).join(',');
    const socialPostsRes = await supabaseFetch(
      `/rest/v1/social_posts?id=in.(${encodeURIComponent(idFilter)})&select=id,hook,hook_type,cta_type,topic,persona`
    );

    if (!socialPostsRes.ok) {
      console.error('[backfill] Failed to fetch social_posts:', socialPostsRes.status);
      process.exit(1);
    }

    const socialPosts = Array.isArray(socialPostsRes.data) ? socialPostsRes.data : [];
    const postMap = {};
    for (const post of socialPosts) {
      postMap[post.id] = post;
    }

    // Step 3: Update each post_analytics row with the enriched data
    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const row of rows) {
      const sourcePost = postMap[row.social_post_id];
      if (!sourcePost) {
        skipped++;
        console.warn(`[backfill] No source social_posts row found for analytics id=${row.id}`);
        continue;
      }

      const updateBody = {
        hook: sourcePost.hook || null,
        hook_type: sourcePost.hook_type || null,
        cta_type: sourcePost.cta_type || null,
        topic: sourcePost.topic || null,
        persona: sourcePost.persona || null,
      };

      const updateRes = await supabaseFetch(
        `/rest/v1/post_analytics?id=eq.${row.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(updateBody),
        }
      );

      if (updateRes.ok) {
        updated++;
        if (updated % 50 === 0) {
          console.log(`[backfill] Updated ${updated}/${rows.length}...`);
        }
      } else {
        errors.push({ row_id: row.id, status: updateRes.status, error: updateRes.text.slice(0, 100) });
        console.error(`[backfill] Update failed for id=${row.id}: ${updateRes.status}`);
      }
    }

    console.log(`[backfill] Complete. Updated: ${updated}, Skipped: ${skipped}, Errors: ${errors.length}`);
    if (errors.length > 0) {
      console.error('[backfill] Errors:', errors.slice(0, 5));
    }

    process.exit(errors.length > 0 ? 1 : 0);
  } catch (err) {
    console.error('[backfill] Fatal error:', err.message);
    process.exit(1);
  }
}

main();
