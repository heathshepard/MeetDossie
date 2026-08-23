'use strict';

// scripts/carter-team-sales-demo-seed2.js
//
// Pre-seed step for the EXPANDED (2026-08-23, round 2) team sales-demo video.
// Creates one throwaway auth user + profile — demo-team-tc@meetdossie.com —
// WITHOUT attaching org membership. Membership is added live, on camera, via
// the real "+ Add team member" form (TC role only), so the recording shows
// a genuine invite + genuine TC-only role grant, not a pre-faked state.
//
// Pre-creating (rather than letting invite.js's inviteUserByEmail branch
// create it) avoids a real outbound Resend send to a non-existent mailbox
// and any invited-but-unconfirmed edge cases — invite.js's existing-user
// branch (auth.admin.getUserByEmail) finds this user and attaches
// membership directly, no email round-trip needed.
//
// Idempotent: safe to re-run.
//
// Usage: node scripts/carter-team-sales-demo-seed2.js

const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const rawSupabaseUrl = process.env.SUPABASE_URL;
const SUPABASE_URL = (rawSupabaseUrl && rawSupabaseUrl !== '[SENSITIVE]') ? rawSupabaseUrl : process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env.local.');

const headers = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };

async function rest(pathAndQuery, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}${pathAndQuery}`, {
    ...opts,
    headers: { ...headers, ...(opts.headers || {}), Prefer: opts.prefer || 'return=representation' },
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error(`${pathAndQuery} -> ${res.status}: ${text}`);
  return json;
}

async function createAuthUser(email, password, fullName) {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { full_name: fullName } }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (res.status === 422 && /already been registered/i.test(text)) {
    let existing = null;
    for (let page = 1; page <= 5 && !existing; page++) {
      const list = await rest(`/auth/v1/admin/users?page=${page}&per_page=200`);
      existing = (list && list.users || []).find((u) => u.email === email) || null;
      if (!list || !list.users || list.users.length < 200) break;
    }
    if (!existing) throw new Error(`User ${email} reported existing but not found by paging`);
    console.log(`[seed2] auth user already exists: ${email} (${existing.id})`);
    return existing;
  }
  if (!res.ok) throw new Error(`create user ${email} -> ${res.status}: ${text}`);
  console.log(`[seed2] created auth user: ${email} (${json.id})`);
  return json;
}

async function upsertProfile(userId, email, fullName) {
  await rest('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({ id: userId, email, full_name: fullName, is_demo: true, role: 'agent', onboarded: true, broker_address_state: 'TX' }),
  });
  console.log(`[seed2] profile upserted (is_demo=true): ${email}`);
}

async function main() {
  const password = require('crypto').randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) + 'Aa1!';
  const tc = await createAuthUser('demo-team-tc@meetdossie.com', password, 'Casey Nolan');
  await upsertProfile(tc.id, 'demo-team-tc@meetdossie.com', 'Casey Nolan');
  console.log(`\n[seed2] DONE — demo-team-tc@meetdossie.com (Casey Nolan), user_id=${tc.id}`);
  console.log('  NOT yet a member of any org — add live via the Team Dashboard "+ Add team member" form (TC role only).');
}

main().catch((err) => {
  console.error('[seed2] FATAL:', err.message);
  process.exit(1);
});
