#!/usr/bin/env node
'use strict';

// scripts/backfill-docuseal-completions.js
// =============================================================================
// C1 (docs/BACKLOG-ENGINEERING.md) — reconcile DocuSeal completions the product
// never saw.
//
// WHY THIS EXISTS AND WHY IT IS NOT A SECOND MECHANISM
// ----------------------------------------------------
// api/esign-webhook.js is the completion mechanism and it works — it is live
// and demonstrably processing events. But it is FIRE-AND-FORGET: DocuSeal posts
// an event once, the webhook looks the submission up by docuseal_submission_id,
// and if no row exists it answers "submission not tracked" and drops it
// permanently. That is what happened to Heath's five Ridge Bluff amendments on
// 2026-09-15/16 — they completed, the webhook was told, and there was nothing
// to attach them to. DocuSeal will never re-send those events.
//
// So this script does NOT reimplement the completion leg. It imports the
// webhook's own storeSignedArtifacts() / storePdfAsDocument() / patchAuditTrail()
// through the module's existing __testing export and replays them against a
// live GET /submissions/{id}. Same code, same Storage layout, same documents
// rows, same hashes. If that logic changes, this follows automatically.
//
// It covers two jobs:
//   1. Backfill  — completions that finished before the write-back existed.
//   2. Repair    — a webhook delivery that was missed (outage, deploy window).
//
// EMAIL SAFETY
// ------------
// Rows are written with suppress_notifications = true AND owner_notified_at
// already stamped, and this script never calls any of the webhook's email
// functions. Reconciling a months-old signature must not mail a client about a
// document they signed and forgot about. Nothing here sends anything.
//
// USAGE
//   node scripts/backfill-docuseal-completions.js                     # dry run, list untracked completions
//   node scripts/backfill-docuseal-completions.js --id 11272607       # dry run, one submission, full detail
//   node scripts/backfill-docuseal-completions.js --id 11272607 --transaction <uuid> --apply
//   node scripts/backfill-docuseal-completions.js --all --apply       # every untracked completion
//
// Dry run is the default and performs only GETs. --apply is required to write.
// =============================================================================

const path = require('path');
const crypto = require('crypto');

// Load .env.local BEFORE requiring the webhook module — it captures
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / DOCUSEAL_API_KEY into consts at
// require time, so requiring it first would bind them to undefined.
const wb = require('./_lib/signature-request-writeback.js');
wb.loadEnv();

const webhook = require(path.resolve(__dirname, '..', 'api', 'esign-webhook.js'));
const { storeSignedArtifacts, patchAuditTrail } = webhook.__testing;

const DOCUSEAL_BASE = 'https://api.docuseal.com';

