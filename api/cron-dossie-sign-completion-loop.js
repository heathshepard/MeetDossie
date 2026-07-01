'use strict';

// api/cron-dossie-sign-completion-loop.js
// =============================================================================
// SV-ENG-RIDGE-DOSSIE-SIGN-LOOP-002 (Ridge, 2026-07-01)
//
// ARCHITECTURAL FIX 2026-07-01 11:38 CDT — Heath is furious (0% complete after
// 24h, 17 yellow / 55 red / 0 green). Root cause: previous version dispatched
// new work every tick without proving previous dispatches actually landed +
// flipped gates green. Signature_requests refresh was querying a `metadata`
// column that doesn't exist — silently returned zero flips. Agent_queue
// refresh required metadata.quinn_apv_pass=true which agents never set.
//
// NEW ORDER OF OPERATIONS EACH TICK:
//   1. Read current DoD state
//   2. EVIDENCE-CHECK EVERY YELLOW GATE — apply strict per-gate rules to
//      determine if the previous fix actually landed:
//        - fill_accuracy / hadley_signed_pass → Hadley PASS report file
//        - send_button_works → agent_queue task closed with proof + real
//          signature_requests row created recently for this template
//        - multi_signer / signer_email_collect → agent_queue task closed with
//          apv_pass proof + Playwright screenshot metadata
//        - envelope_status → signature_requests row status advanced past 'sent'
//        - audit_trail → signature_requests row exists w/ signed_document_id
//          AND webhook completion record on file
//        - signed_pdf_stored → signature_requests row has signed_document_id
//          pointing to a real documents row
//        - real_deal_closed → HUMAN gate, only Heath flips
//      If evidence present → flip to green.
//   3. BEFORE dispatching new work: count in-flight yellow gates. If ≥ 4
//      yellow gates awaiting evidence, SKIP dispatch this tick — the queue
//      is already stacked. Wait for evidence to land.
//   4. If a red gate has been dispatched ≥ 3 times without moving to green,
//      mark STUCK, ping Heath with the specific "why it's not moving" reason,
//      skip further dispatch of that gate.
//   5. Pick THE ONE lowest-hanging red gate (weighted)
//   6. Enforce guardrails
//   7. Dispatch to the right agent via agent_queue insert
//   8. Log the tick to dossie_sign_dod_runs
//   9. If ALL 72 gates green → celebration ping + tag + exit
//
// SCHEDULE: every 20 min via vercel.json → "*/20 * * * *"
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron header
// FROZEN FILES: never touch scripts/trec-*, api/_lib/trec-*, api/fill-form*.js
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const fs = require('fs');
const path = require('path');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

// ─── Constants ────────────────────────────────────────────────────────────────

// Cooldown per dispatched gate — same red gate not re-picked for 60min after
// dispatch. Prevents thrash while an agent is actually working on it.
const GATE_COOLDOWN_MINUTES = 60;

// Max in-flight yellow gates before we stop dispatching new work. Yellow =
// dispatched, agent said "done", but strict evidence check hasn't cleared it.
// If we already have 4 stacked, DO NOT add a 5th — wait for evidence to land.
const MAX_YELLOW_IN_FLIGHT = 4;

// Stuck threshold — if same gate dispatched > this many times without moving
// to green, flag for Heath review + skip on next tick.
// LOWERED FROM 6 → 3 per Heath 2026-07-01: catch stuck gates faster.
const STUCK_GATE_THRESHOLD = 3;

// 24h no-progress alarm
const NO_PROGRESS_ALERT_HOURS = 24;

// Daily rollup — send at this hour (CDT = UTC-5)
const DAILY_ROLLUP_UTC_HOUR = 11;   // 6am CDT

// Guardrails
const GUARDRAIL_PATTERNS = [
  {
    key: 'spend',
    re: /\b(subscribe to|purchase|buy|upgrade to paid|new paid tier|business plan|enterprise plan|docuseal business|\$\d+\/mo|monthly subscription|add credit card)\b/i,
  },
  {
    key: 'docuseal_template_rebuild',
    re: /\b(rebuild.*template|recreate.*template|redo.*docuseal template|template needs rebuild|template.*heath.*account)\b/i,
  },
  {
    key: 'contact_founder',
    re: /\b(email brittney|contact brittney|text brittney|reach out to.*founder|ask.*founder to test|founder trial)\b/i,
  },
  {
    key: 'merge_to_main',
    re: /\b(merge to main|force merge|deploy to production without staging|push to main branch)\b/i,
  },
  {
    key: 'licensed_attorney',
    re: /\b(attorney review required|licensed attorney|legal counsel needed|barred lawyer)\b/i,
  },
];

// Per-gate stuck reason lookup — used when we flag a gate STUCK. Explains
// concretely WHY it's not moving so Heath knows what to unblock.
const STUCK_REASON_HINTS = {
  fill_accuracy:      'Carter draft or Hadley re-audit never landed a PASS report. Check docs/hadley-pass-report-* for latest verdict.',
  hadley_signed_pass: 'Hadley never signed a fresh PASS report. The APV loop between Carter draft and Hadley audit is not closing.',
  send_button_works:  'Atlas Playwright APV never proved /api/esign-create returned a real docuseal_submission_id (not null) for this form.',
  multi_signer:       'Atlas Playwright never proved 2+ signer roles complete via DocuSeal for this template.',
  signer_email_collect: 'Atlas Playwright never captured signer-role modal working correctly for this form type.',
  envelope_status:    'No signature_requests row for this template has advanced past status=sent — customer dashboard cannot show progress.',
  audit_trail:        'DocuSeal Certificate of Completion has never been stored + linked for a signed envelope of this form.',
  signed_pdf_stored:  'No completed signature_requests row for this template has signed_document_id populated → signed PDF never landed in Storage.',
  real_deal_closed:   'HUMAN GATE: only Heath can flip this (Brittney trial complete).',
};

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function sb(pathAndQuery, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[dossie-sign-loop] tg error:', err && err.message);
  }
}

// Flip a gate's status + record what evidence closed it
async function flipGate(row, newStatus, evidencePath, evidenceMeta) {
  await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      status: newStatus,
      last_checked_at: new Date().toISOString(),
      last_evidence: evidencePath,
      last_evidence_meta: evidenceMeta || {},
      updated_at: new Date().toISOString(),
    }),
  });
  row.status = newStatus;
  row.last_evidence = evidencePath;
}

