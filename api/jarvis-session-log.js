'use strict';

// api/jarvis-session-log.js
// ============================================================================
// GET /api/jarvis-session-log
//
// Built 2026-08-22 per Heath's ask over jarvis-bridge: the "ACTIVE BACKGROUND
// JOBS" strip only shows what's running RIGHT NOW — nothing about the huge
// amount of work already finished earlier the same session. "We've talked
// about more but I don't see where it all went" / "make it all visible so I
// can see it." SESSION-DIARY.md is the real record (one entry per session,
// newest-first per its own header comment) but it was a file on disk with no
// path from Heath's phone to reading it. This endpoint is that path.
//
// Deliberately minimal: reads SESSION-DIARY.md, splits on top-level `## `
// headers, returns ONLY the first (= most recent, per the file's own
// newest-first ordering) entry. No date-range filtering, no history browsing
// — if that's wanted later, extend this endpoint, don't build a second one.
//
// Auth: Bearer Supabase JWT, same verifySupabaseToken() gate as every other
// read-only jarvis-* endpoint (see jarvis-in-flight-work.js). Diary content
// isn't secret-bearing but it does name real clients/deals, so it stays
// behind Heath's own auth like everything else on this surface.
//
// Vercel serverless functions run from /var/task/api/, so SESSION-DIARY.md
// (repo root, one level up from this file) has to be explicitly bundled via
// `includeFiles` in vercel.json — see the entry for this function there.
// ============================================================================

import { verifySupabaseToken } from './_middleware/auth.js';
const fs = require('fs');
const path = require('path');

const DIARY_PATH = path.join(__dirname, '..', 'SESSION-DIARY.md');

export const config = { api: { bodyParser: false }, maxDuration: 10 };

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

// Pulls the first `## ` section out of the diary. The file's own header
// comment states the ordering contract ("One entry per session ... most
// recent first") — this trusts that contract rather than trying to parse
// dates out of the heading text, which vary in format across old entries.
function extractLatestEntry(raw) {
  const lines = raw.split('\n');
  const headingIdxs = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^## /.test(lines[i])) headingIdxs.push(i);
  }
  if (headingIdxs.length === 0) return null;
  const start = headingIdxs[0];
  const end = headingIdxs.length > 1 ? headingIdxs[1] : lines.length;
  const block = lines.slice(start, end).join('\n').trim();
  const titleLine = lines[start].replace(/^## /, '').trim();
  // Pull a leading date token like "2026-08-22" off the title if present.
  const dateMatch = titleLine.match(/^(\d{4}-\d{2}-\d{2})/);
  return {
    date: dateMatch ? dateMatch[1] : null,
    title: titleLine,
    markdown: block,
  };
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method_not_allowed' });

  try {
    await verifySupabaseToken(req);
  } catch (err) {
    return res.status(err.status || 401).json({ ok: false, error: err.message });
  }

  try {
    if (!fs.existsSync(DIARY_PATH)) {
      return res.status(404).json({ ok: false, error: 'session_diary_not_found' });
    }
    const raw = fs.readFileSync(DIARY_PATH, 'utf-8');
    const entry = extractLatestEntry(raw);
    if (!entry) {
      return res.status(404).json({ ok: false, error: 'no_entries_in_diary' });
    }
    return res.status(200).json({
      ok: true,
      date: entry.date,
      title: entry.title,
      markdown: entry.markdown,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[jarvis-session-log] error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
