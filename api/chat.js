// Vercel Serverless Function: /api/chat
// Routes conversation to Haiku (general) or Sonnet (transaction reasoning)
// Rate limits by plan: Solo (200/day), Team (500/day), Brokerage (unlimited)

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

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
  
  // Use Sonnet only for transaction data updates
  const transactionUpdateKeywords = [
    'update', 'change', 'set', 'buyer name', 'seller name', 'sale price',
    'earnest money', 'option fee', 'closing date', 'effective date',
    'lender name', 'title company'
  ];
  
  const needsDataUpdate = hasTransaction && 
    transactionUpdateKeywords.some(keyword => lowerMessage.includes(keyword));
  
  return needsDataUpdate ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
}

function buildSystemPrompt(hasTransaction) {
  const basePrompt = `You are Dossie, a warm, calm, competent AI transaction coordinator for Texas real estate agents.

Your personality:
- Warm and feminine, but professional
- Calm under pressure
- One step at a time, not overwhelming
- You speak like a real person, not a chatbot
- You remember context and adapt to the agent's style

Your capabilities:
- Help agents think through transaction decisions
- Explain Texas real estate processes
- Provide general advice and context
- Update transaction records when given specific information
- Generate contract documents when files are complete

Guidelines:
- Keep responses concise and human
- Use "I" and "you" naturally
- Don't be overly formal or robotic
- If you don't know something, say so
- Default to being helpful, not defensive
- Never start responses with "Hey there", "Hi there", "Hello", "Sure", "Of course", or any filler phrase
- Start with the actual response immediately`;

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
  const maxTokens = model === 'claude-sonnet-4-6' ? 1024 : 400;
  
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

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
    const { message, userId, transactionContext, userPlan } = req.body;

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
    console.error('Chat API error:', error);
    
    // Handle Anthropic API errors
    if (error.status === 429) {
      return res.status(429).json({ 
        ok: false, 
        error: 'Anthropic API rate limit reached. Try again in a moment.' 
      });
    }
    
    return res.status(500).json({ 
      ok: false, 
      error: 'Failed to generate response. Try again.' 
    });
  }
}