// ─── Evidence-check phase ─────────────────────────────────────────────────────
// STRICT rules per gate type. Each rule is a promise resolving to
// { flipped: bool, path: string, meta: object } — if flipped, gate moves to
// green. Otherwise the gate stays yellow/red.

// Read all Hadley PASS reports on disk once per tick.
// Accepts BOTH naming conventions:
//   - hadley-pass-report-trec-20-18-2026-07-01.md   (full-slug)
//   - hadley-pass-report-40-11-2026-07-01.md         (short-slug)
//   - hadley-pass-report-HOA-2026-07-01.md           (form-nickname)
function loadHadleyReports() {
  const docsDir = path.join(process.cwd(), 'docs');
  try {
    const files = fs.readdirSync(docsDir).filter(f => /^hadley-pass-report-.*\.md$/i.test(f));
    return { docsDir, files };
  } catch (e) {
    return { docsDir, files: [] };
  }
}

// Map a form_code (e.g. "TREC-20-18", "TREC-36-11") to all possible Hadley
// report filename slugs it could match on.
function candidateSlugsForForm(formCode) {
  // TREC-20-18 → ["trec-20-18", "20-18"]
  // TREC-36-11 → ["trec-36-11", "36-11", "hoa"] (HOA nickname)
  // TREC-OP-H → ["trec-op-h", "op-h", "lead", "lead-paint"] (nickname)
  const short = formCode.replace(/^TREC-/i, '').toLowerCase();
  const nicknames = {
    'op-h': ['op-h', 'lead', 'lead-paint'],
    'op-l': ['op-l', 'sellers-disclosure', 'seller-disclosure'],
    '36-11': ['36-11', 'hoa'],
    '39-10': ['39-10', 'amendment'],
    '40-11': ['40-11', 'financing', 'financing-addendum'],
    '49-1': ['49-1', 'appraisal', 'lender-appraisal'],
    '11-7': ['11-7', 'backup'],
    '20-18': ['20-18', 'resale', 'one-to-four'],
  };
  const slugs = [formCode.toLowerCase(), short];
  if (nicknames[short]) slugs.push(...nicknames[short]);
  return [...new Set(slugs)];
}

// Fetch all completed agent_queue rows that carry dossie_sign_* metadata
async function loadCompletedAgentQueue() {
  const r = await sb('agent_queue?select=id,status,completed_at,metadata,task_subject,task_brief&status=eq.completed&order=completed_at.desc&limit=500');
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data.filter(q => q.metadata && q.metadata.dossie_sign_form_code && q.metadata.dossie_sign_gate_key);
}

// Fetch all signature_requests once per tick (no metadata column exists —
// use docuseal_submission_id, status, signers jsonb, signed_document_id).
// ALSO fetches document_id so we can attribute submission → form via
// documents.document_type + file_name (Ridge 2026-07-01 attribution fix).
async function loadSignatureRequests() {
  const r = await sb('signature_requests?select=id,status,docuseal_submission_id,signed_document_id,signers,completed_at,transaction_id,document_id,created_at,user_id&order=created_at.desc&limit=500');
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data;
}

// Fetch document rows for every signature_request so we can attribute
// submission → form_code via document_type + file_name. This is the primary
// attribution path — agent_queue metadata rarely carries docuseal_submission_id
// because Playwright agents run without writing back to their own queue row.
async function loadDocumentsForSigRequests(sigRequests) {
  if (!sigRequests || sigRequests.length === 0) return new Map();
  const docIds = [...new Set(sigRequests.map(sr => sr.document_id).filter(Boolean))];
  if (docIds.length === 0) return new Map();
  // In batches of 100 (Supabase URL length safety)
  const map = new Map();  // document_id → { document_type, file_name }
  for (let i = 0; i < docIds.length; i += 100) {
    const batch = docIds.slice(i, i + 100);
    const inList = batch.map(id => encodeURIComponent(id)).join(',');
    const r = await sb(`documents?select=id,document_type,file_name&id=in.(${inList})&limit=200`);
    if (r.ok && Array.isArray(r.data)) {
      for (const d of r.data) map.set(d.id, { document_type: d.document_type, file_name: d.file_name });
    }
  }
  return map;
}

// Map a documents row (document_type + file_name) to a TREC form_code.
// Uses both explicit document_type values AND filename patterns from the
// Dossie fill pipeline output naming conventions.
function documentToFormCode(doc) {
  if (!doc) return null;
  const type = (doc.document_type || '').toLowerCase();
  const name = (doc.file_name || '').toLowerCase();

  // Explicit document_type mappings
  const typeMap = {
    'resale_contract': 'TREC-20-18',
    'one_to_four_resale': 'TREC-20-18',
    'one_to_four': 'TREC-20-18',
    'financing_addendum': 'TREC-40-11',
    'third_party_financing': 'TREC-40-11',
    'appraisal_addendum': 'TREC-49-1',
    'lender_appraisal': 'TREC-49-1',
    'hoa_addendum': 'TREC-36-11',
    'hoa': 'TREC-36-11',
    'amendment': 'TREC-39-10',
    'amendment_to_contract': 'TREC-39-10',
    'backup_addendum': 'TREC-11-7',
    'backup_contract': 'TREC-11-7',
    // NOTE: DoD table labels TREC-OP-H = Seller's Disclosure Notice and
    // TREC-OP-L = Lead-Based Paint. Ridge 2026-07-01 confirmed this against
    // dossie_sign_dod_progress form_label. Conform mapper to DoD table.
    'lead_paint_addendum': 'TREC-OP-L',
    'lead_paint': 'TREC-OP-L',
    'sellers_disclosure': 'TREC-OP-H',
    'seller_disclosure': 'TREC-OP-H',
    'sellers_disclosure_notice': 'TREC-OP-H',
  };
  if (typeMap[type]) return typeMap[type];

  // Filename pattern fallbacks — DossieSign preview naming.
  // ORDER MATTERS: check specific forms before generic "seller disclosure"
  // which is ambiguous.
  if (/one to four|resale contract|20-18|20-17/.test(name)) return 'TREC-20-18';
  if (/third party financing|financing addendum|40-11/.test(name)) return 'TREC-40-11';
  if (/appraisal|49-1|lender appraisal|right to terminate.*appraisal/.test(name)) return 'TREC-49-1';
  if (/hoa|mandatory membership|36-11|property owners association/.test(name)) return 'TREC-36-11';
  if (/amendment to contract|39-10/.test(name)) return 'TREC-39-10';
  if (/backup contract|11-7|contract concerning backup/.test(name)) return 'TREC-11-7';
  // Lead paint first (more specific), then seller disclosure fallback
  if (/lead[- ]based paint|lead paint/.test(name)) return 'TREC-OP-L';
  if (/seller.?s disclosure|sellers disclosure/.test(name)) return 'TREC-OP-H';

  // Filename prefix from fill pipeline output — e.g. "OP-L-Lead-Paint-*.pdf"
  const trecPrefix = name.match(/(op-[hl]|11-7|20-1[78]|36-11|39-10|40-11|49-1)/);
  if (trecPrefix) {
    const key = trecPrefix[1].toUpperCase();
    return `TREC-${key}`;
  }

  return null;
}

