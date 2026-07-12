// scripts/daily-regression-suite/_lib/report.mjs
//
// Aggregates results, computes deltas vs. previous run, writes local report
// files, sends the Telegram alert.
//
// Delta rule:
//   - GREEN alert = zero fails AND either (a) previous run had fails OR (b) this is the first green run of the day
//   - YELLOW = 1-10% failed OR delta (any PASS->FAIL) — always alerts
//   - RED = >10% failed — urgent, multi-message allowed
//
// Delta-aware = we do NOT re-alert on tests that were already failing yesterday.
// Only PASS->FAIL and FAIL->PASS trigger the alert body.

import fs from 'node:fs';
import path from 'node:path';
import { sb, fetchPreviousRun, insertRegressionRun } from './supabase.mjs';

export function summarize(results) {
  const passed = results.filter(r => r.verdict === 'PASS').length;
  const failed = results.filter(r => r.verdict === 'FAIL').length;
  const skipped = results.filter(r => r.verdict === 'SKIP').length;
  return { total: results.length, passed, failed, skipped };
}

export function computeDeltas(currentResults, previousResults) {
  if (!Array.isArray(previousResults) || previousResults.length === 0) {
    return { regressions: [], recoveries: [], newTests: [], firstRun: true };
  }
  const prev = new Map(previousResults.map(r => [r.id, r.verdict]));
  const regressions = [];
  const recoveries = [];
  const newTests = [];
  for (const c of currentResults) {
    const p = prev.get(c.id);
    if (p === undefined) {
      if (c.verdict === 'FAIL') newTests.push(c);
      continue;
    }
    if (p === 'PASS' && c.verdict === 'FAIL') regressions.push({ ...c, previous_verdict: p });
    if (p === 'FAIL' && c.verdict === 'PASS') recoveries.push({ ...c, previous_verdict: p });
  }
  return { regressions, recoveries, newTests, firstRun: false };
}

function severity(sum) {
  if (sum.failed === 0) return 'GREEN';
  const pct = (sum.failed / sum.total) * 100;
  if (pct <= 10) return 'YELLOW';
  return 'RED';
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTelegramMessage(sum, deltas, cfg) {
  const sev = severity(sum);
  const emoji = { GREEN: '✅', YELLOW: '⚠️', RED: '🚨' }[sev];
  const header = `${emoji} <b>Regression Suite — ${sev}</b>\n${sum.passed}/${sum.total} passed · ${sum.failed} failed · ${sum.skipped} skipped\n<i>${cfg.base}</i>`;

  const parts = [header];

  if (deltas.regressions.length > 0) {
    parts.push('<b>Regressions (PASS → FAIL):</b>\n' +
      deltas.regressions.slice(0, 15).map(r => `• <code>${esc(r.id)}</code> — ${esc((r.error || '').slice(0, 120))}`).join('\n'));
  }
  if (deltas.recoveries.length > 0) {
    parts.push('<b>Recoveries (FAIL → PASS):</b>\n' +
      deltas.recoveries.slice(0, 10).map(r => `• <code>${esc(r.id)}</code>`).join('\n'));
  }
  if (deltas.newTests.length > 0) {
    parts.push('<b>New failing tests:</b>\n' +
      deltas.newTests.slice(0, 10).map(r => `• <code>${esc(r.id)}</code>`).join('\n'));
  }

  // For GREEN: only alert if previous run wasn't already GREEN with no deltas
  return parts.join('\n\n');
}

export async function sendTelegram(cfg, text) {
  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    console.log('[report] Telegram not configured — skipping alert');
    return { sent: false, reason: 'no-telegram-config' };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    console.error('[report] Telegram send failed:', err.message);
    return { sent: false, reason: err.message };
  }
}

export async function writeLocalReport(cfg, results, sum, deltas, durationMs) {
  if (cfg.vercelMode) return { skipped: true }; // Vercel serverless has no writable local FS
  fs.mkdirSync(cfg.outDir, { recursive: true });
  const jsonPath = path.join(cfg.outDir, 'run.json');
  fs.writeFileSync(jsonPath, JSON.stringify({
    cfg: { base: cfg.base, tiers: cfg.tiers, source: cfg.source, runId: cfg.runId },
    summary: sum,
    duration_ms: durationMs,
    deltas,
    results,
  }, null, 2));

  // Dashboard — refreshed every run
  const dashPath = path.join(path.dirname(cfg.outDir), 'HEALTH-DASHBOARD.md');
  const dashboard = await buildDashboardMarkdown(cfg, sum, results, deltas);
  fs.writeFileSync(dashPath, dashboard);
  return { jsonPath, dashPath };
}

