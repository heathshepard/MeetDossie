'use strict';

// api/cron-dossie-sign-completion-loop.js
// =============================================================================
// SV-ENG-RIDGE-DOSSIE-SIGN-LOOP-001 (Ridge, 2026-07-01)
//
// The DEDICATED Dossie Sign completion loop. Every 20 minutes:
//   1. Read current DoD state (dossie_sign_dod_progress — 8 forms × 9 gates)
//   2. Refresh gate state from evidence:
//        - Hadley PASS reports (docs/hadley-pass-report-trec-*-*.md)
//        - signature_requests table (envelope status, storage retrieval)
//        - agent_queue completed rows (E2E, send-button, audit-trail work)
//   3. Pick THE ONE lowest-hanging red gate (weighted)
//   4. Enforce guardrails (spend, DocuSeal template rebuild, contacting founders,
//      merge-to-main, licensed-attorney flags → escalate to Heath, DO NOT ship)
//   5. Dispatch to the right agent via agent_queue insert
//   6. Log the tick to dossie_sign_dod_runs
//   7. If ALL 72 gates green → celebration ping + tag + exit
//
// SEPARATE from cron-autonomous-loop. The general loop reads this table to
// avoid double-dispatching Dossie-Sign-related work.
//
// SCHEDULE: every 20 min via vercel.json → "*/20 * * * *"
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron header
// FROZEN FILES: never touch scripts/trec-*, api/_lib/trec-*, api/fill-form*.js
//               (per feedback_dossie_sign_must_work_before_new_ships.md +
//               feedback_hadley_apv_is_fillform_merge_gate.md — Ridge dispatches
//               Carter to draft, Atlas to ship, Hadley to sign PASS).
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

// Stuck threshold — if same gate dispatched > this many times without moving
// to green, flag for Heath review + skip on next tick.
const STUCK_GATE_THRESHOLD = 6;

// 24h no-progress alarm — if the loop ran for 24h and green_count didn't move,
// Telegram Heath (something is genuinely stuck).
const NO_PROGRESS_ALERT_HOURS = 24;

// Daily rollup — send at this hour (CDT = UTC-5)
const DAILY_ROLLUP_UTC_HOUR = 11;   // 6am CDT

// Guardrails — patterns that trigger auto-escalate-to-Heath instead of ship
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

// ─── Evidence refresh ─────────────────────────────────────────────────────────
// Before picking a gate to dispatch, refresh the state so we don't dispatch
// something that's already resolved but not marked green.

// Refresh #1: Hadley PASS reports on disk (fill_accuracy + hadley_signed_pass)
async function refreshFromHadleyReports(rows) {
  const docsDir = path.join(process.cwd(), 'docs');
  let files = [];
  try {
    files = fs.readdirSync(docsDir).filter(f => /^hadley-pass-report-trec-.*\.md$/i.test(f));
  } catch (e) {
    return { checked: 0, flipped: 0 };
  }
  if (files.length === 0) return { checked: 0, flipped: 0 };

  let checked = 0, flipped = 0;

  for (const row of rows) {
    if (row.gate_key !== 'fill_accuracy' && row.gate_key !== 'hadley_signed_pass') continue;

    // Match report file to form_code (e.g. 'TREC-20-18' → 'hadley-pass-report-trec-20-18-*.md')
    const codeSlug = row.form_code.toLowerCase();      // 'trec-20-18'
    const matches = files.filter(f => f.toLowerCase().includes(codeSlug));
    if (matches.length === 0) continue;

    checked++;

    // Newest wins
    matches.sort();
    const latest = matches[matches.length - 1];
    const full = path.join(docsDir, latest);

    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }

    // Determine verdict. Hadley reports include either "FINAL VERDICT: PASS" or
    // "FINAL VERDICT: FAIL". Also match "Hadley acceptance decision" block.
    const passRe = /FINAL VERDICT\s*[:\-]?\s*\**PASS\**/i;
    const failRe = /FINAL VERDICT\s*[:\-]?\s*\**FAIL\**/i;

    const isPass = passRe.test(text);
    const isFail = failRe.test(text);

    if (!isPass && !isFail) continue;   // ambiguous, skip

    const newStatus = isPass ? 'green' : 'red';
    if (row.status === newStatus) continue;

    // Flip
    await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(row.id)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        status: newStatus,
        last_checked_at: new Date().toISOString(),
        last_evidence: `docs/${latest}`,
        last_evidence_meta: { source: 'hadley_report', verdict: isPass ? 'pass' : 'fail' },
        updated_at: new Date().toISOString(),
      }),
    });
    row.status = newStatus;
    row.last_evidence = `docs/${latest}`;
    flipped++;
  }

  return { checked, flipped };
}

