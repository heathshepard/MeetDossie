'use strict';
// scripts/finish-realtor-page-zernio-setup.js
//
// Atlas, 2026-08-17 — the 30-second finish for connecting Heath's personal
// realtor Facebook Page (facebook.com/HeathShepardRealtor) to Zernio, once
// Heath has done the one human-only step: the manual OAuth re-auth click on
// Zernio's dashboard granting access to that Page. Do NOT attempt to script
// around that click — it's an OAuth consent grant, genuinely human-only.
//
// What this does, once the real zernio_account_id exists:
//   1. Calls /api/debug-zernio-accounts (read-only, hits Zernio's own API —
//      not our DB) to find the realtor Page's connected-account entry.
//   2. Inserts the matching row into zernio_accounts with
//      owner='heath-realtor' (see 20260817_zernio_accounts_owner.sql —
//      apply that migration BEFORE running this script, or the insert 400s
//      on the missing `owner` column).
//   3. Re-verifies via the same debug endpoint that the inserted
//      zernio_account_id is reachable and enabled.
//
// IMPORTANT — read this before running: as of 2026-08-17, Zernio's facebook
// account object for @meetdossie (_id 69f253c3985e734bf3d8f9bc) carries a
// SINGLE `selectedPageId`/`selectedPageName` plus a `metadata.availablePages`
// list of every Page the underlying Facebook user token can see. It is NOT
// yet confirmed whether tomorrow's re-auth will:
//   (a) create a BRAND NEW account object (new _id) for the realtor Page —
//       the easy case, just paste that _id as --zernio-account-id, or
//   (b) only add the realtor Page into the EXISTING @meetdossie account's
//       availablePages, with selectedPageId still pointed at MeetDossie —
//       in which case there is no second postable destination yet, and
//       Zernio may require a second connected profile (see the
//       `profileId`/"Default profile" field in the debug output) rather
//       than a second OAuth grant on the same account. If auto-discovery
//       below finds ONLY the existing 69f253c3985e734bf3d8f9bc id with the
//       realtor Page merely listed in availablePages, STOP and flag this to
//       Heath before inserting — inserting that same id under
//       owner='heath-realtor' would silently make both owners post through
//       the one Page currently selected (MeetDossie), not two destinations.
//
// Usage:
//   node scripts/finish-realtor-page-zernio-setup.js --discover
//     (dry run — lists every facebook account Zernio currently sees, does
//      not write anything; run this first)
//   node scripts/finish-realtor-page-zernio-setup.js --zernio-account-id=<id> --handle=HeathShepardRealtor
//     (inserts the row, then verifies)

const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && m[2] && m[2] !== '[SENSITIVE]') process.env[m[1]] = m[2]; // last non-placeholder wins
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const EXISTING_MEETDOSSIE_FB_ID = '69f253c3985e734bf3d8f9bc';

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function getDeployUrl() {
  // Prefer an explicit override; otherwise this only works once the code is
  // live somewhere. Staging preview URLs rotate — pass --base-url if the
  // default (production, once this branch is merged) isn't right yet.
  return process.env.FINISH_SCRIPT_BASE_URL || 'https://meetdossie.com';
}

async function fetchZernioAccounts(baseUrl) {
  const r = await fetch(`${baseUrl}/api/debug-zernio-accounts`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  const text = await r.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* leave null */ }
  if (!r.ok || !data || !data.ok) {
    throw new Error(`debug-zernio-accounts failed: HTTP ${r.status} — ${text.slice(0, 300)}`);
  }
  return data.data && Array.isArray(data.data.accounts) ? data.data.accounts : [];
}

async function supabaseFetch(path_, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path_}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function main() {
  const args = parseArgs();
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !CRON_SECRET) {
    console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / CRON_SECRET — check .env.local.');
    process.exit(1);
  }

  const baseUrl = args['base-url'] || (await getDeployUrl());
  console.log(`[finish-realtor-page-zernio-setup] using base URL: ${baseUrl}`);

  console.log('[finish-realtor-page-zernio-setup] fetching live Zernio accounts...');
  const accounts = await fetchZernioAccounts(baseUrl);
  const fbAccounts = accounts.filter((a) => a.platform === 'facebook');
  console.log(`[finish-realtor-page-zernio-setup] found ${fbAccounts.length} facebook account object(s) on Zernio:`);
  for (const a of fbAccounts) {
    const selectedName = a.metadata && a.metadata.selectedPageName;
    const pages = (a.metadata && a.metadata.availablePages) || [];
    console.log(`  _id=${a._id} selectedPage="${selectedName}" availablePages=[${pages.map((p) => p.name).join(', ')}]`);
  }

  if (args.discover) {
    console.log('\n[discover mode] no writes made. Re-run with --zernio-account-id=<id> --handle=<name> once you know which id/page is the realtor Page.');
    return;
  }

  const newId = args['zernio-account-id'];
  if (!newId) {
    console.error('Missing --zernio-account-id. Run with --discover first to see what Zernio currently reports.');
    process.exit(1);
  }

  if (newId === EXISTING_MEETDOSSIE_FB_ID) {
    console.error(`\nSTOP: ${newId} is the EXISTING @meetdossie facebook account id. If the realtor Page only shows up in that account's availablePages (not as its own _id), this OAuth grant did not create a second postable destination — see the header comment in this file. Do not insert this id under owner='heath-realtor'; it would just repoint/share MeetDossie's account. Flag to Heath before proceeding.`);
    process.exit(1);
  }

  const matched = fbAccounts.find((a) => a._id === newId);
  if (!matched) {
    console.error(`\nWARNING: ${newId} was not found among the facebook accounts Zernio currently reports. Double-check the id before inserting (see the --discover list above).`);
    process.exit(1);
  }

  const handle = args.handle || (matched.metadata && matched.metadata.selectedPageName) || 'HeathShepardRealtor';
  console.log(`\n[finish-realtor-page-zernio-setup] inserting zernio_accounts row: platform=facebook owner=heath-realtor handle=${handle} zernio_account_id=${newId}`);

  const insertRes = await supabaseFetch('/rest/v1/zernio_accounts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      platform: 'facebook',
      account_handle: handle,
      zernio_account_id: newId,
      owner: 'heath-realtor',
      is_active: true,
    }),
  });

  if (!insertRes.ok) {
    console.error(`Insert failed (HTTP ${insertRes.status}): ${insertRes.raw.slice(0, 500)}`);
    console.error('If this mentions column "owner" does not exist, apply supabase/migrations/20260817_zernio_accounts_owner.sql first.');
    process.exit(1);
  }
  console.log('[finish-realtor-page-zernio-setup] insert OK:', JSON.stringify(insertRes.data));

  console.log('\n[finish-realtor-page-zernio-setup] re-verifying reachability via debug-zernio-accounts...');
  const verifyAccounts = await fetchZernioAccounts(baseUrl);
  const stillThere = verifyAccounts.find((a) => a._id === newId);
  if (!stillThere) {
    console.error(`WARNING: ${newId} no longer/never appeared in Zernio's live account list on re-check. Row was inserted into our DB but Zernio itself does not confirm it.`);
    process.exit(1);
  }
  console.log(`CONFIRMED reachable: platformStatus=${stillThere.platformStatus} enabled=${stillThere.enabled} selectedPage="${stillThere.metadata && stillThere.metadata.selectedPageName}"`);
  console.log('\nDone. Heath\'s realtor Page is now routable via zernio_accounts owner=heath-realtor. To publish to it, set social_posts.target_owner=\'heath-realtor\' on the row (see 20260817_social_posts_target_owner.sql).');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
