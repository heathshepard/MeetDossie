'use strict';

// scripts/setup-team-demo-org.js
//
// One-time (idempotent-ish) setup of a synthetic Team-tier demo org so
// /team-dashboard has real, non-empty data to record against. Every user,
// email, name, address and dollar figure here is fabricated — zero real
// customer data. Mirrors the existing demo@meetdossie.com / demo2@meetdossie.com
// convention (docs/DEMO-ACCOUNTS.md): synthetic auth users, profiles.is_demo=true.
//
// Creates:
//   - 3 synthetic auth users (1 team-lead admin + 2 agents)
//   - 1 organizations row (tier='team') via create_org_with_founder RPC
//   - 2 additional memberships via invite_member_with_roles RPC
//   - 5 synthetic transactions (dossiers) across the 3 members, varied
//     stage/status, including two with a real computed deadline flag
//     (past_option_expiration, past_loan_approval_deadline) so the dashboard
//     recording shows actual value, not an empty state.
//
// Usage: node scripts/setup-team-demo-org.js
//
// Prints the lead admin's email + password (also written to .env.local as
// DEMO_TEAM_PASSWORD) — needed by feature-demo-recorder.js to sign in.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(envPath)) return;
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
const SUPABASE_URL = (rawSupabaseUrl && rawSupabaseUrl !== '[SENSITIVE]')
  ? rawSupabaseUrl
  : process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Need SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY in .env.local.');
}

const headers = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

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
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    }),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  if (res.status === 422 && /already been registered/i.test(text)) {
    // Already exists — the admin API's ?email= query param is not honored as
    // a server-side filter, so page through and match client-side.
    let existing = null;
    for (let page = 1; page <= 5 && !existing; page++) {
      const list = await rest(`/auth/v1/admin/users?page=${page}&per_page=200`);
      existing = (list && list.users || []).find((u) => u.email === email) || null;
      if (!list || !list.users || list.users.length < 200) break;
    }
    if (!existing) throw new Error(`User ${email} reported as existing but not found by paging`);
    // Force the password to match THIS run's generated value — a prior run
    // may have crashed before persisting its password to .env.local, which
    // would otherwise leave the saved value out of sync with the real one.
    const resetRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${existing.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ password }),
    });
    if (!resetRes.ok) throw new Error(`password reset for ${email} -> ${resetRes.status}: ${await resetRes.text()}`);
    console.log(`[setup] auth user already exists: ${email} (${existing.id}) — password reset to current run value`);
    return existing;
  }
  if (!res.ok) throw new Error(`create user ${email} -> ${res.status}: ${text}`);
  console.log(`[setup] created auth user: ${email} (${json.id})`);
  return json;
}

async function upsertProfile(userId, email, fullName) {
  await rest('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({
      id: userId,
      email,
      full_name: fullName,
      is_demo: true,
      role: 'agent',
      onboarded: true,
      broker_address_state: 'TX',
    }),
  });
  console.log(`[setup] profile upserted (is_demo=true): ${email}`);
}

