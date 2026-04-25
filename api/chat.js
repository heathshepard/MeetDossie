// Vercel Serverless Function: /api/chat
// Routes conversation to Haiku (general) or Sonnet (transaction reasoning)
// Rate limits by plan: Solo (200/day), Team (500/day), Brokerage (unlimited)

const Anthropic = require('@anthropic-ai/sdk');
const {
  checkRateLimit: checkIpRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// CORS allowlist — production domains plus any localhost port for dev.
const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

const RATE_LIMITS = {
  solo: 200,
  team: 500,
  brokerage: null, // unlimited
};

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

// In-memory rate limit store (use Redis/Vercel KV for production)
const rateLimitStore = new Map();

function checkRateLimit(userId, userPlan = 'solo') {
  const now = Date.now();
  const userKey = `user:${userId}`;
  const maxMessages = RATE_LIMITS[userPlan] || RATE_LIMITS.solo;
  
  // Brokerage plan has unlimited messages
  if (maxMessages === null) {
    return {
      allowed: true,
      remaining: null,
      resetAt: null,
      plan: userPlan,
    };
  }
  
  if (!rateLimitStore.has(userKey)) {
    rateLimitStore.set(userKey, { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS });
  }
  
  const userData = rateLimitStore.get(userKey);
  
  // Reset if window expired
  if (now >= userData.resetAt) {
    userData.count = 0;
    userData.resetAt = now + RATE_LIMIT_WINDOW_MS;
  }
  
  // Check limit
  if (userData.count >= maxMessages) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: userData.resetAt,
      plan: userPlan,
    };
  }
  
  // Increment
  userData.count += 1;
  
  return {
    allowed: true,
    remaining: maxMessages - userData.count,
    resetAt: userData.resetAt,
    plan: userPlan,
  };
}

function determineModel(message, transactionContext) {
  const hasTransaction = transactionContext && Object.keys(transactionContext).length > 0;
  const lowerMessage = message.toLowerCase();
  
  // Use Sonnet only for complex transaction reasoning
  const transactionReasoningKeywords = [
    'update', 'change', 'set', 'buyer name', 'seller name', 'sale price',
    'earnest money', 'option fee', 'closing date', 'effective date',
    'lender name', 'title company'
  ];
  
  const needsComplexReasoning = hasTransaction && 
    transactionReasoningKeywords.some(keyword => lowerMessage.includes(keyword));
  
  return needsComplexReasoning ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

function buildSystemPrompt(hasTransaction) {
  const basePrompt = `You are Dossie, a warm professional Texas real estate transaction coordinator. Rules: one to two sentences maximum per response. Never say Hey there, Sure, Of course, Absolutely, Honey, Sweetie, or any pet name. Never correct the user. Start responses immediately without filler. Sound like a real colleague on a phone call.`;

  if (hasTransaction) {
    return basePrompt + `

Transaction context is available. When the agent gives you updates like "buyer changed to Sarah Martinez" or "closing got pushed to May 14", acknowledge the update naturally and confirm what you've captured.

If they ask questions, answer them. If they give you information, update the file. Be fluid between conversation and data collection.`;
  }

  return basePrompt + `

No transaction is currently selected. Focus on being genuinely helpful:
- Answer questions about processes, documents, timelines
- Help them think through decisions
- Provide context and advice
- Guide them to create a transaction when they're ready

Don't force data entry. Just be a helpful coordinator they can talk to.`;
}

async function callClaude(model, message, systemPrompt) {
  const maxTokens = model === 'claude-sonnet-4-6' ? 400 : 150;

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: message,
      },
    ],
  });

  return response.content[0].text;
}

// =============================================================================
// ACTION MODE — voice/text command -> structured intent JSON
// =============================================================================

const ACTION_INTENTS = new Set([
  'update_field',
  'advance_stage',
  'archive_deal',
  'answer_question',
  'unknown',
]);

const ACTION_FIELDS = new Set([
  'optionDays',
  'financingDays',
  'closingDate',
  'contractEffectiveDate',
  'salePrice',
  'earnestMoney',
  'optionFee',
  'buyerName',
  'sellerName',
  'propertyAddress',
  'cityStateZip',
  'notes',
  'stage',
]);