// Index docuseal_submission_id → form_code. Combines 3 sources:
//   1. agent_queue.metadata.docuseal_submission_id (if any agent set it)
//   2. signature_requests.document_id → documents.document_type/file_name
//   3. agent_queue.metadata.signature_request_id → sr → doc mapping
function buildSubmissionFormMap(agentQueueRows, sigRequests, documentMap) {
  const map = new Map();  // submissionId → form_code

  // Path 1: explicit agent metadata (rare but authoritative)
  for (const q of agentQueueRows) {
    const m = q.metadata || {};
    if (m.docuseal_submission_id && m.dossie_sign_form_code) {
      map.set(String(m.docuseal_submission_id), m.dossie_sign_form_code);
    }
    if (m.signature_request_id && m.dossie_sign_form_code) {
      map.set(`sr:${m.signature_request_id}`, m.dossie_sign_form_code);
    }
  }

  // Path 2: PRIMARY — document attribution via signature_requests.document_id
  for (const sr of sigRequests) {
    if (!sr.docuseal_submission_id) continue;
    if (map.has(String(sr.docuseal_submission_id))) continue;  // agent metadata wins
    const doc = documentMap.get(sr.document_id);
    const formCode = documentToFormCode(doc);
    if (formCode) {
      map.set(String(sr.docuseal_submission_id), formCode);
      map.set(`sr:${sr.id}`, formCode);
    }
  }

  return map;
}

