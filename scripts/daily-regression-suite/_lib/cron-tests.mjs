// scripts/daily-regression-suite/_lib/cron-tests.mjs
//
// Category 16 — Cron health. Reads `cron_runs` table + asserts each daily-or-
// more-frequent cron has a recent last_run.
//
// This is the exact class of failure the suite exists to detect: silently-
// broken crons that stop running but never alert.

import { mkTest } from './http.mjs';
import { sb } from './supabase.mjs';

// [cron_name, max_age_hours]
// If a cron runs every N minutes, max_age is 3× that interval (buffer for cold-start latency).
// Daily crons get 30h.
const CRONS = [
  ['cron-alert-health',                0.5],   // every 5m -> 30m
  ['cron-publish-approved',            1.5],
  ['cron-staging-watcher',             0.5],
  ['cron-send-outbound-emails',        0.5],
  ['cron-agent-queue-tick',            0.5],
  ['cron-agent-worker-tick',           0.5],
  ['cron-pull-post-analytics',         30],
  ['cron-platform-health-checker',     4],
  ['cron-followup-check',              1],
  ['cron-morning-brief',               30],
  ['cron-morning-ops-digest',          30],
  ['cron-daily-platform-health',       30],
  ['cron-autonomous-loop',             30],
  ['cron-dossie-sign-completion-loop', 1.5],
  ['cron-deadline-reminders',          30],
  ['cron-email-digest',                30],
  ['cron-pipeline-health',             30],
  ['cron-self-improvement-daily',      30],
  ['cron-calculator-deadline-reminders', 30],
  ['cron-dossie-full-diagnostic',      30],
  ['cron-codebase-facts-indexer',      8],
  ['cron-verify-zernio-deliveries',    1.5],
  ['cron-inbox-scan',                  2],
  ['cron-followup',                    30],
];

export function cronTests() {
  return CRONS.map(([name, maxHours]) => {
    return mkTest(`cron.${name}`, 'cron', 'cron', async (ctx) => {
      if (!ctx.cfg.supabaseServiceKey) return { verdict: 'SKIP', response_ms: 0, error: 'no supabase key' };
      const { data, ok } = await sb(ctx.cfg,
        `/rest/v1/cron_runs?cron_name=eq.${encodeURIComponent(name)}&select=last_run,last_status&limit=1`);
      if (!ok) return { verdict: 'FAIL', response_ms: 0, error: `query failed: ${data?.message || 'unknown'}` };
      if (!Array.isArray(data) || data.length === 0) {
        return { verdict: 'FAIL', response_ms: 0, error: `no cron_runs row for ${name} — either never ran or telemetry broken` };
      }
      const row = data[0];
      const lastRun = row.last_run ? new Date(row.last_run) : null;
      if (!lastRun) return { verdict: 'FAIL', response_ms: 0, error: 'null last_run' };
      const ageHours = (Date.now() - lastRun.getTime()) / 3600 / 1000;
      const stale = ageHours > maxHours;
      const badStatus = row.last_status && row.last_status !== 'ok' && row.last_status !== 'success';
      if (stale) return { verdict: 'FAIL', response_ms: 0, error: `stale: last_run ${ageHours.toFixed(1)}h ago (max ${maxHours}h)`, detail: { age_hours: ageHours, last_status: row.last_status } };
      if (badStatus) return { verdict: 'FAIL', response_ms: 0, error: `bad last_status: ${row.last_status}`, detail: { last_status: row.last_status, age_hours: ageHours } };
      return { verdict: 'PASS', response_ms: 0, detail: { age_hours: ageHours, last_status: row.last_status } };
    });
  });
}
