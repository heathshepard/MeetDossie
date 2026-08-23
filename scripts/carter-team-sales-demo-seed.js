'use strict';

// scripts/carter-team-sales-demo-seed.js
//
// Extends the existing "Whitley Realty Team (DEMO)" org (built 2026-08-17 by
// scripts/setup-team-demo-org.js) for the Brittney/Natalie sales demo video:
//   - Adds a 3rd synthetic agent (the brief asks for 3 fictional agents under
//     the lead; the existing org only had 2).
//   - Adds documents + action_items rows so the new admin drill-down
//     (/api/team/org-dossier-detail, TeamView.jsx click-to-expand) has real
//     data to show — the 2026-08-17 seed only ever wrote transaction rows.
//   - Assigns the three named demo states from Heath's brief to distinct
//     agents so each is unambiguous on camera:
//       Marcus Webb (agent1)  -> nearing closing, most items done
//       Priya Anand (agent2)  -> mid-contract, missing/flagged disclosure
//       [new] agent3          -> overdue action item
//
// Idempotent: every insert is preceded by an existence check keyed on
// dossier_number / a stable marker, so re-running after a partial failure
// does not create duplicates.
//
// Usage: node scripts/carter-team-sales-demo-seed.js

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
    console.log(`[seed] auth user already exists: ${email} (${existing.id})`);
    return existing;
  }
  if (!res.ok) throw new Error(`create user ${email} -> ${res.status}: ${text}`);
  console.log(`[seed] created auth user: ${email} (${json.id})`);
  return json;
}

async function upsertProfile(userId, email, fullName) {
  await rest('/rest/v1/profiles?on_conflict=id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body: JSON.stringify({ id: userId, email, full_name: fullName, is_demo: true, role: 'agent', onboarded: true, broker_address_state: 'TX' }),
  });
  console.log(`[seed] profile upserted (is_demo=true): ${email}`);
}

async function findTxByDossierNumber(orgId, dossierNumber) {
  const rows = await rest(`/rest/v1/transactions?org_id=eq.${orgId}&dossier_number=eq.${dossierNumber}&select=id`);
  return rows && rows[0] ? rows[0].id : null;
}

async function insertTransaction(row) {
  const existing = await findTxByDossierNumber(row.org_id, row.dossier_number);
  if (existing) {
    console.log(`[seed] transaction ${row.dossier_number} already exists (${existing}) — reusing`);
    return existing;
  }
  const inserted = await rest('/rest/v1/transactions', { method: 'POST', body: JSON.stringify(row) });
  const tx = Array.isArray(inserted) ? inserted[0] : inserted;
  console.log(`[seed] transaction: ${row.property_address} (${row.stage}) for user ${row.user_id} -> ${tx.id}`);
  return tx.id;
}

async function ensureDocuments(transactionId, userId, docs) {
  const existing = await rest(`/rest/v1/documents?transaction_id=eq.${transactionId}&select=document_type`);
  const have = new Set((existing || []).map((d) => d.document_type));
  for (const doc of docs) {
    if (have.has(doc.document_type)) { console.log(`  [doc] ${doc.document_type} already present — skip`); continue; }
    await rest('/rest/v1/documents', {
      method: 'POST',
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        file_name: doc.file_name,
        file_type: 'application/pdf',
        document_type: doc.document_type,
        storage_path: `${userId}/${transactionId}/${doc.file_name}`,
        file_size: 128000,
        status: doc.status || 'filled',
      }),
    });
    console.log(`  [doc] inserted ${doc.document_type} (${doc.status || 'filled'})`);
  }
}

