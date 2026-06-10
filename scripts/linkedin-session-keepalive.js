'use strict';

// scripts/linkedin-session-keepalive.js
//
// Keeps the DossieBot Chrome profile's LinkedIn session warm. The
// linkedin-engager.js script already reads from this profile — this script
// just makes sure the `li_at` cookie doesn't go stale between engager runs.
//
// Schedule via Windows Task Scheduler:
//   Name: Dossie LinkedIn Session Keepalive
//   Trigger: Every 3 days at 02:40 local
//   Program: node
//   Arguments: scripts/linkedin-session-keepalive.js
//   Start in: C:\Users\Heath Shepard\Desktop\MeetDossie

const path = require('path');
const { runKeepalive } = require('./_lib/session-keepalive');

(async () => {
  const result = await runKeepalive({
    platform: 'linkedin',
    urls: [
      'https://www.linkedin.com/feed/',
      'https://www.linkedin.com/in/me/',
    ],
    cookieName: 'li_at',
    cookieDomain: 'linkedin.com',
    renewalCommand: 'open Chrome → DossieBot profile → log into LinkedIn (Heath Shepard, MeetDossie page admin)',
    screenshotPath: path.join(__dirname, '.linkedin-keepalive-last.png'),
  });

  if (!result.ok && result.alerted) process.exit(2);
  if (!result.ok) process.exit(1);
  process.exit(0);
})();
