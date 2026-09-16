'use strict';

// scripts/_lib/fb-own-identity.js
//
// Shared "is this comment/post author actually Heath?" config + matcher.
//
// 2026-09-16 bug: scripts/harvest-tc-discovery-responses.js and
// scripts/watch-guest-thread-replies.js both matched HEATH_FB_NAMES=
// ['Heath Shepard'] with EXACT equality. Facebook's acting identity for
// group posting/commenting renders as "Heath Shepard, Realtor with Keller
// Williams City View" (the Page, confirmed live 2026-09-16 -- see
// facebook.com/HeathShepardRealtor), not the bare personal-profile name. The
// exact match silently missed every one of Heath's own comments under that
// identity, which risked the auto-reply pipeline drafting a reply to
// Heath's own comment as if it were a stranger's.
//
// Fix: name list lives in config (env var, not a literal array baked into a
// consumer file) and matching is a normalized prefix match, not `===`, so
// any suffix Facebook appends to either identity ("... Realtor with Keller
// Williams City View", a future title change, etc.) still self-flags
// without a code change.
//
// Config: HEATH_FB_OWN_NAMES, comma-separated, checked into .env.local (same
// loading pattern as TELEGRAM_BOT_TOKEN elsewhere in scripts/). Falls back
// to the two identities confirmed live as of 2026-09-16 if unset.

const DEFAULT_OWN_NAMES = [
  'Heath Shepard',
  'Heath Shepard, Realtor with Keller Williams City View',
];

function loadOwnNames() {
  const raw = process.env.HEATH_FB_OWN_NAMES;
  if (!raw || !raw.trim()) return DEFAULT_OWN_NAMES.slice();
  const parsed = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return parsed.length ? parsed : DEFAULT_OWN_NAMES.slice();
}

// Lazy so a test can set HEATH_FB_OWN_NAMES before first use and still see
// it; re-reading process.env.HEATH_FB_OWN_NAMES on every call is cheap.
function getOwnNames() {
  return loadOwnNames();
}

function normalize(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Robust prefix/normalized match, not exact equality. Matches when either
// string is a name-boundary prefix of the other (boundary = end-of-string,
// comma, or space) -- so "Heath Shepard" matches "Heath Shepard, Realtor
// with Keller Williams City View" (Page display name carries the personal
// name as a prefix) and vice versa, but "Heath Shepardson" or "Co-Heath
// Shepard" do NOT falsely match "Heath Shepard".
function isOwnAuthor(author, names) {
  const a = normalize(author);
  if (!a) return false;
  const list = names || getOwnNames();
  return list.some((raw) => {
    const n = normalize(raw);
    if (!n) return false;
    if (a === n) return true;
    if (a.length > n.length && a.startsWith(n) && /[\s,]/.test(a[n.length])) return true;
    if (n.length > a.length && n.startsWith(a) && /[\s,]/.test(n[a.length])) return true;
    return false;
  });
}

module.exports = { DEFAULT_OWN_NAMES, getOwnNames, isOwnAuthor, normalize };
