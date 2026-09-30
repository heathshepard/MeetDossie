// Vercel Serverless Function: /api/onboarding-extract-profile-defaults
//
// Onboarding step: "upload one past transaction, we'll fill in your
// defaults." The member uploads the Broker Information page of a past TREC
// contract and/or an IABS form; this extracts THEIR OWN agent-profile
// fields (license number, brokerage, designated broker, licensed
// supervisor + license, team name, office info) — never the deal's party
// data (sales price, buyer/seller names, property address).
//
// POST { files: [{ base64, fileName? }] }  (1-3 PDFs)
// -> { ok, extracted: { <field>: { value, confidence, source } }, validation, warnings }
//
// ── DATA HANDLING — READ BEFORE CHANGING THIS FILE ──────────────────────
// The uploaded PDF almost certainly contains a THIRD PARTY's personal data
// (a past client's name, address, sale price) who never consented to being
// in Dossie. This endpoint NEVER writes the uploaded PDF anywhere: no
// Supabase Storage upload, no `documents` row, no `transactions` row. The
// base64 exists only inside this request's memory for the single Anthropic
// call below, then falls out of scope when the function returns. The only
// thing persisted is `onboarding_document_extractions`, which by design
// holds field KEYS and a TREC validation summary — never PDF content, never
// a third party's name/address/price. See
// supabase/migrations/20260930d_onboarding_defaults_extraction.sql.
//
// This is a DIFFERENT extraction target than api/scan-contract.js, which
// extracts the DEAL's fields (and explicitly ignores "Licensed Supervisor
// of Associate" / license numbers on the broker-info block, since those
// aren't needed to contact someone about a live deal). This endpoint wants
// exactly the fields scan-contract.js throws away.

const Anthropic = require('@anthropic-ai/sdk');
const { validatePdfBase64, ValidationError } = require('./_middleware/validate');
const { checkRateLimit, RateLimitError, clientIpFromReq } = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { applyCorsHeaders } = require('./_middleware/cors');
const { logAnthropic } = require('./_lib/usage-logger.js');
const { repairTruncatedJson, identifyDocument } = require('./scan-contract.js');
const { validatePerson, validateSupervisorAgainstSponsor } = require('./_lib/trec-license-lookup.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const EXTRACT_MODEL = 'claude-sonnet-5';
const EXTRACT_MAX_TOKENS = 4096;
const MAX_FILES = 3;

const QUALIFYING_DOC_TYPES = new Set(['trec-20-17', 'iabs-form']);

function applyCors(req, res) {
  return applyCorsHeaders(req, res, { methods: 'POST, OPTIONS' });
}

function safeParseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    // 2026-09-30 — repairTruncatedJson() (api/scan-contract.js) already
    // returns a PARSED OBJECT (it calls JSON.parse() internally and
    // returns null on failure), not a JSON string. Re-wrapping its result
    // in JSON.parse() here always threw — "[object Object]" is not valid
    // JSON — so this fallback silently failed on every single call,
    // including the extremely common case of Claude wrapping its answer
    // in a ```json fence despite being told not to. Confirmed live: a
    // real extraction run found every field correctly (verified via the
    // raw response in Vercel logs) but still surfaced "Could not read
    // this document reliably" because of this double-parse.
    try {
      const repaired = repairTruncatedJson(text);
      return repaired && typeof repaired === 'object' ? repaired : null;
    } catch (_e2) {
      return null;
    }
  }
}

const FIELD_KEYS = [
  'agent_full_name', 'agent_license_number', 'agent_phone', 'agent_email',
  'broker_name', 'broker_license_number', 'broker_phone', 'broker_email',
  'broker_address_street', 'broker_address_city', 'broker_address_state', 'broker_address_zip',
  'designated_broker_name', 'designated_broker_license',
  'supervising_broker_name', 'supervising_broker_license', 'supervising_broker_phone',
  'team_name',
];

