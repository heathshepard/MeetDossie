#!/usr/bin/env node
'use strict';

// scripts/auto-merge-test-suite.js
//
// The exact test suite that must pass before the daily staging->main
// auto-merge gate (.github/workflows/staging-auto-merge-gate.yml) will
// merge anything:
//   1. Every scripts/regression-*.js, run standalone (`node <file>`),
//      exit code 0 = pass.
//   2. `node --test` over every api/_lib/*.test.js.
//
// Runs in GitHub Actions (ubuntu-latest), not Vercel — two of the
// regression scripts launch a real headless Chromium via Playwright
// (regression-comment-hunt-dom-extraction.js, regression-tc-discovery-
// harvest-post-boundary.js) and Vercel serverless has no Chromium binary.
// CI installs Playwright's Chromium before this runs (see the workflow).
//
// scripts/carter-esign-verdict-logic-test.js is DELIBERATELY EXCLUDED, not
// silently skipped — it needs a fixture PDF that
// scripts/carter-signature-verifier-structural-test.js generates from a
// REAL client file (.tmp/wildcherry-amendment/Amendment #1 - 526.pdf) that
// is gitignored and correctly not committed to this public repo
// (scripts/check-no-personal-data.js exists specifically to keep real
// client data out of tracked source). There is no clean-checkout/CI fixture
// for it today. It is reported below as EXCLUDED, counted separately from
// PASS, and never allowed to look like a pass.
//
// Exit code: 0 only if every included test passed. Non-zero (and the JSON
// summary's overall !== 'green') on ANY failure, timeout, or crash — never
// merge on red or unknown state.
//
// REAL-ARTIFACT CHECK (2026-09-29): scripts/regression-scan-contract-
// real-artifact.js makes a REAL, billed Anthropic API call — see its own
// header. It is picked up automatically by the regression-*.js glob below
// like every other script, but running it on every daily gate invocation
// regardless of what changed would spend money on merges that never touch
// the document pipeline. --changed-files gates that: pass the same
// changed-file list the workflow already computed
// (git diff --name-only origin/main...origin/staging), and this script
// only REQUIRES the real-artifact check when
// api/_lib/auto-merge-risk-gate.js's touchesDocumentPipeline() says the
// diff actually touches it — otherwise it's excluded for this run (never
// silently "passed", always reported as excluded with a reason).
//
// FAIL CLOSED, same reasoning as the risk gate itself: if --changed-files
// is NOT supplied at all (unknown diff), the real-artifact check is
// REQUIRED by default rather than skipped — a false hold (running an
// unnecessary check) costs a few cents; a false skip could re-ship the
// exact 2026-09-29 regression.
//
// Usage:
//   node scripts/auto-merge-test-suite.js            # human-readable + JSON summary on stdout
//   node scripts/auto-merge-test-suite.js --json-out result.json
//   node scripts/auto-merge-test-suite.js --changed-files /tmp/changed_files.txt --json-out result.json

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { touchesDocumentPipeline } = require('../api/_lib/auto-merge-risk-gate.js');

const REAL_ARTIFACT_SCRIPT = 'scripts/regression-scan-contract-real-artifact.js';

const REPO_ROOT = path.join(__dirname, '..');
const TEST_TIMEOUT_MS = 5 * 60 * 1000; // 5 min per script — generous, catches real hangs

