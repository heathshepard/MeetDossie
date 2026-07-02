// Vercel Serverless Function: /api/ask-hadley
// Answers TREC/Texas-RE questions using Hadley's knowledge base.
//
// POST /api/ask-hadley
// {
//   question: string,
//   context?: { form?: "TREC 20-19", paragraph?: "12.A.(1)(b)" }
// }
//
// Returns:
// {
//   ok: true,
//   answer: string,
//   citations: [{ source: string, url?: string, section?: string }],
//   knowledge_file_used: string,
//   classifier_used?: boolean,   // true when smart-fallback picked the form
//   low_confidence?: boolean
// }
//
// Knowledge base coverage (as of 2026-07-01):
//   - Master residential resale: TREC 20-19 (current), TREC 20-18 (superseded)
//   - Farm & ranch: TREC 25-17
//   - Condo resale: TREC 30-19
//   - Financing addenda: TREC 40-11 (TPF), TREC 41-3 (Loan Assumption), TREC 49-1
//     (lender appraisal), TREC 26-8 (seller financing), TREC 12-3 (VA/release)
//   - Amendment + termination: TREC 39-11, TREC 38-7
//   - Property condition + disclosures: TREC 55-1 (SDN), TREC 56-0 (LBP),
//     TREC 36-11 (POA), TREC 61-0 (water rights)
//   - Land + environmental + minerals: TREC 44-3 (minerals), TREC 47-0 (propane),
//     TREC 48-1 (hydrostatic), TREC 53-0 (improvement district), TREC 59-0
//     (special taxing district), TREC 33-2 (coastal), TREC 34-4 (seaward)
//   - Back-up + contingency: TREC 11-9, TREC 10-6
//   - Temporary leases: TREC 15-6 (Seller), TREC 16-6 (Buyer)
//   Total: 26 forms.
//
// Smart fallback: if the caller omits context.form, a classifier picks the
// most-relevant form from the question text before loading the KB.
//
// Authorization: Bearer <supabase user JWT>

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { messagesCreateCached } = require('./_lib/spawn-with-cache');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '*';
  res.setHeader('Access-Control-Allow-Origin', origin === '*' ? '*' : origin);
  if (origin !== '*') {
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  return true;
}

// In-repo knowledge base — synced from Shepard-Ventures/Legal/TREC-Forms-Knowledge/
// at build time so it ships in the Vercel bundle (Desktop paths don't exist there).
//
// Vercel serverless functions run from /var/task/api/, so `__dirname` is
// `/var/task/api`. The data folder is bundled at `/var/task/data/...`.
const KNOWLEDGE_BASE_PATH = path.join(__dirname, '..', 'data', 'hadley-knowledge');