function buildExtractPrompt({ accountFullName, accountEmail, documentType }) {
  const docContext = documentType === 'iabs-form'
    ? `This is a TREC Information About Brokerage Services (IABS 1-0) form. It
has exactly four role lines — do NOT conflate them, they are four different
TREC-licensed roles:
  1. "Licensed Broker /Broker Firm Name" + "License No." — the BROKERAGE/FIRM itself -> broker_name, broker_license_number
  2. "Designated Broker of Firm" + "License No." — the INDIVIDUAL who is the firm's designated broker (may or may not be the same PERSON named in line 1, and is almost never the same as line 3) -> designated_broker_name, designated_broker_license
  3. "Licensed Supervisor of Sales Agent/Associate" + "License No." — the individual who DIRECTLY SUPERVISES the sales agent day to day. This is frequently a DIFFERENT person than the Designated Broker of Firm (a large brokerage has one designated broker and many supervisors). -> supervising_broker_name, supervising_broker_license
  4. "Sales Agent/Associate's Name" + "License No." — the agent themself -> agent_full_name, agent_license_number
Also extract the broker's phone/email and office address if printed, and any "Team Name" if present.`
    : `This is the Broker Information / Broker Contact Information page of a
Texas TREC residential contract (last page, "Print name(s) only. Do not
sign"). It has TWO blocks — a buyer's side and a listing side. Within
whichever block matches the account holder (see matching instructions
below), the labels map as:
  - "(Broker Firm)" or "Broker/Firm Name" -> broker_name
  - "License No." next to the firm -> broker_license_number
  - "Licensed Supervisor of Associate" + its "License No." -> supervising_broker_name, supervising_broker_license (this is a DIFFERENT role than any "Designated Broker" language — if the page does not separately label a "Designated Broker of Firm," leave designated_broker_name/designated_broker_license null rather than guessing)
  - "Associate's Name" -> agent_full_name
  - "Associate's License No." or a license number printed next to the associate -> agent_license_number
  - "Associate's Email" -> agent_email
  - "Associate's Phone No." -> agent_phone
  - "Team Name" -> team_name
  - The office street/city/state/zip printed for that block -> broker_address_street/city/state/zip
IGNORE the page footer entirely (the Lone Wolf/zipForm "Produced with..."
line and the office that PRODUCED the document) — that is not necessarily
the same as the broker block's own firm.`;

  return `You are extracting ONE Texas real estate agent's OWN professional
identity fields from an uploaded document, for an onboarding flow that
turns them into that agent's saved defaults. You are NOT extracting deal
information (no sales price, no property address, no buyer/seller names,
no dates) — ignore all of that even if present elsewhere in the document.

${docContext}

MATCHING — CRITICAL: This document may name TWO different agents (a buyer's
side and a listing side) or may belong to someone else entirely. The
account holder we are extracting defaults FOR is:
  Name: "${accountFullName || '(not provided)'}"
  Email: "${accountEmail || '(not provided)'}"

Find the block/role-4 line whose name or email reasonably matches the
account holder above (allow for minor spelling variation, nicknames,
missing middle names). Extract ONLY from that person's block. If you
cannot find a block that plausibly matches this person anywhere in the
document, set "matchFound": false, leave every field null, and explain why
in "matchReasoning" (e.g. "Document shows Jane Doe and John Smith as the
two agents; neither name resembles the account holder").

Return ONLY a JSON object, no markdown, in this exact shape:
{
  "matchFound": boolean,
  "matchReasoning": "<one sentence>",
  "fields": {
    "agent_full_name": { "value": string|null, "confidence": 0-1 },
    "agent_license_number": { "value": string|null, "confidence": 0-1 },
    "agent_phone": { "value": string|null, "confidence": 0-1 },
    "agent_email": { "value": string|null, "confidence": 0-1 },
    "broker_name": { "value": string|null, "confidence": 0-1 },
    "broker_license_number": { "value": string|null, "confidence": 0-1 },
    "broker_phone": { "value": string|null, "confidence": 0-1 },
    "broker_email": { "value": string|null, "confidence": 0-1 },
    "broker_address_street": { "value": string|null, "confidence": 0-1 },
    "broker_address_city": { "value": string|null, "confidence": 0-1 },
    "broker_address_state": { "value": string|null, "confidence": 0-1 },
    "broker_address_zip": { "value": string|null, "confidence": 0-1 },
    "designated_broker_name": { "value": string|null, "confidence": 0-1 },
    "designated_broker_license": { "value": string|null, "confidence": 0-1 },
    "supervising_broker_name": { "value": string|null, "confidence": 0-1 },
    "supervising_broker_license": { "value": string|null, "confidence": 0-1 },
    "supervising_broker_phone": { "value": string|null, "confidence": 0-1 },
    "team_name": { "value": string|null, "confidence": 0-1 }
  }
}

Rules:
- Confidence reflects how clearly the field is printed/legible, not how
  important it is. A blank/absent field is { "value": null, "confidence": 0 }.
- Never invent a value. If a role isn't printed on this document at all
  (e.g. no "Designated Broker of Firm" line exists on a contract's broker
  page), return null, not a guess.
- License numbers: transcribe exactly as printed, including any letter
  suffix (e.g. "9014162-BB" or "751964"). Do not reformat.`;
}