// STRICT evidence check per gate. Called for every non-green, non-human-gated
// row. Returns { newStatus, path, meta } or null if no evidence found.
async function checkGateEvidence(row, ctx) {
  const { hadleyFiles, docsDir, completedQueue, sigRequests, submissionFormMap } = ctx;
  const formCode = row.form_code;
  const gateKey = row.gate_key;

  // Filter queue rows to this (form_code, gate_key)
  const gateQueue = completedQueue.filter(q =>
    q.metadata && q.metadata.dossie_sign_form_code === formCode
    && q.metadata.dossie_sign_gate_key === gateKey
  );

  // Filter sig-requests to those we can attribute to this form_code
  const gateSigs = sigRequests.filter(sr => {
    const byId = submissionFormMap.get(String(sr.docuseal_submission_id)) === formCode;
    const bySrId = submissionFormMap.get(`sr:${sr.id}`) === formCode;
    return byId || bySrId;
  });

  switch (gateKey) {
    case 'fill_accuracy':
    case 'hadley_signed_pass': {
      // Rule: docs/hadley-pass-report-<slug>-<date>.md exists AND contains
      // FINAL VERDICT: PASS AND states 0 FAIL items. Accepts full-slug
      // (trec-20-18), short-slug (20-18), or form-nickname (hoa, financing).
      const slugs = candidateSlugsForForm(formCode);
      const matches = hadleyFiles.filter(f => {
        const lower = f.toLowerCase();
        return slugs.some(s => {
          // Match slug bounded by non-alphanumerics so "20-18" doesn't hit "120-18"
          const bounded = new RegExp(`(^|[^0-9a-z])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9a-z]|$)`);
          return bounded.test(lower);
        });
      });
      if (matches.length === 0) return null;
      matches.sort();
      const latest = matches[matches.length - 1];
      let text = '';
      try { text = fs.readFileSync(path.join(docsDir, latest), 'utf8'); } catch { return null; }

      const passRe = /FINAL VERDICT\s*[:\-]?\s*\**PASS\**/i;
      const failRe = /FINAL VERDICT\s*[:\-]?\s*\**FAIL\**/i;
      const isPass = passRe.test(text);
      const isFail = failRe.test(text);
      if (isFail) return null;   // explicit fail, don't flip green
      if (!isPass) return null;  // no verdict, ambiguous

      // Extra strictness: PASS report must mention 0 FAIL items OR omit fail count.
      const failCountMatch = text.match(/(\d+)\s+FAIL(?:\s+items?)?/i);
      if (failCountMatch && Number(failCountMatch[1]) > 0) return null;

      return {
        newStatus: 'green',
        path: `docs/${latest}`,
        meta: { source: 'hadley_report', verdict: 'pass', fail_count: 0 },
      };
    }

    case 'send_button_works': {
      // Rule: agent_queue completed row exists AND metadata has real proof:
      //   - apv_pass=true OR quinn_apv_pass=true
      //   - docuseal_submission_id is set (real submission actually happened)
      //   - screenshot_path is set OR playwright_run_id is set
      // OR: a signature_requests row for this form was created in the last
      //     48h (concrete proof the send button worked end-to-end).
      const proofQueue = gateQueue.find(q => {
        const m = q.metadata || {};
        const apvPass = m.apv_pass === true || m.quinn_apv_pass === true;
        const realSubmission = m.docuseal_submission_id && String(m.docuseal_submission_id).length > 0;
        const proofArtifact = m.screenshot_path || m.playwright_run_id || m.evidence_path;
        return apvPass && realSubmission && proofArtifact;
      });
      if (proofQueue) {
        return {
          newStatus: 'green',
          path: `agent_queue/${proofQueue.id}`,
          meta: {
            source: 'agent_queue_apv_proof',
            docuseal_submission_id: proofQueue.metadata.docuseal_submission_id,
            proof: proofQueue.metadata.screenshot_path || proofQueue.metadata.playwright_run_id || proofQueue.metadata.evidence_path,
          },
        };
      }

      // Fallback: real signature_requests row created recently for this form.
      const cutoff48h = Date.now() - 48 * 3600 * 1000;
      const freshSig = gateSigs.find(sr => new Date(sr.created_at || sr.completed_at || 0).getTime() > cutoff48h);
      if (freshSig && freshSig.docuseal_submission_id) {
        return {
          newStatus: 'green',
          path: `signature_requests/${freshSig.id}`,
          meta: { source: 'live_signature_request', docuseal_submission_id: freshSig.docuseal_submission_id },
        };
      }
      return null;
    }

    case 'multi_signer': {
      // Rule: at least one signature_requests row for this form has 2+ signers
      // (signers jsonb array length ≥ 2) AND status = completed OR at least 2
      // signers have completed_at timestamps.
      const proofSig = gateSigs.find(sr => {
        const signers = Array.isArray(sr.signers) ? sr.signers : [];
        if (signers.length < 2) return false;
        // completed envelope OR 2+ signed individually
        if (sr.status === 'completed') return true;
        const signedCount = signers.filter(s => s && (s.completed_at || s.signed_at || s.status === 'completed')).length;
        return signedCount >= 2;
      });
      if (proofSig) {
        return {
          newStatus: 'green',
          path: `signature_requests/${proofSig.id}`,
          meta: { source: 'multi_signer_completed', signer_count: (proofSig.signers || []).length },
        };
      }
      // Fallback: agent_queue proof with playwright evidence of 2+ signers
      const proofQueue = gateQueue.find(q => {
        const m = q.metadata || {};
        return (m.apv_pass === true || m.quinn_apv_pass === true)
          && Array.isArray(m.signer_evidence) && m.signer_evidence.length >= 2
          && (m.screenshot_path || m.playwright_run_id);
      });
      if (proofQueue) {
        return {
          newStatus: 'green',
          path: `agent_queue/${proofQueue.id}`,
          meta: { source: 'agent_queue_multi_signer_apv', signer_evidence: proofQueue.metadata.signer_evidence },
        };
      }
      return null;
    }

    case 'signer_email_collect': {
      // Rule: agent_queue APV row with UI test proof — apv_pass + screenshot +
      // captured_roles array of ≥ 2 role fields verified by Playwright.
      const proofQueue = gateQueue.find(q => {
        const m = q.metadata || {};
        const apvPass = m.apv_pass === true || m.quinn_apv_pass === true;
        const rolesCaptured = Array.isArray(m.captured_roles) && m.captured_roles.length >= 2;
        const proofArtifact = m.screenshot_path || m.playwright_run_id;
        return apvPass && rolesCaptured && proofArtifact;
      });
      if (proofQueue) {
        return {
          newStatus: 'green',
          path: `agent_queue/${proofQueue.id}`,
          meta: { source: 'signer_email_ui_apv', captured_roles: proofQueue.metadata.captured_roles },
        };
      }
      return null;
    }

    case 'envelope_status': {
      // Rule: at least one signature_requests row for this form has status
      // advanced past 'sent' (viewed / in_progress / completed) — proves the
      // customer dashboard can show real progress.
      const advanced = gateSigs.find(sr =>
        sr.status && !['sent', 'draft', 'pending'].includes(String(sr.status).toLowerCase())
      );
      if (advanced) {
        return {
          newStatus: 'green',
          path: `signature_requests/${advanced.id}`,
          meta: { source: 'envelope_status_advanced', observed_status: advanced.status },
        };
      }
      return null;
    }

    case 'audit_trail': {
      // Rule: signed signature_requests row exists w/ signed_document_id AND
      // an agent_queue completed row references a certificate of completion
      // (metadata.certificate_of_completion_url or webhook.certificate_id).
      const signedSig = gateSigs.find(sr => sr.signed_document_id && sr.status === 'completed');
      if (!signedSig) return null;
      const certProof = gateQueue.find(q => {
        const m = q.metadata || {};
        return m.certificate_of_completion_url
          || m.certificate_id
          || (m.audit_trail_evidence && m.audit_trail_evidence.hash_chain);
      });
      if (certProof) {
        return {
          newStatus: 'green',
          path: `signature_requests/${signedSig.id}`,
          meta: {
            source: 'audit_trail_certificate',
            signature_request_id: signedSig.id,
            certificate_evidence: certProof.metadata.certificate_of_completion_url || certProof.metadata.certificate_id,
          },
        };
      }
      return null;
    }

    case 'signed_pdf_stored': {
      // Rule: at least one signature_requests row for this form has
      // signed_document_id populated AND that document row exists.
      const withPdf = gateSigs.find(sr => sr.signed_document_id);
      if (!withPdf) return null;
      // Verify the document actually exists
      // NOTE: documents table has no file_url column — only storage_path.
      // Ridge 2026-07-01 fixed: previous query returned 400 for every check,
      // blocking all 8 signed_pdf_stored gates from ever flipping.
      const docCheck = await sb(`documents?select=id,storage_path,file_name&id=eq.${encodeURIComponent(withPdf.signed_document_id)}&limit=1`);
      if (!docCheck.ok || !Array.isArray(docCheck.data) || docCheck.data.length === 0) return null;
      const doc = docCheck.data[0];
      if (!doc.storage_path) return null;
      return {
        newStatus: 'green',
        path: `signature_requests/${withPdf.id}`,
        meta: {
          source: 'signed_pdf_verified',
          signature_request_id: withPdf.id,
          document_id: withPdf.signed_document_id,
          storage_path: doc.storage_path,
          file_name: doc.file_name,
        },
      };
    }

    case 'real_deal_closed': {
      // HUMAN GATE — never auto-flip.
      return null;
    }

    default:
      return null;
  }
}

