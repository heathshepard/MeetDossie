// Vercel Serverless Function: /api/ask-hadley
// Answers TREC/Texas-RE questions using Hadley's knowledge base.
//
// POST /api/ask-hadley
// {
//   question: string,
//   context?: { form?: "TREC 20-18", paragraph?: "12.A.(1)(b)" }
// }
//
// Returns:
// {
//   ok: true,
//   answer: string,
//   citations: [{ source: string, url?: string, section?: string }],
//   knowledge_file_used: string,
//   low_confidence?: boolean
// }
//
// Authorization: Bearer <supabase user JWT>

import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

const { verifySupabaseToken, AuthError } = require('./_middleware/auth');

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
const FORM_FILES = {
  'TREC 20-18': 'trec-20-18.md',
  '20-18': 'trec-20-18.md',
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

async function answerWithHadley(question, knowledgeContent, formName) {
  const systemPrompt = `You are Hadley, Head of General Counsel for Dossie. You are a licensed Texas REALTOR with deep expertise in TREC contract forms and Texas real estate law.

You will answer the user's question USING ONLY the knowledge base content provided below. You must cite every claim using specific references to:
- TAC (Texas Administrative Code) sections — write as (TAC §537.28)
- TRELA (Texas Real Estate License Act) sections — write as (TRELA §1101.155)
- Texas Property Code — write as (Tex. Prop. Code §5.008)
- TREC bulletins and form documentation
- TREC form paragraph references — write as (TREC ${formName} ¶12.A.(1)(b))

If the knowledge base does not contain sufficient information to answer the question, state explicitly: "I don't have that information in my current knowledge base. This would require further research." — and do NOT fabricate citations.

If the question is off-topic (not about Texas real estate or TREC forms), politely decline and suggest the user ask something on-topic.

Never invent or assume facts. Answer in plain English (1-3 paragraphs), structured and clear. Include parenthetical citations inline.`;

  const userMessage = `Question: ${question}

Knowledge base (${formName}):
${knowledgeContent}`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 800,
    system: systemPrompt,
    messages: [
      { role: 'user', content: userMessage },
    ],
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

    // Determine which knowledge file to use
    const requestedForm = context?.form ? String(context.form).trim() : null;
    const formName = requestedForm && FORM_FILES[requestedForm] ? requestedForm : 'TREC 20-18';
    const knowledgeContent = loadKnowledgeFile(formName);

    // Graceful fallback for forms we haven't studied yet — log + return polite decline.
    // AWAIT the insert so Vercel doesn't kill the promise mid-flight when the
    // function returns. ~50-150ms, acceptable for this branch.
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

    if (!knowledgeContent) {
      return res.status(503).json({
        ok: false,
        error: `Knowledge base for ${formName} is not yet available.`,
      });
    }

    const result = await answerWithHadley(question.trim(), knowledgeContent, formName);

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
