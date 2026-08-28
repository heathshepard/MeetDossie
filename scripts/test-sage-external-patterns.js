'use strict';

// scripts/test-sage-external-patterns.js
//
// Standalone test — runs api/_lib/sage-external-patterns.js against the REAL
// live sage_swipe_rules/sage_swipe_items/post_analytics data and prints the
// exact block that would be injected into cron-generate-posts.js's prompt
// IF this were wired in (it is NOT wired in — see file header comment).
//
// Usage: node scripts/test-sage-external-patterns.js

const fs = require('fs');
const path = require('path');

try {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/\r$/, '').replace(/^"(.*)"$/, '$1');
      if (val && val !== '[SENSITIVE]') process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal
}

const { fetchExternalSwipeRules, fetchExternalSwipeItems, buildCrossReferencedStrategyBlock } = require('../api/_lib/sage-external-patterns');

async function fetchInternalTopHooks() {
  const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/post_analytics?select=hook,platform,persona,engagement_score,hook_type&engagement_score=gt.0&order=engagement_score.desc&limit=5`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  const data = await res.json();
  return Array.isArray(data) ? data.filter((h) => h.hook) : [];
}

(async () => {
  const externalRules = await fetchExternalSwipeRules();
  const externalItems = await fetchExternalSwipeItems();
  const internalTopHooks = await fetchInternalTopHooks();

  console.log(`external rules: ${externalRules.length}`);
  console.log(`external items: ${externalItems.length}`);
  console.log(`internal top hooks (post_analytics, real): ${internalTopHooks.length}`);
  console.log('');

  const block = buildCrossReferencedStrategyBlock(externalRules, internalTopHooks, externalItems);
  console.log('=== PROMPT BLOCK THAT WOULD BE INJECTED (not currently wired in) ===');
  console.log(block || '(empty — no external rules found)');
})();