// Form name mapping: TREC form slug -> markdown filename
// Expanded 2026-07-01 by hadley_2: full residential + rental + land coverage.
// Each form has multiple aliases (with and without "TREC " prefix, common
// misspellings, etc.) so the customer can pass "TREC 40-11", "40-11", or
// "third party financing" and still hit the right file.
const FORM_FILES = {
  // Master residential resale contracts
  'TREC 20-19': 'trec-20-19.md',
  '20-19': 'trec-20-19.md',
  'TREC 20-18': 'trec-20-18.md',
  '20-18': 'trec-20-18.md',
  // Master contracts — other verticals
  'TREC 25-17': 'trec-25-17.md',
  '25-17': 'trec-25-17.md',
  'TREC 30-19': 'trec-30-19.md',
  '30-19': 'trec-30-19.md',
  // Financing addenda
  'TREC 40-11': 'trec-40-11.md',
  '40-11': 'trec-40-11.md',
  'TREC 41-3': 'trec-41-3.md',
  '41-3': 'trec-41-3.md',
  'TREC 49-1': 'trec-49-1.md',
  '49-1': 'trec-49-1.md',
  'TREC 26-8': 'trec-26-8.md',
  '26-8': 'trec-26-8.md',
  'TREC 12-3': 'trec-12-3.md',
  '12-3': 'trec-12-3.md',
  // Amendment + termination
  'TREC 39-11': 'trec-39-11.md',
  '39-11': 'trec-39-11.md',
  'TREC 38-7': 'trec-38-7.md',
  '38-7': 'trec-38-7.md',
  // Property condition / disclosure
  'TREC 55-1': 'trec-55-1.md',
  '55-1': 'trec-55-1.md',
  'TREC 56-0': 'trec-56-0.md',
  '56-0': 'trec-56-0.md',
  'TREC 36-11': 'trec-36-11.md',
  '36-11': 'trec-36-11.md',
  'TREC 61-0': 'trec-61-0.md',
  '61-0': 'trec-61-0.md',
  // Land + mineral + environmental
  'TREC 44-3': 'trec-44-3.md',
  '44-3': 'trec-44-3.md',
  'TREC 47-0': 'trec-47-0.md',
  '47-0': 'trec-47-0.md',
  'TREC 48-1': 'trec-48-1.md',
  '48-1': 'trec-48-1.md',
  'TREC 53-0': 'trec-53-0.md',
  '53-0': 'trec-53-0.md',
  'TREC 59-0': 'trec-59-0.md',
  '59-0': 'trec-59-0.md',
  // Coastal / seaward
  'TREC 33-2': 'trec-33-2.md',
  '33-2': 'trec-33-2.md',
  'TREC 34-4': 'trec-34-4.md',
  '34-4': 'trec-34-4.md',
  // Back-up + contingency
  'TREC 11-9': 'trec-11-9.md',
  '11-9': 'trec-11-9.md',
  'TREC 10-6': 'trec-10-6.md',
  '10-6': 'trec-10-6.md',
  // Temporary residential leases
  'TREC 15-6': 'trec-15-6.md',
  '15-6': 'trec-15-6.md',
  'TREC 16-6': 'trec-16-6.md',
  '16-6': 'trec-16-6.md',
  // hadley_3 additions 2026-07-01 — short sale / 1031 / back-up removal / notice-to-buyer / non-realty
  'TREC 45-2': 'trec-45-2.md',
  '45-2': 'trec-45-2.md',
  'TREC 60-0': 'trec-60-0.md',
  '60-0': 'trec-60-0.md',
  'TREC 62-0': 'trec-62-0.md',
  '62-0': 'trec-62-0.md',
  'TREC 57-0': 'trec-57-0.md',
  '57-0': 'trec-57-0.md',
  'TREC OP-M': 'trec-op-m.md',
  'OP-M': 'trec-op-m.md',
};

// Reverse mapping — filename -> canonical form label (for smart fallback).
// Only the first-listed slug per file is treated as canonical.
const CANONICAL_FORM_BY_FILE = {
  'trec-20-19.md': 'TREC 20-19',
  'trec-20-18.md': 'TREC 20-18',
  'trec-25-17.md': 'TREC 25-17',
  'trec-30-19.md': 'TREC 30-19',
  'trec-40-11.md': 'TREC 40-11',
  'trec-41-3.md': 'TREC 41-3',
  'trec-49-1.md': 'TREC 49-1',
  'trec-26-8.md': 'TREC 26-8',
  'trec-12-3.md': 'TREC 12-3',
  'trec-39-11.md': 'TREC 39-11',
  'trec-38-7.md': 'TREC 38-7',
  'trec-55-1.md': 'TREC 55-1',
  'trec-56-0.md': 'TREC 56-0',
  'trec-36-11.md': 'TREC 36-11',
  'trec-61-0.md': 'TREC 61-0',
  'trec-44-3.md': 'TREC 44-3',
  'trec-47-0.md': 'TREC 47-0',
  'trec-48-1.md': 'TREC 48-1',
  'trec-53-0.md': 'TREC 53-0',
  'trec-59-0.md': 'TREC 59-0',
  'trec-33-2.md': 'TREC 33-2',
  'trec-34-4.md': 'TREC 34-4',
  'trec-11-9.md': 'TREC 11-9',
  'trec-10-6.md': 'TREC 10-6',
  'trec-15-6.md': 'TREC 15-6',
  'trec-16-6.md': 'TREC 16-6',
  // hadley_3 additions
  'trec-45-2.md': 'TREC 45-2',
  'trec-60-0.md': 'TREC 60-0',
  'trec-62-0.md': 'TREC 62-0',
  'trec-57-0.md': 'TREC 57-0',
  'trec-op-m.md': 'TREC OP-M',
};

