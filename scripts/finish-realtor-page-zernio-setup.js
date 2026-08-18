'use strict';
// scripts/finish-realtor-page-zernio-setup.js
//
// Atlas, 2026-08-18 — REWRITTEN. Last night's version (2026-08-17) assumed
// Heath's personal realtor Facebook Page (facebook.com/HeathShepardRealtor)
// would need its own OAuth grant and its own distinct zernio_account_id.
// That assumption is wrong and no re-auth is needed:
//
// Heath confirmed live in Zernio's dashboard ("Switch Facebook page" panel)
// that BOTH Pages already sit under the ONE existing Facebook connection
// (zernio_account_id 69f253c3985e734bf3d8f9bc). Confirmed independently via
// GET /v1/accounts (api/debug-zernio-accounts.js): that account's
// metadata.availablePages lists both:
//   - MeetDossie                                 id 1066823756515739
//   - Heath Shepard, Realtor... (@HeathShepardRealtor)  id 102113502016276
//
// Per docs.zernio.com/platforms/facebook, the publish API lets ONE account
// object post to a SPECIFIC Page via platforms[].platformSpecificData.pageId
// — no second connected profile required. See
// supabase/migrations/20260818_zernio_accounts_page_id.sql /
// api/admin-migrate-zernio-page-id.js for the schema change (adds
// zernio_accounts.page_id) and api/cron-publish-approved.js's
// lookupZernioPageId() for where this gets read at publish time.
//
// This script now just auto-discovers the realtor Page's ID from the
// existing account's availablePages and upserts the zernio_accounts row —
// no manual --zernio-account-id needed, no OAuth click needed.
//
// Usage:
//   node scripts/finish-realtor-page-zernio-setup.js --discover
//     (dry run — lists the facebook account + its availablePages, writes nothing)
//   node scripts/finish-realtor-page-zernio-setup.js
//     (finds @HeathShepardRealtor in availablePages, upserts the
//      owner='heath-realtor' zernio_accounts row with the real page_id)

const path = require('path');
const fs = require('fs');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)="?(.*?)"?\r?$/);
  if (m && m[2] && m[2] !== '[SENSITIVE]') process.env[m[1]] = m[2]; // last non-placeholder wins
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    const m = a.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function getDeployUrl() {
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
  const handle = args.handle || 'HeathShepardRealtor';
  console.log(`[finish-realtor-page-zernio-setup] using base URL: ${baseUrl}`);

  console.log('[finish-realtor-page-zernio-setup] fetching live Zernio accounts...');
  const accounts = await fetchZernioAccounts(baseUrl);
  const fbAccounts = accounts.filter((a) => a.platform === 'facebook');
  console.log(`[finish-realtor-page-zernio-setup] found ${fbAccounts.length} facebook account object(s) on Zernio:`);
  for (const a of fbAccounts) {
    const pages = (a.metadata && a.metadata.availablePages) || [];
    console.log(`  _id=${a._id} selectedPage="${a.metadata && a.metadata.selectedPageName}" availablePages=[${pages.map((p) => `${p.name} (id=${p.id}${p.username ? `, @${p.username}` : ''})`).join(', ')}]`);
  }

  // Find the realtor Page by username first, fall back to name match.
  let found = null;
  let foundAccount = null;
  for (const a of fbAccounts) {
    const pages = (a.metadata && a.metadata.availablePages) || [];
    const match = pages.find(
      (p) => (p.username && p.username.toLowerCase() === handle.toLowerCase()) ||
             (p.name && p.name.toLowerCase().includes('heath shepard'))
    );
    if (match) { found = match; foundAccount = a; break; }
  }

  if (args.discover) {
    if (found) {
      console.log(`\n[discover mode] matched: name="${found.name}" page_id=${found.id} under zernio_account_id=${foundAccount._id}. Re-run without --discover to upsert.`);
    } else {
      console.log(`\n[discover mode] no Page matching handle="${handle}" found in any connected facebook account's availablePages. No writes made.`);
    }
    return;
  }

  if (!found) {
    console.error(`\nSTOP: no Page matching handle="${handle}" found in availablePages on any connected facebook account. Nothing to insert. Run with --discover to see what Zernio currently reports.`);
    process.exit(1);
  }

  console.log(`\n[finish-realtor-page-zernio-setup] upserting zernio_accounts row: platform=facebook owner=heath-realtor handle=@${handle} zernio_account_id=${foundAccount._id} page_id=${found.id}`);

  // Delete-then-insert instead of a real upsert — zernio_accounts has no
  // unique constraint PostgREST can target with on_conflict for (platform,
  // owner) beyond the partial index, so this stays simple and idempotent.
  await supabaseFetch(
    `/rest/v1/zernio_accounts?platform=eq.facebook&owner=eq.heath-realtor`,
    { method: 'DELETE' }
  );

  const insertRes = await supabaseFetch('/rest/v1/zernio_accounts', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      platform: 'facebook',
      account_handle: `@${handle}`,
      zernio_account_id: foundAccount._id,
      page_id: found.id,
      owner: 'heath-realtor',
      is_active: true,
    }),
  });

  if (!insertRes.ok) {
    console.error(`Insert failed (HTTP ${insertRes.status}): ${insertRes.raw.slice(0, 500)}`);
    console.error('If this mentions column "page_id" or "owner" does not exist, apply supabase/migrations/20260818_zernio_accounts_page_id.sql (and 20260817_zernio_accounts_owner.sql) first — or hit /api/admin-migrate-zernio-page-id with Bearer CRON_SECRET.');
    process.exit(1);
  }
  console.log('[finish-realtor-page-zernio-setup] insert OK:', JSON.stringify(insertRes.data));
  console.log('\nDone. Heath\'s realtor Page is now routable via zernio_accounts owner=heath-realtor, page_id=' + found.id + '. To publish to it, set social_posts.target_owner=\'heath-realtor\' on the row (see 20260817_social_posts_target_owner.sql). cron-publish-approved.js reads page_id automatically via lookupZernioPageId() and attaches it as platformSpecificData.pageId.');
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