// Run evidence check across ALL non-green, non-human-gated rows. Returns
// { checked, flipped, byGate }. This is Phase 1 of every tick — runs BEFORE
// any new dispatch is considered.
async function runEvidenceCheck(rows) {
  const { docsDir, files: hadleyFiles } = loadHadleyReports();
  const completedQueue = await loadCompletedAgentQueue();
  const sigRequests = await loadSignatureRequests();
  const documentMap = await loadDocumentsForSigRequests(sigRequests);
  const submissionFormMap = buildSubmissionFormMap(completedQueue, sigRequests, documentMap);

  const ctx = { hadleyFiles, docsDir, completedQueue, sigRequests, submissionFormMap, documentMap };

  let checked = 0, flipped = 0;
  const flippedGates = [];

  for (const row of rows) {
    if (row.status === 'green') continue;
    if (row.human_gated) continue;
    if (row.gate_key === 'real_deal_closed') continue;

    checked++;
    let result = null;
    try {
      result = await checkGateEvidence(row, ctx);
    } catch (e) {
      console.warn(`[loop] evidence-check err ${row.form_code}/${row.gate_key}:`, e.message);
    }
    if (result && result.newStatus && result.newStatus !== row.status) {
      await flipGate(row, result.newStatus, result.path, result.meta);
      flipped++;
      flippedGates.push(`${row.form_code}/${row.gate_key}`);
    }
  }

  return {
    checked,
    flipped,
    flipped_gates: flippedGates,
    context_sizes: {
      hadley_reports: hadleyFiles.length,
      completed_queue: completedQueue.length,
      signature_requests: sigRequests.length,
      documents_mapped: documentMap.size,
      submission_form_map: submissionFormMap.size,
    },
  };
}

// ─── Gate picker + agent routing ──────────────────────────────────────────────

function routeGateToAgent(row) {
  const { form_code, form_label, gate_key, gate_label, docuseal_template_id } = row;

  switch (gate_key) {
    case 'fill_accuracy':
      return {
        agent: 'carter',
        priority: 1,
        subject: `Dossie Sign fill accuracy — ${form_code}`,
        brief: `Fill accuracy is red on ${form_code} (${form_label}, DocuSeal template ${docuseal_template_id}).\n\n`
          + `Task: draft a field-map fix so the next Hadley APV pass returns FINAL VERDICT PASS. Read the latest `
          + `docs/hadley-pass-report-trec-${form_code.replace('TREC-', '').toLowerCase()}-*.md for the defect list. Group `
          + `the defects into engineering fixes and produce the diff.\n\n`
          + `HARD CONSTRAINT: Do NOT push to main. Draft only. Atlas ships once Hadley re-audits and signs PASS.\n\n`
          + `HARD CONSTRAINT: Do NOT modify scripts/trec-*, api/_lib/trec-*, api/fill-form*.js unless the frozen-files `
          + `rule is being explicitly lifted. Work through DocuSeal prefill instead per project_docuseal_template_ids.md.\n\n`
          + `When drafted, insert an agent_queue row for Atlas with metadata.dossie_sign_form_code='${form_code}' and `
          + `metadata.dossie_sign_gate_key='fill_accuracy'.`,
      };

    case 'hadley_signed_pass':
      return {
        agent: 'hadley',
        priority: 1,
        subject: `Dossie Sign PASS re-audit — ${form_code}`,
        brief: `${form_code} needs a Hadley PASS report on file. Fill accuracy may already be green; re-run the v3-FHA `
          + `master prompt through the current fill pipeline, render the PDF at 200dpi, audit every expected field per `
          + `feedback_hadley_apv_is_fillform_merge_gate.md.\n\n`
          + `Write your report to docs/hadley-pass-report-${form_code.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.md `
          + `with FINAL VERDICT: PASS (or FAIL with defect list). The evidence-check phase detects the verdict automatically `
          + `on the next tick.`,
      };

    case 'send_button_works':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign send-button APV — ${form_code}`,
        brief: `Verify the "Send for signature" flow works end-to-end for ${form_code} (template ${docuseal_template_id}).\n\n`
          + `Playwright as demo (demo@meetdossie.com): open a transaction, generate ${form_code}, click Send for signature, `
          + `fill the signer email modal, submit.\n\n`
          + `EVIDENCE REQUIRED (all three) to flip this gate green on next tick:\n`
          + `  1. apv_pass=true in your completed agent_queue metadata\n`
          + `  2. docuseal_submission_id populated (a real DocuSeal submission was created — NOT null)\n`
          + `  3. screenshot_path OR playwright_run_id set\n\n`
          + `If any of the three is missing, the gate stays yellow and the loop will re-dispatch after cooldown.`,
      };

    case 'multi_signer':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign multi-signer APV — ${form_code}`,
        brief: `Verify multi-signer flow for ${form_code}: 2+ signers (buyer + seller + optional co-signers) round-trip.\n\n`
          + `Playwright the full flow on staging with test emails. Confirm each signer receives their DocuSeal link, signs, `
          + `envelope only completes when all have signed.\n\n`
          + `EVIDENCE REQUIRED (either path):\n`
          + `  Path A — signature_requests row with signers.length ≥ 2 AND (status='completed' OR 2+ signers show completed_at)\n`
          + `  Path B — agent_queue completed row with apv_pass=true, signer_evidence array of ≥ 2 entries, screenshot_path or playwright_run_id`,
      };

    case 'signer_email_collect':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign signer email UI APV — ${form_code}`,
        brief: `Verify signer email-collection modal works for ${form_code}. Different forms have different roles (resale = `
          + `buyer+seller; amendment = same; HOA = seller alone; backup = additional signers).\n\n`
          + `EVIDENCE REQUIRED in your completed agent_queue metadata:\n`
          + `  - apv_pass=true\n`
          + `  - captured_roles array (≥ 2 role keys observed working in the UI)\n`
          + `  - screenshot_path OR playwright_run_id\n`,
      };

    case 'envelope_status':
      return {
        agent: 'atlas',
        priority: 2,
        subject: `Dossie Sign envelope status in dashboard — ${form_code}`,
        brief: `After a ${form_code} envelope is sent, verify status shows in customer dashboard and progresses beyond 'sent'.\n\n`
          + `EVIDENCE REQUIRED: at least one signature_requests row for this form (docuseal_submission_id mapped to `
          + `${docuseal_template_id}) must have status advanced past 'sent' (viewed / in_progress / completed). The webhook `
          + `should be advancing status. If it isn't, dispatch Carter to fix.`,
      };

    case 'audit_trail':
      return {
        agent: 'carter',
        priority: 2,
        subject: `Dossie Sign audit trail (Certificate of Completion) — ${form_code}`,
        brief: `Every signed ${form_code} envelope must produce a Certificate of Completion. DocuSeal returns it in the `
          + `form.completed webhook. Draft the code to extract + store, surface a "download audit trail" link.\n\n`
          + `EVIDENCE REQUIRED to flip green:\n`
          + `  - completed signature_requests row with signed_document_id AND status='completed'\n`
          + `  - agent_queue row w/ metadata.certificate_of_completion_url OR certificate_id OR audit_trail_evidence.hash_chain\n\n`
          + `Do NOT push to main. Draft only. Atlas ships.`,
      };

    case 'signed_pdf_stored':
      return {
        agent: 'atlas',
        priority: 2,
        subject: `Dossie Sign signed PDF retrieval — ${form_code}`,
        brief: `Verify signed ${form_code} PDFs are stored + retrievable via app.\n\n`
          + `EVIDENCE REQUIRED: signature_requests row with signed_document_id populated → that documents row must exist AND `
          + `have file_url or storage_path set. Webhook (api/esign-webhook.js) already handles this; complete a real signed `
          + `envelope and confirm the chain.`,
      };

    case 'real_deal_closed':
      return null;

    default:
      return null;
  }
}

