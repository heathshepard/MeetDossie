#!/usr/bin/env node
'use strict';

// scripts/toggle-auto-reply.js
//
// Single-command flip for the auto-reply-with-veto kill switch
// (scripts/_lib/auto-reply-kill-switch.js). Ships OFF; this is how Heath
// turns it on after Quinn's QA pass, and how anyone kills it instantly if
// something looks wrong.
//
// Usage:
//   node scripts/toggle-auto-reply.js on   ["reason text"]
//   node scripts/toggle-auto-reply.js off  ["reason text"]
//   node scripts/toggle-auto-reply.js status
//
// Owner: Carter, 2026-09-16

const killSwitch = require('./_lib/auto-reply-kill-switch.js');

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const reason = rest.join(' ') || undefined;

  if (cmd === 'on') {
    const state = killSwitch.enableAutoReply(reason || 'manual enable via toggle-auto-reply.js');
    console.log(`[toggle-auto-reply] ENABLED at ${state.updated_at} — ${state.reason}`);
    return;
  }
  if (cmd === 'off') {
    const state = killSwitch.disableAutoReply(reason || 'manual disable via toggle-auto-reply.js');
    console.log(`[toggle-auto-reply] DISABLED at ${state.updated_at} — ${state.reason}`);
    return;
  }
  if (cmd === 'status' || !cmd) {
    const state = killSwitch.getState();
    console.log(`[toggle-auto-reply] ${state.enabled ? 'ENABLED' : 'DISABLED'} (updated_at=${state.updated_at || 'never'}, reason=${state.reason || 'n/a'})`);
    console.log(`[toggle-auto-reply] state file: ${killSwitch.SWITCH_FILE}`);
    return;
  }
  console.error(`[toggle-auto-reply] unknown command "${cmd}" — use on | off | status`);
  process.exitCode = 1;
}

main();