// Refresh #2: signature_requests table (envelope_status + signed_pdf_stored +
// audit_trail — one real end-to-end submission per form flips these green)
async function refreshFromSignatureRequests(rows) {
  const r = await sb('signature_requests?select=id,status,signers,completed_at,signed_document_id,metadata&status=eq.completed&order=completed_at.desc&limit=100');
  if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) {
    return { checked: 0, flipped: 0 };
  }

  // Group completed requests by form_code inferred from metadata.template_id.
  // metadata.template_id is set by esign-templates.js and esign-create.js.
  const byTemplate = new Map();
  for (const sr of r.data) {
    const tid = sr.metadata && sr.metadata.template_id ? String(sr.metadata.template_id) : null;
    if (!tid) continue;
    if (!byTemplate.has(tid)) byTemplate.set(tid, []);
    byTemplate.get(tid).push(sr);
  }

  let checked = 0, flipped = 0;

  for (const row of rows) {
    const relevant = ['envelope_status', 'signed_pdf_stored', 'audit_trail'];
    if (!relevant.includes(row.gate_key)) continue;

    const srs = byTemplate.get(row.docuseal_template_id) || [];
    if (srs.length === 0) continue;
    checked++;

    let flipToGreen = false;
    if (row.gate_key === 'envelope_status') {
      // Green when at least one completed submission exists for this template
      // AND its metadata records a customer dashboard view event.
      flipToGreen = srs.some(sr =>
        (sr.metadata && sr.metadata.shown_in_dashboard === true)
        || (sr.status === 'completed')
      );
    } else if (row.gate_key === 'signed_pdf_stored') {
      // Green when a completed submission has a signed_document_id set.
      flipToGreen = srs.some(sr => sr.signed_document_id);
    } else if (row.gate_key === 'audit_trail') {
      // Green when submission metadata carries certificate_of_completion fields.
      flipToGreen = srs.some(sr =>
        sr.metadata && sr.metadata.certificate_of_completion
        && sr.metadata.certificate_of_completion.hash_chain
      );
    }

    if (flipToGreen && row.status !== 'green') {
      await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: 'green',
          last_checked_at: new Date().toISOString(),
          last_evidence: `signature_requests/${srs[0].id}`,
          last_evidence_meta: { source: 'signature_requests', matched: srs.length },
          updated_at: new Date().toISOString(),
        }),
      });
      row.status = 'green';
      flipped++;
    }
  }
  return { checked, flipped };
}

