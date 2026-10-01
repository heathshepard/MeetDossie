#!/usr/bin/env node
'use strict';
/**
 * Regression test for the 2026-09-28 memory-capture token-drain incident
 * (memory/memory-capture-hook-token-drain-2026-09-28.md) and Heath's rebuild
 * spec (memory/feedback_memory-capture-cost-control-requirements.md).
 *
 * Reproduces the EXACT failure conditions — multiple distinct session_ids
 * firing .claude/hooks/memory-capture.js concurrently from one cwd — using
 * the hook's MEMORY_CAPTURE_FAKE_SPAWN=1 test-only escape hatch so this
 * costs zero real `claude -p` tokens while every gate check (rate limit,
 * daily ceiling, machine-wide lock) runs for real.
 *
 * Asserts: exactly ONE of N concurrent firings gets through to a real
 * (fake) extraction, the rest are rejected via the gate in milliseconds, the
 * daily budget only ever reflects the one real attempt (rejections must not
 * consume budget), and the lock is released afterward (no leak).
 *
 * Usage: node scripts/test-memory-capture-concurrency.js [N]
 * Exit code 0 = bound holds. Non-zero = regression, do not re-enable the
 * hook in settings.json until this passes again.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const N = Number(process.argv[2]) || 5;

async function main() {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-capture-concurrency-test-'));
  fs.mkdirSync(path.join(testDir, '.claude', 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(testDir, '.claude', 'hooks', 'guard-config.json'),
    JSON.stringify({ memory_capture: { rate_limit_minutes: 30, daily_ceiling: 12, stale_lock_minutes: 3 } })
  );
  const transcriptPath = path.join(testDir, 'fake-transcript.jsonl');
  fs.writeFileSync(
    transcriptPath,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'test correction: always do X not Y.' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Got it.' }] } }),
    ].join('\n') + '\n'
  );

  const hookPath = path.join(REPO_ROOT, '.claude', 'hooks', 'memory-capture.js');
  const runs = [];
  for (let i = 1; i <= N; i++) {
    const stdin = JSON.stringify({
      session_id: `fake-sess-${i}`,
      hook_event_name: 'PreCompact',
      cwd: testDir,
      trigger: 'auto',
      transcript_path: transcriptPath,
      permission_mode: 'acceptEdits',
    });
    runs.push(new Promise((resolve) => {
      const child = spawn('node', [hookPath], {
        env: { ...process.env, MEMORY_CAPTURE_LIVE: '1', MEMORY_CAPTURE_FAKE_SPAWN: '1' },
      });
      child.stdin.write(stdin);
      child.stdin.end();
      child.on('close', (code) => resolve({ i, code }));
    }));
  }

  console.log(`Firing ${N} concurrent memory-capture.js invocations, distinct session_ids, same cwd (${testDir})...`);
  const t0 = Date.now();
  await Promise.all(runs);
  const elapsedMs = Date.now() - t0;

  const logLines = fs.readFileSync(path.join(testDir, '.claude', 'hooks', 'logs', 'memory-capture.log'), 'utf-8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const runCount = logLines.filter((l) => l.level === 'RUN').length;
  const skipCount = logLines.filter((l) => l.level.startsWith('SKIP_')).length;
  const dailyLog = JSON.parse(fs.readFileSync(path.join(testDir, '.claude', 'hooks', 'state', 'memory-capture-global-daily-log.json'), 'utf-8'));
  const lockExists = fs.existsSync(path.join(testDir, '.claude', 'hooks', 'state', 'memory-capture-global-lock.txt'));

  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log(`RUN (real extraction attempts): ${runCount}`);
  console.log(`SKIP_* (rejected by the gate): ${skipCount}`);
  console.log(`Daily budget consumed: ${dailyLog.length}`);
  console.log(`Lock file still held after completion: ${lockExists}`);

  const ok = runCount === 1 && skipCount === N - 1 && dailyLog.length === 1 && lockExists === false;

  fs.rmSync(testDir, { recursive: true, force: true });

  if (!ok) {
    console.error('FAIL — concurrency bound did not hold as expected. Do not re-enable this hook in settings.json.');
    process.exit(1);
  }
  console.log(`PASS — exactly 1 of ${N} concurrent firings (distinct session_ids, same cwd) got through; the rest were gated in milliseconds; budget and lock both correct.`);
}

main().catch((e) => {
  console.error('Test harness error:', e);
  process.exit(1);
});
