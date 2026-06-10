'use strict';

// scripts/instagram-session-keepalive.js
//
// Keeps the DossieBot Chrome profile's Instagram session warm so the
// instagram-engager.js / unified-scanner pipelines never trip a logged-out
// state. Heath never gets pinged unless 3 consecutive runs come back logged
// out (and even then, the ping goes to Cole's chat if ATLAS_ALERT_CHAT_ID is
// set).
//
// Schedule via Windows Task Scheduler:
//   Name: Dossie IG Session Keepalive
//   Trigger: Every 3 days at 02:30 local
//   Program: node
//   Arguments: scripts/instagram-session-keepalive.js
//   Start in: C:\Users\Heath Shepard\Desktop\MeetDossie

const path = require('path');
const { runKeepalive } = require('./_lib/session-keepalive');

(async () => {
  const result = await runKeepalive({
    platform: 'instagram',
    // Touch the home feed + saved (an authenticated-only surface) so a stale
    // `sessionid` cookie either refreshes or fails fast.
    urls: [
      'https://www.instagram.com/',
      'https://www.instagram.com/accounts/edit/',
    ],
    cookieName: 'sessionid',
    cookieDomain: 'instagram.com',
    renewalCommand: 'open Chrome → DossieBot profile → log into Instagram (@meetdossie)',
    screenshotPath: path.join(__dirname, '.instagram-keepalive-last.png'),
  });

  if (!result.ok && result.alerted) process.exit(2);
  if (!result.ok) process.exit(1);
  process.exit(0);
})();