function buildActionSystemPrompt(today) {
  return `You are Dossie, an AI transaction coordinator. The user will give you a voice command about their real estate deals. Parse the intent and return ONLY valid JSON with no prose.

Today's date is ${today} (use this to resolve relative dates like "next Friday" or "tomorrow").

Return EXACTLY this JSON shape with no markdown fences and no commentary:
{
  "intent": "update_field" | "advance_stage" | "archive_deal" | "answer_question" | "unknown",
  "dealIdentifier": "partial address or party name to match against existing deals" | null,
  "field": "optionDays" | "financingDays" | "closingDate" | "contractEffectiveDate" | "salePrice" | "earnestMoney" | "optionFee" | "buyerName" | "sellerName" | "propertyAddress" | "cityStateZip" | "notes" | "stage" | null,
  "value": "new value as string" | null,
  "confirmationMessage": "What Dossie says back to the user after executing the action — one warm professional sentence, no filler",
  "clarificationNeeded": "Question to ask if intent is unclear or the deal cannot be uniquely identified" | null
}

INTENT MEANINGS:
- update_field: change one field on an existing deal (e.g. "extend the option period by 2 days", "change closing on 311 Main to May 15", "update earnest money to 7500")
- advance_stage: move a deal to its next pipeline stage (e.g. "move Henderson to option period", "advance Rilla Vista", "Henderson is now under contract")
- archive_deal: close/archive a deal (e.g. "close out the Henderson file", "archive 311 Main")
- answer_question: the user is asking, not commanding (e.g. "what's urgent today?", "when does Rilla Vista close?")
- unknown: command is ambiguous, deal can't be identified, or value can't be parsed — set clarificationNeeded

FIELD CONVENTIONS:
- For date fields (closingDate, contractEffectiveDate) return YYYY-MM-DD strings
- For numeric fields (optionDays, financingDays, salePrice, earnestMoney, optionFee) return a number as a string ("7", "350000")
- For relative numeric updates ("extend by 2 days") return the FINAL value, not the delta — read the current value from the deals context and add. If you can't compute the final value, return clarificationNeeded.
- For salePrice strip "$" and commas ("$350,000" -> "350000")
- For stage updates use one of: active-listing, under-contract, option-period, inspection, financing, title-survey, clear-to-close, closed

DEAL MATCHING:
- Match against propertyAddress (substring, case-insensitive), buyerName, or sellerName
- If multiple deals match, set intent to "unknown" and ask clarificationNeeded with the candidates listed
- If zero deals match, set intent to "unknown" and ask which deal they meant

CONFIRMATION TONE:
- One warm professional sentence, present tense, never filler
- Reference the specific deal: "Done — option period on Rilla Vista is now 9 days."
- Never say Sure, Of course, Absolutely, Honey, or any pet name`;
}

function compactDealsForAction(deals) {
  if (!Array.isArray(deals)) return [];
  return deals
    .filter((d) => d && d.id)
    .slice(0, 50)
    .map((d) => ({
      id: d.id,
      propertyAddress: d.propertyAddress || null,
      cityStateZip: d.cityStateZip || null,
      buyerName: d.buyerName || null,
      sellerName: d.sellerName || null,
      stage: d.stage || null,
      status: d.status || null,
      role: d.role || null,
      salePrice: typeof d.salePrice === 'number' ? d.salePrice : null,
      earnestMoney: typeof d.earnestMoney === 'number' ? d.earnestMoney : null,
      optionFee: typeof d.optionFee === 'number' ? d.optionFee : null,
      optionDays: typeof d.optionDays === 'number' ? d.optionDays : null,
      financingDays: typeof d.financingDays === 'number' ? d.financingDays : null,
      contractEffectiveDate: d.contractEffectiveDate || null,
      closingDate: d.closingDate || null,
    }));
}

function safeParseActionJson(text) {
  if (!text || typeof text !== 'string') return null;
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return JSON.parse(s);
  } catch (e) {
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { return JSON.parse(s.slice(start, end + 1)); } catch (e2) { return null; }
    }
    return null;
  }
}

function normalizeAction(parsed) {
  const fallback = {
    intent: 'unknown',
    dealIdentifier: null,
    field: null,
    value: null,
    confirmationMessage: '',
    clarificationNeeded: "I couldn't quite catch that. Could you rephrase?",
  };
  if (!parsed || typeof parsed !== 'object') return fallback;

  const intent = ACTION_INTENTS.has(parsed.intent) ? parsed.intent : 'unknown';
  const field = ACTION_FIELDS.has(parsed.field) ? parsed.field : null;
  const dealIdentifier = (typeof parsed.dealIdentifier === 'string' && parsed.dealIdentifier.trim().length > 0) ? parsed.dealIdentifier.trim() : null;
  const value = (parsed.value === null || parsed.value === undefined) ? null : String(parsed.value);
  const confirmationMessage = typeof parsed.confirmationMessage === 'string' ? parsed.confirmationMessage : '';
  const clarificationNeeded = (typeof parsed.clarificationNeeded === 'string' && parsed.clarificationNeeded.trim().length > 0) ? parsed.clarificationNeeded.trim() : null;

  return { intent, dealIdentifier, field, value, confirmationMessage, clarificationNeeded };
}

