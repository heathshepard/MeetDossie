#!/usr/bin/env node
'use strict';

// scripts/toggle-auto-reply.js
//
// Single-command flip for the auto-reply-with-veto kill switch
// (scripts/_lib/auto-reply-kill-switch.js), backed by the SAME Supabase
// ops_flags row the Vercel crons read — this is the actual production
// switch, not a local-only copy. Ships OFF; this is how Heath turns it on
// after Quinn's QA pass, and how anyone kills it instantly if something
// looks wrong.
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (loaded from
// .env.local automatically if present).
//
// Usage:
//   node scripts/toggle-auto-reply.js on   ["reason text"]
//   node scripts/toggle-auto-reply.js off  ["reason text"]
//   node scripts/toggle-auto-reply.js status
//
// Owner: Carter, 2026-09-16

const killSwitch = require('./_lib/auto-reply-kill-switch.js');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const reason = rest.join(' ') || undefined;

  if (cmd === 'on') {
    const state = await killSwitch.enableAutoReply(reason || 'manual enable via toggle-auto-reply.js');
    console.log(`[toggle-auto-reply] ENABLED at ${state.updated_at} — ${state.reason}`);
    console.log(`[toggle-auto-reply] ${killSwitch.describeTarget()}`);
    return;
  }
  if (cmd === 'off') {
    const state = await killSwitch.disableAutoReply(reason || 'manual disable via toggle-auto-reply.js');
    console.log(`[toggle-auto-reply] DISABLED at ${state.updated_at} — ${state.reason}`);
    console.log(`[toggle-auto-reply] ${killSwitch.describeTarget()}`);
    return;
  }
  if (cmd === 'status' || !cmd) {
    const state = await killSwitch.getState();
    console.log(`[toggle-auto-reply] ${state.enabled ? 'ENABLED' : 'DISABLED'} (updated_at=${state.updated_at || 'never'}, reason=${state.reason || 'n/a'})`);
    console.log(`[toggle-auto-reply] ${killSwitch.describeTarget()}`);
    return;
  }
  console.error(`[toggle-auto-reply] unknown command "${cmd}" — use on | off | status`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('[toggle-auto-reply] FATAL', err.message);
  process.exitCode = 1;
});