const EXCLUDED = [
  {
    file: 'scripts/carter-esign-verdict-logic-test.js',
    reason: 'requires a fixture generated from a real, gitignored client PDF (.tmp/wildcherry-amendment/Amendment #1 - 526.pdf) via scripts/carter-signature-verifier-structural-test.js — no clean-checkout fixture exists; correctly not committed to a public repo (scripts/check-no-personal-data.js). Documented exclusion, not a silent skip. Explicitly named by Heath 2026-09-28 when he approved this gate.',
  },
  {
    file: 'scripts/regression-chat-deal-fuzzy-match.js',
    reason: 'imports Dossie/src/utils/find-deal-by-identifier.js from a SIBLING repo checkout (path.resolve(__dirname, "..", "..", "Dossie")) that only exists on Heath\'s machine (C:\\Users\\Heath\\Projects\\Dossie / heathshepard/DossieApp on GitHub). A single-repo MeetDossie checkout (this CI runner) has no sibling to resolve. Runs for real locally where the sibling exists; excluded (not silently skipped as a pass) when it does not. Standing up a second private-repo checkout in CI for this one test was judged out of scope for the merge-gate build — flag to Heath if he wants that wired up.',
  },
  // Found 2026-09-28 while wiring this runner (not previously known — Heath
  // only named the esign-verdict-logic-test.js case). Same failure class:
  // both read .tmp/ridgebluff-offer/blank-20-19.pdf. VERIFIED (2026-09-28):
  // the file exists on Heath's own machine (.tmp/ is gitignored — "Ad-hoc
  // .tmp-* scratch files — historically leaked DocuSeal + CRON secrets") and
  // both tests PASS for real once it's present. It is correctly not
  // committed, and no generator script reproduces it from scratch, so a
  // clean checkout (including this CI runner) can never run these two.
  // Flag to Heath: either commit a sanitized/synthetic blank TREC 20-19 PDF
  // fixture, or write a generator, so these can run in CI instead of
  // sitting excluded indefinitely.
  {
    file: 'scripts/regression-trec-20-19-overflow-padding.js',
    reason: 'requires .tmp/ridgebluff-offer/blank-20-19.pdf — gitignored, exists only on Heath\'s machine, no generator script exists to (re)produce it in a clean checkout. Verified passing for real with the fixture present.',
  },
  {
    file: 'scripts/regression-trec-20-19-p21-agent-columns.js',
    reason: 'requires .tmp/ridgebluff-offer/blank-20-19.pdf — gitignored, exists only on Heath\'s machine, no generator script exists to (re)produce it in a clean checkout. Verified passing for real with the fixture present.',
  },
];

function isApplicable(relPath) {
  if (relPath.endsWith('regression-chat-deal-fuzzy-match.js')) {
    const dossieUtil = path.resolve(REPO_ROOT, '..', 'Dossie', 'src', 'utils', 'find-deal-by-identifier.js');
    return fs.existsSync(dossieUtil);
  }
  return true;
}

function listRegressionScripts() {
  return fs
    .readdirSync(path.join(REPO_ROOT, 'scripts'))
    .filter((f) => /^regression-.*\.js$/.test(f))
    .sort()
    .map((f) => `scripts/${f}`);
}

function listLibTestFiles() {
  const dir = path.join(REPO_ROOT, 'api', '_lib');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.test.js'))
    .sort()
    .map((f) => `api/_lib/${f}`);
}