function ds(pathAndQuery) {
  return fetch(`${DOCUSEAL_BASE}${pathAndQuery}`, {
    headers: { 'X-Auth-Token': process.env.DOCUSEAL_API_KEY },
  }).then(async (r) => {
    const text = await r.text();
    if (!r.ok) throw new Error(`DocuSeal ${pathAndQuery} -> ${r.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  });
}

// Every completed submission DocuSeal knows about, newest first.
async function listCompleted(limit = 100) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const q = `/submissions?status=completed&limit=100${after ? `&after=${after}` : ''}`;
    const page = await ds(q);
    const rows = Array.isArray(page.data) ? page.data : [];
    if (rows.length === 0) break;
    out.push(...rows);
    const next = page.pagination && page.pagination.next;
    if (!next) break;
    after = next;
  }
  return out.slice(0, limit);
}

async function trackedIds() {
  const r = await wb.supa('signature_requests?select=docuseal_submission_id&limit=2000');
  const rows = Array.isArray(r.data) ? r.data : [];
  return new Set(rows.map((x) => String(x.docuseal_submission_id)));
}

// The webhook sets signers[].status = 'signed' when a submitter completes.
// Match that exactly — the dashboard and the DoD evidence checks read it.
function signersFromSubmission(sub) {
  return wb.normaliseSigners(sub.submitters || []).map((s, i) => {
    const raw = (sub.submitters || [])[i] || {};
    return {
      ...s,
      status: raw.status === 'completed' ? 'signed' : (raw.status || 'awaiting'),
      ...(raw.completed_at ? { completed_at: raw.completed_at } : {}),
    };
  });
}

async function backfillOne(submissionId, apply, transactionId = null) {
  const sub = await ds(`/submissions/${encodeURIComponent(submissionId)}`);
  const name = (sub.template && sub.template.name) || `submission-${submissionId}`;
  const docs = Array.isArray(sub.documents) ? sub.documents : [];

  console.log(`\n── ${submissionId} ──`);
  console.log(`  template     ${name}`);
  console.log(`  status       ${sub.status}   completed_at ${sub.completed_at || '-'}`);
  console.log(`  signers      ${(sub.submitters || []).map((s) => `${s.name} <${s.email}> ${s.status}`).join(' | ')}`);
  console.log(`  documents    ${docs.length} (${docs.map((d) => d.name).join(', ') || 'none'})`);
  console.log(`  audit_log    ${sub.audit_log_url ? 'present' : 'MISSING'}`);

  if (sub.status !== 'completed') {
    console.log('  SKIP — not completed.');
    return { ok: false, reason: 'not_completed' };
  }

  const owner = await wb.resolveOwnerUserId(null);
  if (!owner.ok) {
    console.log(`  ABORT — ${owner.reason}: ${owner.detail}`);
    return owner;
  }
  console.log(`  owner        ${owner.userId} (${owner.source})`);
  console.log(`  transaction  ${transactionId || 'NONE'}`);
  if (!transactionId) {
    // documents.transaction_id is NOT NULL, so with no dossier the signed PDFs
    // and the completion certificate cannot be stored. The tracking row is
    // still worth writing (status, signers, event history), but say plainly
    // that the artifact leg will not run — this used to fail silently.
    console.log('  NOTE — no --transaction given: the tracking row will be written but the');
    console.log('         signed PDF and completion certificate CANNOT be stored, because');
    console.log('         documents.transaction_id is NOT NULL. Pass --transaction <uuid>.');
  }

  if (!apply) {
    // Prove the artifacts are genuinely retrievable without writing anything.
    for (const d of docs) {
      if (!d.url) continue;
      const r = await fetch(d.url);
      const buf = Buffer.from(await r.arrayBuffer());
      console.log(`  [dry] signed  ${d.name} ${r.status} ${buf.length}B sha256=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}…`);
    }
    if (sub.audit_log_url) {
      const r = await fetch(sub.audit_log_url);
      const buf = Buffer.from(await r.arrayBuffer());
      console.log(`  [dry] cert    ${r.status} ${buf.length}B sha256=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)}…`);
    }
    console.log(`  [dry] events  ${Array.isArray(sub.submission_events) ? sub.submission_events.length : 0}`);
    console.log('  DRY RUN — nothing written. Re-run with --apply.');
    return { ok: true, dryRun: true };
  }

  // 1. Tracking row, already completed. suppress_notifications AND
  //    owner_notified_at are both set so no path can email anyone about a
  //    signature that finished days ago.
  const existing = await wb.supa(
    `signature_requests?docuseal_submission_id=eq.${encodeURIComponent(submissionId)}&select=id&limit=1`
  );
  let srId = (Array.isArray(existing.data) && existing.data[0]) ? existing.data[0].id : null;

  if (!srId) {
    const ins = await wb.supa('signature_requests', {
      method: 'POST',
      body: JSON.stringify({
        user_id: owner.userId,
        transaction_id: transactionId || null,
        docuseal_submission_id: String(submissionId),
        docuseal_template_id: sub.template && sub.template.id ? String(sub.template.id) : null,
        status: 'completed',
        completed_at: sub.completed_at || new Date().toISOString(),
        signers: signersFromSubmission(sub),
        message: name,
        suppress_notifications: true,
        owner_notified_at: new Date().toISOString(),
      }),
    });
    if (!ins.ok) {
      console.log(`  FAIL — signature_requests insert ${ins.status}: ${String(ins.text).slice(0, 300)}`);
      return { ok: false, reason: 'insert_failed' };
    }
    srId = (Array.isArray(ins.data) ? ins.data[0] : ins.data).id;
    console.log(`  row          ${srId} (created)`);
  } else {
    console.log(`  row          ${srId} (existing)`);
    if (transactionId) {
      await wb.supa(`signature_requests?id=eq.${encodeURIComponent(srId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ transaction_id: transactionId, updated_at: new Date().toISOString() }),
        headers: { Prefer: 'return=minimal' },
      });
    }
  }

  const sr = {
    id: srId,
    user_id: owner.userId,
    transaction_id: transactionId || null,
    docuseal_submission_id: String(submissionId),
  };

  // 2. The webhook's own artifact leg — signed PDFs + completion certificate
  //    into Storage and documents, sha256 of everything.
  const artifacts = await storeSignedArtifacts(sr, sub);
  console.log(`  signed docs  ${artifacts.signedDocs.length} stored`);
  for (const d of artifacts.signedDocs) console.log(`    ${d.fileName} -> documents ${d.id} sha256=${d.sha256.slice(0, 16)}…`);
  console.log(`  certificate  ${artifacts.auditDocId ? `documents ${artifacts.auditDocId} sha256=${String(artifacts.auditSha256).slice(0, 16)}…` : 'NOT STORED'}`);
  console.log(`  events       ${artifacts.events ? artifacts.events.length : 0}`);

  // 3. The webhook's own audit-trail patch.
  const signedHashes = {};
  for (const d of artifacts.signedDocs) signedHashes[d.fileName] = d.sha256;
  await patchAuditTrail(srId, {
    ...(artifacts.signedDocs.length > 0 ? { signed_pdf_sha256: signedHashes } : {}),
    ...(artifacts.auditSha256 ? { audit_log_sha256: artifacts.auditSha256 } : {}),
    ...(artifacts.auditDocId ? { audit_log_document_id: artifacts.auditDocId } : {}),
    ...(artifacts.events ? { submission_events: artifacts.events } : {}),
    ...(artifacts.auditFetchFailed ? { audit_fetch_failed_at: new Date().toISOString() } : {}),
  });

  // 4. Point the row at the primary signed document.
  if (artifacts.signedDocs.length > 0 && artifacts.signedDocs[0].id) {
    await wb.supa(`signature_requests?id=eq.${encodeURIComponent(srId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ signed_document_id: artifacts.signedDocs[0].id, updated_at: new Date().toISOString() }),
      headers: { Prefer: 'return=minimal' },
    });
  }

  console.log('  DONE');
  return { ok: true, srId, artifacts };
}

(async () => {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const idIdx = args.indexOf('--id');
  const txIdx = args.indexOf('--transaction');
  const transactionId = txIdx !== -1 ? args[txIdx + 1] : null;

  if (!process.env.DOCUSEAL_API_KEY) throw new Error('DOCUSEAL_API_KEY missing from .env.local');

  console.log(apply ? 'MODE: APPLY (writes to Supabase + Storage)' : 'MODE: DRY RUN (reads only)');

  if (idIdx !== -1) {
    const ids = args[idIdx + 1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const id of ids) await backfillOne(id, apply, transactionId);
    return;
  }

  const [completed, tracked] = await Promise.all([listCompleted(), trackedIds()]);
  const untracked = completed.filter((s) => !tracked.has(String(s.id)));

  console.log(`\nDocuSeal completed: ${completed.length}`);
  console.log(`Tracked in Dossie:  ${tracked.size}`);
  console.log(`Untracked:          ${untracked.length}\n`);
  for (const s of untracked) {
    console.log(`  ${s.id}  ${s.completed_at}  ${(s.template && s.template.name) || ''}`);
  }

  if (!args.includes('--all')) {
    console.log('\nListing only. Use --id <n> for detail, or --all --apply to reconcile everything.');
    return;
  }
  for (const s of untracked) await backfillOne(s.id, apply, transactionId);
})().catch((err) => { console.error(err.message); process.exit(1); });
