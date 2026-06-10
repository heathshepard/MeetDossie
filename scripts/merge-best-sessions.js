'use strict';

// scripts/merge-best-sessions.js
//
// Walks scripts/sessions/*-<platform>.json (namespaced files from
// extract-cookies-from-profile.js) and for each platform picks the file
// containing the strongest authentication signal, then writes it as
// scripts/sessions/<platform>.json.
//
// Auth signal heuristic: each platform has a list of required cookies that
// only exist after a real login. A file scores by how many required cookies
// it has set with non-empty values. Highest score wins.

const fs = require('fs');
const path = require('path');

const SESSIONS_DIR = path.join(__dirname, 'sessions');

// Auth-required cookies per platform. These exist only after real login.
const AUTH_COOKIES = {
  reddit:    ['reddit_session', 'loid', 'token_v2', 'session_tracker'],
  twitter:   ['auth_token', 'ct0', 'twid', 'kdt'],
  instagram: ['sessionid', 'ds_user_id'],
  linkedin:  ['li_at', 'liap', 'JSESSIONID'],
  facebook:  ['c_user', 'xs'],
  gmail:     ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', '__Secure-3PSID'],
};

function scoreFile(filePath, platform) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const required = AUTH_COOKIES[platform] || [];
    let score = 0;
    const present = [];
    for (const cookieName of required) {
      const found = state.cookies.find(c =>
        c.name === cookieName && c.value && c.value.length > 5
      );
      if (found) {
        score++;
        present.push(cookieName);
      }
    }
    return { score, present, total: state.cookies.length };
  } catch (e) {
    return { score: -1, present: [], total: 0, error: e.message };
  }
}

function main() {
  const platforms = Object.keys(AUTH_COOKIES);
  const allFiles = fs.readdirSync(SESSIONS_DIR);

  console.log('[merge] Scanning namespaced session files...\n');

  const results = {};

  for (const platform of platforms) {
    const candidates = allFiles
      .filter(f => f.endsWith(`-${platform}.json`))
      .map(f => path.join(SESSIONS_DIR, f));

    if (candidates.length === 0) {
      console.log(`[merge] ${platform}: no namespaced candidates found, skipping`);
      results[platform] = { winner: null, score: 0 };
      continue;
    }

    let best = null;
    let bestScore = -1;

    console.log(`[merge] ${platform}:`);
    for (const candidate of candidates) {
      const result = scoreFile(candidate, platform);
      const baseName = path.basename(candidate);
      console.log(`  ${baseName}: score=${result.score}/${AUTH_COOKIES[platform].length} (auth cookies: ${result.present.join(', ') || 'NONE'})`);
      if (result.score > bestScore) {
        bestScore = result.score;
        best = candidate;
      }
    }

    if (best && bestScore > 0) {
      const finalPath = path.join(SESSIONS_DIR, `${platform}.json`);
      fs.copyFileSync(best, finalPath);
      console.log(`  WINNER: ${path.basename(best)} (score=${bestScore}) -> ${platform}.json\n`);
      results[platform] = { winner: path.basename(best), score: bestScore };
    } else {
      console.log(`  NO LOGIN DETECTED — leaving ${platform}.json untouched\n`);
      results[platform] = { winner: null, score: 0 };
    }
  }

  console.log('\n[merge] Summary:');
  let authenticated = 0;
  for (const [platform, info] of Object.entries(results)) {
    const max = AUTH_COOKIES[platform].length;
    if (info.winner) {
      console.log(`  ${platform}: ${info.score}/${max} auth cookies from ${info.winner}`);
      if (info.score > 0) authenticated++;
    } else {
      console.log(`  ${platform}: NOT LOGGED IN in any profile`);
    }
  }
  console.log(`\n[merge] ${authenticated}/${platforms.length} platforms authenticated.`);
}

main();
