'use strict';

// scripts/_lib/session-profiles.js
//
// ONE source of truth for "which Chrome profile backs which channel, and which
// cookie proves that channel is logged in".
//
// WHY THIS FILE EXISTS (2026-09-25, Atlas)
// The same mapping was written out by hand in several places and they had
// already drifted apart. scripts/credential-health-probe.js declared that
// linkedin_personal and instagram_engagement live in the DossieBot-Sage
// profile. They do not. scripts/linkedin-engager.js and instagram-engager.js
// both resolve PLAYWRIGHT_PROFILE_DIR, which .env.local sets to
// C:\Users\Heath\DossieBot -- a DIFFERENT directory that, verified live today,
// holds the 9 linkedin.com cookies while the Sage profile holds zero. So the
// probe was reading the wrong database for two of its three channels and could
// report them healthy/unknown independently of the truth.
//
// Every consumer imports from here so that class of drift cannot recur.
//
// PATHS: these scripts run under Windows node from Task Scheduler, but are
// frequently inspected from WSL. Cookie reads therefore go through
// cookieDbPath(), which translates a C:\ path to /mnt/c when it detects WSL.

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Windows home, whether we are running under Windows node or WSL. */
function winHome() {
  if (process.platform !== 'win32' && fs.existsSync('/mnt/c/Users/Heath')) return '/mnt/c/Users/Heath';
  return os.homedir();
}

/** Translate a Windows path to a WSL path when (and only when) we are in WSL. */
function toLocalPath(p) {
  if (!p) return p;
  if (process.platform === 'win32') return p;
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return path.posix.join('/mnt', m[1].toLowerCase(), m[2].replace(/\\/g, '/'));
  return p;
}

/**
 * Resolve a profile directory exactly the way the owning script does, so the
 * probe can never disagree with the thing it is probing.
 */
function resolveProfile(envVar, fallbackSegments) {
  const fromEnv = process.env[envVar];
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return path.join(winHome(), ...fallbackSegments);
}

/**
 * Chrome keeps cookies at <profileDir>/<ProfileName>/Network/Cookies.
 * PLAYWRIGHT_PROFILE_NAME is 'Default' for the DossieBot profiles but has been
 * 'Profile 4' historically, so it is read rather than assumed.
 */
function cookieDbPath(profileDir, profileName) {
  return path.join(toLocalPath(profileDir), profileName || 'Default', 'Network', 'Cookies');
}

/**
 * The channels the marketing pipelines depend on.
 *
 * `required` is the set of cookies whose ABSENCE proves a logout. Their
 * presence does not prove a working session -- only the server can say that --
 * which is why live_url/live_selector exist for the stronger probe.
 */
function channels() {
  const sageDir = resolveProfile('SAGE_PROFILE_DIR', ['AppData', 'Local', 'DossieBot-Sage']);
  const sageName = process.env.SAGE_PROFILE_NAME || 'Default';
  const botDir = resolveProfile('PLAYWRIGHT_PROFILE_DIR', ['DossieBot']);
  const botName = process.env.PLAYWRIGHT_PROFILE_NAME || 'Default';

  return [
    {
      channel: 'facebook_groups',
      label: 'Facebook (DossieBot-Sage profile) — group posting + comment replies',
      profile_dir: sageDir,
      profile_name: sageName,
      owning_scripts: ['fb-group-poster.js', 'fb-group-commenter.js', 'fb-comment-opp-poster.js'],
      host_match: 'facebook.com',
      required: ['c_user', 'xs'],
      live_url: 'https://www.facebook.com/',
      // Authenticated-only surfaces; the composer never renders logged out.
      live_selector: '[aria-label="Create a post"], [role="navigation"] [aria-label="Profile"]',
      live_ok: (url) => !/login|checkpoint|recover/i.test(url),
    },
    {
      channel: 'linkedin_personal',
      label: 'LinkedIn (DossieBot profile) — personal-profile posting + engagement',
      profile_dir: botDir,
      profile_name: botName,
      owning_scripts: ['linkedin-engager.js'],
      host_match: 'linkedin.com',
      required: ['li_at'],
      live_url: 'https://www.linkedin.com/feed/',
      live_selector: '.share-box-feed-entry__trigger, #global-nav',
      live_ok: (url) => !/\/login|authwall|checkpoint/i.test(url),
    },
    {
      channel: 'instagram_engagement',
      label: 'Instagram (DossieBot profile) — engagement only; posting is Zernio',
      profile_dir: botDir,
      profile_name: botName,
      owning_scripts: ['instagram-engager.js'],
      host_match: 'instagram.com',
      required: ['sessionid'],
      live_url: 'https://www.instagram.com/',
      live_selector: 'a[href="/direct/inbox/"], svg[aria-label="New post"]',
      live_ok: (url) => !/accounts\/login|challenge/i.test(url),
    },
  ];
}

function channelByName(name) {
  return channels().find((c) => c.channel === name) || null;
}

module.exports = { channels, channelByName, cookieDbPath, toLocalPath, winHome };
