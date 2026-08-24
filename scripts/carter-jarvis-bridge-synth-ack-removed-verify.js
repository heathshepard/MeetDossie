#!/usr/bin/env node
// scripts/carter-jarvis-bridge-synth-ack-removed-verify.js
//
// Real, live round trip through the ACTUAL scripts/jarvis-bridge/server.ts
// (unmodified — spawned exactly as .mcp.json spawns it: `bun
// scripts/jarvis-bridge/server.ts`), proving the 2026-08-24 fix for Heath's
// live complaint: "In between your responses ... I get a response that says
// 'Got it. Still working on,' and then it starts talking back what I just
// said."
//
// Root cause (found this session): scripts/jarvis-bridge/server.ts had a
// SEPARATE synthetic-busy-ack mechanism (Atlas, 2026-08-20, buildSynthAckText
// / ACK_DELAY_MS) that auto-wrote a canned "Got it — still working on '<echo
// of Heath's own message>', give me a moment" into turn.reply_text whenever a
// turn sat 'delivered' for >8s with no real model reply yet — completely
// independent of, and in addition to, the model's own genuine
// reply(final:false) interim-ack tool call. jarvis-pwa.html's askBridge()
// polling loop then spoke/showed whatever reply_text it found, with no way
// to tell a synthetic echo from a real one. That's the exact pattern Heath
// described. This was NOT the same bug as the 2026-08-22 "interim ack
// audio overlap" fix (carter-jarvis-interim-ack-overlap-verify.js) — that one
// fixed a race between two real interim-ack audio elements; this one is a
// fully separate auto-fallback that fires even when the model never sends an
// ack at all.
//
// This harness spawns the REAL, currently-committed server.ts as a child
// process (identical spawn command to .mcp.json) against a local mock of the
// Supabase Storage REST surface it talks to (list/get/put/delete on the
// jarvis-bridge bucket) — zero writes to production Storage, zero risk of
// injecting a fake turn into Heath's actual live Cole session (that live
// process, PID confirmed separately, keeps running unaffected; this spawns
// an independent second instance pointed at JARVIS_BRIDGE_STATE_DIR under
// the scratch dir so it never touches ~/.claude/channels/jarvis-bridge/.env
// or its real state files).
//
// Two things are proven against the REAL code, not a re-implementation:
//   1. A turn left 'delivered' for well past the old 8s ACK_DELAY_MS never
//      gets a synthetic reply_text — the exact bug is gone.
//   2. A genuine model-driven interim ack (the `reply` MCP tool, called with
//      final:false over a real stdio JSON-RPC connection, exactly how Cole
//      calls it) still writes reply_text/status='working' correctly, and a
//      follow-up reply(final:true) still resolves the turn — the legitimate
//      mechanism Heath explicitly wants kept.
//
// Usage: node scripts/carter-jarvis-bridge-synth-ack-removed-verify.js

