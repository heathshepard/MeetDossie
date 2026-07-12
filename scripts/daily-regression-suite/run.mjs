#!/usr/bin/env node
// scripts/daily-regression-suite/run.mjs
//
// Daily regression suite runner. Executes every test in the manifest and
// writes results to `regression_runs` table + local dashboard.
//
// USAGE:
//   node scripts/daily-regression-suite/run.mjs                                  # full local run (prod)
//   node scripts/daily-regression-suite/run.mjs --base https://staging.foo.app    # staging
//   node scripts/daily-regression-suite/run.mjs --tiers api,db,cron              # skip Playwright
//   node scripts/daily-regression-suite/run.mjs --categories api,cron            # single-category run
//
// CRITICAL CONSTRAINT:
//   - Pure Playwright + direct API calls. NO Anthropic API dependency.
//   - Runner must produce a report even when the base URL is down.
//   - Never touches real customer rows (demo user only, sentinel prefix, teardown).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfig } from './_lib/config.mjs';
import { runOne } from './_lib/http.mjs';
import { apiTests } from './_lib/api-tests.mjs';
import { dbTests } from './_lib/db-tests.mjs';
import { cronTests } from './_lib/cron-tests.mjs';
import { finalize } from './_lib/report.mjs';

// Load .env.local for local runs (Vercel already has env populated)
async function tryLoadDotenv(repoRoot) {
  const envPath = path.join(repoRoot, '.env.local');
  if (!fs.existsSync(envPath)) return;
  try {
    const { config } = await import('dotenv');
    config({ path: envPath });
  } catch {
    // Fallback: hand-parse
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      if (!process.env[k]) process.env[k] = v.replace(/^["']|["']$/g, '');
    }
  }
}

async function collectTests(cfg) {
  const wants = new Set(cfg.tiers);
  const tests = [];
  if (wants.has('api')) tests.push(...apiTests());
  if (wants.has('db')) tests.push(...dbTests());
  if (wants.has('cron')) tests.push(...cronTests());
  if (wants.has('ui')) {
    // Lazy import so Vercel mode doesn't hit missing playwright
    const { uiTests } = await import('./_lib/ui-tests.mjs');
    tests.push(...(await uiTests(cfg)));
  }
  // Filter by category if requested
  if (cfg.categories.length > 0) {
    const s = new Set(cfg.categories);
    return tests.filter(t => s.has(t.category) || s.has(t.tier));
  }
  return tests;
}

async function main() {
  const cfg = buildConfig();
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  await tryLoadDotenv(path.resolve(__dirname, '..', '..'));

  // Reload cfg to pick up env-populated values
  const cfg2 = buildConfig();
  Object.assign(cfg, cfg2);

  console.log(`[regression] base: ${cfg.base}`);
  console.log(`[regression] tiers: ${cfg.tiers.join(',')}`);
  console.log(`[regression] source: ${cfg.source}`);
  console.log(`[regression] outDir: ${cfg.outDir}`);

  const tests = await collectTests(cfg);
  console.log(`[regression] ${tests.length} tests to run`);

  const started = Date.now();
  const results = [];
  const ctx = { cfg };
  for (const t of tests) {
    const r = await runOne(t, ctx);
    const emoji = r.verdict === 'PASS' ? '.' : r.verdict === 'FAIL' ? 'F' : 's';
    process.stdout.write(emoji);
    results.push(r);
  }
  process.stdout.write('\n');
  const durationMs = Date.now() - started;

  const outcome = await finalize(cfg, results, durationMs);

  console.log(`\n[regression] ${outcome.sum.passed}/${outcome.sum.total} passed · ${outcome.sum.failed} failed · ${outcome.sum.skipped} skipped · ${durationMs}ms`);
  console.log(`[regression] severity: ${outcome.severity}`);
  console.log(`[regression] regressions: ${outcome.deltas.regressions.length} · recoveries: ${outcome.deltas.recoveries.length}`);
  if (outcome.local?.dashPath) console.log(`[regression] dashboard: ${outcome.local.dashPath}`);
  if (outcome.local?.jsonPath) console.log(`[regression] report:    ${outcome.local.jsonPath}`);

  // Exit non-zero only on RED so CI can gate on it if desired
  process.exit(outcome.severity === 'RED' ? 1 : 0);
}

main().catch(e => {
  console.error('[regression] fatal:', e.stack || e.message);
  process.exit(2);
});
