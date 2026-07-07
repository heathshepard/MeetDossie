// scripts/claude-code-task-handlers/echo.js
//
// Trivial handler used to smoke-test the claude-code-worker end-to-end
// without touching any LLM. Echoes payload back into result_summary + result.
//
// Contract:
//   { payload: { message: string, delay_ms?: number } }
//
// Returns:
//   { ok: true, summary: string, result: { echoed: any, ts: string } }
//
// Owner: Atlas, 2026-07-07.

'use strict';

module.exports = async function echoHandler({ payload, task_id, log }) {
  log(`echo handler received payload keys=[${Object.keys(payload || {}).join(',')}]`);

  const message = payload && typeof payload.message === 'string' ? payload.message : '(no message)';
  const delayMs = payload && Number.isFinite(payload.delay_ms) ? Math.max(0, Math.min(10000, payload.delay_ms)) : 0;

  if (delayMs > 0) {
    log(`echo sleeping ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }

  return {
    ok: true,
    summary: `Echo OK. message="${message.slice(0, 200)}" (task_id=${task_id})`,
    result: {
      echoed: payload,
      ts: new Date().toISOString(),
    },
  };
};