async function ensureActionItems(transactionId, userId, items) {
  const existing = await rest(`/rest/v1/action_items?transaction_id=eq.${transactionId}&select=description`);
  const have = new Set((existing || []).map((a) => a.description));
  for (const item of items) {
    if (have.has(item.description)) { console.log(`  [action] "${item.description}" already present — skip`); continue; }
    await rest('/rest/v1/action_items', {
      method: 'POST',
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        action_type: item.action_type || 'general',
        description: item.description,
        status: item.status || 'pending',
        due_date: item.due_date || null,
        completed_at: item.status === 'completed' ? (item.completed_at || new Date().toISOString()) : null,
      }),
    });
    console.log(`  [action] inserted "${item.description}" (${item.status || 'pending'})`);
  }
}

async function main() {
  // ── 0. Locate the existing demo org + its two agents ──────────────────────
  const orgs = await rest(`/rest/v1/organizations?name=eq.${encodeURIComponent('Whitley Realty Team (DEMO)')}&select=id`);
  if (!orgs || !orgs.length) throw new Error('Whitley Realty Team (DEMO) org not found — run scripts/setup-team-demo-org.js first.');
  const orgId = orgs[0].id;
  console.log(`[seed] org_id=${orgId}`);

  const lead = await rest(`/rest/v1/organization_members_with_roles?org_id=eq.${orgId}&select=user_id,roles`);
  const leadRow = lead.find((m) => (m.roles || []).includes('admin'));
  if (!leadRow) throw new Error('No admin member found on the demo org.');

  const marcus = (await rest(`/rest/v1/profiles?email=eq.demo-team-agent1@meetdossie.com&select=id`))[0];
  const priya = (await rest(`/rest/v1/profiles?email=eq.demo-team-agent2@meetdossie.com&select=id`))[0];
  if (!marcus || !priya) throw new Error('agent1/agent2 profiles not found — run scripts/setup-team-demo-org.js first.');

  // ── 1. Third agent ──────────────────────────────────────────────────────
  const password = require('crypto').randomBytes(12).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 16) + 'Aa1!';
  const agent3 = await createAuthUser('demo-team-agent3@meetdossie.com', password, 'Jordan Reyes');
  await upsertProfile(agent3.id, 'demo-team-agent3@meetdossie.com', 'Jordan Reyes');
  await callRpc('invite_member_with_roles', {
    p_org_id: orgId,
    p_invitee_user_id: agent3.id,
    p_roles: ['agent'],
    p_acting_user_id: leadRow.user_id,
  });
  console.log('[seed] invited agent3 (Jordan Reyes)');

  const base = {
    role: 'buyer', sale_price: 0, earnest_money: 0, option_fee: 0, option_days: 7, financing_days: 21,
    notes: '', parties: {}, email_history: [], checklist: [], city_state_zip: 'San Antonio, TX', org_id: orgId,
  };

  // ── 2. Marcus Webb — "nearing closing, most items done" ────────────────
  const marcusTxId = await insertTransaction({
    ...base,
    user_id: marcus.id,
    dossier_number: 'DEMO-06',
    status: 'active',
    stage: 'clear-to-close',
    transaction_type: 'residential_purchase_buyer',
    property_address: '214 Copperfield Way',
    buyer_name: 'Devon & Kayla Ruiz',
    seller_name: 'Whitmore Estate',
    sale_price: 428000,
    earnest_money: 6000,
    option_fee: 250,
    contract_effective_date: isoDaysAgo(35),
    option_expiration_date: isoDaysAgo(20),
    loan_approval_deadline: isoDaysAgo(10),
    closing_date: isoDaysFromNow(4),
  });
  await ensureDocuments(marcusTxId, marcus.id, [
    { document_type: 'sellers_disclosure', file_name: 'sellers-disclosure.pdf', status: 'filled' },
    { document_type: 'title_commitment', file_name: 'title-commitment.pdf', status: 'filled' },
    { document_type: 'survey', file_name: 'survey.pdf', status: 'filled' },
    { document_type: 'closing_disclosure', file_name: 'closing-disclosure.pdf', status: 'filled' },
  ]);
  await ensureActionItems(marcusTxId, marcus.id, [
    { description: 'Confirm wire instructions with title company', action_type: 'closing', status: 'completed', due_date: isoDaysAgo(6) },
    { description: 'Schedule final walkthrough', action_type: 'closing', status: 'completed', due_date: isoDaysAgo(2) },
    { description: 'Send closing day confirmation to buyer', action_type: 'closing', status: 'pending', due_date: isoDaysFromNow(3) },
  ]);

  // ── 3. Priya Anand — "mid-contract, missing/flagged disclosure" ────────
  // Reuses the existing DEMO-04 transaction (930 Alamo Heights Blvd,
  // under-contract, loan_approval_deadline already past) from the
  // 2026-08-17 seed — adding the documents/action_items it never had.
  const priyaTxId = await findTxByDossierNumber(orgId, 'DEMO-04');
  if (!priyaTxId) throw new Error('DEMO-04 (Priya) not found — run scripts/setup-team-demo-org.js first.');
  await ensureDocuments(priyaTxId, priya.id, [
    { document_type: 'option_agreement', file_name: 'option-agreement.pdf', status: 'filled' },
    { document_type: 'title_commitment', file_name: 'title-commitment.pdf', status: 'filled' },
    // sellers_disclosure intentionally NOT inserted — this is the missing/flagged doc.
  ]);
  await ensureActionItems(priyaTxId, priya.id, [
    { description: "Request Seller's Disclosure Notice from listing agent", action_type: 'disclosure', status: 'pending', due_date: isoDaysAgo(3) },
    { description: 'Order survey', action_type: 'title', status: 'completed', due_date: isoDaysAgo(15) },
  ]);

  // ── 4. Jordan Reyes (agent3) — "overdue action item" ────────────────────
  const jordanTxId = await insertTransaction({
    ...base,
    user_id: agent3.id,
    dossier_number: 'DEMO-07',
    status: 'active',
    stage: 'inspection',
    transaction_type: 'residential_purchase_buyer',
    property_address: '3021 Canyon Ridge Dr',
    buyer_name: 'Holt Family',
    seller_name: 'Nguyen Trust',
    sale_price: 512000,
    earnest_money: 6500,
    option_fee: 275,
    contract_effective_date: isoDaysAgo(18),
    option_expiration_date: isoDaysFromNow(2),
    closing_date: isoDaysFromNow(35),
  });
  await ensureDocuments(jordanTxId, agent3.id, [
    { document_type: 'sellers_disclosure', file_name: 'sellers-disclosure.pdf', status: 'filled' },
    { document_type: 'inspection_report', file_name: 'inspection-report.pdf', status: 'filled' },
  ]);
  await ensureActionItems(jordanTxId, agent3.id, [
    { description: "Submit repair amendment to seller's agent", action_type: 'repairs', status: 'pending', due_date: isoDaysAgo(4) },
    { description: 'Schedule re-inspection', action_type: 'repairs', status: 'pending', due_date: isoDaysFromNow(5) },
  ]);

  await insertTransaction({
    ...base,
    user_id: agent3.id,
    dossier_number: 'DEMO-08',
    status: 'active',
    stage: 'pre-contract',
    transaction_type: 'residential_purchase_buyer',
    property_address: '88 Meadowlark Lane',
    buyer_name: 'Jordan Reyes Client — Elena Cho',
    contract_effective_date: isoDaysAgo(2),
  });

  console.log('\n[seed] DONE');
  console.log(`  org_id=${orgId}`);
  console.log('  agents: demo-team-agent1@meetdossie.com (Marcus), demo-team-agent2@meetdossie.com (Priya), demo-team-agent3@meetdossie.com (Jordan)');
  console.log(`  marcus tx (nearing closing)=${marcusTxId}`);
  console.log(`  priya tx (missing disclosure)=${priyaTxId}`);
  console.log(`  jordan tx (overdue action item)=${jordanTxId}`);
}

main().catch((err) => {
  console.error('[seed] FATAL:', err.message);
  process.exit(1);
});
