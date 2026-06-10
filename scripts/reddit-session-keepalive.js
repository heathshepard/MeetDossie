'use strict';

// scripts/reddit-session-keepalive.js
//
// Keeps the DossieBot Chrome profile's Reddit session warm. Reddit's
// `reddit_session` cookie lasts about 1 year, but the `token_v2` web JWT
// expires inside hours — visiting the home feed via the persistent profile
// refreshes both.
//
// Schedule via Windows Task Scheduler:
//   Name: Dossie Reddit Session Keepalive
//   Trigger: Every 3 days at 02:50 local
//   Program: node
//   Arguments: scripts/reddit-session-keepalive.js
//   Start in: C:\Users\Heath Shepard\Desktop\MeetDossie
//
// Reddit-specific notes:
//   - We use the DossieBot Chrome profile to match what fb/ig/li engagers
//     already do. The legacy `scripts/sessions/reddit.json` cookie file is
//     deprecated — see the migration shim in reddit-fetch-new.js.
//   - Reddit is bot-suspicious. If the account `Icy_Response3978` keeps
//     getting flagged (challenge / suspended / shadowbanned), the right
//     answer is OAuth via a dedicated `DossieBotApp` account. See
//     `Shepard-Ventures/Engineering/INDEX.md` SV-REDDIT-001 for context.

const path = require('path');
const { runKeepalive } = require('./_lib/session-keepalive');

(async () => {
  const result = await runKeepalive({
    platform: 'reddit',
    urls: [
      'https://www.reddit.com/',
      'https://www.reddit.com/r/realtors/new/',
    ],
    // `reddit_session` is the long-lived auth cookie. `token_v2` is the
    // short-lived bearer — either one being present means we're logged in.
    cookieName: 'reddit_session',
    cookieDomain: 'reddit.com',
    renewalCommand: 'open Chrome → DossieBot profile → log into Reddit (Icy_Response3978)',
    screenshotPath: path.join(__dirname, '.reddit-keepalive-last.png'),
  });

  if (!result.ok && result.alerted) process.exit(2);
  if (!result.ok) process.exit(1);
  process.exit(0);
})();
