'use strict';

// scripts/twitter-session-keepalive.js
//
// Keeps the DossieBot Chrome profile's Twitter/X session warm. The legacy
// twitter-keyword-scanner.js still uses scripts/sessions/twitter.json — a
// follow-up commit will migrate it to read from the persistent profile too.
//
// Schedule via Windows Task Scheduler:
//   Name: Dossie Twitter Session Keepalive
//   Trigger: Every 3 days at 03:00 local
//   Program: node
//   Arguments: scripts/twitter-session-keepalive.js
//   Start in: C:\Users\Heath Shepard\Desktop\MeetDossie

const path = require('path');
const { runKeepalive } = require('./_lib/session-keepalive');

(async () => {
  const result = await runKeepalive({
    platform: 'twitter',
    urls: [
      'https://x.com/home',
      'https://x.com/notifications',
    ],
    // X/Twitter auth cookie is `auth_token` (httpOnly). The `ct0` CSRF token
    // is also good — either signals a live session.
    cookieName: 'auth_token',
    cookieDomain: 'x.com',
    renewalCommand: 'open Chrome → DossieBot profile → log into X (@meetdossie)',
    screenshotPath: path.join(__dirname, '.twitter-keepalive-last.png'),
  });

  if (!result.ok && result.alerted) process.exit(2);
  if (!result.ok) process.exit(1);
  process.exit(0);
})();