// ─── Guardrails ───────────────────────────────────────────────────────────────

function tripsGuardrail(subject, brief) {
  const hay = `${subject}\n${brief}`;
  for (const g of GUARDRAIL_PATTERNS) {
    if (g.re.test(hay)) return g.key;
  }
  return null;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(row, route) {
  const sourceKey = `dossie-sign-loop:${row.form_code}:${row.gate_key}:${Date.now()}`;

  const fb = await sb('jarvis_future_builds', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: HEATH_TENANT_ID,
      title: route.subject.slice(0, 280),
      description: route.brief.slice(0, 8000),
      source: 'dossie-sign-loop',
      source_key: sourceKey,
      status: 'building',
      score: Math.round(row.gate_weight),
      updated_at: new Date().toISOString(),
    }),
  });
  const futureBuildId = (fb.ok && Array.isArray(fb.data) && fb.data[0]) ? fb.data[0].id : null;

  const q = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      agent_name: route.agent,
      task_subject: route.subject.slice(0, 200),
      task_brief: route.brief.slice(0, 8000),
      priority: route.priority,
      depends_on: [],
      venture: 'dossie',
      status: 'pending',
      metadata: {
        source: 'dossie-sign-loop',
        source_table: futureBuildId ? 'jarvis_future_builds' : null,
        source_id: futureBuildId,
        source_key: sourceKey,
        dossie_sign_form_code: row.form_code,
        dossie_sign_gate_key: row.gate_key,
        dossie_sign_docuseal_template_id: row.docuseal_template_id,
        gate_weight: row.gate_weight,
        enqueued_at: new Date().toISOString(),
        enqueued_by: 'dossie-sign-loop',
      },
    }),
  });
  const queueId = (q.ok && Array.isArray(q.data) && q.data[0]) ? q.data[0].id : null;

  const nextCount = (row.dispatch_count || 0) + 1;
  const cooldownUntil = new Date(Date.now() + GATE_COOLDOWN_MINUTES * 60 * 1000).toISOString();
  await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(row.id)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      last_dispatched_at: new Date().toISOString(),
      last_dispatched_agent: route.agent,
      last_dispatched_queue_id: queueId,
      dispatch_count: nextCount,
      cooldown_until: cooldownUntil,
      updated_at: new Date().toISOString(),
    }),
  });

  return { queueId, futureBuildId, queueOk: q.ok, futureBuildOk: fb.ok, dispatchCount: nextCount };
}

// ─── Log a run tick ───────────────────────────────────────────────────────────

async function logRun(payload) {
  await sb('dossie_sign_dod_runs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
}

// ─── Daily rollup + no-progress alert (unchanged) ─────────────────────────────

async function maybeSendDailyRollup(counts) {
  const nowUtcHour = new Date().getUTCHours();
  if (nowUtcHour !== DAILY_ROLLUP_UTC_HOUR) return;

  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const r = await sb(`dossie_sign_dod_runs?select=id,metadata&metadata->>rollup_sent=eq.true&run_ts=gte.${encodeURIComponent(cutoff)}&limit=1`);
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) return;

  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r2 = await sb(`dossie_sign_dod_runs?select=green_count&run_ts=lte.${encodeURIComponent(dayAgo)}&order=run_ts.desc&limit=1`);
  const priorGreen = (r2.ok && Array.isArray(r2.data) && r2.data[0]) ? Number(r2.data[0].green_count) : 0;
  const delta = counts.green - priorGreen;

  const rReds = await sb('dossie_sign_dod_progress?select=form_code,gate_key,gate_label,dispatch_count&status=eq.red&order=gate_weight.desc&limit=8');
  const reds = (rReds.ok && Array.isArray(rReds.data)) ? rReds.data : [];
  const blockerList = reds.length === 0
    ? 'None — all gates green or yellow.'
    : reds.map(r => `- ${r.form_code} / ${r.gate_label} (dispatched ${r.dispatch_count}x)`).join('\n');

  await tg(
    `<b>Dossie Sign — daily rollup (6am CDT)</b>\n\n`
    + `Overnight loop moved <b>${delta >= 0 ? '+' : ''}${delta}</b> gates to green.\n\n`
    + `Status: <b>${counts.green}/${counts.total}</b> green. ${counts.yellow} yellow. ${counts.red} red.\n\n`
    + `<b>Top red gates:</b>\n${blockerList}\n\n`
    + `Dashboard: https://meetdossie.com/admin-dossie-sign-progress.html`
  );

  await logRun({
    total_gates: counts.total,
    green_count: counts.green,
    yellow_count: counts.yellow,
    red_count: counts.red,
    outcome: 'skipped_no_red',
    outcome_reason: 'daily_rollup_marker',
    metadata: { rollup_sent: true },
  });
}

async function maybeSendNoProgressAlert(counts) {
  const cutoff = new Date(Date.now() - NO_PROGRESS_ALERT_HOURS * 3600 * 1000).toISOString();
  const r = await sb(`dossie_sign_dod_runs?select=green_count&run_ts=lte.${encodeURIComponent(cutoff)}&order=run_ts.desc&limit=1`);
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) return;

  const priorGreen = Number(r.data[0].green_count) || 0;
  if (counts.green > priorGreen) return;

  const alertCutoff = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const r2 = await sb(`dossie_sign_dod_runs?select=id,metadata&metadata->>no_progress_alert=eq.true&run_ts=gte.${encodeURIComponent(alertCutoff)}&limit=1`);
  if (r2.ok && Array.isArray(r2.data) && r2.data.length > 0) return;

  await tg(
    `<b>Dossie Sign loop: 24h no progress.</b>\n\n`
    + `Green count stuck at ${counts.green}/${counts.total} for 24 hours. Loop needs human review.\n\n`
    + `Dashboard: https://meetdossie.com/admin-dossie-sign-progress.html`
  );

  await logRun({
    total_gates: counts.total,
    green_count: counts.green,
    yellow_count: counts.yellow,
    red_count: counts.red,
    outcome: 'skipped_no_red',
    outcome_reason: 'no_progress_alert_marker',
    metadata: { no_progress_alert: true },
  });
}