// Short one-line purpose for each form — used by the smart fallback classifier
// so the model can pick the right form without loading full KB content.
const FORM_PURPOSES = {
  'TREC 20-19': 'Master residential resale contract for 1-4 family property (effective 2026-07-01, supersedes 20-18)',
  'TREC 20-18': 'Prior master residential resale contract (superseded by 20-19 on 2026-07-01, still valid for pre-July-1 executed contracts)',
  'TREC 25-17': 'Farm and Ranch Contract — master purchase contract for rural/agricultural property, farms, ranches, hunting properties',
  'TREC 30-19': 'Residential Condominium Contract (Resale) — master purchase contract for resale of condo units',
  'TREC 40-11': 'Third Party Financing Addendum — attached when buyer uses a lender (conventional, FHA, VA, USDA, VLB, reverse)',
  'TREC 41-3': "Loan Assumption Addendum — attached when buyer assumes seller's existing loan(s)",
  'TREC 49-1': "Addendum Concerning Right to Terminate Due to Lender's Appraisal — buyer's protection when appraisal comes in below sales price",
  'TREC 26-8': 'Seller Financing Addendum — attached when seller carries the note (seller-carry)',
  'TREC 12-3': "Addendum for Release of Liability on Assumed Loan / Restoration of Seller's VA Entitlement — sits on top of 41-3 for lender-release + VA restoration",
  'TREC 39-11': 'Amendment to Contract — any post-execution change (price, date, repairs, financing terms, option extension, financing deadline extension)',
  'TREC 38-7': "Notice of Buyer's Termination of Contract — buyer's formal termination notice under a specific paragraph right",
  'TREC 55-1': "Seller's Disclosure Notice — statutory Prop. Code §5.008 disclosure (effective 2026-05-28, supersedes OP-H)",
  'TREC 56-0': 'Lead-Based Paint Addendum — federal 24 CFR §35 disclosure for pre-1978 dwellings (effective 2026-07-01, supersedes OP-L)',
  'TREC 36-11': 'POA/HOA Addendum — Subdivision Information disclosure for property in mandatory Property Owners Association',
  'TREC 61-0': "Seller's Disclosure about Groundwater and Surface Water Rights — water wells, groundwater district, surface water permits, ponds/tanks (effective 2026-07-01)",
  'TREC 44-3': "Addendum for Reservation of Oil, Gas, and Other Minerals — seller reserves all or part of the Mineral Estate",
  'TREC 47-0': 'Addendum for Property in a Propane Gas System Service Area — required disclosure when property is served by a propane gas system',
  'TREC 48-1': 'Addendum for Authorizing Hydrostatic Testing — buyer authorized to conduct hydrostatic testing of plumbing',
  'TREC 53-0': 'Addendum Containing Notice of Obligation to Pay Improvement District Assessment — improvement district (PID/MUD) assessment disclosure',
  'TREC 59-0': 'Notice to Purchaser of Special Taxing or Assessment District — special-district taxing/assessment notice',
  'TREC 33-2': 'Addendum for Coastal Area Property — Texas coastal area disclosure (Natural Resources Code §33.135)',
  'TREC 34-4': 'Addendum for Property Located Seaward of the Gulf Intercoastal Waterway — seaward-of-GIW notice',
  'TREC 11-9': 'Back-Up Contract Addendum — back-up buyer position behind primary contract (effective 2026-07-01, supersedes 11-7)',
  'TREC 10-6': 'Sale of Other Property Addendum — buyer contingent on selling their other property (with kick-out clause)',
  'TREC 15-6': "Seller's Temporary Residential Lease — seller stays post-closing",
  'TREC 16-6': "Buyer's Temporary Residential Lease — buyer occupies pre-closing",
  'TREC 45-2': "Short Sale Addendum — attached when seller's net proceeds won't cover the mortgage payoff and lienholder consent + shortfall acceptance + recordable release are required",
  'TREC 60-0': 'Addendum for Section 1031 Exchange — attached when Buyer or Seller intends to use the property in a like-kind exchange under IRC §1031',
  'TREC 62-0': "Seller's Notice to Buyer of Removal of Contingency Under Addendum for Back-Up Contract — Seller notifies Back-Up Buyer that the First Contract has terminated and the Back-Up is now primary (companion to TREC 11-9/38-7)",
  'TREC 57-0': 'Notice to Prospective Buyer — title advisory (abstract vs. title insurance) + MUD/PID reminder for transactions OUTSIDE the standard TREC promulgated forms; broker-signed; replaces OP-C',
  'TREC OP-M': "Non-Realty Items Addendum — voluntary-use form to convey specifically-identified personal property (refrigerator, washer/dryer, furniture, etc.) not already covered by ¶2.C Accessories, with Seller's warranty of clear title but no condition warranty",
};

