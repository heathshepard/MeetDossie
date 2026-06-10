#!/usr/bin/env node
/**
 * open-fb-group.js — open a Facebook group URL in DossieBot Chrome (or
 * Heath's main Chrome if DossieBot isn't usable).
 *
 * Usage:
 *   node scripts/open-fb-group.js <name-or-fragment>
 *
 * Examples:
 *   node scripts/open-fb-group.js dallas
 *   node scripts/open-fb-group.js "hill country"
 *   node scripts/open-fb-group.js ginger
 *
 * Logic:
 *   1. Pull fb_groups rows from Supabase, fuzzy-match against the argument.
 *   2. If 1 match  → open it.
 *      If 0 match  → list nearby names and exit.
 *      If >1 match → list all matches and exit; user retypes more specifically.
 *   3. Try DossieBot-Sage profile dir first (canonical Sage Chrome).
 *      Fall back to Heath's main Chrome with --new-window if the DossieBot
 *      dir is missing or unusable.
 *
 * No browser launch happens until we have a single, confirmed URL.
 *
 * Required env (read from .env.local):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// -------- env loader (minimal, mirrors other scripts) --------
function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    const [, k, v] = m;
    let val = v.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = val;
  }
}
loadDotEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERR: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required (check .env.local).');
  process.exit(2);
}

const arg = process.argv.slice(2).join(' ').trim().toLowerCase();
if (!arg) {
  console.error('Usage: node scripts/open-fb-group.js <name-or-fragment>');
  process.exit(2);
}

// -------- main --------
(async function main() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/fb_groups?select=group_url,group_name,posting_status,member_status&limit=500`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  if (!res.ok) {
    console.error('ERR: Supabase fetch failed', res.status, await res.text().catch(() => ''));
    process.exit(3);
  }
  const groups = await res.json();

  const matches = groups.filter(g => (g.group_name || '').toLowerCase().includes(arg));

  if (matches.length === 0) {
    console.error(`No match for "${arg}". Try one of:`);
    groups.slice(0, 20).forEach(g => console.error(`  - ${g.group_name}`));
    process.exit(4);
  }
  if (matches.length > 1) {
    console.error(`Multiple matches for "${arg}":`);
    matches.forEach(g => console.error(`  - ${g.group_name}`));
    console.error('\nRetype with a more specific fragment.');
    process.exit(5);
  }

  const { group_url, group_name, posting_status, member_status } = matches[0];
  console.log(`Opening: ${group_name}`);
  console.log(`  URL:      ${group_url}`);
  console.log(`  Posting:  ${posting_status}`);
  console.log(`  Member:   ${member_status}`);

  openInChrome(group_url);
})().catch(e => {
  console.error('ERR:', e);
  process.exit(1);
});

// -------- chrome launcher --------
function openInChrome(url) {
  const HOME = process.env.USERPROFILE || process.env.HOME || '';
  const DOSSIEBOT_DIR = path.join(HOME, 'AppData', 'Local', 'DossieBot-Sage');
  const MAIN_DIR     = path.join(HOME, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');

  const CANDIDATES = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ];
  let chrome = CANDIDATES.find(p => fs.existsSync(p));
  if (!chrome) {
    console.error('ERR: chrome.exe not found in standard install paths.');
    process.exit(6);
  }

  // Prefer DossieBot profile if it exists.
  const profileDir = fs.existsSync(DOSSIEBOT_DIR) ? DOSSIEBOT_DIR : MAIN_DIR;
  const usingDossiebot = profileDir === DOSSIEBOT_DIR;

  if (usingDossiebot) {
    console.log(`  Profile:  DossieBot-Sage`);
    // DossieBot dir is dedicated — safe to use --user-data-dir + --profile-directory
    spawn(chrome, [
      `--user-data-dir=${DOSSIEBOT_DIR}`,
      '--profile-directory=Default',
      '--new-window',
      url,
    ], { detached: true, stdio: 'ignore' }).unref();
  } else {
    console.log(`  Profile:  Heath's main Chrome (DossieBot dir not found)`);
    // For main Chrome, do NOT pass --user-data-dir — that would clone the
    // profile. Just open a new window via the running instance.
    spawn(chrome, ['--new-window', url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }

  console.log('Launched.');
}