// ─── Stuck-gate ping ──────────────────────────────────────────────────────────
// When a gate has been dispatched ≥ STUCK_GATE_THRESHOLD times without moving
// to green, ping Heath with a specific reason.

async function pingStuckGates(stuckRows) {
  if (stuckRows.length === 0) return;

  // Dedupe: don't re-ping about a stuck gate within the last 6h.
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const rRecent = await sb(`dossie_sign_dod_runs?select=metadata&metadata->>stuck_ping=eq.true&run_ts=gte.${encodeURIComponent(cutoff)}&limit=5`);
  const recentlyPinged = new Set();
  if (rRecent.ok && Array.isArray(rRecent.data)) {
    for (const r of rRecent.data) {
      const gates = (r.metadata && r.metadata.stuck_gates) || [];
      for (const g of gates) recentlyPinged.add(g);
    }
  }

  const freshStuck = stuckRows.filter(r => !recentlyPinged.has(`${r.form_code}/${r.gate_key}`));
  if (freshStuck.length === 0) return;

  const lines = freshStuck.slice(0, 10).map(r => {
    const hint = STUCK_REASON_HINTS[r.gate_key] || 'No hint available.';
    return `- <b>${r.form_code} / ${r.gate_label}</b> (${r.dispatch_count}x dispatched)\n  → ${hint}`;
  });

  await tg(
    `<b>Dossie Sign: ${freshStuck.length} gate(s) STUCK</b>\n\n`
    + `Each was dispatched ${STUCK_GATE_THRESHOLD}+ times without moving to green. `
    + `Loop will stop retrying these until you unblock:\n\n`
    + lines.join('\n\n') + '\n\n'
    + `Dashboard: https://meetdossie.com/admin-dossie-sign-progress.html`
  );

  await logRun({
    total_gates: 0,
    green_count: 0,
    yellow_count: 0,
    red_count: 0,
    outcome: 'skipped_no_red',
    outcome_reason: 'stuck_gates_ping',
    metadata: {
      stuck_ping: true,
      stuck_gates: freshStuck.map(r => `${r.form_code}/${r.gate_key}`),
    },
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-dossie-sign-completion-loop', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const startTs = Date.now();

  try {
    // 1) Read current DoD state
    const r = await sb('dossie_sign_dod_progress?select=*&order=gate_weight.desc,form_code.asc');
    if (!r.ok || !Array.isArray(r.data)) {
      return res.status(500).json({ ok: false, error: 'dod_read_failed', status: r.status });
    }
    let rows = r.data;
    if (rows.length === 0) {
      return res.status(500).json({ ok: false, error: 'no_dod_rows_seeded_run_migration_first' });
    }

    // 2) ── PHASE 1: EVIDENCE CHECK ──
    // Before dispatching ANY new work, run the strict evidence check against
    // every non-green gate. Flips gates to green when the previous fix
    // actually landed and left concrete proof.
    let evidenceResult = { checked: 0, flipped: 0, flipped_gates: [], context_sizes: {} };
    try {
      evidenceResult = await runEvidenceCheck(rows);
    } catch (e) {
      evidenceResult.error = e.message;
      console.warn('[loop] evidence-check top-level err:', e.message);
    }

    // Re-read after evidence check
    const r2 = await sb('dossie_sign_dod_progress?select=*&order=gate_weight.desc,form_code.asc');
    if (r2.ok && Array.isArray(r2.data)) rows = r2.data;

    // 3) Count buckets
    const counts = {
      total: rows.length,
      green: rows.filter(r => r.status === 'green').length,
      yellow: rows.filter(r => r.status === 'yellow').length,
      red: rows.filter(r => r.status === 'red').length,
    };

    // 4) Mission complete?
    if (counts.green === counts.total) {
      const rDone = await sb(`dossie_sign_dod_runs?select=id&outcome=eq.skipped_all_green&metadata->>celebration_sent=eq.true&limit=1`);
      const alreadyCelebrated = rDone.ok && Array.isArray(rDone.data) && rDone.data.length > 0;

      if (!alreadyCelebrated) {
        await tg(
          `<b>Dossie Sign — MISSION COMPLETE.</b>\n\n`
          + `All 9 gates green across all 8 TREC forms. 72/72. Every gate.\n\n`
          + `Tag GOLD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-dossie-sign-complete.`
        );
      }

      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        outcome: 'skipped_all_green',
        outcome_reason: 'all_gates_green_mission_complete',
        duration_ms: Date.now() - startTs,
        metadata: { celebration_sent: !alreadyCelebrated, evidence: evidenceResult },
      });

      return res.status(200).json({
        ok: true,
        outcome: 'mission_complete',
        counts,
        evidence: evidenceResult,
      });
    }

    // 5) Daily rollup + no-progress alert
    try { await maybeSendDailyRollup(counts); } catch (e) { console.warn('[loop] rollup err', e.message); }
    try { await maybeSendNoProgressAlert(counts); } catch (e) { console.warn('[loop] noprog err', e.message); }

    // 6) ── PHASE 2: BACKPRESSURE CHECK ──
    // If we already have MAX_YELLOW_IN_FLIGHT yellows waiting on evidence,
    // DO NOT dispatch new work — the queue is stacked. Wait for evidence.
    const yellowRows = rows.filter(r => r.status === 'yellow' && !r.human_gated && r.gate_key !== 'real_deal_closed');
    if (yellowRows.length >= MAX_YELLOW_IN_FLIGHT) {
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        outcome: 'skipped_no_red',
        outcome_reason: `backpressure_${yellowRows.length}_yellow_awaiting_evidence`,
        duration_ms: Date.now() - startTs,
        metadata: {
          evidence: evidenceResult,
          backpressure: true,
          yellow_in_flight: yellowRows.map(r => `${r.form_code}/${r.gate_key}`),
        },
      });
      return res.status(200).json({
        ok: true,
        outcome: 'backpressure',
        counts,
        evidence: evidenceResult,
        yellow_in_flight: yellowRows.length,
        message: `${yellowRows.length} yellow gates awaiting evidence — not dispatching new work until they resolve.`,
      });
    }

    // 7) ── PHASE 3: STUCK GATE SURFACE ──
    // Rows dispatched ≥ STUCK_GATE_THRESHOLD times without moving to green.
    // Ping Heath with per-gate reason. Excluded from eligibility.
    const now = Date.now();
    const stuckRows = [];
    const eligible = [];

    for (const row of rows) {
      if (row.status !== 'red') continue;
      if (row.human_gated) continue;
      if (row.gate_key === 'real_deal_closed') continue;
      if (row.cooldown_until && new Date(row.cooldown_until).getTime() > now) continue;
      if ((row.dispatch_count || 0) >= STUCK_GATE_THRESHOLD) {
        stuckRows.push(row);
        continue;
      }
      eligible.push(row);
    }

    if (stuckRows.length > 0) {
      try { await pingStuckGates(stuckRows); } catch (e) { console.warn('[loop] stuck ping err', e.message); }
    }

    // 8) Nothing eligible AND nothing stuck → cooldown, quiet exit
    if (eligible.length === 0 && stuckRows.length === 0) {
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        outcome: 'skipped_cooldown',
        outcome_reason: 'all_red_gates_on_cooldown',
        duration_ms: Date.now() - startTs,
        metadata: { evidence: evidenceResult },
      });
      return res.status(200).json({ ok: true, outcome: 'all_on_cooldown', counts, evidence: evidenceResult });
    }

    if (eligible.length === 0) {
      // All reds are stuck — nothing to dispatch. Ping was already sent.
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        outcome: 'skipped_no_red',
        outcome_reason: 'all_reds_stuck_or_cooldown',
        duration_ms: Date.now() - startTs,
        metadata: {
          evidence: evidenceResult,
          stuck_count: stuckRows.length,
        },
      });
      return res.status(200).json({
        ok: true,
        outcome: 'all_stuck',
        counts,
        evidence: evidenceResult,
        stuck: stuckRows.length,
      });
    }

    // 9) Pick winner — highest weight, then lowest dispatch_count, then form_code
    eligible.sort((a, b) => {
      if (b.gate_weight !== a.gate_weight) return b.gate_weight - a.gate_weight;
      if ((a.dispatch_count || 0) !== (b.dispatch_count || 0)) return (a.dispatch_count || 0) - (b.dispatch_count || 0);
      return a.form_code.localeCompare(b.form_code);
    });
    const winner = eligible[0];

    // 10) Route to agent
    const route = routeGateToAgent(winner);
    if (!route) {
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        picked_form_code: winner.form_code,
        picked_gate_key: winner.gate_key,
        outcome: 'error',
        outcome_reason: 'no_route_defined_for_gate',
        duration_ms: Date.now() - startTs,
      });
      return res.status(500).json({ ok: false, error: 'no_route_for_gate', gate_key: winner.gate_key });
    }

    // 11) Guardrail check
    const guardrail = tripsGuardrail(route.subject, route.brief);
    if (guardrail) {
      await tg(
        `<b>Dossie Sign loop paused — human decision needed.</b>\n\n`
        + `Picked: ${winner.form_code} / ${winner.gate_label}\n`
        + `Guardrail tripped: <code>${guardrail}</code>\n\nLoop did NOT ship. Your call.`
      );
      await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(winner.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          cooldown_until: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }),
      });
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        picked_form_code: winner.form_code,
        picked_gate_key: winner.gate_key,
        picked_gate_weight: winner.gate_weight,
        picked_reason: 'highest_weight_red_eligible',
        agent_dispatched: route.agent,
        outcome: 'skipped_guardrail',
        outcome_reason: `guardrail:${guardrail}`,
        duration_ms: Date.now() - startTs,
        metadata: { evidence: evidenceResult },
      });
      return res.status(200).json({
        ok: true,
        outcome: 'skipped_guardrail',
        guardrail,
        picked: { form_code: winner.form_code, gate_key: winner.gate_key },
        counts,
        evidence: evidenceResult,
      });
    }

    // 12) Dispatch
    const dispatchResult = await dispatch(winner, route);
    if (!dispatchResult.queueOk) {
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        picked_form_code: winner.form_code,
        picked_gate_key: winner.gate_key,
        picked_gate_weight: winner.gate_weight,
        picked_reason: 'highest_weight_red_eligible',
        agent_dispatched: route.agent,
        outcome: 'error',
        outcome_reason: 'agent_queue_insert_failed',
        duration_ms: Date.now() - startTs,
        metadata: { evidence: evidenceResult },
      });
      return res.status(500).json({ ok: false, error: 'dispatch_failed', counts });
    }

    // 13) Log successful dispatch
    await logRun({
      total_gates: counts.total,
      green_count: counts.green,
      yellow_count: counts.yellow,
      red_count: counts.red,
      picked_form_code: winner.form_code,
      picked_gate_key: winner.gate_key,
      picked_gate_weight: winner.gate_weight,
      picked_reason: 'highest_weight_red_eligible',
      agent_dispatched: route.agent,
      queue_id: dispatchResult.queueId,
      future_build_id: dispatchResult.futureBuildId,
      outcome: 'dispatched',
      duration_ms: Date.now() - startTs,
      metadata: {
        evidence: evidenceResult,
        dispatch_count: dispatchResult.dispatchCount,
        yellow_in_flight: yellowRows.length,
      },
    });

    return res.status(200).json({
      ok: true,
      outcome: 'dispatched',
      picked: {
        form_code: winner.form_code,
        gate_key: winner.gate_key,
        gate_weight: winner.gate_weight,
      },
      agent: route.agent,
      queue_id: dispatchResult.queueId,
      future_build_id: dispatchResult.futureBuildId,
      counts,
      evidence: evidenceResult,
      yellow_in_flight: yellowRows.length,
    });
  } catch (err) {
    console.error('[dossie-sign-loop] crashed:', err);
    await logRun({
      total_gates: 0,
      green_count: 0,
      yellow_count: 0,
      red_count: 0,
      outcome: 'error',
      outcome_reason: `crash:${(err && err.message) ? err.message.slice(0, 500) : 'unknown'}`,
      duration_ms: Date.now() - startTs,
    });
    return res.status(500).json({ ok: false, error: err.message });
  }
});