// Load knowledge file content — sync at cold-start, cached module-scope.
const knowledgeCache = new Map();

function loadKnowledgeFile(formName) {
  const filename = FORM_FILES[formName];
  if (!filename) {
    return null;
  }

  if (knowledgeCache.has(filename)) {
    return knowledgeCache.get(filename);
  }

  try {
    const filepath = path.join(KNOWLEDGE_BASE_PATH, filename);
    const content = fs.readFileSync(filepath, 'utf-8');
    knowledgeCache.set(filename, content);
    return content;
  } catch (err) {
    console.error(`[ask-hadley] Failed to load ${filename}:`, err.message);
    return null;
  }
}

// Preload the current knowledge base at module init
function preloadKnowledge() {
  const filenames = Array.from(new Set(Object.values(FORM_FILES)));
  for (const filename of filenames) {
    try {
      const filepath = path.join(KNOWLEDGE_BASE_PATH, filename);
      if (fs.existsSync(filepath)) {
        const content = fs.readFileSync(filepath, 'utf-8');
        knowledgeCache.set(filename, content);
        console.log(`[ask-hadley] Preloaded ${filename}`);
      } else {
        console.warn(`[ask-hadley] Knowledge file not found at cold-start: ${filepath}`);
      }
    } catch (err) {
      console.warn(`[ask-hadley] Could not preload ${filename}:`, err.message);
    }
  }
}

preloadKnowledge();

// Smart fallback classifier — when the user asks a question WITHOUT specifying
// a form via context.form, ask the model which form(s) are relevant based on
// the question text. Returns the canonical form label (e.g., "TREC 40-11") or
// null if the model can't confidently identify one.
//
// Uses the same anthropic client as the main answer path; cheaper Sonnet call
// since we only need the model to pick a form-code, not to answer the full
// question. Falls back to "TREC 20-19" (the master residential contract) if
// the model returns something unrecognized — that's the safe default because
// 90% of ambiguous questions are actually about the master contract.
async function identifyFormFromQuestion(question, userId) {
  try {
    const catalog = Object.entries(FORM_PURPOSES)
      .map(([form, purpose]) => `- ${form}: ${purpose}`)
      .join('\n');

    const systemStatic = `You are a Texas real estate contract classifier. Your job is to identify which TREC form is most likely being asked about, based on a user question.

Available forms:
${catalog}

Rules:
- Respond with ONLY the canonical form label (e.g., "TREC 40-11") on a single line, nothing else.
- If the question could apply to multiple forms, pick the SINGLE most-likely form.
- If the question is clearly about the master residential contract but doesn't specify 20-18 vs 20-19, default to "TREC 20-19" (the current-effective form).
- If the question is off-topic or cannot be classified, respond with exactly "UNCLASSIFIED".`;

    const response = await messagesCreateCached(anthropic, {
      model: 'claude-sonnet-4-6',
      max_tokens: 20,
      systemStatic,
      messages: [
        { role: 'user', content: `Question: ${question}\n\nWhich TREC form?` },
      ],
      metadata: { endpoint: 'ask-hadley-classifier', agent_role: 'hadley', user_id: userId },
    });

    const textBlock = response.content?.find((b) => b.type === 'text');
    const raw = (textBlock?.text || '').trim();

    // Look for a match against the catalog labels
    for (const canonical of Object.keys(FORM_PURPOSES)) {
      if (raw.includes(canonical)) {
        return canonical;
      }
    }

    // Nothing matched — return null so caller can decide fallback behavior
    return null;
  } catch (err) {
    console.warn('[ask-hadley] identifyFormFromQuestion failed:', err.message);
    return null;
  }
}

