'use strict';

// api/_lib/auth-users.js
//
// Reading auth.users through the GoTrue admin API, without the two failure
// modes that made the previous inline version unsafe to build an alarm on.
//
// FAILURE MODE 1 — SILENT TRUNCATION
//   `GET /auth/v1/admin/users?per_page=200` returns at most one page. GoTrue
//   caps per_page (currently 1000, historically lower) and pages silently. Any
//   user past the last returned row simply is not in the response. A caller
//   that builds `lastSignInMap` from one page and then asks "is this user
//   missing?" will answer YES for everyone off the end of the page — and
//   "missing from the map" is exactly how cron-pierce-activation decides
//   somebody has NEVER LOGGED IN. At 200 customers that alarm starts lying.
//
// FAILURE MODE 2 — ERROR READ AS DATA
//   The old code caught a failed fetch, logged a warning, and carried on with
//   an EMPTY array. An outage or an expired key therefore produced a confident
//   Telegram message telling Heath that every single paying customer had never
//   logged in. An alarm that cries wolf on its own infrastructure failure is
//   worse than no alarm: the next real one gets ignored.
//
// This module pages to exhaustion and THROWS on failure. Callers must decide
// what to do with an error; none of them may treat it as "no users".
//
// Read-only. Never writes, never sends.
//
// Owner: 2026-09-18.

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const PER_PAGE = 200;
// Hard ceiling so a paging bug can never spin forever inside a serverless
// function. 100 pages x 200 = 20,000 users; far beyond current scale, and if we
// ever hit it the caller gets an explicit error rather than a truncated answer.
const MAX_PAGES = 100;

/**
 * Every auth user, across all pages.
 * @returns {Promise<Array<object>>}
 * @throws on any non-OK response — deliberately. Do not swallow this.
 */
async function listAllAuthUsers() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('auth_admin_not_configured');
  }
  const all = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?page=${page}&per_page=${PER_PAGE}`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`auth_admin_list_failed_${res.status}: ${text.slice(0, 200)}`);
    }
    const data = await res.json().catch(() => null);
    const users = (data && Array.isArray(data.users)) ? data.users : [];
    all.push(...users);
    // A short page is the last page.
    if (users.length < PER_PAGE) return all;
  }
  throw new Error('auth_admin_list_exceeded_max_pages');
}

/**
 * Index by id, carrying the few fields callers actually need.
 *
 * `neverSignedIn` and `neverSetPassword` are DIFFERENT questions and the
 * distinction is the whole point of this file:
 *
 *   neverSignedIn    — no session has ever existed. The account is unreachable.
 *   neverSetPassword — updated_at has not moved since the recovery email went
 *                      out, i.e. no updateUser({password}) ever landed. This is
 *                      the fingerprint that identified Kim, Cecilia and Lisa in
 *                      docs/ACTIVATION-FORENSICS-2026-09-18.md §3.
 *
 * Someone can have signed in once (via the recovery link) and still have no
 * password — that was Terry Katz, whose single 42-second session was the only
 * time he could ever get in.
 */
function indexAuthUsers(users) {
  const byId = new Map();
  for (const u of (users || [])) {
    const recoverySentAt = u.recovery_sent_at || null;
    const updatedAt = u.updated_at || null;
    const neverSetPassword = !!(recoverySentAt && updatedAt
      && new Date(updatedAt).getTime() <= new Date(recoverySentAt).getTime() + 1000);
    byId.set(u.id, {
      id: u.id,
      email: u.email || '',
      lastSignInAt: u.last_sign_in_at || null,
      createdAt: u.created_at || null,
      recoverySentAt,
      updatedAt,
      invitedAt: u.invited_at || null,
      neverSignedIn: !u.last_sign_in_at,
      neverSetPassword,
    });
  }
  return byId;
}

module.exports = { listAllAuthUsers, indexAuthUsers, PER_PAGE };
