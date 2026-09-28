#!/usr/bin/env node
'use strict';
/**
 * PostCompact hook — sets a marker that pretooluse-guard.js enforces
 * (real block, not shadow) until CLAUDE.md is Read again. Rationale
 * (Cole, 2026-09-28): hook-injected context gets summarized away by
 * /compact, and a controlled test showed re-injecting text loses to
 * compaction "momentum" while a denied tool call does not. So: deny
 * Bash/Edit/Write until the rules file is actually re-read.
 *
 * PostCompact hooks are observational only (no decision control per Claude
 * Code docs) — this hook does not and cannot block anything itself. It only
 * writes the marker file; pretooluse-guard.js is what actually enforces it.
 * Always exits 0.
 */
const fs = require('fs');
const path = require('path');
const util = require(path.join(__dirname, 'lib', 'hook-utils.js'));

const REANCHOR_MARKER = 'reanchor-pending.txt';

function main() {
  let input = {};
  try {
    input = util.readStdinJSON();
  } catch (e) { /* proceed with defaults below */ }

  const cwd = input.cwd || process.cwd();
  util.writeState(cwd, REANCHOR_MARKER, new Date().toISOString());
  util.appendLog(cwd, 'postcompact-reanchor.log', {
    level: 'MARKER_SET',
    triggered_by: input.triggered_by || input.trigger || 'unknown',
  });
}

try {
  main();
} catch (e) {
  try {
    fs.appendFileSync(
      path.join(process.cwd(), '.claude', 'hooks', 'logs', 'postcompact-reanchor.log'),
      JSON.stringify({ ts: new Date().toISOString(), level: 'ERROR', msg: e.message }) + '\n'
    );
  } catch (e2) { /* nowhere left to report this */ }
}
process.exit(0);
