#!/usr/bin/env node
/**
 * run-all.js — top-level orchestrator for the Dossie Sign e2e suite.
 *
 * Runs every spec in ./tests sequentially. Prints a summary matrix at the end
 * and writes a combined report to
 *   .tmp/dossie-sign-e2e-runs/summary-<iso>.json
 *
 * Exit 0 = ALL forms passed; exit 1 = ANY form failed.
 *
 * USAGE:
 *   node scripts/daily-regression-suite/dossie-sign-e2e/run-all.js
 *   BASE_URL=https://meetdossie.com node ...
 *
 * Runs sequentially (not in parallel) — mailinator public inboxes are
 * rate-limited, and each spec needs a fresh Playwright browser + real
 * network round trips to DocuSeal / Resend / mailinator.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TESTS_DIR = path.join(__dirname, 'tests');
const SUMMARY_ROOT = path.resolve(__dirname, '..', '..', '..', '.tmp', 'dossie-sign-e2e-runs');
fs.mkdirSync(SUMMARY_ROOT, { recursive: true });

const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const SUMMARY_PATH = path.join(SUMMARY_ROOT, `summary-${RUN_ID}.json`);

function runSpec(specPath) {
  return new Promise((resolve) => {
    const child = spawn('node', [specPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', (d) => { stderr += d.toString(); process.stderr.write(d); });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const specs = fs.readdirSync(TESTS_DIR)
    .filter((f) => f.endsWith('.spec.js'))
    .sort();

  console.log(`\n[run-all] running ${specs.length} specs sequentially against ${process.env.BASE_URL || 'https://meetdossie.com'}\n`);

  const results = [];
  for (const spec of specs) {
    console.log(`\n${'='.repeat(70)}\n  SPEC: ${spec}\n${'='.repeat(70)}`);
    const specPath = path.join(TESTS_DIR, spec);
    const started = Date.now();
    const result = await runSpec(specPath);
    const durationMs = Date.now() - started;
    // Parse run dir from stdout (first line matching "Run dir     : <path>").
    const runDirMatch = result.stdout.match(/Run dir\s+:\s+(.+)/);
    const runDir = runDirMatch ? runDirMatch[1].trim() : null;
    let evidence = null;
    if (runDir) {
      try {
        evidence = JSON.parse(fs.readFileSync(path.join(runDir, 'evidence.json'), 'utf8'));
      } catch {}
    }
    results.push({
      spec,
      passed: result.code === 0,
      exitCode: result.code,
      durationMs,
      runDir,
      submissionId: evidence?.submissionId || null,
      signingUrl: evidence?.signingUrl || null,
      videoPath: evidence?.videoPath || null,
      failReason: evidence?.failReason || null,
      firstSignerAddress: (evidence?.signerAddresses || [])[0] || null,
    });
  }

  // Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const summary = {
    runId: RUN_ID,
    base: process.env.BASE_URL || 'https://meetdossie.com',
    started: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    results,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`\n${'='.repeat(70)}\n  SUMMARY: ${passed}/${results.length} passed\n${'='.repeat(70)}`);
  for (const r of results) {
    const status = r.passed ? '  PASS  ' : '  FAIL  ';
    const dur = (r.durationMs / 1000).toFixed(0) + 's';
    console.log(`  [${status}] ${r.spec.padEnd(40)} ${dur.padStart(6)}  ${r.failReason || r.signingUrl || ''}`);
    if (r.firstSignerAddress) {
      console.log(`             mailinator: https://www.mailinator.com/v4/public/inbox.jsp?to=${encodeURIComponent(r.firstSignerAddress)}`);
    }
  }
  console.log(`\n  Summary: ${SUMMARY_PATH}`);

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