async function answerWithHadley(question, knowledgeContent, formName, userId) {
  // STATIC portion — persona + the entire knowledge-base content.
  // The KB is the largest input and is byte-identical across calls (it's
  // loaded from a markdown file at cold-start), so it's a perfect cache
  // target. First call writes the cache (~1.25x cost on KB tokens); every
  // subsequent question within 5 min reads it at ~10% of input cost.
  //
  // We embed the form name into the persona text — note that swapping
  // forms (TREC 20-18 vs another form) yields a different prefix and a
  // separate cache entry, which is correct.
  const systemStatic = `You are Hadley, Head of General Counsel for Dossie. You are a licensed Texas REALTOR with deep expertise in TREC contract forms and Texas real estate law.

You will answer the user's question USING ONLY the knowledge base content provided below. You must cite every claim using specific references to:
- TAC (Texas Administrative Code) sections — write as (TAC §537.28)
- TRELA (Texas Real Estate License Act) sections — write as (TRELA §1101.155)
- Texas Property Code — write as (Tex. Prop. Code §5.008)
- TREC bulletins and form documentation
- TREC form paragraph references — write as (TREC ${formName} ¶12.A.(1)(b))

If the knowledge base does not contain sufficient information to answer the question, state explicitly: "I don't have that information in my current knowledge base. This would require further research." — and do NOT fabricate citations.

If the question is off-topic (not about Texas real estate or TREC forms), politely decline and suggest the user ask something on-topic.

Never invent or assume facts. Answer in plain English (1-3 paragraphs), structured and clear. Include parenthetical citations inline.

Knowledge base (${formName}):
${knowledgeContent}`;

  const response = await messagesCreateCached(anthropic, {
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    systemStatic,
    messages: [
      { role: 'user', content: `Question: ${question}` },
    ],
    metadata: { endpoint: 'ask-hadley', agent_role: 'hadley', user_id: userId, form: formName },
  });

  const textBlock = response.content?.find((b) => b.type === 'text');
  const answerText = textBlock?.text || '';

  // Extract citations: TAC §X, TRELA §X, Tex. Prop. Code §X, TREC <form> ¶X
  const patterns = [
    /\(TAC\s+§([\d\.\-]+)\)/g,
    /\(TRELA\s+§([\d\.\-]+)\)/g,
    /\(Tex\.\s+Prop\.\s+Code\s+§([\d\.\-]+)\)/g,
    /\(TREC\s+(\d{1,3}-\d{1,3})\s+¶([\d\.\(\)A-Za-z]+)\)/g,
  ];

  const citations = [];
  const seen = new Set();
  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(answerText)) !== null) {
      let source;
      let section;
      if (pattern.source.startsWith('\\(TAC')) {
        source = `TAC §${m[1]}`;
        section = m[1];
      } else if (pattern.source.startsWith('\\(TRELA')) {
        source = `TRELA §${m[1]}`;
        section = m[1];
      } else if (pattern.source.startsWith('\\(Tex')) {
        source = `Tex. Prop. Code §${m[1]}`;
        section = m[1];
      } else {
        source = `TREC ${m[1]} ¶${m[2]}`;
        section = `${m[1]} ¶${m[2]}`;
      }
      if (!seen.has(source)) {
        seen.add(source);
        citations.push({ source, section });
      }
    }
  }

  // Low confidence if no citations were found OR if Hadley explicitly declined
  const lowConfidenceDeclineRe = /I don't have that information in my current knowledge base/i;
  const lowConfidence = citations.length === 0 || lowConfidenceDeclineRe.test(answerText);

  return {
    answer: answerText,
    citations: citations.slice(0, 5),
    low_confidence: lowConfidence,
  };
}