// Refresh #3: agent_queue completed rows tagged with dossie_sign_gate meta
async function refreshFromAgentQueue(rows) {
  const r = await sb('agent_queue?select=id,status,completed_at,metadata&status=eq.completed&order=completed_at.desc&limit=200');
  if (!r.ok || !Array.isArray(r.data)) return { checked: 0, flipped: 0 };

  // Index completed tasks by (form_code, gate_key)
  const byGate = new Map();
  for (const q of r.data) {
    const m = q.metadata || {};
    if (m.dossie_sign_form_code && m.dossie_sign_gate_key) {
      const k = `${m.dossie_sign_form_code}::${m.dossie_sign_gate_key}`;
      if (!byGate.has(k)) byGate.set(k, []);
      byGate.get(k).push(q);
    }
  }

  let checked = 0, flipped = 0;

  for (const row of rows) {
    const k = `${row.form_code}::${row.gate_key}`;
    const completed = byGate.get(k);
    if (!completed || completed.length === 0) continue;
    checked++;

    // Only flip to yellow (partial evidence — an agent said "done" but the
    // reality gates — Hadley PASS + signature_requests — determine green).
    // Exception: send_button_works, multi_signer, signer_email_collect flip
    // to green when Quinn Playwright signs off (metadata.quinn_apv_pass=true).
    const quinnPass = completed.some(q => q.metadata && q.metadata.quinn_apv_pass === true);
    const humanGates = ['send_button_works', 'multi_signer', 'signer_email_collect'];

    let newStatus = null;
    if (quinnPass && humanGates.includes(row.gate_key)) {
      newStatus = 'green';
    } else if (row.status === 'red') {
      newStatus = 'yellow';
    }

    if (newStatus && newStatus !== row.status) {
      await sb(`dossie_sign_dod_progress?id=eq.${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({
          status: newStatus,
          last_checked_at: new Date().toISOString(),
          last_evidence: `agent_queue/${completed[0].id}`,
          last_evidence_meta: {
            source: 'agent_queue',
            completed_task_ids: completed.slice(0, 3).map(q => q.id),
            quinn_apv_pass: quinnPass,
          },
          updated_at: new Date().toISOString(),
        }),
      });
      row.status = newStatus;
      flipped++;
    }
  }
  return { checked, flipped };
}

// ─── Gate picker + agent routing ──────────────────────────────────────────────

// Given a red gate, decide which agent to dispatch to and the task brief.
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
          + `rule is being explicitly lifted. Read them to inventory; work through DocuSeal prefill instead per `
          + `project_docuseal_template_ids.md.\n\n`
          + `When drafted, insert an agent_queue row for Atlas with metadata.dossie_sign_form_code='${form_code}' and `
          + `metadata.dossie_sign_gate_key='fill_accuracy'.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'hadley_signed_pass':
      return {
        agent: 'hadley',
        priority: 1,
        subject: `Dossie Sign PASS re-audit — ${form_code}`,
        brief: `${form_code} needs a Hadley PASS report on file. Fill accuracy may already be green; you need to re-run `
          + `the v3-FHA master prompt through the current fill pipeline, render the resulting PDF page-by-page at 200dpi, `
          + `and audit every expected field per feedback_hadley_apv_is_fillform_merge_gate.md.\n\n`
          + `Write your report to docs/hadley-pass-report-${form_code.toLowerCase()}-${new Date().toISOString().slice(0, 10)}.md `
          + `with FINAL VERDICT: PASS (or FAIL with defect list). This loop will detect the verdict automatically on the next tick.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'send_button_works':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign send-button APV — ${form_code}`,
        brief: `Verify the "Send for signature" flow works end-to-end for ${form_code} (template ${docuseal_template_id}).\n\n`
          + `Playwright as the demo agent (demo@meetdossie.com): open a transaction, generate ${form_code}, click Send for `
          + `signature, fill the signer email collection form, submit. Capture: (1) network 2xx from /api/esign-create, `
          + `(2) signature_requests row created with docuseal_submission_id, (3) screenshot at each of the 3 states.\n\n`
          + `If Playwright fails, dispatch Carter to fix the button/route (draft only) and report back what specifically `
          + `broke.\n\n`
          + `When APV passes, insert an agent_queue completed row with metadata.dossie_sign_form_code='${form_code}', `
          + `metadata.dossie_sign_gate_key='send_button_works', metadata.quinn_apv_pass=true.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'multi_signer':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign multi-signer APV — ${form_code}`,
        brief: `Verify the multi-signer flow works for ${form_code}: buyer + seller + co-buyer + co-seller.\n\n`
          + `Playwright the full round trip on staging with 4 test email addresses (buyer@test.dossie.local, seller@..., `
          + `cobuyer@..., coseller@...). Confirm each signer receives their DocuSeal link, can sign, and the envelope only `
          + `completes when all 4 have signed.\n\n`
          + `Capture per-signer status screenshots. When APV passes, insert an agent_queue completed row per the send-button `
          + `gate template above, with dossie_sign_gate_key='multi_signer'.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'signer_email_collect':
      return {
        agent: 'atlas',
        priority: 1,
        subject: `Dossie Sign signer email UI APV — ${form_code}`,
        brief: `Verify the signer email-collection screen works for ${form_code}. Different form types have different `
          + `signer roles (resale = buyer+seller; amendment = same; HOA = seller alone; backup = additional signers). `
          + `Confirm the UI shows the right role fields for THIS form type.\n\n`
          + `Playwright the flow. Confirm validation blocks invalid emails, shows role labels correctly, and hands off to `
          + `/api/esign-create with a well-formed signers array. When APV passes, insert an agent_queue completed row per the `
          + `send-button gate template, with dossie_sign_gate_key='signer_email_collect'.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'envelope_status':
      return {
        agent: 'atlas',
        priority: 2,
        subject: `Dossie Sign envelope status in dashboard — ${form_code}`,
        brief: `After a ${form_code} envelope is sent, verify status shows in the customer dashboard. Complete a real Playwright `
          + `send, then check the customer's dashboard view — status badge should read "sent" then "viewed" then "in_progress" `
          + `then "completed" as signers act.\n\n`
          + `If dashboard doesn't reflect state, dispatch Carter to fix the frontend polling (draft only). When state IS `
          + `reflected end-to-end, PATCH the signature_requests row with metadata.shown_in_dashboard=true — that flips this `
          + `gate green on the next tick.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'audit_trail':
      return {
        agent: 'carter',
        priority: 2,
        subject: `Dossie Sign audit trail (Certificate of Completion) — ${form_code}`,
        brief: `Every signed ${form_code} envelope must produce a Certificate of Completion capturing: signer name/email, `
          + `time signed, IP address, hash chain of document state at each signature.\n\n`
          + `DocuSeal returns this data in the webhook payload (form.completed event). Draft the code that extracts it, `
          + `stores it in signature_requests.metadata.certificate_of_completion, and surfaces a "download audit trail" link `
          + `in the customer dashboard.\n\n`
          + `Do NOT push to main. Draft only. Atlas ships. When the code lands and a real signed envelope has metadata.`
          + `certificate_of_completion.hash_chain populated, this gate flips green automatically.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'signed_pdf_stored':
      return {
        agent: 'atlas',
        priority: 2,
        subject: `Dossie Sign signed PDF retrieval — ${form_code}`,
        brief: `Verify that signed ${form_code} PDFs are stored permanently in Supabase Storage and retrievable via the app.\n\n`
          + `Playwright: complete a signed envelope, then from the customer's app open the signed document. Confirm the file `
          + `downloads and is a valid signed PDF (contains DocuSeal signature blocks).\n\n`
          + `The webhook (api/esign-webhook.js) already downloads and stores. Confirm signature_requests.signed_document_id is `
          + `set and the documents row is retrievable. Report screenshots.`,
        gateMeta: { form_code, gate_key, docuseal_template_id },
      };

    case 'real_deal_closed':
      // Human-gated — should never reach here (skipped upstream)
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

  // Future build for HUD visibility
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

  // Agent queue insert
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

  // Stamp the row: dispatch_count++, cooldown, last_dispatched_at
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

// ─── Daily rollup + no-progress alert ─────────────────────────────────────────

async function maybeSendDailyRollup(counts) {
  // Only send at ~6am CDT (~11am UTC)
  const nowUtcHour = new Date().getUTCHours();
  if (nowUtcHour !== DAILY_ROLLUP_UTC_HOUR) return;

  // Was one sent already in the last 6 hours?
  const cutoff = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const r = await sb(`dossie_sign_dod_runs?select=id,metadata&metadata->>rollup_sent=eq.true&run_ts=gte.${encodeURIComponent(cutoff)}&limit=1`);
  if (r.ok && Array.isArray(r.data) && r.data.length > 0) return;

  // Compute delta vs 24h ago
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const r2 = await sb(`dossie_sign_dod_runs?select=green_count&run_ts=lte.${encodeURIComponent(dayAgo)}&order=run_ts.desc&limit=1`);
  const priorGreen = (r2.ok && Array.isArray(r2.data) && r2.data[0]) ? Number(r2.data[0].green_count) : 0;
  const delta = counts.green - priorGreen;

  // Fetch red gates for blocker list
  const rReds = await sb('dossie_sign_dod_progress?select=form_code,gate_key,gate_label,dispatch_count&status=eq.red&order=gate_weight.desc&limit=8');
  const reds = (rReds.ok && Array.isArray(rReds.data)) ? rReds.data : [];
  const blockerList = reds.length === 0
    ? 'None — all gates green or yellow.'
    : reds.map(r => `- ${r.form_code} / ${r.gate_label} (dispatched ${r.dispatch_count}x)`).join('\n');

  await tg(
    `<b>Dossie Sign — daily rollup (6am CDT)</b>\n\n`
    + `Overnight the Dossie Sign loop moved <b>${delta >= 0 ? '+' : ''}${delta}</b> gates to green.\n\n`
    + `Status: <b>${counts.green}/${counts.total}</b> green. `
    + `${counts.yellow} yellow. ${counts.red} red.\n\n`
    + `<b>Top red gates:</b>\n${blockerList}\n\n`
    + `Dashboard: https://meetdossie.com/admin-dossie-sign-progress.html`
  );

  // Mark rollup sent so we don't spam this hour
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
  if (counts.green > priorGreen) return; // progress made, no alert

  // Was the alert already sent recently?
  const alertCutoff = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const r2 = await sb(`dossie_sign_dod_runs?select=id,metadata&metadata->>no_progress_alert=eq.true&run_ts=gte.${encodeURIComponent(alertCutoff)}&limit=1`);
  if (r2.ok && Array.isArray(r2.data) && r2.data.length > 0) return;

  await tg(
    `<b>Dossie Sign loop: 24h no progress.</b>\n\n`
    + `Green count stuck at ${counts.green}/${counts.total} for 24 hours. Something is genuinely stuck. `
    + `Loop needs human review.\n\n`
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

    // 2) Refresh gate state from evidence sources
    const refreshResults = {};
    try { refreshResults.hadley = await refreshFromHadleyReports(rows); } catch (e) { refreshResults.hadley = { error: e.message }; }
    try { refreshResults.signatureRequests = await refreshFromSignatureRequests(rows); } catch (e) { refreshResults.signatureRequests = { error: e.message }; }
    try { refreshResults.agentQueue = await refreshFromAgentQueue(rows); } catch (e) { refreshResults.agentQueue = { error: e.message }; }

    // Re-read after refresh (rows array was mutated in-place; also re-query to
    // pick up any external writes since we started)
    const r2 = await sb('dossie_sign_dod_progress?select=*&order=gate_weight.desc,form_code.asc');
    if (r2.ok && Array.isArray(r2.data)) rows = r2.data;

    // 3) Count buckets
    const counts = {
      total: rows.length,
      green: rows.filter(r => r.status === 'green').length,
      yellow: rows.filter(r => r.status === 'yellow').length,
      red: rows.filter(r => r.status === 'red').length,
    };

    // 4) Mission complete? All green?
    if (counts.green === counts.total) {
      // Only send celebration once — check for a completion marker run
      const rDone = await sb(`dossie_sign_dod_runs?select=id&outcome=eq.skipped_all_green&metadata->>celebration_sent=eq.true&limit=1`);
      const alreadyCelebrated = rDone.ok && Array.isArray(rDone.data) && rDone.data.length > 0;

      if (!alreadyCelebrated) {
        await tg(
          `<b>Dossie Sign — MISSION COMPLETE.</b>\n\n`
          + `All 9 gates green across all 8 TREC forms. 72/72. Every gate.\n\n`
          + `Time to tag GOLD-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-dossie-sign-complete.\n\n`
          + `The loop will now exit on future ticks unless a gate regresses.`
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
        metadata: { celebration_sent: !alreadyCelebrated, refresh: refreshResults },
      });

      return res.status(200).json({
        ok: true,
        outcome: 'mission_complete',
        counts,
        celebration_sent: !alreadyCelebrated,
      });
    }

    // 5) Daily rollup + no-progress alert (fire-and-forget; doesn't block main pick)
    try { await maybeSendDailyRollup(counts); } catch (e) { console.warn('[loop] rollup err', e.message); }
    try { await maybeSendNoProgressAlert(counts); } catch (e) { console.warn('[loop] noprog err', e.message); }

    // 6) Pick the ONE lowest-hanging red gate (weighted). Human-gated rows are
    //    excluded — the loop cannot flip them. Rows on cooldown excluded. Rows
    //    dispatched > STUCK_GATE_THRESHOLD times excluded (surfaces separately).
    const now = Date.now();
    const stuckRows = [];
    const eligible = [];

    for (const row of rows) {
      if (row.status !== 'red') continue;
      if (row.human_gated) continue;
      if (row.cooldown_until && new Date(row.cooldown_until).getTime() > now) continue;
      if ((row.dispatch_count || 0) >= STUCK_GATE_THRESHOLD) {
        stuckRows.push(row);
        continue;
      }
      eligible.push(row);
    }

    // 7) If everything is stuck, telegram Heath + log
    if (eligible.length === 0 && stuckRows.length > 0) {
      const summary = stuckRows.slice(0, 5).map(r => `- ${r.form_code} / ${r.gate_label} (${r.dispatch_count}x)`).join('\n');
      await tg(
        `<b>Dossie Sign loop: all reds are stuck.</b>\n\n`
        + `${stuckRows.length} red gate(s) dispatched >${STUCK_GATE_THRESHOLD} times without moving to green.\n\n`
        + `${summary}\n\n`
        + `Loop needs human review. Dashboard: https://meetdossie.com/admin-dossie-sign-progress.html`
      );

      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        picked_form_code: stuckRows[0].form_code,
        picked_gate_key: stuckRows[0].gate_key,
        picked_gate_weight: stuckRows[0].gate_weight,
        outcome: 'skipped_no_red',
        outcome_reason: 'all_reds_stuck',
        duration_ms: Date.now() - startTs,
        metadata: { stuck_count: stuckRows.length, refresh: refreshResults },
      });

      return res.status(200).json({
        ok: true,
        outcome: 'all_stuck',
        counts,
        stuck: stuckRows.length,
      });
    }

    // 8) Nothing eligible AND nothing stuck → everything on cooldown; quiet exit
    if (eligible.length === 0) {
      await logRun({
        total_gates: counts.total,
        green_count: counts.green,
        yellow_count: counts.yellow,
        red_count: counts.red,
        outcome: 'skipped_cooldown',
        outcome_reason: 'all_red_gates_on_cooldown',
        duration_ms: Date.now() - startTs,
        metadata: { refresh: refreshResults },
      });
      return res.status(200).json({ ok: true, outcome: 'all_on_cooldown', counts });
    }

    // 9) Pick winner — already sorted by gate_weight DESC. Tiebreak by lowest
    //    dispatch_count (freshness), then lowest form_code (stable).
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
        + `Guardrail tripped: <code>${guardrail}</code>\n\n`
        + `Loop did NOT ship. Your call.`
      );
      // Cooldown-stamp so we don't ping every 20min
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
        metadata: { refresh: refreshResults },
      });
      return res.status(200).json({
        ok: true,
        outcome: 'skipped_guardrail',
        guardrail,
        picked: { form_code: winner.form_code, gate_key: winner.gate_key },
        counts,
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
        metadata: { refresh: refreshResults },
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
        refresh: refreshResults,
        dispatch_count: dispatchResult.dispatchCount,
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
      refresh: refreshResults,
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
