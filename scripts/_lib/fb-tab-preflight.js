'use strict';

// scripts/_lib/fb-tab-preflight.js
//
// Shared helper: before any DossieBot Facebook automation runs, close any
// facebook.com tabs that happen to be open in Heath's MAIN Chrome window
// (NOT the DossieBot-Sage profile). FB's session-keepalive / engagement
// pings in his main Chrome can race with the automation profile and trip
// Facebook bot-detection on Heath's personal account.
//
// Strategy:
//  1. Enumerate visible Chrome windows by walking the UI Automation tree
//     via Windows pygetwindow. (We use a child Python process for the heavy
//     lifting because pygetwindow + UIA SelectionItem is mature in Python.)
//  2. For each window whose title contains "Facebook" / "facebook.com" /
//     "Meta" — and which is NOT the DossieBot-Sage profile window — bring
//     it to the foreground briefly and send Ctrl+W to close just that tab.
//  3. If the window has the DossieBot-Sage profile name in its chrome
//     subtitle ("DossieBot-Sage" or "DossieBot Sage"), SKIP — never close
//     the automation profile's own tabs.
//  4. Log every action to scripts/atlas-runs/preflight-YYYY-MM-DD.log
//     (append). Return a summary object: { closed: N, skipped_dossiebot: M,
//     errors: [...] }.
//
// Usage from any FB script:
//   const { preflight } = require('./_lib/fb-tab-preflight');
//   await preflight({ reason: 'first-comment-blitz' });
//
// Safe to call multiple times — idempotent.

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUN_DIR = path.join(REPO_ROOT, 'scripts', 'atlas-runs');
if (!fs.existsSync(RUN_DIR)) fs.mkdirSync(RUN_DIR, { recursive: true });

function logLine(reason, line) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const logPath = path.join(RUN_DIR, `preflight-${date}.log`);
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] [${reason || 'unspecified'}] ${line}\n`);
  } catch {}
}

async function preflight(opts = {}) {
  const reason = opts.reason || 'fb-automation';
  const dryRun = !!opts.dryRun;

  logLine(reason, `preflight start (dryRun=${dryRun})`);

  return new Promise((resolve) => {
    const pyHelper = path.join(__dirname, 'fb_tab_preflight.py');
    if (!fs.existsSync(pyHelper)) {
      logLine(reason, `ERROR: python helper missing at ${pyHelper}`);
      return resolve({ closed: 0, skipped_dossiebot: 0, errors: ['helper-missing'] });
    }

    const args = [pyHelper, '--reason', reason];
    if (dryRun) args.push('--dry-run');

    const proc = spawn('python', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', () => {
      const m = stdout.match(/PREFLIGHT_RESULT_JSON:(\{.*\})\s*$/m);
      let parsed = { closed: 0, skipped_dossiebot: 0, errors: [] };
      if (m) {
        try { parsed = JSON.parse(m[1]); } catch (e) {
          logLine(reason, `parse error: ${e.message}`);
        }
      } else {
        logLine(reason, `no PREFLIGHT_RESULT_JSON marker. stdout-tail: ${stdout.slice(-400)}`);
      }
      if (stderr) logLine(reason, `stderr: ${stderr.trim().slice(0, 800)}`);
      logLine(reason, `preflight end: closed=${parsed.closed} skipped_dossiebot=${parsed.skipped_dossiebot} errors=${(parsed.errors || []).length}`);
      resolve(parsed);
    });
    proc.on('error', (err) => {
      logLine(reason, `spawn error: ${err.message}`);
      resolve({ closed: 0, skipped_dossiebot: 0, errors: [err.message] });
    });
  });
}

module.exports = { preflight };

// Allow direct CLI invocation: `node scripts/_lib/fb-tab-preflight.js [reason]`
if (require.main === module) {
  const cliReason = process.argv[2] || 'cli';
  preflight({ reason: cliReason }).then((res) => {
    console.log(JSON.stringify(res, null, 2));
    process.exit(0);
  });
}