'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const results = [];
function report(name, pass, note) {
  results.push({ name, pass, note });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${note ? ' — ' + note : ''}`);
}

// ---- mock Supabase Storage --------------------------------------------
const store = new Map(); // name (e.g. "turns/test123.json") -> object
const writeLog = []; // every PUT, in order, for post-hoc inspection

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

const mock = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'POST' && p === '/storage/v1/object/list/jarvis-bridge') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const prefix = body.prefix || '';
    const names = [...store.keys()]
      .filter((k) => k.startsWith(prefix))
      .map((k) => ({ name: k.slice(prefix.length) }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(names));
    return;
  }

  if (p.startsWith('/storage/v1/object/jarvis-bridge/')) {
    const name = decodeURIComponent(p.slice('/storage/v1/object/jarvis-bridge/'.length));
    if (req.method === 'GET') {
      if (!store.has(name)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(store.get(name)));
      return;
    }
    if (req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      store.set(name, body);
      writeLog.push({ ts: Date.now(), name, body: JSON.parse(JSON.stringify(body)) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Key: name }));
      return;
    }
    if (req.method === 'DELETE') {
      store.delete(name);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({}));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'unhandled', path: p, method: req.method }));
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async () => {
  await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
  const port = mock.address().port;
  console.log(`[verify] mock Supabase Storage listening on 127.0.0.1:${port}`);

  const scratchStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bridge-verify-'));
  console.log(`[verify] JARVIS_BRIDGE_STATE_DIR=${scratchStateDir} (isolated — no real .env, no real state)`);

  const child = spawn('bun', ['scripts/jarvis-bridge/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${port}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-key-mock-storage-only',
      JARVIS_BRIDGE_STATE_DIR: scratchStateDir,
      JARVIS_PUSH_URL: `http://127.0.0.1:${port}/no-op-push`,
      JARVIS_BRIDGE_POLL_MS: '500', // faster ticks so the test doesn't need to wait as long
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let childStderr = '';
  child.stderr.on('data', (d) => { childStderr += d.toString(); });
  let childExited = null;
  child.on('exit', (code, signal) => { childExited = { code, signal }; });

  // Give it a moment to boot (env load, youtube-context optional import, mcp.connect).
  await sleep(1500);
  report('server.ts child process still alive after boot', !childExited, childExited ? JSON.stringify(childExited) : '');

  // ---- MCP client over the same stdio pipes, exactly how Cole/Claude Code
  // itself talks to this channel — proves the `reply` tool round trip for
  // real, not just that the process didn't crash.
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

  // StdioClientTransport normally spawns its own child; we already have one
  // running with the env we need, so hand it the existing pipes instead of
  // letting it spawn a second process.
  const mcpClient = new Client({ name: 'carter-verify', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: 'true', // never actually spawned — see below
    args: [],
  });
  // Swap in the already-running child's pipes rather than letting the
  // transport spawn a fresh process (there's no supported "attach to
  // existing process" constructor in this SDK version).
  transport._process = child;
  transport._stdin = child.stdin;
  transport._stdout = child.stdout;

  let mcpConnected = false;
  try {
    // Manually wire the transport's readable/writable to the child's stdio
    // since we bypassed its own spawn path.
    const readline = require('readline');
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (transport.onmessage) {
        try { transport.onmessage(JSON.parse(line)); } catch {}
      }
    });
    transport.send = async (message) => {
      child.stdin.write(JSON.stringify(message) + '\n');
    };
    transport.start = async () => {};
    transport.close = async () => { rl.close(); };
    await mcpClient.connect(transport);
    mcpConnected = true;
  } catch (err) {
    report('MCP client connected to spawned server.ts over stdio', false, String(err && err.message ? err.message : err));
  }
  if (mcpConnected) report('MCP client connected to spawned server.ts over stdio', true);

  // ---- Test 1: genuine reply(final:false) interim ack still works -------
  // Run this FIRST, right after connect, before the realtime ambient-
  // awareness subscription (a separate, unrelated feature this process also
  // runs) has had time to retry repeatedly against this mock — which has no
  // WebSocket support and isn't what's under test here.
  const ackTurnId = 'verify-reply-tool-' + Date.now();
  const ackTurnName = `turns/${ackTurnId}.json`;
  store.set(ackTurnName, {
    status: 'delivered',
    user_message: 'Carter QA — reply tool round trip test, please ignore.',
    created_at: new Date().toISOString(),
    delivered_at: new Date().toISOString(),
  });
  let interimOk = false;
  let finalOk = false;
  if (mcpConnected) {
    try {
      const interimText = 'Dispatching Atlas to fix the staging build.';
      await mcpClient.callTool({ name: 'reply', arguments: { chat_id: ackTurnId, text: interimText, final: false } }, undefined, { timeout: 15000 });
      await sleep(500);
      const afterInterim = store.get(ackTurnName);
      interimOk = afterInterim && afterInterim.status === 'working' && afterInterim.reply_text === interimText;
      report('genuine reply(final:false) interim ack still writes status=working + exact reply_text', interimOk, interimOk ? '' : `got: ${JSON.stringify(afterInterim)}`);

      const finalText = 'All done — staging build is fixed and pushed.';
      await mcpClient.callTool({ name: 'reply', arguments: { chat_id: ackTurnId, text: finalText, final: true } }, undefined, { timeout: 15000 });
      await sleep(500);
      const afterFinal = store.get(ackTurnName);
      finalOk = afterFinal && afterFinal.status === 'answered' && afterFinal.reply_text === finalText;
      report('genuine reply(final:true) still resolves the turn to answered with the real answer', finalOk, finalOk ? '' : `got: ${JSON.stringify(afterFinal)}`);
    } catch (err) {
      report('reply tool round trip (interim + final)', false, String(err && err.message ? err.message : err));
    }
  } else {
    report('reply tool round trip (interim + final)', false, 'skipped — MCP client never connected');
  }

  // ---- Test 2: no synthetic ack ever fires -------------------------------
  const turnId = 'verify-synth-ack-' + Date.now();
  const turnName = `turns/${turnId}.json`;
  const userMessage = 'This is a Carter QA test message for the synthetic-ack removal fix — please ignore.';
  store.set(turnName, {
    status: 'pending',
    user_message: userMessage,
    created_at: new Date().toISOString(),
  });
  console.log(`[verify] seeded pending turn ${turnId}, watching for ${14}s (old ACK_DELAY_MS default was 8000ms)...`);

  const WATCH_MS = 14000;
  const sawStates = [];
  const t0 = Date.now();
  while (Date.now() - t0 < WATCH_MS) {
    await sleep(500);
    const cur = store.get(turnName);
    sawStates.push({ t: Date.now() - t0, status: cur && cur.status, reply_text: cur && cur.reply_text });
  }
  fs.writeFileSync(path.join(scratchStateDir, 'states.json'), JSON.stringify(sawStates, null, 2));

  const gotDelivered = sawStates.some((s) => s.status === 'delivered' || s.status === 'working' || s.status === 'answered');
  report('turn was actually picked up (pending -> delivered) by the real tick loop', gotDelivered, gotDelivered ? '' : 'process never touched the seeded turn — harness problem, not a fix problem');

  const badPattern = /still working on|mid-task right now, give me a moment/i;
  const synthFired = sawStates.some((s) => s.reply_text && badPattern.test(s.reply_text));
  report('no synthetic "Got it — still working on..." echo ever appeared on the turn', !synthFired, synthFired ? `saw: ${JSON.stringify(sawStates.find((s) => s.reply_text && badPattern.test(s.reply_text)))}` : `watched ${WATCH_MS}ms, states: ${sawStates.map((s) => s.status).join(',')}`);

  const finalTurn = store.get(turnName);
  report("turn status stayed 'delivered' (or model answered it) — never auto-flipped to 'working' by the process itself", finalTurn && finalTurn.status !== 'working', `final status: ${finalTurn && finalTurn.status}`);

  fs.writeFileSync(path.join(scratchStateDir, 'write-log.json'), JSON.stringify(writeLog, null, 2));

  try { child.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { mock.close(); } catch {}

  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  const overall = results.every((r) => r.pass);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  if (!overall && childStderr) {
    console.log('\n---- child stderr (last 4000 chars) ----');
    console.log(childStderr.slice(-4000));
  }
  console.log(`\nArtifacts: ${scratchStateDir}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
