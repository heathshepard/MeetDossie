#!/usr/bin/env node
// scripts/atlas-jarvis-bridge-liveness-verify.js
//
// Real, live round trip proving the 2026-08-27 fix for Heath's repeated
// complaint: the Jarvis PWA (meetdossie.com/myjarvis) showing "Cole's
// terminal isn't running right now — will answer once it's back…" while
// Cole was demonstrably alive and answering elsewhere (Telegram, terminal).
//
// Root cause (confirmed live against ~/.claude/channels/jarvis-bridge/
// server.log 2026-08-27): api/jarvis-bridge-turn.js's GET poll had NO real
// liveness signal — it declared the whole channel "offline" purely because
// ONE turn's delivered_at hadn't been set within PICKUP_TIMEOUT_MS (20s).
// That heuristic conflates "the local channel process is dead" with "it's
// alive and ticking but a single Supabase Storage call ran long" — the log
// shows scripts/jarvis-bridge/server.ts's listTurns() intermittently
// throwing "TimeoutError: The operation timed out" (its own 10s fetch
// timeout), clustering roughly hourly, with the process's LOCAL heartbeat
// file proving it never actually stopped ticking through those blips.
//
// Fix: server.ts now mirrors its already-existing local heartbeat into the
// jarvis-bridge Storage bucket (heartbeat.json, bucket-root, outside the
// turns/ prefix) every REMOTE_HEARTBEAT_MIN_INTERVAL_MS while alive.
// api/jarvis-bridge-turn.js's GET handler now only reports bridge_offline
// when that heartbeat is ALSO stale/missing — a slow single turn no longer
// gets misreported as "Cole's terminal isn't running."
//
// This harness runs BOTH real, unmodified production files against mock
// Supabase Storage HTTP servers — same pattern already established in
// scripts/carter-jarvis-bridge-synth-ack-removed-verify.js for this exact
// channel, chosen deliberately so no test turn is ever written to the real,
// shared production jarvis-bridge bucket (which Heath's actual live Cole
// session polls) — zero risk of injecting a spurious message into his real
// conversation.
//
//   Part 1 (write-side, real server.ts spawned as a child, exactly how
//   .mcp.json spawns it): proves the new writeRemoteHeartbeat() code path
//   really executes and really PUTs a fresh heartbeat.json to Storage.
//
//   Part 2 (read-side, the real exported handler from
//   api/jarvis-bridge-turn.js, called directly): proves the GET decision
//   logic —
//     Case B: turn stuck pending past PICKUP_TIMEOUT_MS, NO heartbeat at
//             all -> bridge_offline: true (still correctly catches a
//             genuinely dead channel — nothing regressed).
//     Case C: SAME stuck-pending turn, but a FRESH heartbeat present ->
//             bridge_offline absent — the exact false positive from
//             production, reproduced and confirmed fixed.
//     Case D: heartbeat present but STALE (>15s old) -> bridge_offline:
//             true again — a genuinely dead channel (heartbeat stopped
//             updating) is still reported accurately, not masked forever
//             by a once-fresh heartbeat.
//
// Usage: node scripts/atlas-jarvis-bridge-liveness-verify.js

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
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---- mock Supabase Storage factory (one store per test part) --------------
function makeMockStorage() {
  const store = new Map(); // object name -> object body
  const writeLog = [];

  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
  }

  const server = http.createServer(async (req, res) => {
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
      const name = decodeURIComponent(p.slice('/storage/v1/object/jarvis-bridge/'.length)).split('?')[0];
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

  return { server, store, writeLog };
}

(async () => {
  // ===========================================================================
  // PART 1 — write side: spawn the REAL, unmodified server.ts and prove it
  // actually writes a fresh remote heartbeat.
  // ===========================================================================
  const part1 = makeMockStorage();
  await new Promise((resolve) => part1.server.listen(0, '127.0.0.1', resolve));
  const port1 = part1.server.address().port;
  console.log(`[verify] Part 1: mock Storage on 127.0.0.1:${port1}`);

  const scratchStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jarvis-bridge-liveness-verify-'));
  const child = spawn('bun', ['scripts/jarvis-bridge/server.ts'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      SUPABASE_URL: `http://127.0.0.1:${port1}`,
      SUPABASE_SERVICE_ROLE_KEY: 'test-key-mock-storage-only',
      JARVIS_BRIDGE_STATE_DIR: scratchStateDir,
      JARVIS_PUSH_URL: `http://127.0.0.1:${port1}/no-op-push`,
      JARVIS_BRIDGE_POLL_MS: '500',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let childStderr = '';
  child.stderr.on('data', (d) => { childStderr += d.toString(); });
  let childExited = null;
  child.on('exit', (code, signal) => { childExited = { code, signal }; });

  await sleep(1500);
  report('server.ts child process still alive after boot', !childExited, childExited ? JSON.stringify(childExited) : '');

  // REMOTE_HEARTBEAT_MIN_INTERVAL_MS in server.ts is 5000ms — wait past that
  // plus margin for at least one real write to land.
  console.log('[verify] Part 1: waiting 7s for a real writeRemoteHeartbeat() PUT...');
  await sleep(7000);

  const hbObj = part1.store.get('heartbeat.json');
  const hbWritten = !!(hbObj && hbObj.ts);
  report('real server.ts wrote heartbeat.json to Storage (bucket-root, outside turns/)', hbWritten, hbWritten ? `ts=${hbObj.ts} pid=${hbObj.pid}` : `store keys: ${[...part1.store.keys()].join(',')}`);
  if (hbWritten) {
    const ageMs = Date.now() - new Date(hbObj.ts).getTime();
    report('written heartbeat is fresh (age well under 15s stale threshold)', ageMs >= 0 && ageMs < 15000, `age=${ageMs}ms`);
  }
  const turnsPrefixLeaked = [...part1.store.keys()].some((k) => k === 'turns/heartbeat.json');
  report('heartbeat object did NOT land under turns/ prefix (would corrupt listTurns())', !turnsPrefixLeaked);

  try { child.kill('SIGTERM'); } catch {}
  await sleep(300);
  try { part1.server.close(); } catch {}

  // ===========================================================================
  // PART 2 — read side: the REAL exported handler from
  // api/jarvis-bridge-turn.js, called directly, against a second, isolated
  // mock store I fully control (no server.ts attached) so I can construct
  // both the false-positive and genuine-down conditions deterministically.
  // ===========================================================================
  const part2 = makeMockStorage();
  await new Promise((resolve) => part2.server.listen(0, '127.0.0.1', resolve));
  const port2 = part2.server.address().port;
  console.log(`[verify] Part 2: mock Storage on 127.0.0.1:${port2}`);

  process.env.SUPABASE_URL = `http://127.0.0.1:${port2}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key-mock-storage-only';

  // Stub the auth middleware so the real handler's owner-email gate passes
  // without a real Supabase JWT — everything else in the handler (including
  // the new heartbeat check) runs completely unmodified.
  const authPath = require.resolve(path.join(REPO_ROOT, 'api', '_middleware', 'auth.js'));
  require.cache[authPath] = {
    id: authPath,
    filename: authPath,
    loaded: true,
    exports: {
      verifySupabaseToken: async () => ({ email: 'heath.shepard@kw.com' }),
      AuthError: class AuthError extends Error {},
    },
  };

  const handlerPath = path.join(REPO_ROOT, 'api', 'jarvis-bridge-turn.js');
  delete require.cache[require.resolve(handlerPath)];
  const handler = require(handlerPath);

  function makeRes() {
    return {
      _status: 200,
      _json: null,
      status(code) { this._status = code; return this; },
      json(obj) { this._json = obj; return this; },
    };
  }
  function makeReq({ method, query }) {
    return { method, query: query || {}, headers: { authorization: 'Bearer fake-jwt-stubbed-in-test' } };
  }

  // Create a real turn via the real POST path.
  const createRes = makeRes();
  const createReq = Object.assign(makeReq({ method: 'POST' }), { body: { message: 'Atlas QA — liveness fix verification, please ignore.' } });
  await handler(createReq, createRes);
  const created = createRes._json;
  report('real handler created a turn via POST', createRes._status === 202 && created && created.ok, JSON.stringify(created));
  const turnId = created.turn_id;
  const turnName = `turns/${turnId}.json`;

  // Backdate it past PICKUP_TIMEOUT_MS (20s) without waiting for real time.
  const turnObj = part2.store.get(turnName);
  turnObj.created_at = new Date(Date.now() - 25000).toISOString();
  part2.store.set(turnName, turnObj);

  // ---- Case B: no heartbeat at all -> genuine-down still correctly caught
  const resB = makeRes();
  await handler(makeReq({ method: 'GET', query: { id: turnId } }), resB);
  const offlineB = resB._json && resB._json.bridge_offline === true;
  report('Case B (no heartbeat, stuck pending 25s): bridge_offline=true — genuine-down still detected', offlineB, JSON.stringify(resB._json));

  // ---- Case C: fresh heartbeat present -> the actual false positive, now fixed
  part2.store.set('heartbeat.json', { ts: new Date().toISOString(), pid: 999999, uptime_s: 120 });
  const resC = makeRes();
  await handler(makeReq({ method: 'GET', query: { id: turnId } }), resC);
  const stillOfflineC = resC._json && resC._json.bridge_offline === true;
  const statusC = resC._json && resC._json.status;
  report('Case C (FRESH heartbeat, SAME stuck-pending-25s turn): bridge_offline is NOT set — false positive fixed', !stillOfflineC && statusC === 'pending', JSON.stringify(resC._json));

  // ---- Case D: heartbeat present but stale -> genuine-down still caught
  part2.store.set('heartbeat.json', { ts: new Date(Date.now() - 20000).toISOString(), pid: 999999, uptime_s: 120 });
  const resD = makeRes();
  await handler(makeReq({ method: 'GET', query: { id: turnId } }), resD);
  const offlineD = resD._json && resD._json.bridge_offline === true;
  report('Case D (STALE 20s-old heartbeat, same stuck-pending turn): bridge_offline=true — a truly dead channel is not masked forever', offlineD, JSON.stringify(resD._json));

  // ---- Sanity: fresh turn, no heartbeat needed, normal path unaffected
  const createRes2 = makeRes();
  await handler(Object.assign(makeReq({ method: 'POST' }), { body: { message: 'Atlas QA — sanity check, please ignore.' } }), createRes2);
  const turnId2 = createRes2._json.turn_id;
  part2.store.delete('heartbeat.json');
  const resE = makeRes();
  await handler(makeReq({ method: 'GET', query: { id: turnId2 } }), resE);
  const normalPending = resE._json && resE._json.status === 'pending' && !resE._json.bridge_offline;
  report('Case E (brand-new turn, well under 20s, no heartbeat needed): normal pending, no false alarm', normalPending, JSON.stringify(resE._json));

  try { part2.server.close(); } catch {}

  console.log('\n========== SUMMARY ==========');
  results.forEach((r) => console.log(`${r.pass ? 'PASS' : 'FAIL'} — ${r.name}${r.note ? ' :: ' + r.note : ''}`));
  const overall = results.every((r) => r.pass);
  console.log(`OVERALL: ${overall ? 'PASS' : 'FAIL'}`);
  if (!overall && childStderr) {
    console.log('\n---- server.ts child stderr (last 4000 chars) ----');
    console.log(childStderr.slice(-4000));
  }
  console.log(`\nArtifacts: ${scratchStateDir}`);
  process.exit(overall ? 0 : 1);
})().catch((e) => {
  console.error('[verify] CRASH', e.stack || e);
  process.exit(1);
});
