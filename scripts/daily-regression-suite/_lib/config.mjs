// scripts/daily-regression-suite/_lib/config.mjs
//
// Central config for the daily regression suite.
// Reads env from process.env (populated by dotenv in run.mjs OR by Vercel env).
//
// NO Anthropic API dependency in the runner. NO destructive endpoints in prod.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SUITE_ROOT = path.resolve(__dirname, '..');
export const REPO_ROOT = path.resolve(SUITE_ROOT, '..', '..');

export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function buildConfig(argv = process.argv) {
  const args = parseArgs(argv);

  const base = args.base || process.env.REGRESSION_BASE_URL || 'https://meetdossie.com';

  const tiers = (args.tiers || process.env.REGRESSION_TIERS || 'api,db,cron,ui')
    .split(',').map(s => s.trim()).filter(Boolean);

  const categories = (args.categories || process.env.REGRESSION_CATEGORIES || '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out || path.join(REPO_ROOT, '.tmp', 'regression-runs', runId);

  return {
    base,
    tiers,
    categories, // if set, only run these categories
    outDir,
    runId,
    source: args.source || 'local-playwright',
    headless: args.headless !== 'false' && args.headless !== false,
    // Auth for signed-in UI tests
    email: args.email || process.env.APV_EMAIL || 'demo@meetdossie.com',
    password: args.password || process.env.APV_PASSWORD || process.env.DEMO_PASSWORD || null,
    demoUserId: process.env.DEMO_USER_ID || 'c29ce34c-1434-44e5-a260-8d1a45213ec3',
    // Supabase
    supabaseUrl: process.env.SUPABASE_URL || 'https://pgwoitbdiyubjugwufhk.supabase.co',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || null,
    // Telegram (delta alerts)
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
    telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
    // Cron secret for auth-gated probes
    cronSecret: process.env.CRON_SECRET || null,
    // Sentinel prefix for created rows (auto-delete in teardown)
    sentinel: `REGRESSION-${Date.now()}`,
    // Timeouts
    apiTimeoutMs: 10000,
    uiTimeoutMs: 45000,
    // Vercel-cron mode = no Playwright / no local FS write
    vercelMode: !!args.vercel || process.env.REGRESSION_VERCEL_MODE === '1',
  };
}