async function callRpc(fn, args) {
  return rest(`/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
}

function isoDaysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function isoDaysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function insertTransaction(row) {
  const inserted = await rest('/rest/v1/transactions', { method: 'POST', body: JSON.stringify(row) });
  console.log(`[setup] transaction: ${row.property_address} (${row.stage}) for user ${row.user_id}`);
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function main() {
  const password = crypto.randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) + 'Aa1!';

  // ── 1. Synthetic auth users ────────────────────────────────────────────────
  const lead = await createAuthUser('demo-team-lead@meetdossie.com', password, 'Dana Whitley');
  const agent1 = await createAuthUser('demo-team-agent1@meetdossie.com', password, 'Marcus Webb');
  const agent2 = await createAuthUser('demo-team-agent2@meetdossie.com', password, 'Priya Anand');

  await upsertProfile(lead.id, 'demo-team-lead@meetdossie.com', 'Dana Whitley');
  await upsertProfile(agent1.id, 'demo-team-agent1@meetdossie.com', 'Marcus Webb');
  await upsertProfile(agent2.id, 'demo-team-agent2@meetdossie.com', 'Priya Anand');

  // ── 2. Org (idempotent: skip creation if lead is already on an active org) ──
  let orgId;
  const existingMembership = await rest(
    `/rest/v1/organization_members?user_id=eq.${lead.id}&removed_at=is.null&select=org_id`,
  );
  if (existingMembership && existingMembership.length) {
    orgId = existingMembership[0].org_id;
    console.log(`[setup] lead already on org ${orgId} — reusing, skipping create_org_with_founder`);
  } else {
    orgId = await callRpc('create_org_with_founder', {
      p_name: 'Whitley Realty Team (DEMO)',
      p_tier: 'team',
      p_founder_user_id: lead.id,
      p_founder_roles: ['admin', 'agent'],
      p_seat_price_cents: 3500,
      p_parent_org_id: null,
      p_upgrade_from_solo: false,
      p_stripe_customer_id: null,
      p_acting_user_id: lead.id,
    });
    console.log(`[setup] created org: ${orgId}`);
  }

  // ── 3. Invite the two agents (idempotent — RPC reactivates existing rows) ──
  await callRpc('invite_member_with_roles', {
    p_org_id: orgId,
    p_invitee_user_id: agent1.id,
    p_roles: ['agent'],
    p_acting_user_id: lead.id,
  });
  console.log(`[setup] invited agent1 (Marcus Webb)`);

  await callRpc('invite_member_with_roles', {
    p_org_id: orgId,
    p_invitee_user_id: agent2.id,
    p_roles: ['agent'],
    p_acting_user_id: lead.id,
  });
  console.log(`[setup] invited agent2 (Priya Anand)`);

  // ── 4. Synthetic dossiers — skip if this org already has any ───────────────
  const existingTx = await rest(`/rest/v1/transactions?org_id=eq.${orgId}&select=id&limit=1`);
  if (existingTx && existingTx.length) {
    console.log(`[setup] org already has ${existingTx.length}+ transactions — skipping seed`);
  } else {
    const base = {
      dossier_number: '000',
      role: 'buyer',
      sale_price: 0,
      earnest_money: 0,
      option_fee: 0,
      option_days: 7,
      financing_days: 21,
      notes: '',
      parties: {},
      email_history: [],
      checklist: [],
      city_state_zip: 'San Antonio, TX',
      org_id: orgId,
    };

    // Dana (lead) — active under-contract deal, option period already blown
    // past (flag: past_option_expiration) — the "why pay for Team" moment.
    await insertTransaction({
      ...base,
      user_id: lead.id,
      dossier_number: 'DEMO-01',
      status: 'active',
      stage: 'under-contract',
      transaction_type: 'residential_purchase_buyer',
      property_address: '482 Ridgeline Court',
      buyer_name: 'Tom & Renee Castellano',
      seller_name: 'Whitfield Family Trust',
      sale_price: 465000,
      earnest_money: 5000,
      option_fee: 250,
      contract_effective_date: isoDaysAgo(25),
      option_expiration_date: isoDaysAgo(3),
      closing_date: isoDaysFromNow(20),
    });

    // Marcus — closed deal (no active flags — status closed skips flag checks)
    await insertTransaction({
      ...base,
      user_id: agent1.id,
      dossier_number: 'DEMO-02',
      status: 'closed',
      stage: 'closed',
      transaction_type: 'residential_purchase_buyer',
      property_address: '119 Cedar Bend',
      buyer_name: 'Alicia Fenwick',
      seller_name: 'Robert Duarte',
      sale_price: 312000,
      contract_effective_date: isoDaysAgo(60),
      closing_date: isoDaysAgo(10),
    });

    // Marcus — early-stage listing, no deadlines yet
    await insertTransaction({
      ...base,
      user_id: agent1.id,
      dossier_number: 'DEMO-03',
      status: 'active',
      stage: 'active-listing',
      role: 'listing',
      transaction_type: 'residential_listing_seller',
      property_address: '77 Preston Hollow',
      seller_name: 'Marcus Webb Client — Ines Ohara',
      sale_price: 389000,
      contract_effective_date: isoDaysAgo(4),
    });

    // Priya — under contract, financing deadline already blown
    // (flag: past_loan_approval_deadline)
    await insertTransaction({
      ...base,
      user_id: agent2.id,
      dossier_number: 'DEMO-04',
      status: 'active',
      stage: 'under-contract',
      transaction_type: 'residential_purchase_buyer',
      property_address: '930 Alamo Heights Blvd',
      buyer_name: 'Wei & Grace Tanaka',
      seller_name: 'Callahan Family',
      sale_price: 587500,
      earnest_money: 7500,
      option_fee: 300,
      contract_effective_date: isoDaysAgo(30),
      option_expiration_date: isoDaysAgo(23),
      loan_approval_deadline: isoDaysAgo(2),
      closing_date: isoDaysFromNow(15),
    });

    // Priya — early pre-contract, no dates yet
    await insertTransaction({
      ...base,
      user_id: agent2.id,
      dossier_number: 'DEMO-05',
      status: 'active',
      stage: 'pre-contract',
      transaction_type: 'residential_purchase_buyer',
      property_address: '56 Vineyard Trail',
      buyer_name: 'Priya Anand Client — Sam Okoro',
      contract_effective_date: isoDaysAgo(1),
    });
  }

  // ── 5. Persist password locally + report ────────────────────────────────────
  // Always overwrite: the auth-user branch above resets the real account
  // password to THIS run's value every time, so the saved value must track
  // it exactly rather than being written once and potentially going stale.
  const envPath = path.join(__dirname, '..', '.env.local');
  const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const line = `DEMO_TEAM_PASSWORD="${password}"`;
  const newContent = /^DEMO_TEAM_PASSWORD=.*$/m.test(envContent)
    ? envContent.replace(/^DEMO_TEAM_PASSWORD=.*$/m, line)
    : `${envContent}\n${line}\n`;
  fs.writeFileSync(envPath, newContent);
  console.log('[setup] DEMO_TEAM_PASSWORD written to .env.local — push to Vercel: vercel env rm DEMO_TEAM_PASSWORD && vercel env add DEMO_TEAM_PASSWORD');

  console.log('\n[setup] DONE');
  console.log(`  org_id=${orgId}`);
  console.log(`  lead login: demo-team-lead@meetdossie.com / (DEMO_TEAM_PASSWORD in .env.local)`);
}

main().catch((err) => {
  console.error('[setup] FATAL:', err.message);
  process.exit(1);
});
