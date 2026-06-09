'use strict';

// scripts/generate-group-posts.js
//
// Reads group_registry where skip=false and cool-down has passed.
// For each eligible group, calls Claude Haiku to generate fresh post copy
// based on FB-GROUP-PLAYBOOK.md templates, inserts a group_posts row,
// and sends two messages to DossieMarketingBot for one-tap approval.
//
// Usage:
//   node scripts/generate-group-posts.js
//   node scripts/generate-group-posts.js --dry-run   # generate but don't send to Telegram
//   node scripts/generate-group-posts.js --group-id [uuid]  # single group only
//   node scripts/generate-group-posts.js --max 3     # cap groups per run
//
// Env vars required:
//   ANTHROPIC_API_KEY
//   TELEGRAM_MARKETING_BOT_TOKEN
//   TELEGRAM_CHAT_ID
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY

const path = require('path');

// Load .env.local when running locally
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env.local');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
      if (!process.env[key]) process.env[key] = val;
    }
  }
} catch (e) {
  // Non-fatal — env vars may already be set
}

const { runGroupPostGeneration } = require('../api/_lib/group-post-generator');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const groupIdFilter = (() => {
  const idx = args.indexOf('--group-id');
  return idx >= 0 ? args[idx + 1] : null;
})();
const maxArgIdx = args.indexOf('--max');
const maxPerRun = maxArgIdx >= 0 ? parseInt(args[maxArgIdx + 1], 10) : null;

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[generate-group-posts] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('[generate-group-posts] ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[generate-group-posts] TELEGRAM_MARKETING_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
    process.exit(1);
  }

  const result = await runGroupPostGeneration({
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
    anthropicKey: ANTHROPIC_API_KEY,
    telegramToken: TELEGRAM_BOT_TOKEN,
    telegramChatId: TELEGRAM_CHAT_ID,
    dryRun: DRY_RUN,
    groupIdFilter,
    maxPerRun: Number.isFinite(maxPerRun) && maxPerRun > 0 ? maxPerRun : null,
  });

  if (DRY_RUN) {
    for (const g of result.generated) {
      console.log(`\n--- DRY RUN: ${g.group_name} (${g.template_id}) ---`);
      console.log(g.post_body);
      if (g.first_comment_body) {
        console.log('\n[First comment]');
        console.log(g.first_comment_body);
      }
      console.log('---\n');
    }
  }
}

main().catch((err) => {
  console.error('[generate-group-posts] Fatal error:', err.message);
  process.exit(1);
});