async function buildDashboardMarkdown(cfg, sum, results, deltas) {
  const failing = results.filter(r => r.verdict === 'FAIL');
  const bySlot = groupBy(results, r => r.category);
  const now = new Date().toISOString();

  let md = `# Dossie Regression Suite — Health Dashboard\n\n`;
  md += `Updated: ${now}  \n`;
  md += `Source: ${cfg.source}  \n`;
  md += `Base URL: ${cfg.base}\n\n`;
  md += `## Current run\n\n`;
  md += `- Total: ${sum.total}\n- Passed: ${sum.passed}\n- Failed: ${sum.failed}\n- Skipped: ${sum.skipped}\n\n`;
  md += `## Delta vs. previous run\n\n`;
  md += `- Regressions (PASS→FAIL): ${deltas.regressions?.length ?? 0}\n`;
  md += `- Recoveries (FAIL→PASS): ${deltas.recoveries?.length ?? 0}\n`;
  md += `- New failing tests: ${deltas.newTests?.length ?? 0}\n\n`;
  md += `## Category summary\n\n`;
  md += `| Category | Passed | Failed | Skipped |\n|---|---|---|---|\n`;
  for (const [cat, rows] of Object.entries(bySlot)) {
    const s = summarize(rows);
    md += `| ${cat} | ${s.passed} | ${s.failed} | ${s.skipped} |\n`;
  }
  md += `\n## Currently failing (${failing.length})\n\n`;
  if (failing.length === 0) {
    md += `_None. Full green._\n`;
  } else {
    for (const f of failing) {
      md += `- \`${f.id}\` (${f.category}, ${f.response_ms}ms) — ${(f.error || 'no error').slice(0, 200)}\n`;
    }
  }

  // Chronic-failure ranking — pull last 7 runs
  try {
    const { data } = await sb(cfg,
      `/rest/v1/regression_runs?source=eq.${encodeURIComponent(cfg.source)}&order=run_at.desc&limit=7&select=results`);
    if (Array.isArray(data) && data.length > 1) {
      const failCounts = new Map();
      for (const run of data) {
        for (const r of (run.results || [])) {
          if (r.verdict === 'FAIL') failCounts.set(r.id, (failCounts.get(r.id) || 0) + 1);
        }
      }
      const top = [...failCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      md += `\n## Top 5 chronically-broken tests (last 7 runs)\n\n`;
      if (top.length === 0) md += `_None._\n`;
      for (const [id, count] of top) md += `- \`${id}\` — failed ${count}/${data.length} runs\n`;
    }
  } catch { /* dashboard is best-effort */ }

  return md;
}

function groupBy(arr, fn) {
  const out = {};
  for (const item of arr) {
    const k = fn(item) || 'uncategorized';
    (out[k] = out[k] || []).push(item);
  }
  return out;
}

// Main entry — called by run.mjs after all tests execute
export async function finalize(cfg, results, durationMs) {
  const sum = summarize(results);
  const prev = cfg.supabaseServiceKey ? await fetchPreviousRun(cfg, cfg.source) : [];
  const prevResults = prev[0]?.results || [];
  const deltas = computeDeltas(results, prevResults);

  const local = await writeLocalReport(cfg, results, sum, deltas, durationMs);

  // Insert into Supabase (single source of truth)
  let insertResult = { skipped: true };
  if (cfg.supabaseServiceKey) {
    insertResult = await insertRegressionRun(cfg, {
      run_at: new Date().toISOString(),
      source: cfg.source,
      base_url: cfg.base,
      total_tests: sum.total,
      passed: sum.passed,
      failed: sum.failed,
      skipped: sum.skipped,
      duration_ms: durationMs,
      results,
      deltas: [
        ...deltas.regressions.map(r => ({ id: r.id, previous_verdict: 'PASS', current_verdict: 'FAIL' })),
        ...deltas.recoveries.map(r => ({ id: r.id, previous_verdict: 'FAIL', current_verdict: 'PASS' })),
      ],
      alert_sent: false,
      notes: deltas.firstRun ? 'first run — baseline' : null,
    });
  }

  // Alert policy
  const sev = severity(sum);
  const hasDeltas = deltas.regressions.length + deltas.recoveries.length + deltas.newTests.length > 0;
  const prevSum = summarize(prevResults);
  const prevWasGreen = prevResults.length > 0 && prevSum.failed === 0;

  let alertSent = false;
  if (sev === 'RED') {
    const msg = buildTelegramMessage(sum, deltas, cfg);
    const r = await sendTelegram(cfg, msg);
    alertSent = !!r.sent;
  } else if (sev === 'YELLOW' && hasDeltas) {
    const msg = buildTelegramMessage(sum, deltas, cfg);
    const r = await sendTelegram(cfg, msg);
    alertSent = !!r.sent;
  } else if (sev === 'GREEN' && (!prevWasGreen || deltas.recoveries.length > 0)) {
    const msg = `✅ <b>Regression Suite — GREEN</b>\n${sum.total}/${sum.total} passed.\n<i>${cfg.base}</i>` +
      (deltas.recoveries.length > 0 ? `\n\n<b>Recovered:</b>\n` + deltas.recoveries.map(r => `• <code>${esc(r.id)}</code>`).join('\n') : '');
    const r = await sendTelegram(cfg, msg);
    alertSent = !!r.sent;
  }

  return { sum, deltas, local, insertResult, alertSent, severity: sev };
}
