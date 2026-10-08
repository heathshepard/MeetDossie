#!/usr/bin/env node
'use strict';
/**
 * PostToolUse hook (matcher: "Read") — clears the post-compact re-anchor
 * marker once CLAUDE.md has actually been read again. Pairs with
 * postcompact-reanchor.js (sets the marker) and the reanchor check inside
 * pretooluse-guard.js (enforces it). Always exits 0 — PostToolUse has no
 * decision control to give up anyway.
 */
const fs = require('fs');
const path = require('path');
const util = require(path.join(__dirname, 'lib', 'hook-utils.js'));

const REANCHOR_MARKER = 'reanchor-pending.txt';

function main() {
  let input = {};
  try {
    input = util.readStdinJSON();
  } catch (e) { return; }

  if (input.tool_name !== 'Read') return;
  const filePath = String((input.tool_input && input.tool_input.file_path) || '');
  if (!/CLAUDE\.md$/.test(filePath)) return;

  const cwd = input.cwd || process.cwd();
  if (util.readState(cwd, REANCHOR_MARKER)) {
    util.clearState(cwd, REANCHOR_MARKER);
    util.appendLog(cwd, 'postcompact-reanchor.log', { level: 'MARKER_CLEARED', via: filePath });
  }
}

try { main(); } catch (e) { /* swallow — nothing to block here */ }
process.exit(0);
