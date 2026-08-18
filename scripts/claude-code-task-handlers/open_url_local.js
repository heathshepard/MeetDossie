// scripts/claude-code-task-handlers/open_url_local.js
//
// "Nicer UX" half of the engagement-queue manual-post handoff (Atlas,
// 2026-08-18). The MINIMUM viable handoff is the Telegram message itself
// (permalink + copy-pasteable reply text) -- that always fires regardless of
// this handler. This handler is a best-effort convenience on top: it pops
// the DossieBot Chrome profile straight to the thread on Heath's own machine
// so he doesn't have to copy the link into a browser by hand.
//
// This is NOT automation of the post itself -- it opens a normal Chrome
// window to a URL, nothing more. No Playwright, no DOM interaction, no
// typing, no clicking. Heath still pastes the text and clicks Post himself.
// Chrome's single-instance-per-profile behavior means if a Playwright
// session already holds this profile, this just opens a new tab in that
// same window (or a plain no-op tab request) rather than launching a second
// conflicting instance.
//
// Contract:
//   { payload: { url: string } }
// Returns:
//   { ok: true, summary } | { ok: false, summary }
//
// Dispatched via POST /api/claude-code-enqueue { task_type: 'open_url_local',
// payload: { url } } from api/telegram-webhook.js's engage_approve handler.
// Picked up by scripts/claude-code-worker.js (already running on Heath's PC
// via the ClaudeCodeWorker scheduled task) within one poll cycle (~30s).
//
// Owner: Atlas, 2026-08-18

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

function resolveChromeExe() {
  for (const c of CHROME_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return 'chrome'; // fall back to PATH
}

module.exports = async function openUrlLocalHandler({ payload, log }) {
  const url = payload && typeof payload.url === 'string' ? payload.url.trim() : '';
  if (!url) return { ok: false, summary: 'no url in payload' };

  // Scope this strictly to Facebook -- this handler only exists to save a
  // copy/paste for the engagement-queue handoff, never a general "open
  // anything" remote-control primitive.
  if (!/^https:\/\/(www\.)?facebook\.com\//i.test(url)) {
    return { ok: false, summary: `refusing non-facebook.com url: ${url}` };
  }

  const profileDir = process.env.PLAYWRIGHT_PROFILE_DIR || path.join(os.homedir(), 'DossieBot');
  const profileName = process.env.PLAYWRIGHT_PROFILE_NAME || 'Default';
  const chromeExe = resolveChromeExe();

  log(`opening ${url} in DossieBot Chrome profile (${profileDir} / ${profileName})`);

  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawn(chromeExe, [
        `--user-data-dir=${profileDir}`,
        `--profile-directory=${profileName}`,
        url,
      ], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
    } catch (err) {
      return resolve({ ok: false, summary: `spawn threw: ${err.message}` });
    }

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, summary: `spawn failed: ${err.message}` });
    });

    child.unref();

    // Chrome's launcher process exits almost immediately once it hands off
    // to the (possibly already-running) browser instance -- give it a beat
    // then declare success. This is best-effort UX only; the Telegram
    // handoff message with the permalink + text is the real deliverable and
    // does not depend on this succeeding.
    setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: true,
        summary: `Opened ${url} in DossieBot Chrome (best-effort). Heath still pastes + posts manually.`,
      });
    }, 1500);
  });
};
