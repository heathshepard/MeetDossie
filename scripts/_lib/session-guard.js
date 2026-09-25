'use strict';

// scripts/_lib/session-guard.js
//
// THE CIRCUIT BREAKER. Call this before launching Chrome at a platform.
//
// WHAT IT PREVENTS (measured, not theoretical -- 2026-09-25)
// scripts/linkedin-post-approved.log shows this exact loop repeating all day:
//
//     [linkedin-engager] Launching Chrome with DossieBot profile (Default)
//     [linkedin-engager] Posting approved post: heath-linkedin-2026-09-15
//     [linkedin-engager] Redirected to login - cannot post.
//
// One approved post that can never publish kept postApprovedLinkedIn() finding
// "work" on every tick, so the "Dossie TC Discovery Harvest" task -- which
// repeats every 15 MINUTES -- launched Chrome and hit linkedin.com/feed/ 96
// times a day against a session that was already dead. Every one of those
// bounced to /login.
//
// That is not a session that expired naturally. That is a logged-out browser
// knocking on the door every quarter hour, forever, from one IP. It is the
// single most automation-shaped signal we emit, and it is emitted hardest
// exactly when the session is already gone -- so it actively works against
// getting a new one to stick.
//
// The guard is an OFFLINE cookie-database read: no network, no Chrome, ~15ms.
// If the cookie that proves login is absent, the caller returns immediately and
// never opens a browser. Cheap enough to call unconditionally.
//
// WHAT IT DELIBERATELY DOES NOT DO
// It cannot tell you a present cookie is still VALID -- only the server can,
// and asking the server is the expensive thing we are rationing. So the guard
// is one-directional and that is the correct trade:
//     cookie absent  -> certainly logged out -> SKIP (high confidence)
//     cookie present -> maybe fine           -> PROCEED (the caller's normal
//                                               login-redirect handling still
//                                               applies, unchanged)
// It only ever removes doomed work. It never authorises anything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { channelByName, cookieDbPath } = require('./session-profiles');

// Chrome stores expiry as microseconds since 1601-01-01. The value overflows a
// JS number, so it is CAST to TEXT in SQL and parsed as a float here -- reading
// it as an integer throws ERR_OUT_OF_RANGE on node:sqlite.
const CHROME_EPOCH_OFFSET_MS = 11644473600000;

/** Warn this far ahead of a cookie lapsing, so it is renewed before it breaks. */
const EXPIRY_WARN_DAYS = 14;

/**
 * Read the auth cookies for a channel straight out of Chrome's SQLite file.
 *
 * SAFETY: the live database is copied to a temp path and opened read-only. No
 * lock is taken on the profile, so this can never disturb -- or be blamed for
 * killing -- an authenticated Chrome someone else is holding.
 *
 * Cookie VALUES are encrypted at rest and are never read or decrypted. Only
 * host_key, name and expires_utc are touched, which are plaintext metadata.
 */
function inspectChannel(name) {
  const ch = channelByName(name);
  if (!ch) return { channel: name, known: false, logged_in: null, reason: 'unknown channel' };

  const dbPath = cookieDbPath(ch.profile_dir, ch.profile_name);
  if (!fs.existsSync(dbPath)) {
    return {
      channel: name, known: true, logged_in: null, present: [], missing: ch.required,
      reason: `cookie database not found at ${dbPath}`, profile_dir: ch.profile_dir,
    };
  }

  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch { return { channel: name, known: true, logged_in: null, present: [], reason: 'node:sqlite unavailable (needs node >= 22)' }; }

  const tmp = path.join(os.tmpdir(), `sessguard-${process.pid}-${Math.random().toString(36).slice(2)}.sqlite`);
  try {
    fs.copyFileSync(dbPath, tmp);
    const db = new DatabaseSync(tmp, { readOnly: true });
    const rows = db.prepare(
      'SELECT name, CAST(expires_utc AS TEXT) AS expires_utc FROM cookies WHERE host_key LIKE ?'
    ).all(`%${ch.host_match}%`);
    db.close();

    const present = [];
    let earliest = null;
    for (const r of rows) {
      if (!ch.required.includes(r.name)) continue;
      present.push(r.name);
      const raw = Number(r.expires_utc);
      if (!raw) continue; // session cookie: no expiry to reason about
      const ms = raw / 1000 - CHROME_EPOCH_OFFSET_MS;
      if (ms > 0 && (earliest === null || ms < earliest)) earliest = ms;
    }

    const missing = ch.required.filter((c) => !present.includes(c));
    const loggedIn = missing.length === 0;
    const days = earliest === null ? null : Math.round(((earliest - Date.now()) / 86400000) * 10) / 10;

    return {
      channel: name, known: true, logged_in: loggedIn,
      present, missing,
      profile_dir: ch.profile_dir,
      cookies_for_host: rows.length,
      earliest_expiry: earliest === null ? null : new Date(earliest).toISOString(),
      days_to_expiry: days,
      expiring_soon: days !== null && days <= EXPIRY_WARN_DAYS && days > 0,
      reason: loggedIn
        ? 'required cookies present'
        : `missing ${missing.join('/')} — this profile is logged out of ${ch.host_match}`,
    };
  } catch (e) {
    return { channel: name, known: true, logged_in: null, present: [], reason: `cookie read failed: ${e.message.slice(0, 200)}` };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
  }
}

/**
 * The call site helper.
 *
 *   const { ensureSession } = require('./_lib/session-guard');
 *   const gate = ensureSession('linkedin_personal', 'linkedin-engager');
 *   if (!gate.proceed) return;   // logged out: do NOT launch Chrome
 *
 * UNKNOWN proceeds. A guard that cannot read the cookie DB must not be able to
 * take a working pipeline offline -- it is a brake, not a kill switch.
 */
function ensureSession(channel, caller) {
  const info = inspectChannel(channel);
  const tag = `[session-guard:${caller || channel}]`;

  if (info.logged_in === false) {
    console.log(`${tag} SKIP — ${info.reason}.`);
    console.log(`${tag} Not launching Chrome. Hammering a dead session every tick is what invalidates the next one.`);
    console.log(`${tag} Fix: open Chrome on ${info.profile_dir} and log in manually. Nothing here will do it for you.`);
    return { proceed: false, ...info };
  }
  if (info.logged_in === null) {
    console.warn(`${tag} UNKNOWN — ${info.reason}. Proceeding (the guard is a brake, not a kill switch).`);
    return { proceed: true, ...info };
  }
  if (info.expiring_soon) {
    console.warn(`${tag} session valid but EXPIRING in ${info.days_to_expiry}d (${info.earliest_expiry}).`);
  }
  return { proceed: true, ...info };
}

module.exports = { ensureSession, inspectChannel, EXPIRY_WARN_DAYS, CHROME_EPOCH_OFFSET_MS };
