#!/usr/bin/env node
'use strict';

// scripts/jarvis-bridge-attach-file.js
// =============================================================================
// Attaches one or more real files (PDFs, screenshots, images) to an OPEN
// jarvis-bridge turn so Heath sees them inline in the Jarvis PWA
// (meetdossie.com/myjarvis) instead of only in the Claude Code app's own UI.
//
// WHY THIS EXISTS (read before touching the `reply` MCP tool):
// `mcp__jarvis-bridge__reply` (scripts/jarvis-bridge/server.ts) only accepts
// {chat_id, text, final} — that tool's schema is the MCP server's own code,
// not something a Claude session can extend at call time. This script is a
// deliberately SEPARATE mechanism: it does not call the reply tool at all,
// it writes directly to the same underlying Supabase Storage turn object
// (jarvis-bridge bucket, turns/<chat_id>.json) that the reply tool also
// writes to, merging in an `attachments` array alongside whatever reply_text
// is already there (or gets set by a `reply` call before/after this runs).
//
// HOW TO USE (future Cole session — this is the whole interface):
//   node scripts/jarvis-bridge-attach-file.js <chat_id> <file_path> [<file_path> ...]
//
//   <chat_id>    — the turn id from the inbound <channel chat_id="..."> tag,
//                  same value passed to the `reply` tool for this turn.
//   <file_path>  — one or more absolute local file paths (PDF, PNG, JPG,
//                  WEBP, GIF; anything else uploads fine but renders as a
//                  generic download link, not an inline preview).
//
// Typical flow for a live jarvis-bridge turn where Heath asked to see a
// document:
//   1. Call `reply` (final:true) with the spoken-aloud text answer, same as
//      always.
//   2. Run this script with the same chat_id and the file path(s) — order
//      relative to step 1 does not matter, this script read-modifies-writes
//      the turn object rather than overwriting it.
//   3. Nothing else to do — jarvis-pwa.html's existing poll of
//      GET /api/jarvis-bridge-turn?id=<chat_id> already picks up the
//      `attachments` field once status is 'answered' and renders it (image
//      = inline preview, tap to open full-size in a new tab; PDF/other =
//      a tappable open/download chip).
//
// Prints a single JSON line to stdout on success:
//   {"ok":true,"chat_id":"...","attachments":[{"name":...,"url":...,"kind":...}]}
// Non-zero exit + a plain error line on failure — check the message, it's
// meant to be self-explanatory (missing turn, oversized file, bad creds).
//
// TRANSPORT: uploads to the existing private `jarvis-attachments` Supabase
// Storage bucket (already used by jarvis-pwa.html for the OUTBOUND direction
// — Heath attaching a file to send TO Cole, see uploadAttachment() in that
// file). This script uses it for the INBOUND direction (Cole -> Heath)
// instead, under a `cole-replies/<chat_id>/` prefix so the two directions
// never collide. Bucket is private (no public mime allowlist, 25MB object
// cap, confirmed live via GET /storage/v1/bucket 2026-08-27) — reads happen
// through a signed URL this script generates with the service-role key and
// writes straight into the turn JSON, so the PWA never needs its own
// Storage call (and never needs RLS access) to render an attachment; it
// just uses the URL as-is in an <img>/<a> tag.
//
// CREDENTIALS: same file server.ts already loads for the exact same
// bucket/turn-object trust boundary — ~/.claude/channels/jarvis-bridge/.env
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). This script is meant to be run
// from Heath's own machine (same one running the live Claude Code session
// and the jarvis-bridge channel process), never from CI or a shared box.
// =============================================================================

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.JARVIS_BRIDGE_STATE_DIR || path.join(os.homedir(), '.claude', 'channels', 'jarvis-bridge');
const ENV_FILE = path.join(STATE_DIR, '.env');

