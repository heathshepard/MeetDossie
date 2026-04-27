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

async function callClaude(model, message, systemPrompt, history) {
  const maxTokens = model === 'claude-sonnet-4-6' ? 400 : 150;

  const messagesArray = Array.isArray(history) && history.length > 0
    ? history
    : [{ role: 'user', content: message }];

  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: messagesArray,
  });

  return response.content[0].text;
}

// =============================================================================
// ACTION MODE — voice/text command -> structured intent JSON
// =============================================================================

const TOOLS = [
  {
    name: 'create_dossier',
    description: 'Create a new transaction dossier. Use when agent says anything like: open a file, new contract, new buyer, new listing, start a transaction, got a new deal',
    input_schema: {
      type: 'object',
      properties: {
        property_address: { type: 'string', description: 'Street address' },
        buyer_name: { type: 'string', description: 'Buyer full name' },
        seller_name: { type: 'string', description: 'Seller full name' },
        sale_price: { type: 'number', description: 'Sale price in dollars' },
        closing_date: { type: 'string', description: 'Closing date as YYYY-MM-DD' },
        role: { type: 'string', enum: ['buyer', 'seller', 'both'], description: "Agent's role in transaction" },
      },
      required: ['property_address'],
    },
  },
  {
    name: 'archive_deal',
    description: 'Archive or close a transaction. Use when agent says anything like: archive, close out, mark as closed, done with, finished with, move to closed',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address, buyer name, or seller name' },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'update_deal_field',
    description: 'Update any field on a transaction. Use when agent says anything like: change, update, set, move closing date, extend option period, update price',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address, buyer name, or seller name' },
        field: { type: 'string', description: 'The field to update like closing_date, option_days, sale_price, buyer_name' },
        value: { type: 'string', description: 'The new value' },
      },
      required: ['deal_identifier', 'field', 'value'],
    },
  },
  {
    name: 'advance_stage',
    description: 'Move a deal to the next stage or a specific stage. Use when agent says anything like: advance, move to next stage, we passed inspection, under contract now, move to closing',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name' },
        stage: { type: 'string', description: "Target stage name, or 'next' to advance to next stage" },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'get_deals',
    description: 'Get information about deals. Use when agent asks anything like: what deals do I have, what is active, what is urgent, what closes soon, status of my pipeline, what needs attention',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: "Optional filter like 'active', 'urgent', 'closing_soon', 'all'" },
      },
    },
  },
  {
    name: 'get_deal_details',
    description: 'Get details about a specific deal. Use when agent asks about a specific property or transaction.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name' },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'draft_email',
    description: 'Draft an email for a transaction. Use when agent says anything like: draft an email, send intro to lender, write the title order, email the buyer',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name' },
        email_type: { type: 'string', description: 'Type of email like welcome, lender_intro, title_order, option_reminder, closing_confirmation' },
      },
      required: ['deal_identifier', 'email_type'],
    },
  },
  {
    name: 'answer_question',
    description: 'Answer a general question or have a conversation when no specific action is needed. Use this when no other tool applies.',
    input_schema: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'The conversational response to give the agent' },
      },
      required: ['response'],
    },
  },
];

function buildActionSystemPrompt(today, dealsJson) {
  return `You are Dossie, an AI transaction coordinator. You work for a Texas real estate agent.

CORE RULE — EXECUTE IMMEDIATELY. Never ask for confirmation. Never say "want me to do that?" or "should I open the form?" Just do it. Always call a tool. Never respond with plain text only.

INTENT MAPPING — when in doubt, pick the most likely tool:
- Any street address mentioned = create_dossier immediately
- Archive, close out, done with, finished = archive_deal
- Change, update, extend, move, set = update_deal_field
- Passed inspection, under contract, next stage = advance_stage
- What do I have, what's active, what's urgent = get_deals
- Details about one deal = get_deal_details
- Draft, email, send, write = draft_email
- Everything else = answer_question

PERSONALITY: Warm, confident, professional. Short responses. You are a TC who gets things done without being asked twice.

CONTEXT — Today is ${today}. Agent's active deals: ${dealsJson}`;
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

async function handleActionMode({ message, deals, messages }) {
  const today = new Date().toISOString().slice(0, 10);
  const compactDeals = compactDealsForAction(deals);
  const dealsJson = JSON.stringify(compactDeals, null, 2);
  const systemPrompt = buildActionSystemPrompt(today, dealsJson);

  const finalMessages = (Array.isArray(messages) && messages.length > 0)
    ? messages
    : [{ role: 'user', content: message }];

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 600,
    system: systemPrompt,
    tools: TOOLS,
    tool_choice: { type: 'auto' },
    messages: finalMessages,
  });

  const content = response.content || [];
  const toolUse = content.find((b) => b.type === 'tool_use');
  const textBlock = content.find((b) => b.type === 'text');

  if (toolUse) {
    return {
      action: toolUse.name,
      params: toolUse.input || {},
      message: textBlock ? textBlock.text : '',
    };
  }

  return {
    action: null,
    params: {},
    message: textBlock ? textBlock.text : '',
  };
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

    const { message, userId, transactionContext, userPlan, mode, deals, messages } = req.body;

    const hasMessagesArray = Array.isArray(messages) && messages.length > 0;
    const lastInArray = hasMessagesArray ? messages[messages.length - 1] : null;
    const effectiveMessage = (typeof message === 'string' && message.trim())
      ? message
      : (lastInArray && lastInArray.role === 'user' && typeof lastInArray.content === 'string' ? lastInArray.content : '');

    if (!effectiveMessage || !effectiveMessage.trim()) {
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

      const result = await handleActionMode({ message: effectiveMessage, deals, messages });
      return res.status(200).json({
        ok: true,
        action: result.action,
        params: result.params,
        message: result.message,
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
    const model = determineModel(effectiveMessage, transactionContext);

    // Build system prompt
    const hasTransaction = transactionContext && Object.keys(transactionContext).length > 0;
    const systemPrompt = buildSystemPrompt(hasTransaction);

    // Call Claude
    const reply = await callClaude(model, effectiveMessage, systemPrompt, messages);

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