async function handleActionMode({ message, deals }) {
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = buildActionSystemPrompt(today);
  const compactDeals = compactDealsForAction(deals);

  const userPayload = `User said: "${message}"

Current deals (JSON):
${JSON.stringify(compactDeals, null, 2)}

Return ONLY the JSON object as specified. No prose, no markdown.`;

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPayload }],
  });

  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const rawText = textBlock ? textBlock.text : '';
  const parsed = safeParseActionJson(rawText);
  return normalizeAction(parsed);
}

export default async function handler(req, res) {
  applyCors(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    // IP-based rate limit (30/hour). Layered on top of the per-user/plan
    // limit below — this catches abusive callers regardless of userId.
    const ip = clientIpFromReq(req);
    await checkIpRateLimit(ip, 'chat', 30, 60 * 60 * 1000);

    const { message, userId, transactionContext, userPlan, mode, deals } = req.body;

    // Validate input
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({
        ok: false,
        error: 'Message is required and must be a non-empty string.'
      });
    }

    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({
        ok: false,
        error: 'userId is required for rate limiting.'
      });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('ANTHROPIC_API_KEY not configured');
      return res.status(500).json({
        ok: false,
        error: 'Server configuration error. Contact support.'
      });
    }

    // Action mode: parse a voice/text command into a structured action.
    // Counted against the user's daily limit just like any other call.
    if (mode === 'action') {
      const plan = userPlan && ['solo', 'team', 'brokerage'].includes(userPlan) ? userPlan : 'solo';
      const rateLimitResult = checkRateLimit(userId, plan);
      if (!rateLimitResult.allowed) {
        const resetDate = new Date(rateLimitResult.resetAt).toISOString();
        const limit = RATE_LIMITS[rateLimitResult.plan];
        return res.status(429).json({
          ok: false,
          error: `Rate limit exceeded. You've used your ${limit} daily messages (${rateLimitResult.plan} plan). Resets at ${resetDate}.`,
          remaining: 0,
          resetAt: rateLimitResult.resetAt,
          plan: rateLimitResult.plan,
        });
      }

      const action = await handleActionMode({ message, deals });
      return res.status(200).json({
        ok: true,
        action,
        remaining: rateLimitResult.remaining,
        resetAt: rateLimitResult.resetAt,
        plan: rateLimitResult.plan,
      });
    }

    // Check rate limit (default to 'solo' plan)
    const plan = userPlan && ['solo', 'team', 'brokerage'].includes(userPlan) ? userPlan : 'solo';
    const rateLimitResult = checkRateLimit(userId, plan);
    
    if (!rateLimitResult.allowed) {
      const resetDate = new Date(rateLimitResult.resetAt).toISOString();
      const limit = RATE_LIMITS[rateLimitResult.plan];
      return res.status(429).json({ 
        ok: false, 
        error: `Rate limit exceeded. You've used your ${limit} daily messages (${rateLimitResult.plan} plan). Resets at ${resetDate}.`,
        remaining: 0,
        resetAt: rateLimitResult.resetAt,
        plan: rateLimitResult.plan,
      });
    }

    // Determine model
    const model = determineModel(message, transactionContext);
    
    // Build system prompt
    const hasTransaction = transactionContext && Object.keys(transactionContext).length > 0;
    const systemPrompt = buildSystemPrompt(hasTransaction);
    
    // Call Claude
    const reply = await callClaude(model, message, systemPrompt);

    // Return response
    return res.status(200).json({
      ok: true,
      reply,
      model,
      remaining: rateLimitResult.remaining,
      resetAt: rateLimitResult.resetAt,
      plan: rateLimitResult.plan,
    });

  } catch (error) {
    // Internal logging keeps full detail.
    console.error('Chat API error:', error);

    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) {
        res.setHeader('Retry-After', String(error.retryAfterSeconds));
      }
      return res.status(429).json({
        ok: false,
        error: 'Rate limit exceeded. Please try again later.'
      });
    }

    // Anthropic upstream rate limit — distinct from our own limiter.
    if (error && error.status === 429) {
      return res.status(429).json({
        ok: false,
        error: 'Service is busy. Please try again in a moment.'
      });
    }

    // Generic sanitized response — never leak SDK stack traces or upstream
    // API messages.
    return res.status(500).json({
      ok: false,
      error: 'Failed to generate response. Try again.'
    });
  }
}