function loadEnv() {
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const m = line.match(/^(\w+)=(.*)$/);
      if (m) process.env[m[1]] = m[2];
    }
  } catch {
    // fall through — env may already be set some other way (e.g. exported
    // in the calling shell). Missing required vars are caught below.
  }
}
loadEnv();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'jarvis-attachments';
const TURN_BUCKET = 'jarvis-bridge';
const TURN_PREFIX = 'turns/';
// Matches the jarvis-attachments bucket's own file_size_limit (confirmed
// live 2026-08-27) — fail fast locally with a clear message instead of a
// confusing 413 from Storage.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Signed URL lifetime. 7 days comfortably covers "Heath opens Jarvis later
// today/this week" without leaving a permanent public-ish link — this
// script re-signs a fresh URL every time it's re-run for the same file if
// a longer window is ever needed.
const SIGNED_URL_TTL_S = 7 * 24 * 60 * 60;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

function kindForMime(mime) {
  if (/^image\//i.test(mime)) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

function storageUrl(p) {
  return `${SUPABASE_URL}/storage/v1/${p}`;
}
function authHeaders(extra) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(extra || {}),
  };
}

async function uploadOneFile(chatId, filePath) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs); // throws ENOENT with a clear message if missing
  if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${path.basename(abs)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — exceeds the 25MB jarvis-attachments bucket limit`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const safeName = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const objectPath = `cole-replies/${chatId}/${Date.now()}-${safeName}`;

  const buf = fs.readFileSync(abs);
  const upRes = await fetch(storageUrl(`object/${BUCKET}/${objectPath}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': mime, 'x-upsert': 'true' }),
    body: buf,
  });
  if (!upRes.ok) {
    throw new Error(`upload failed for ${safeName}: ${upRes.status} ${await upRes.text().catch(() => '')}`);
  }

  const signRes = await fetch(storageUrl(`object/sign/${BUCKET}/${objectPath}`), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_S }),
  });
  if (!signRes.ok) {
    throw new Error(`sign-url failed for ${safeName}: ${signRes.status} ${await signRes.text().catch(() => '')}`);
  }
  const signData = await signRes.json();
  const signedPath = signData.signedURL || signData.signedUrl;
  if (!signedPath) throw new Error(`sign-url response for ${safeName} had no signedURL`);
  const url = signedPath.startsWith('http') ? signedPath : `${SUPABASE_URL}/storage/v1${signedPath}`;

  return {
    name: path.basename(abs),
    url,
    media_type: mime,
    kind: kindForMime(mime),
    size: stat.size,
    uploaded_at: new Date().toISOString(),
  };
}

async function getTurn(id) {
  const res = await fetch(storageUrl(`object/${TURN_BUCKET}/${TURN_PREFIX}${id}.json?_cb=${Date.now()}`), {
    headers: authHeaders({ 'Cache-Control': 'no-cache' }),
    cache: 'no-store',
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`turn lookup failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

async function putTurn(id, turn) {
  const res = await fetch(storageUrl(`object/${TURN_BUCKET}/${TURN_PREFIX}${id}.json`), {
    method: 'POST',
    headers: authHeaders({
      'Content-Type': 'application/json',
      'x-upsert': 'true',
      'cache-control': 'no-cache, no-store, max-age=0, must-revalidate',
    }),
    body: JSON.stringify(turn),
  });
  if (!res.ok) throw new Error(`turn write failed: ${res.status} ${await res.text().catch(() => '')}`);
}

async function main() {
  const [chatId, ...filePaths] = process.argv.slice(2);
  if (!chatId || filePaths.length === 0) {
    console.error('usage: node scripts/jarvis-bridge-attach-file.js <chat_id> <file_path> [<file_path> ...]');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — expected in ${ENV_FILE} (same file scripts/jarvis-bridge/server.ts loads)`);
    process.exit(1);
  }

  const existing = await getTurn(chatId);
  if (!existing) {
    console.error(`turn ${chatId} not found in Storage — it may have expired (turns clean up after 1h) or the id is wrong. Attachments can only attach to a turn that's still open.`);
    process.exit(1);
  }

  const uploaded = [];
  for (const fp of filePaths) {
    uploaded.push(await uploadOneFile(chatId, fp));
  }

  const priorAttachments = Array.isArray(existing.attachments) ? existing.attachments : [];
  await putTurn(chatId, { ...existing, attachments: [...priorAttachments, ...uploaded] });

  console.log(JSON.stringify({ ok: true, chat_id: chatId, attachments: uploaded }));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