function getAdminClient() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function insertUnansweredQuestion(supabase, userId, question, formContext) {
  if (!supabase) return;
  try {
    const { error } = await supabase
      .from('hadley_unanswered_questions')
      .insert({
        customer_user_id: userId,
        question_text: question,
        form_context: formContext || null,
        asked_at: new Date().toISOString(),
      });

    if (error) {
      console.warn('[ask-hadley] Failed to insert unanswered question:', error.message);
    }
  } catch (err) {
    console.warn('[ask-hadley] Error inserting unanswered question:', err.message);
  }
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed. Use POST.',
    });
  }

  try {
    // JWT auth
    let userId;
    try {
      const authResult = await verifySupabaseToken(req);
      userId = authResult.userId;
    } catch (authErr) {
      return res.status(authErr.status || 401).json({
        ok: false,
        error: authErr.message,
      });
    }

    const { question, context } = req.body || {};

    if (!question || typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Question is required and must be a non-empty string.',
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('[ask-hadley] ANTHROPIC_API_KEY not configured');
      return res.status(500).json({
        ok: false,
        error: 'Server configuration error.',
      });
    }

    // Determine which knowledge file to use.
    //
    // Priority:
    //   1. If caller passed context.form and we have a KB for it -> use it.
    //   2. If caller passed context.form and we do NOT have a KB for it -> polite decline.
    //   3. If caller did NOT pass context.form -> use the smart-fallback classifier
    //      to identify the most-relevant form from the question text, then load
    //      that KB. If classifier fails, default to TREC 20-19 (current-effective
    //      master residential contract).
    const requestedForm = context?.form ? String(context.form).trim() : null;

    // Graceful fallback for a requested form we don't have — log + polite decline.
    if (requestedForm && !FORM_FILES[requestedForm]) {
      const supabase = getAdminClient();
      const formContext = context?.paragraph ? `${requestedForm} ${context.paragraph}` : requestedForm;
      await insertUnansweredQuestion(supabase, userId, question.trim(), formContext);
      return res.status(200).json({
        ok: true,
        answer: `I haven't studied ${requestedForm} yet, so I can't answer questions about it with the confidence I want. Your question has been logged for my next study pass.`,
        citations: [],
        knowledge_file_used: null,
        low_confidence: true,
      });
    }

    let formName;
    let classifierUsed = false;
    if (requestedForm) {
      formName = requestedForm;
    } else {
      // No form specified — ask the classifier to pick one from the question
      const classified = await identifyFormFromQuestion(question.trim(), userId);
      if (classified && FORM_FILES[classified]) {
        formName = classified;
        classifierUsed = true;
      } else {
        // Classifier couldn't decide — fall back to master residential contract
        formName = 'TREC 20-19';
      }
    }

    const knowledgeContent = loadKnowledgeFile(formName);

    if (!knowledgeContent) {
      return res.status(503).json({
        ok: false,
        error: `Knowledge base for ${formName} is not yet available.`,
      });
    }

    const result = await answerWithHadley(question.trim(), knowledgeContent, formName, userId);

    // If low confidence, log for later study pass. AWAIT to ensure the row
    // commits before the function terminates.
    if (result.low_confidence) {
      const supabase = getAdminClient();
      const formContext = context?.paragraph
        ? `${formName} ${context.paragraph}`
        : formName;
      await insertUnansweredQuestion(supabase, userId, question.trim(), formContext);
    }

    return res.status(200).json({
      ok: true,
      answer: result.answer,
      citations: result.citations || [],
      knowledge_file_used: formName,
      classifier_used: classifierUsed,
      low_confidence: result.low_confidence || false,
    });
  } catch (error) {
    console.error('[ask-hadley] Error:', error);

    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({
        ok: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      ok: false,
      error: 'Failed to generate answer. Try again.',
    });
  }
}