function runScript(relPath) {
  const start = Date.now();
  try {
    const out = execFileSync(process.execPath, [relPath], {
      cwd: REPO_ROOT,
      timeout: TEST_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { file: relPath, verdict: 'pass', ms: Date.now() - start, output: out.slice(-2000) };
  } catch (err) {
    const isTimeout = err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT';
    return {
      file: relPath,
      verdict: isTimeout ? 'timeout' : 'fail',
      ms: Date.now() - start,
      output: String((err.stdout || '') + (err.stderr || err.message || '')).slice(-4000),
    };
  }
}

function runNodeTest(files) {
  if (files.length === 0) return { verdict: 'pass', ms: 0, output: '(no api/_lib/*.test.js files found)', files: [] };
  const start = Date.now();
  try {
    const out = execFileSync(process.execPath, ['--test', ...files], {
      cwd: REPO_ROOT,
      timeout: TEST_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { verdict: 'pass', ms: Date.now() - start, output: out.slice(-4000), files };
  } catch (err) {
    return {
      verdict: 'fail',
      ms: Date.now() - start,
      output: String((err.stdout || '') + (err.stderr || err.message || '')).slice(-6000),
      files,
    };
  }
}

function readChangedFiles() {
  const idx = process.argv.indexOf('--changed-files');
  if (idx === -1 || !process.argv[idx + 1]) return null; // not supplied
  const filePath = process.argv[idx + 1];
  if (!fs.existsSync(filePath)) {
    console.warn(`[auto-merge-test-suite] --changed-files path does not exist: ${filePath} — treating as unknown diff (fail closed)`);
    return null;
  }
  return fs.readFileSync(filePath, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
}

function main() {
  const allRegressionScripts = listRegressionScripts();
  const libTestFiles = listLibTestFiles();

  const changedFiles = readChangedFiles(); // null = unknown diff -> fail closed, require the real-artifact check
  const pipelineCheck = touchesDocumentPipeline(changedFiles || []);
  const requireRealArtifactCheck = changedFiles === null || pipelineCheck.triggered;

  const excludedNames = new Set(EXCLUDED.map((e) => e.file));
  const runnable = [];
  const skipped = [...EXCLUDED]; // always-excluded, fixed list

  for (const script of allRegressionScripts) {
    if (excludedNames.has(script)) continue; // already in EXCLUDED, always skipped
    if (!isApplicable(script)) {
      skipped.push({ file: script, reason: 'not applicable in this environment (see isApplicable()) — reported as excluded, never as a pass' });
      continue;
    }
    if (script === REAL_ARTIFACT_SCRIPT && !requireRealArtifactCheck) {
      skipped.push({
        file: script,
        reason: `diff does not touch the document/extraction pipeline (api/_lib/auto-merge-risk-gate.js touchesDocumentPipeline() found no match against ${changedFiles.length} changed file(s)) — the real, billed Anthropic API call is skipped to avoid spend on unrelated merges. Excluded, never counted as a pass.`,
      });
      continue;
    }
    runnable.push(script);
  }

  if (requireRealArtifactCheck) {
    console.log(
      `[auto-merge-test-suite] real-artifact check REQUIRED — ${
        changedFiles === null
          ? 'no --changed-files supplied, failing closed'
          : `diff touches: ${pipelineCheck.matched.join(', ')}`
      }`,
    );
  }

  console.log(`[auto-merge-test-suite] ${allRegressionScripts.length} regression scripts total, ${runnable.length} runnable, ${skipped.length} excluded (documented below), ${libTestFiles.length} api/_lib/*.test.js files`);

  const results = [];
  for (const script of runnable) {
    process.stdout.write(`  ${script} ... `);
    const r = runScript(script);
    console.log(r.verdict.toUpperCase());
    if (r.verdict !== 'pass') console.log(r.output);
    results.push(r);
  }

  process.stdout.write(`  node --test (${libTestFiles.length} files) ... `);
  const nodeTestResult = runNodeTest(libTestFiles);
  console.log(nodeTestResult.verdict.toUpperCase());
  if (nodeTestResult.verdict !== 'pass') console.log(nodeTestResult.output);

  const failed = results.filter((r) => r.verdict !== 'pass');
  const nodeTestFailed = nodeTestResult.verdict !== 'pass';
  const overall = failed.length === 0 && !nodeTestFailed ? 'green' : 'red';

  const summary = {
    overall,
    regression_scripts: { total: allRegressionScripts.length, runnable: runnable.length, passed: results.length - failed.length, failed: failed.map((f) => f.file) },
    node_test: { verdict: nodeTestResult.verdict, files: libTestFiles.length },
    excluded: skipped,
    generated_at: new Date().toISOString(),
  };

  console.log('\n[auto-merge-test-suite] SUMMARY');
  console.log(JSON.stringify(summary, null, 2));

  const jsonOutIdx = process.argv.indexOf('--json-out');
  if (jsonOutIdx !== -1 && process.argv[jsonOutIdx + 1]) {
    fs.writeFileSync(process.argv[jsonOutIdx + 1], JSON.stringify(summary, null, 2));
  }

  process.exit(overall === 'green' ? 0 : 1);
}

main();