async function extractFromFile(pdfBase64, accountFullName, accountEmail) {
  const id = await identifyDocument(pdfBase64);
  if (!QUALIFYING_DOC_TYPES.has(id.documentType)) {
    return {
      documentType: id.documentType,
      qualifying: false,
      matchFound: false,
      fields: {},
      warning: `This file looks like "${id.documentType}", not a contract broker-info page or an IABS form — skipped.`,
    };
  }

  const prompt = buildExtractPrompt({ accountFullName, accountEmail, documentType: id.documentType });
  const response = await anthropic.messages.create({
    model: EXTRACT_MODEL,
    max_tokens: EXTRACT_MAX_TOKENS,
    thinking: { type: 'disabled' },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
  });
  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const parsed = safeParseJson(textBlock ? textBlock.text : '');
  if (!parsed || typeof parsed !== 'object') {
    // 2026-09-30 — kept as a permanent (not temp) diagnostic. This branch
    // used to be unreachable-in-practice-but-actually-hit-constantly due
    // to the safeParseJson double-parse bug (see above); logging the raw
    // text is cheap and is the only way to see what a genuine future
    // parse failure actually looked like.
    console.error('[onboarding-extract-profile-defaults] JSON parse failed. Raw text:',
      textBlock ? textBlock.text.slice(0, 1000) : '(no text block)');
    return {
      documentType: id.documentType,
      qualifying: true,
      matchFound: false,
      fields: {},
      warning: 'Could not read this document reliably — try re-uploading a clearer scan.',
    };
  }
  return {
    documentType: id.documentType,
    qualifying: true,
    matchFound: parsed.matchFound === true,
    matchReasoning: typeof parsed.matchReasoning === 'string' ? parsed.matchReasoning : '',
    fields: (parsed.fields && typeof parsed.fields === 'object') ? parsed.fields : {},
    usage: response.usage || null,
  };
}

// Merge per-field results across multiple uploaded files, preferring the
// higher-confidence non-null value and recording where it came from.
function mergeFileResults(fileResults) {
  const merged = {};
  for (const key of FIELD_KEYS) merged[key] = { value: null, confidence: 0, source: null };

  fileResults.forEach((r, idx) => {
    if (!r.matchFound) return;
    const label = r.documentType === 'iabs-form' ? 'IABS form' : 'contract broker info page';
    const sourceLabel = fileResults.length > 1 ? `${label} (file ${idx + 1})` : label;
    for (const key of FIELD_KEYS) {
      const f = r.fields[key];
      if (!f || f.value == null || f.value === '') continue;
      const conf = typeof f.confidence === 'number' ? f.confidence : 0;
      if (conf >= merged[key].confidence) {
        merged[key] = { value: String(f.value).trim(), confidence: conf, source: sourceLabel };
      }
    }
  });
  return merged;
}

async function fetchAccountIdentity(userId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=full_name,email&limit=1`,
    { headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` } },
  );
  if (!res.ok) return { full_name: null, email: null };
  const rows = await res.json().catch(() => []);
  return (Array.isArray(rows) && rows[0]) || { full_name: null, email: null };
}

