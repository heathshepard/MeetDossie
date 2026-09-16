'use strict';

// scripts/_lib/zipform-session.js
//
// Persist and reuse Heath's authenticated zipformplus.com session so he is
// never asked to type his credentials again. Written 2026-09-10 after he
// had to log in three times in one afternoon on the 23 Nopalito amendment
// send — killing/relaunching the Chrome persistent-context profile drops
// the session even though the profile directory itself survives, because
// zipForm's own reasonable-lifetime session token plus some UI state live
// only in that specific browser process's memory/short-lived storage, not
// purely in what gets flushed to disk on every write.
//
// This does NOT replace the persistent Chrome profile
// (~/.brokerage-browser-profile) — that's still the primary mechanism and
// usually enough on its own (cookies + localStorage ARE written to disk
// continuously by Chrome). This is the SECOND layer: an explicit
// `context.storageState()` snapshot (cookies + localStorage + sessionStorage
// origin data) taken right after a confirmed-authenticated moment, saved
// OUTSIDE the repo, that any future script can load to seed a fresh
// context/page without hitting the login screen.
//
// Storage location: a gitignored path under the user's home directory,
// NEVER inside the repo (this is a live credential — same handling rule as
// any other secret in this codebase, see CLAUDE.md Section 15).
//
//   C:\Users\Heath\.zipform-session-state.json   (Windows path, used by
//                                                  Playwright directly)
//
// Usage — saving (call right after confirming isAuthenticated()):
//   const { saveZipFormSession } = require('./_lib/zipform-session');
//   await saveZipFormSession(context);
//
// Usage — loading (in any new script that needs a signed-in zipForm page):
//   const { loadZipFormSessionOptions } = require('./_lib/zipform-session');
//   const context = await launchBrokerageContext({
//     headless: true,
//     reason: 'my-task',
//     contextOptions: loadZipFormSessionOptions(),
//   });
//   // launchBrokerageContext merges contextOptions into
//   // launchPersistentContext()'s options, so storageState hydrates the
//   // SAME persistent profile rather than fighting it.
//
// If the saved state is missing or stale (session actually expired
// server-side), scripts fall back to the normal login screen exactly as
// before — this is additive, never a hard dependency.

const path = require('path');
const fs = require('fs');

const SESSION_STATE_PATH = path.join('C:\\Users\\Heath', '.zipform-session-state.json');

/**
 * Snapshot the current context's storage state (cookies + localStorage +
 * sessionStorage per origin) to disk, outside the repo. Call this
 * immediately after confirming (via real page content, not a flaky
 * selector) that the zipForm session is authenticated.
 * @param {import('playwright').BrowserContext} context
 */
async function saveZipFormSession(context) {
  const state = await context.storageState();
  fs.writeFileSync(SESSION_STATE_PATH, JSON.stringify(state));
  // Never log the contents — this is a live credential. Only ever log that
  // a save happened and where.
  console.log(`[zipform-session] session state saved (${state.cookies.length} cookies, ` +
    `${state.origins.length} origin(s) with storage) -> ${SESSION_STATE_PATH}`);
  return SESSION_STATE_PATH;
}

/**
 * Returns { storageState: <path or object> } suitable for spreading into
 * launchPersistentContext()'s options, or {} if no saved session exists
 * yet (caller falls through to a normal login flow).
 */
function loadZipFormSessionOptions() {
  if (!fs.existsSync(SESSION_STATE_PATH)) {
    return {};
  }
  try {
    // Validate it parses before handing the path to Playwright.
    JSON.parse(fs.readFileSync(SESSION_STATE_PATH, 'utf8'));
    return { storageState: SESSION_STATE_PATH };
  } catch (e) {
    console.warn(`[zipform-session] saved session state at ${SESSION_STATE_PATH} is unreadable/corrupt, ignoring: ${e.message}`);
    return {};
  }
}

module.exports = { SESSION_STATE_PATH, saveZipFormSession, loadZipFormSessionOptions };
