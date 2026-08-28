#!/usr/bin/env node
'use strict';

// scripts/jarvis-todo-attach-file.js
// =============================================================================
// Attaches one or more real files (videos, screenshots, PDFs) to a real row
// in public.jarvis_todos so Heath sees the completed deliverable directly on
// the to-do item in the Jarvis PWA (meetdossie.com/myjarvis), not just
// described in text.
//
// SAME PATTERN AS scripts/jarvis-bridge-attach-file.js (chat-message
// attachments, built 2026-08-27) — deliberately reused rather than
// reinvented: same `jarvis-attachments` Supabase Storage bucket, same
// attachment object shape ({name,url,media_type,kind,size,uploaded_at}), same
// signed-URL approach. The only real difference is the write target: chat
// attachments merge into a Storage JSON turn object (jarvis-bridge bucket),
// todo attachments merge into the `attachments` JSONB column on a
// jarvis_todos row (via PostgREST), because jarvis_todos is a normal Supabase
// table the PWA already queries directly with the browser `supabase` client.
// Storage prefix is `todos/<todo_id>/` (vs. chat's `cole-replies/<chat_id>/`)
// so the two directions never collide in the shared bucket.
//
// HOW TO USE:
//   node scripts/jarvis-todo-attach-file.js <todo_id> <file_path> [<file_path> ...]
//
//   <todo_id>    — the jarvis_todos.id (uuid) of an existing row.
//   <file_path>  — one or more absolute local file paths. Videos (MP4/MOV/
//                  WEBM), images (PNG/JPG/WEBP/GIF), PDFs render inline in
//                  the PWA; anything else uploads fine but renders as a
//                  generic download chip.
//
// Prints a single JSON line to stdout on success:
//   {"ok":true,"todo_id":"...","attachments":[{"name":...,"url":...,"kind":...}]}
// Non-zero exit + a plain error line on failure.
//
// CREDENTIALS: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, same as the chat
// attach script — from ~/.claude/channels/jarvis-bridge/.env if present,
// else whatever is already exported in the calling shell (e.g. this repo's
// .env.local, sourced by the caller).
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
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {
    // fall through — env may already be set some other way.
  }
}
loadEnv();

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BUCKET = 'jarvis-attachments';
// Matches the jarvis-attachments bucket's own file_size_limit (confirmed
// live 2026-08-27, same bucket the chat-attach script uses).
const MAX_FILE_BYTES = 25 * 1024 * 1024;
// Signed URL lifetime. 30 days — a to-do item (unlike a chat turn) can sit
// open for weeks before Heath marks it done, and the attachment needs to
// keep rendering the whole time. Re-run this script to re-sign if it ever
// expires on an old open item.
const SIGNED_URL_TTL_S = 30 * 24 * 60 * 60;

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.m4v': 'video/x-m4v',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

function kindForMime(mime) {
  if (/^image\//i.test(mime)) return 'image';
  if (/^video\//i.test(mime)) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  return 'file';
}

function storageUrl(p) {
  return `${SUPABASE_URL}/storage/v1/${p}`;
}
function restUrl(p) {
  return `${SUPABASE_URL}/rest/v1/${p}`;
}
function authHeaders(extra) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(extra || {}),
  };
}

async function uploadOneFile(todoId, filePath) {
  const abs = path.resolve(filePath);
  const stat = fs.statSync(abs); // throws ENOENT with a clear message if missing
  if (!stat.isFile()) throw new Error(`not a file: ${abs}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`${path.basename(abs)} is ${(stat.size / 1024 / 1024).toFixed(1)}MB — exceeds the 25MB jarvis-attachments bucket limit`);
  }
  const ext = path.extname(abs).toLowerCase();
  const mime = MIME_BY_EXT[ext] || 'application/octet-stream';
  const safeName = path.basename(abs).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  const objectPath = `todos/${todoId}/${Date.now()}-${safeName}`;

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

async function getTodo(id) {
  const res = await fetch(restUrl(`jarvis_todos?id=eq.${id}&select=id,attachments`), {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`todo lookup failed: ${res.status} ${await res.text().catch(() => '')}`);
  const rows = await res.json();
  return rows[0] || null;
}

async function patchTodoAttachments(id, attachments) {
  const res = await fetch(restUrl(`jarvis_todos?id=eq.${id}`), {
    method: 'PATCH',
    headers: authHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify({ attachments }),
  });
  if (!res.ok) throw new Error(`todo update failed: ${res.status} ${await res.text().catch(() => '')}`);
}

async function main() {
  const [todoId, ...filePaths] = process.argv.slice(2);
  if (!todoId || filePaths.length === 0) {
    console.error('usage: node scripts/jarvis-todo-attach-file.js <todo_id> <file_path> [<file_path> ...]');
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — expected in ${ENV_FILE} or the calling shell's env`);
    process.exit(1);
  }

  const existing = await getTodo(todoId);
  if (!existing) {
    console.error(`jarvis_todos row ${todoId} not found — check the id.`);
    process.exit(1);
  }

  const uploaded = [];
  for (const fp of filePaths) {
    uploaded.push(await uploadOneFile(todoId, fp));
  }

  const priorAttachments = Array.isArray(existing.attachments) ? existing.attachments : [];
  const merged = [...priorAttachments, ...uploaded];
  await patchTodoAttachments(todoId, merged);

  console.log(JSON.stringify({ ok: true, todo_id: todoId, attachments: uploaded }));
}

main().catch((err) => {
  console.error(err && err.message ? err.message : String(err));
  process.exit(1);
});