async function logExtractionAudit({ userId, docTypes, fieldsFound, trecSummary }) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/onboarding_document_extractions`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        user_id: userId,
        source_document_types: docTypes,
        fields_found: fieldsFound,
        fields_confirmed: [],
        trec_validation_summary: trecSummary,
        documents_retained: false,
      }),
    });
    // 2026-09-30 — this previously only caught network-level throws. A
    // non-2xx PostgREST response (bad payload, FK violation, etc.) was
    // silently swallowed and the audit row just never appeared, with no
    // trace anywhere. Log the body so a real failure is visible in Vercel
    // function logs instead of looking identical to "worked."
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[onboarding-extract-profile-defaults] audit log insert non-ok:', res.status, text.slice(0, 500));
    }
  } catch (err) {
    console.error('[onboarding-extract-profile-defaults] audit log insert failed (non-fatal):', err && err.message);
  }
}

async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });

  try {
    let userId;
    try {
      const authResult = await verifySupabaseToken(req);
      userId = authResult.userId;
    } catch (authErr) {
      return res.status(authErr.status || 401).json({ ok: false, error: authErr.message });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'Server configuration error.' });
    }

    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'onboarding-extract-profile-defaults', 10, 60 * 60 * 1000);

    const body = req.body || {};
    const files = Array.isArray(body.files) ? body.files.slice(0, MAX_FILES) : null;
    if (!files || files.length === 0) {
      return res.status(400).json({ ok: false, error: 'files (array of { base64 }) is required — at least one PDF.' });
    }

    const pdfBase64List = [];
    for (const f of files) {
      try {
        validatePdfBase64(f && f.base64);
      } catch (ve) {
        return res.status(400).json({ ok: false, error: `Invalid file: ${ve.message}` });
      }
      pdfBase64List.push(f.base64);
    }

    const account = await fetchAccountIdentity(userId);

    // Sequential, not parallel — keeps Anthropic concurrency/cost bounded
    // for what is at most a 3-file onboarding step, and each file's result
    // is independent so a slow/failed one doesn't need the others retried.
    const fileResults = [];
    for (const pdfBase64 of pdfBase64List) {
      // eslint-disable-next-line no-await-in-loop
      const r = await extractFromFile(pdfBase64, account.full_name, account.email);
      fileResults.push(r);
    }
    // pdfBase64List and `files` are not referenced again after this point —
    // nothing from the uploaded PDFs is written anywhere below.

    const merged = mergeFileResults(fileResults);
    const warnings = fileResults
      .map((r, idx) => {
        if (r.warning) return r.warning;
        if (r.qualifying && !r.matchFound) {
          return `File ${idx + 1}: ${r.matchReasoning || "couldn't confirm this document belongs to your account — nothing extracted from it."}`;
        }
        return null;
      })
      .filter(Boolean);

    // TREC validation — the mandatory cross-check against the public
    // license record, not a silent trust of whatever the PDF says.
    const agentLicense = merged.agent_license_number.value;
    const [agentCheck, supervisorCheck, brokerCheck, sponsorCheck] = await Promise.all([
      validatePerson({ licenseNumber: agentLicense, fullName: merged.agent_full_name.value || account.full_name }),
      validatePerson({ licenseNumber: merged.supervising_broker_license.value, fullName: merged.supervising_broker_name.value }),
      validatePerson({ licenseNumber: merged.designated_broker_license.value || merged.broker_license_number.value, fullName: merged.designated_broker_name.value }),
      validateSupervisorAgainstSponsor({
        agentLicenseNumber: agentLicense,
        extractedSupervisorLicense: merged.supervising_broker_license.value,
      }),
    ]);

    const validation = {
      agent_license_number: agentCheck,
      supervising_broker_license: supervisorCheck,
      designated_broker_license: brokerCheck,
      supervisor_matches_trec_sponsor: sponsorCheck,
    };

    if (sponsorCheck.status === 'mismatch') {
      warnings.push(sponsorCheck.detail);
    }

    const fieldsFound = FIELD_KEYS.filter((k) => merged[k].value != null);
    const docTypes = fileResults.map((r) => r.documentType);

    // 2026-09-30 — MUST be awaited, not fire-and-forget. This endpoint runs
    // on Vercel's standard (non-streaming) Node runtime, which is free to
    // freeze/suspend the execution context the instant res.json() flushes
    // the response -- an un-awaited promise started before that point has
    // no guarantee of ever finishing. Confirmed live: with this un-awaited,
    // the client got a normal 200 and a correct warnings array, but ZERO
    // rows ever landed in onboarding_document_extractions across repeated
    // real runs, with no error anywhere (the fetch was simply abandoned
    // mid-flight). This audit table is the only record of what a member's
    // uploaded document was used for, so losing writes to it silently is
    // not an acceptable "non-fatal" background task.
    await logExtractionAudit({
      userId,
      docTypes,
      fieldsFound,
      trecSummary: {
        agent_license: agentCheck.status,
        supervisor: supervisorCheck.status,
        designated_broker: brokerCheck.status,
        supervisor_vs_sponsor: sponsorCheck.status,
      },
    });

    if (userId) {
      const totalUsage = fileResults.reduce((acc, r) => {
        if (!r.usage) return acc;
        acc.input_tokens += r.usage.input_tokens || 0;
        acc.output_tokens += r.usage.output_tokens || 0;
        return acc;
      }, { input_tokens: 0, output_tokens: 0 });
      await logAnthropic(userId, 'onboarding-extract-defaults', totalUsage, EXTRACT_MODEL, {
        file_count: files.length,
      }).catch((err) => console.error('[onboarding-extract-profile-defaults] usage log failed:', err));
    }

    return res.status(200).json({
      ok: true,
      extracted: merged,
      validation,
      warnings,
      retained: false,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      return res.status(429).json({ ok: false, error: err.message });
    }
    if (err instanceof ValidationError) {
      return res.status(400).json({ ok: false, error: err.message });
    }
    console.error('[onboarding-extract-profile-defaults] Uncaught error:', err && err.message);
    return res.status(500).json({ ok: false, error: 'Internal server error' });
  }
}

module.exports = handler;
module.exports.default = handler;
