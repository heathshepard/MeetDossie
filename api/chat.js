// prompt v2 2026-04-27
// Vercel Serverless Function: /api/chat
// Routes conversation to Haiku (general) or Sonnet (transaction reasoning)
// Rate limits by plan: Solo (200/day), Team (500/day), Brokerage (unlimited)

const Anthropic = require('@anthropic-ai/sdk');
const {
  checkRateLimit: checkIpRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { messagesCreateCached } = require('./_lib/spawn-with-cache');

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
  // Ultra-permissive CORS - allow ALL origins
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
  
  return needsComplexReasoning ? 'claude-sonnet-5' : 'claude-haiku-4-5-20251001';
}

function buildSystemPrompt(hasTransaction) {
  const basePrompt = `You are Dossie, a warm professional Texas real estate transaction coordinator inside the Dossie app.

NAME RULES: Your name is Dossie (rhymes with "bossy"). Speech-to-text frequently mishears it as Darcy, Dorothy, Daisy, Dossy, Docie, Dottie, or similar sound-alikes. If the agent greets you or addresses you using any wrong name, warmly correct it in one breath without making a thing of it — for example: "It's Dossie, by the way — but good morning." Never adopt the wrong name. Never repeat the wrong name back to them. After the gentle correction, continue normally.

APP-SPECIFIC HOW-TO ANSWERS COME FIRST. When an agent asks how to do something in the app — even with vague phrasing like "how do I send compliance" or "how do I track a deadline" — ALWAYS answer in terms of Dossie's own features. NEVER describe Skyslope, Dotloop, DocuSign, Folio, dotloop, Brokermint, kvCORE, Brokerkit, or any other third-party tool unless the user explicitly names that tool first. NEVER give generic real-estate workflow advice when there is a Dossie feature that does the thing. If the user asks "how do I send compliance documents", they mean inside Dossie — answer with the Send to Compliance button, not with Skyslope.

Reference facts to weave into one or two natural sentences (never bullets, never numbered steps):
- Adding a document — open the dossier and use the Documents section to upload or scan a contract.
- Calculating TREC deadlines — they're auto-calculated from the contract effective date entered when the dossier is created.
- Sending compliance documents — tap the "Send to Compliance" button in the top action row of any open dossier. Dossie compiles every document attached to that dossier and emails them as one packet to the brokerage compliance email. Works at any stage (under contract, option period, financing, clear-to-close, closed) — not just at closing. The compliance email is set once in Settings → Brokerage compliance email.
- Inviting their TC — team features are coming soon; for now they're flying solo.
- The Morning Brief — the daily audio summary of every active deal, playable from the Today view.
- Talking to Dossie — this conversation, anytime, from the Talk to Dossie button.
- Sharing a closing card — pops up automatically when a deal hits a milestone (Under Contract, Closed, etc.); savable and re-shareable from the Milestones section of the dossier.
- Updating a deadline — open the dossier and tap the deadline field directly to edit it.

TUTORIAL VIDEO OFFER (how-to questions):
When the agent asks any "how do I X" question — sending compliance, opening a dossier, filling a contract, using DossieSign, drafting an amendment, scanning a document, voice commands, the Morning Brief — first give the short one-sentence answer, then offer the tutorial. Format your reply like this when a tutorial likely exists:

"<short answer in one sentence>. Want to see it? I have a 60-second tutorial walking through exactly that — it's at meetdossie.com/help."

If they specifically ask "show me a video" or "is there a video", direct them straight to meetdossie.com/help and mention searching for the feature. If no tutorial exists and the question is broader (TREC, pricing, security, integrations), point them to meetdossie.com/faq for the answer. For deeper Texas TC questions, point them to meetdossie.com/guides. Last fallback is meetdossie.com/help for the tutorial library or emailing heath@meetdossie.com directly.

Voice rules: one to two sentences maximum per response. Never say Hey there, Sure, Of course, Absolutely, Honey, Sweetie, or any pet name. Never correct the user, except to gently correct your own name. Start responses immediately without filler. Sound like a real colleague on a phone call.`;

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

async function callClaude(model, message, systemPrompt, history, metadata = {}) {
  const maxTokens = model === 'claude-sonnet-5' ? 400 : 150;

  const messagesArray = Array.isArray(history) && history.length > 0
    ? history
    : [{ role: 'user', content: message }];

  // Use the cached spawn helper so the large /api/chat system prompt
  // (the warm-TC persona + how-to facts + name rules) becomes cache-
  // eligible. Subsequent calls within the 5-min window pay ~10% of
  // input cost on the prefix.
  const response = await messagesCreateCached(anthropic, {
    model,
    max_tokens: maxTokens,
    systemStatic: systemPrompt,
    messages: messagesArray,
    metadata: { endpoint: 'chat', ...metadata },
  });

  // Sonnet 5 extended thinking prepends a `thinking` block to content[].
  // Read every text block instead of assuming content[0] is text.
  return ((response.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim());
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
    description: 'Silently edit a field on the dossier — no PDF is produced. Use for record-keeping changes the agent wants reflected in the dossier (e.g., "I forgot to enter the inspector\'s phone", "the title company name was wrong"). DO NOT use when the agent asks to draft, generate, or create an amendment, even if a closing_date / option_days / sale_price change is involved — use draft_amendment for that.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address, buyer name, or seller name' },
        field: {
          type: 'string',
          enum: ['closing_date','contract_effective_date','option_days','financing_days','sale_price','earnest_money','option_fee','buyer_name','seller_name','property_address','city_state_zip','notes','title_company','title_officer_name','title_officer_email','title_officer_phone','lender_name','loan_officer_name','loan_officer_email','loan_officer_phone','hoa_name','hoa_phone','hoa_management_company','inspector_name','inspector_phone','inspector_email','mls_number','bedrooms','bathrooms','sqft','year_built','possession_date','appraisal_deadline','survey_deadline','hoa_document_deadline','loan_approval_deadline','transaction_type','option_fee_amount','option_fee_paid_at','option_fee_paid_to','earnest_money_amount','earnest_money_deposited_at','earnest_money_confirmed_at','earnest_money_title_company','inspection_scheduled_at','inspection_completed_at','inspection_report_received','appraisal_ordered_at','appraisal_received_at','appraisal_value','title_commitment_received_at','title_commitment_effective_date','survey_ordered_at','survey_received_at','survey_clear','loan_approval_received_at','clear_to_close_at','hoa_docs_requested_at','hoa_docs_received_at','recorded_deed_received_at','title_policy_delivered_at','cda_signed_at','closed_at','iabs_delivered_at','sellers_disclosure_received_at','buyer_rep_signed_at','pre_approval_received','pre_approval_letter_url','land_acreage','land_legal_description','land_parcel_id','land_zoning','land_deed_restrictions_reviewed','land_deed_restrictions_notes','land_survey_type','land_survey_ordered_date','land_survey_received_date','land_survey_clear','land_survey_notes','land_fence_survey_required','land_water_source','land_sewer_source','land_electric_confirmed','land_gas_confirmed','land_internet_confirmed','land_road_access_confirmed','land_flood_zone','land_flood_map_checked','land_flood_map_checked_date','land_wetlands_present','land_environmental_notes','land_phase1_required','land_phase1_received','land_phase1_received_date','builder_name','builder_rep_name','builder_rep_phone','builder_rep_email','builder_contract_date','builder_warranty_company','builder_warranty_expiration','builder_warranty_received','co_received_date','co_number','expected_completion_date','punch_list_notes','punch_list_cleared','punch_list_cleared_date','lease_monthly_rent','lease_security_deposit','lease_pet_deposit','lease_pet_policy','lease_application_fee','lease_start_date','lease_end_date','lease_application_submitted_date','lease_application_approved_date','lease_signed_date','lease_move_in_date','lease_move_out_date','lease_renewal_deadline','lease_move_in_condition_completed','lease_move_in_condition_date','lease_pre_existing_damage_notes','lease_tenant1_name','lease_tenant1_phone','lease_tenant1_email','lease_tenant2_name','lease_tenant2_phone','lease_tenant2_email','lease_num_occupants','lease_background_check_done','lease_credit_check_done','lease_property_manager_name','lease_property_manager_phone','lease_property_manager_email','lease_hoa_approval_required','lease_hoa_approval_received','lease_hoa_approval_received_date','lease_landlord_name','lease_landlord_phone','lease_landlord_email'],
          description: 'The field to update using snake_case',
        },
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
        stage: {
          type: 'string',
          enum: ['pre-contract','active-listing','under-contract','option-period','inspection','financing','title-survey','clear-to-close','closed','next'],
          description: "Target stage id, or 'next' to advance to the next stage",
        },
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
        filter: {
          type: 'string',
          enum: ['all','active','urgent','closing_soon'],
          description: 'Filter deals by status',
        },
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
        email_type: {
          type: 'string',
          enum: ['buyer-welcome','lender-introduction','title-order','option-reminder','financing-reminder','clear-to-close','closing-day','post-closing'],
          description: 'The email template to draft',
        },
      },
      required: ['deal_identifier', 'email_type'],
    },
  },
  {
    name: 'send_email',
    description: 'Send an email directly on behalf of the agent. Use when agent says: send an email, email them, reach out to, contact, follow up with, send a message to. Do not use for drafting — only when agent explicitly wants to send now.',
    input_schema: {
      type: 'object',
      properties: {
        to_email: { type: 'string', description: 'Recipient email address' },
        to_name: { type: 'string', description: 'Recipient name' },
        subject: { type: 'string', description: 'Email subject line' },
        body: { type: 'string', description: 'Email body in plain text. Write as Dossie speaking on behalf of the agent. Warm, professional, concise.' },
        deal_identifier: { type: 'string', description: 'The deal this email is about — used to log it' },
      },
      required: ['to_email', 'subject', 'body'],
    },
  },
  {
    name: 'draft_amendment',
    description: 'Draft a TREC 39-10 Amendment to Contract PDF (the current TREC amendment form — supersedes 39-9). Use whenever the agent says: draft an amendment, generate an amendment, draw up an amendment, write up an amendment, extend the option period, push closing back, change the closing date, change the sale price, reduce the price, increase the price, draft a repair amendment, list repairs seller must fix. Produces a signable PDF document — different from update_deal_field which silently edits the dossier without producing a PDF. If the agent asks for both a draft AND a dossier update, call draft_amendment only; the agent applies the change to the dossier once the buyer signs.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Property address or buyer/seller name' },
        amendment_type: {
          type: 'string',
          enum: ['closing_date', 'option_extension', 'price_change', 'repair_items'],
          description: 'closing_date for new close date, option_extension for additional option days, price_change for new sale price, repair_items for a repair amendment listing items seller must fix',
        },
        new_value: {
          type: 'string',
          description: 'For closing_date: YYYY-MM-DD. For option_extension: number of additional days as a string ("7"). For price_change: dollar amount as a string ("325000"). For repair_items: JSON array of repair item strings e.g. ["HVAC filter replacement","Leaking faucet in master bath"].',
        },
        notes: { type: 'string', description: 'Optional special provisions / explanation written into the Other Modifications block.' },
      },
      required: ['deal_identifier', 'amendment_type', 'new_value'],
    },
  },
  {
    name: 'fill_forms',
    description: 'Fill out TREC contract forms and addenda. Use whenever the agent says: write a contract, fill out a contract, write up an offer, prepare the paperwork, write an offer, make an offer, purchase agreement, fill the forms, financing addendum, termination notice, TREC 39-10, TREC 40. Selects the right TREC form based on transaction type: TREC 20-16 for residential resale, TREC 9-17 for unimproved land, TREC 25-14 for farm and ranch, TREC 23-18 for new construction (incomplete), TREC 24-18 for new construction (completed), TREC 40-9 for financing addendum, TREC 38-7 for termination notice. Produces ready-to-sign PDF documents in the dossier.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: {
          type: 'string',
          description: 'Property address or buyer/seller name to identify the existing dossier. Required if filling forms for an existing deal.',
        },
        message: {
          type: 'string',
          description: 'The agent\'s full message with all contract details: address, price, buyer name, financing type, down payment, closing date, option period, transaction type, etc.',
        },
        form_type_override: {
          type: 'string',
          enum: ['resale-contract', 'unimproved-property', 'farm-ranch', 'new-home-incomplete', 'new-home-complete', 'financing-addendum', 'termination-notice'],
          description: 'Override the auto-selected form type. Use when: agent says "land contract" or "unimproved property" -> unimproved-property; agent says "farm and ranch" or "farm contract" -> farm-ranch; agent says "new construction incomplete" -> new-home-incomplete; agent says "new construction completed" -> new-home-complete; agent says "financing addendum" or "TREC 40" -> financing-addendum; agent says "termination notice" or "TREC 38-7" or "terminate" -> termination-notice. For standard residential resale, omit this field.',
        },
        forms: {
          type: 'array',
          items: { type: 'string', enum: ['resale-contract', 'financing-addendum', 'hoa-addendum', 'lead-paint-addendum'] },
          description: 'List of additional forms to fill after the main contract form. Auto-detected: if FHA/VA/USDA/Conventional mentioned -> financing-addendum; if HOA mentioned -> hoa-addendum; if property built before 1978 -> lead-paint-addendum.',
        },
        include_financing_addendum: {
          type: 'boolean',
          description: 'Whether to also fill the Third Party Financing Addendum (40-9). Default true for all non-cash deals.',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'send_wire_fraud_warning',
    description: 'Send a TAR 2517 Wire Fraud Warning to the buyer for acknowledgment via DocuSeal e-sign. Use whenever the agent says anything like: send wire fraud warning, send the fraud warning, send TAR 2517, send buyer the wire fraud notice, deliver the wire fraud warning. This fills the TAR 2517 form and routes it to the buyer for electronic signature.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name to identify the transaction' },
        buyer_name: { type: 'string', description: 'Full name of the buyer receiving the wire fraud warning' },
        buyer_email: { type: 'string', description: 'Email address of the buyer — required to send DocuSeal link' },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'log_offer',
    description: 'Log an offer received on a seller-side transaction. Use whenever the agent says anything like: we got an offer, received an offer, got a bid, offer came in, buyer submitted an offer, an offer was submitted. Creates a record in the offer comparison table for the dossier.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or seller name to identify the listing' },
        buyer_name: { type: 'string', description: 'Name of the buyer making the offer' },
        offer_price: { type: 'number', description: 'The offer price in dollars' },
        earnest_money: { type: 'number', description: 'Earnest money amount in dollars' },
        option_fee: { type: 'number', description: 'Option fee amount in dollars' },
        option_days: { type: 'number', description: 'Number of option period days' },
        closing_date: { type: 'string', description: 'Requested closing date as YYYY-MM-DD' },
        financing_type: { type: 'string', enum: ['conventional', 'fha', 'va', 'cash', 'other'], description: 'Type of financing' },
        notes: { type: 'string', description: 'Any additional terms or notes about the offer' },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'initiate_termination',
    description: 'Generate a TREC 38-7 Buyer Termination of Contract form. Use whenever the agent says anything like: buyer wants to terminate, buyer is terminating, generate termination, draft the termination, buyer is backing out, buyer is walking away, terminate the contract, file for termination.',
    input_schema: {
      type: 'object',
      properties: {
        deal_identifier: { type: 'string', description: 'Any part of the address or buyer/seller name to identify the transaction' },
        termination_reason: { type: 'string', description: 'Reason the buyer is terminating (e.g., inspection results, financing denied, option period)' },
        option_fee_return_requested: { type: 'boolean', description: 'Whether the buyer is requesting return of the option fee' },
      },
      required: ['deal_identifier'],
    },
  },
  {
    name: 'ask_hadley',
    description: 'Ask Hadley (General Counsel) a TREC contract or Texas real estate law question. Use whenever the agent says anything like: ask Hadley, what does TREC say about, explain paragraph X of TREC Y, is the seller required to, what does the buyer lose if, what is the rule on, is this enforceable, can the seller, can the buyer, what happens when the option period expires, define earnest money under TREC, what is the deadline for, walk me through paragraph X. Returns a cited answer drawn from Hadley\'s in-house knowledge base of TREC forms and Texas real estate statutes. Currently studied: TREC 20-18 (One to Four Family Residential Contract — Resale). Other forms will return a graceful "studying that next" reply and log the question for Hadley.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The TREC / Texas real estate question, verbatim or paraphrased from the agent.' },
        form: {
          type: 'string',
          enum: ['TREC 20-18', '20-18', 'TREC 20-17', 'TREC 40-11', 'TREC 36-11', 'TREC 39-10', 'TREC 38-7'],
          description: 'Optional: which TREC form this question relates to. Default is TREC 20-18 (the current residential resale contract).',
        },
        paragraph: { type: 'string', description: 'Optional: paragraph reference like "12.A.(1)(b)" — pass through if the agent quotes one.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'answer_question',
    description: 'Answer a general question or have a conversation when no specific action is needed. Use this when no other tool applies. For TREC contract / Texas real estate LAW questions, prefer ask_hadley instead.',
    input_schema: {
      type: 'object',
      properties: {
        response: { type: 'string', description: 'The conversational response to give the agent' },
      },
      required: ['response'],
    },
  },
];

const buildActionSystemPrompt = (deals, today) => {
  const dealsJson = JSON.stringify(deals || [], null, 2);
  return `You are Dossie, an elite AI transaction coordinator for Texas real estate agents. You are warm, sharp, and completely reliable. You work 24/7/365 — nights, weekends, holidays. You never miss a deadline and never drop the ball.

NAME RULES: Your name is Dossie (rhymes with "bossy"). Speech-to-text frequently mishears it as Darcy, Dorothy, Daisy, Dossy, Docie, Dottie, or similar sound-alikes. If the agent greets you or addresses you using any wrong name, warmly correct it in one breath without making a thing of it — for example: "It's Dossie, by the way — but good morning." Never adopt the wrong name. Never repeat the wrong name back to them. After the gentle correction, continue normally.

You know Texas real estate inside and out — TREC contracts, option periods, earnest money, title companies, lenders, HOA requirements, TREC compliance. You speak like a seasoned TC who genuinely cares about the agent's success.

TODAY: ${today}
AGENT'S ACTIVE DEALS: ${dealsJson}

EXECUTION RULES:
- Always call a tool. Never respond with plain text only.
- Execute immediately. Never ask for confirmation. Just do it.
- Never hallucinate. Only use data the agent explicitly provided. Leave unknown fields null.
- Remember context within the conversation. Connect information across messages.
- Never use emoji. Ever.
- Keep spoken responses concise — you are speaking out loud, not writing an email.
- When the agent says "that deal" or "it" or "this one", use the most recently mentioned deal.

AMENDMENT & STAGE SAFETY RULES:
- CRITICAL: Do NOT use update_deal_field for changes to executed contract fields like closing_date, option_days, sale_price, earnest_money, buyer_name, or seller_name. Those changes MUST use draft_amendment because they require an executed amendment PDF (TREC 39-10), not a silent dossier edit.
- CRITICAL: Never call draft_amendment, fill_forms, send_wire_fraud_warning, log_offer, or initiate_termination on deals in "closed" or "terminated" stage. For closed deals, use answer_question to explain the deal is closed and ask if they meant a different deal.
- When the agent says "ratified yesterday" or "executed on [date]", BOTH advance_stage (to under-contract) AND update_deal_field contract_effective_date are required — the dates must align.
- If the agent says "option period ends in 3 days" or "financing ends Friday", acknowledge it naturally with answer_question (it's a computed deadline, not editable). Do NOT write to option_fee_paid_at or other *_paid_at fields unless the agent specifically says "I paid" or "we paid".

TOOL USE GUIDELINES — These examples show WHEN and HOW to call each tool:
When the agent says "fill out a contract to purchase 123 Main St for $400k" → ALWAYS use fill_forms with deal_identifier="123 Main St" (the dispatcher auto-creates the dossier if needed)

FORMS AUTO-DETECTION (within fill_forms):
- ALWAYS analyze the message for keywords to auto-detect required addenda:
  - If "FHA" or "FHA loan" detected → ADD "financing-addendum" to forms array
  - If "VA loan" or "VA financing" detected → ADD "financing-addendum" to forms array
  - If "USDA" or "USDA loan" detected → ADD "financing-addendum" to forms array
  - If "conventional" mentioned with financing → ADD "financing-addendum" to forms array
  - If "HOA" or "homeowners association" mentioned → ADD "hoa-addendum" to forms array
  - If property built 1977 or earlier ("built 1977", "pre-1978", "built before 1978") → ADD "lead-paint-addendum" to forms array
  - If financing_type = "cash" (no loan) → EXCLUDE financing-addendum
- Always pass detected forms in the forms array. If none detected, omit the field.

When the agent says "fill out a contract to purchase 123 Main St for $400k" → ALWAYS use fill_forms with deal_identifier="123 Main St" (the dispatcher auto-creates the dossier if needed)
When the agent says "draft an amendment to extend closing to May 15" → ALWAYS use draft_amendment immediately with amendment_type="closing_date" and new_value="2026-05-15"
When the agent says "send a wire fraud warning to the buyer" → ALWAYS use send_wire_fraud_warning with buyer name and email
When the agent says "we got an offer at $395k" → ALWAYS use log_offer with offer_price=395000
When the agent says "buyer wants to back out" → ALWAYS use initiate_termination immediately
When the agent says "buyer changed to Sarah Martinez" on an open deal → ALWAYS use update_deal_field with field="buyer_name" and value="Sarah Martinez"
When the agent says "mark this deal closed" → ALWAYS use advance_stage with stage="closed"
If the agent says anything else → use answer_question

INTENT MAPPING:
- Any street address + open/new/file/listing/buyer/contract/start = create_dossier immediately
- Archive/close out/done with/finished/wrap up = archive_deal
- Write a contract/offer/purchase agreement, fill the forms, prepare the paperwork, make an offer = fill_forms (auto-selects form: TREC 20-16 for residential resale, TREC 9-17 for land/unimproved property, TREC 25-14 for farm and ranch, TREC 23-18 for new construction not yet done, TREC 24-18 for completed new construction)
- Land contract / unimproved property contract / write a contract for land = fill_forms with form_type_override: "unimproved-property"
- Farm and ranch contract / farm contract / ranch contract = fill_forms with form_type_override: "farm-ranch"
- New construction contract / builder contract / new home contract = fill_forms; use form_type_override "new-home-incomplete" if not done building, "new-home-complete" if home is complete
- Financing addendum / TREC 40 / third party financing addendum = fill_forms with form_type_override: "financing-addendum"
- Termination notice / TREC 38-7 / terminate the contract / cancel the deal = fill_forms with form_type_override: "termination-notice"
- Draft/generate/create/draw up an amendment, write up an amendment, extend the option period, push closing back, change/reduce/increase the sale price, draft a repair amendment/list repairs seller must fix = draft_amendment (produces a signable TREC 39-10 PDF; this beats update_deal_field whenever the agent wants paperwork)
- Change/update/set/correct/fix a field on the dossier (no PDF needed) = update_deal_field
- Passed/moved to/we are now/advance/next stage/under contract/in inspection = advance_stage
- What do I have/what's active/what's urgent/pipeline/my deals/show me = get_deals
- Tell me about/details on/what's the status of/closing date on/who is = get_deal_details
- Draft/email/send/write/intro/introduction/notify = draft_email
- Send wire fraud warning/TAR 2517/fraud notice to buyer = send_wire_fraud_warning
- We got an offer/received an offer/offer came in/buyer submitted/got a bid = log_offer (seller-side)
- Buyer wants to terminate/buyer is terminating/buyer is backing out/terminate the contract/draft the termination/TREC 38-7 = initiate_termination
- Ask Hadley/what does TREC say/explain paragraph/is the seller required to/walk me through paragraph/what's the rule on/is this enforceable/define [TREC term] = ask_hadley (Hadley is Dossie's in-house general counsel; pass the agent's question verbatim and the form/paragraph if mentioned)
- Everything else = answer_question

CANONICAL STAGE IDS — use ONLY these exact values for advance_stage.stage:
- pre-contract (before an executed contract — buyer rep, pre-approval, showing phase)
- active-listing (property is listed, not yet under contract)
- under-contract (executed contract, before option period)
- option-period (within the option period)
- inspection (inspection phase)
- financing (financing/appraisal phase)
- title-survey (title and survey phase)
- clear-to-close (all conditions met, ready to close)
- closed (transaction complete)
- next (advance to the next stage automatically)

COMMON STAGE PHRASES → CANONICAL ID:
- "pre-contract", "pre contract", "before contract", "showing", "buyer rep" → pre-contract
- "active listing", "listing", "just listed" → active-listing
- "under contract", "executed", "in contract", "went under contract" → under-contract
- "option period", "option", "in option" → option-period
- "inspection", "in inspection", "passed inspection" → inspection
- "financing", "appraisal", "in financing" → financing
- "title and survey", "title & survey", "title/survey", "survey" → title-survey
- "clear to close", "CTC", "cleared to close" → clear-to-close
- "closed", "closing complete", "done", "funded" → closed

CANONICAL FIELD NAMES — use ONLY these exact values for update_deal_field.field:
closing_date, contract_effective_date, option_days, financing_days, sale_price, earnest_money, option_fee, buyer_name, seller_name, property_address, city_state_zip, notes, title_company, title_officer_name, title_officer_email, title_officer_phone, lender_name, loan_officer_name, loan_officer_email, loan_officer_phone, hoa_name, hoa_phone, hoa_management_company, inspector_name, inspector_phone, inspector_email, mls_number, bedrooms, bathrooms, sqft, year_built, possession_date, appraisal_deadline, survey_deadline, hoa_document_deadline, loan_approval_deadline, transaction_type, option_fee_amount, option_fee_paid_at, option_fee_paid_to, earnest_money_amount, earnest_money_deposited_at, earnest_money_confirmed_at, earnest_money_title_company, inspection_scheduled_at, inspection_completed_at, inspection_report_received, appraisal_ordered_at, appraisal_received_at, appraisal_value, title_commitment_received_at, title_commitment_effective_date, survey_ordered_at, survey_received_at, survey_clear, loan_approval_received_at, clear_to_close_at, hoa_docs_requested_at, hoa_docs_received_at, recorded_deed_received_at, title_policy_delivered_at, cda_signed_at, closed_at, iabs_delivered_at, sellers_disclosure_received_at, buyer_rep_signed_at, pre_approval_received, pre_approval_letter_url, land_acreage, land_legal_description, land_parcel_id, land_zoning, land_deed_restrictions_reviewed, land_deed_restrictions_notes, land_survey_type, land_survey_ordered_date, land_survey_received_date, land_survey_clear, land_survey_notes, land_fence_survey_required, land_water_source, land_sewer_source, land_electric_confirmed, land_gas_confirmed, land_internet_confirmed, land_road_access_confirmed, land_flood_zone, land_flood_map_checked, land_flood_map_checked_date, land_wetlands_present, land_environmental_notes, land_phase1_required, land_phase1_received, land_phase1_received_date, builder_name, builder_rep_name, builder_rep_phone, builder_rep_email, builder_contract_date, builder_warranty_company, builder_warranty_expiration, builder_warranty_received, co_received_date, co_number, expected_completion_date, punch_list_notes, punch_list_cleared, punch_list_cleared_date, lease_monthly_rent, lease_security_deposit, lease_pet_deposit, lease_pet_policy, lease_application_fee, lease_start_date, lease_end_date, lease_application_submitted_date, lease_application_approved_date, lease_signed_date, lease_move_in_date, lease_move_out_date, lease_renewal_deadline, lease_move_in_condition_completed, lease_move_in_condition_date, lease_pre_existing_damage_notes, lease_tenant1_name, lease_tenant1_phone, lease_tenant1_email, lease_tenant2_name, lease_tenant2_phone, lease_tenant2_email, lease_num_occupants, lease_background_check_done, lease_credit_check_done, lease_property_manager_name, lease_property_manager_phone, lease_property_manager_email, lease_hoa_approval_required, lease_hoa_approval_received, lease_hoa_approval_received_date, lease_landlord_name, lease_landlord_phone, lease_landlord_email

COMMON FIELD PHRASES → CANONICAL NAME:
- "closing date", "close date", "closes on" → closing_date
- "contract date", "effective date", "executed date" → contract_effective_date
- "option period", "option days", "how many option days" → option_days
- "financing days", "financing period", "loan period" → financing_days
- "sale price", "list price", "purchase price", "price" → sale_price
- "earnest money", "EM", "earnest" → earnest_money
- "option fee", "option money" → option_fee
- "buyer", "buyer name", "buyer's name" → buyer_name
- "seller", "seller name", "seller's name" → seller_name
- "address", "property address" → property_address
- "city", "city state zip", "location" → city_state_zip
- "title company", "title co", "title" → title_company
- "title officer", "closer", "title contact" → title_officer_name
- "lender", "lender name", "bank" → lender_name
- "loan officer", "LO", "mortgage officer" → loan_officer_name
- "HOA", "homeowners association", "association" → hoa_name
- "inspector", "home inspector", "inspection company" → inspector_name
- "MLS number", "MLS #", "listing number" → mls_number
- "bedrooms", "beds", "how many bedrooms" → bedrooms
- "bathrooms", "baths", "how many baths" → bathrooms
- "square footage", "sqft", "square feet", "size" → sqft
- "year built", "built in", "age of home" → year_built
- "possession date", "possession", "move in date" → possession_date
- "appraisal deadline", "appraisal date" → appraisal_deadline
- "survey deadline", "survey date" → survey_deadline
- "HOA documents deadline", "HOA docs" → hoa_document_deadline
- "loan approval", "loan approval deadline", "approval date" → loan_approval_deadline
- "option fee amount", "option fee paid", "how much was the option fee" → option_fee_amount
- "option fee paid to", "who got the option fee" → option_fee_paid_to
- "earnest money amount", "how much earnest money" → earnest_money_amount
- "earnest money deposited", "EM deposited", "deposit sent" → earnest_money_deposited_at
- "earnest money confirmed", "EM confirmed", "title confirmed earnest" → earnest_money_confirmed_at
- "earnest money title company", "where is the earnest money" → earnest_money_title_company
- "inspection scheduled", "inspection date", "when is the inspection" → inspection_scheduled_at
- "inspection complete", "inspection done", "inspector finished" → inspection_completed_at
- "inspection report received", "got the inspection report" → inspection_report_received
- "appraisal ordered", "appraisal ordered at" → appraisal_ordered_at
- "appraisal received", "appraisal came back", "got the appraisal" → appraisal_received_at
- "appraisal value", "appraised at", "appraisal came in at" → appraisal_value
- "title commitment received", "title commitment came in", "got the title commitment" → title_commitment_received_at
- "title commitment effective date", "effective date on the title commitment" → title_commitment_effective_date
- "survey ordered", "ordered the survey" → survey_ordered_at
- "survey received", "survey came back", "got the survey" → survey_received_at
- "survey clear", "survey is clear", "survey passed" → survey_clear
- "loan approved", "loan approval received", "lender approved" → loan_approval_received_at
- "clear to close", "CTC", "cleared to close" → clear_to_close_at
- "HOA docs requested", "requested HOA documents", "ordered HOA docs" → hoa_docs_requested_at
- "HOA docs received", "got the HOA documents", "HOA documents arrived" → hoa_docs_received_at
- "recorded deed received", "deed recorded" → recorded_deed_received_at
- "title policy delivered", "title policy sent to buyer" → title_policy_delivered_at
- "CDA signed", "commission disbursement signed", "broker signed the CDA" → cda_signed_at
- "gave the client the IABS", "delivered the IABS", "sent the IABS", "IABS delivered" → iabs_delivered_at
- "seller's disclosure received", "got the seller disclosure", "OP-H received" → sellers_disclosure_received_at
- "buyer rep signed", "buyer representation agreement signed", "TAR 1501 signed" → buyer_rep_signed_at
- "pre-approval received", "got pre-approval", "buyer is pre-approved", "pre-approval letter" → pre_approval_received (set to "true"; follow up with answer_question prompting agent to upload the document in the dossier)
- "pre-approval letter URL", "link to pre-approval" → pre_approval_letter_url
- "acreage", "acres", "how many acres", "[X] acres" → land_acreage (numeric value)
- "legal description", "land legal description" → land_legal_description
- "parcel ID", "parcel number", "tax ID", "tax parcel" → land_parcel_id
- "zoning", "zoned as", "current zoning", "zone classification" → land_zoning
- "deed restrictions reviewed", "reviewed deed restrictions", "deed restrictions checked" → land_deed_restrictions_reviewed (set to "true")
- "deed restriction notes", "deed restrictions notes" → land_deed_restrictions_notes
- "survey type", "what kind of survey", "boundary survey", "ALTA survey", "fence survey" → land_survey_type
- "land survey ordered", "ordered the land survey" → land_survey_ordered_date
- "land survey received", "survey came back", "got the land survey" → land_survey_received_date
- "land survey clear", "survey is clear", "survey passed" → land_survey_clear (set to "true")
- "land survey notes", "survey comments" → land_survey_notes
- "fence survey required", "need a fence survey" → land_fence_survey_required (set to "true")
- "water source", "municipal water", "well water", "city water" → land_water_source
- "sewer source", "septic", "municipal sewer", "city sewer" → land_sewer_source
- "electric confirmed", "electricity confirmed", "power confirmed" → land_electric_confirmed (set to "true")
- "gas confirmed", "natural gas confirmed" → land_gas_confirmed (set to "true")
- "internet confirmed", "telecom confirmed", "fiber confirmed" → land_internet_confirmed (set to "true")
- "road access confirmed", "easement confirmed", "road easement" → land_road_access_confirmed (set to "true")
- "flood zone", "FEMA zone", "zone [X]", "flood zone [X]" → land_flood_zone (text like "Zone X")
- "flood map checked", "checked the flood map" → land_flood_map_checked (set to "true")
- "flood map checked date", "when was flood map checked" → land_flood_map_checked_date
- "wetlands present", "there are wetlands", "wetlands on the property" → land_wetlands_present (set to "true")
- "environmental notes", "environmental concerns" → land_environmental_notes
- "Phase 1 required", "Phase 1 ESA needed", "environmental study required" → land_phase1_required (set to "true")
- "Phase 1 received", "Phase 1 ESA received", "got the Phase 1" → land_phase1_received (set to "true")
- "Phase 1 received date", "when did we get the Phase 1" → land_phase1_received_date
- "builder name", "builder company", "who is the builder" → builder_name
- "builder rep", "builder sales rep", "sales rep name", "builder contact" → builder_rep_name
- "builder rep phone", "builder sales rep phone" → builder_rep_phone
- "builder rep email", "builder sales rep email" → builder_rep_email
- "builder contract date", "contract signed with builder", "builder contract signed" → builder_contract_date
- "warranty company", "builder warranty company", "home warranty company" → builder_warranty_company
- "warranty expires", "builder warranty expiration", "warranty expiration date" → builder_warranty_expiration
- "warranty received", "got the warranty document", "warranty document received" → builder_warranty_received (set to "true")
- "CO received", "certificate of occupancy received", "got the CO", "CO date" → co_received_date (today's date)
- "CO number", "certificate of occupancy number" → co_number
- "expected completion", "estimated completion date", "expected finish date", "home expected to be done" → expected_completion_date
- "punch list cleared", "punch list complete", "all punch list items fixed" → punch_list_cleared (set to "true") and punch_list_cleared_date (today)
- "punch list notes", "punch list items", "walkthrough notes" → punch_list_notes
- "mark [phase] complete", "foundation done", "framing done", "framing complete", "drywall done", "finishes done", "walkthrough complete", "CO phase complete" → construction_phases (use answer_question to tell agent phases are updated in the Builder section of the dossier; the phase tracker UI handles this interactively)
- "monthly rent", "rent amount", "rent is [X]", "lease for [X] per month" → lease_monthly_rent (numeric)
- "security deposit", "deposit amount", "security is [X]" → lease_security_deposit (numeric)
- "pet deposit" → lease_pet_deposit (numeric)
- "pet policy", "pets allowed", "no pets", "pets with deposit" → lease_pet_policy (values: not_allowed / allowed_with_deposit / allowed_no_deposit)
- "application fee", "app fee" → lease_application_fee (numeric)
- "lease starts", "lease start date", "start of lease" → lease_start_date
- "lease ends", "lease end date", "end of lease", "lease expiration" → lease_end_date
- "application submitted", "tenant submitted application", "application sent" → lease_application_submitted_date (today's date)
- "application approved", "tenant approved", "approved the tenant", "tenant [name] approved" → lease_application_approved_date (today's date); also set lease_tenant1_name if a name is given
- "lease signed", "lease executed", "both parties signed the lease" → lease_signed_date (today's date)
- "move-in scheduled", "move in date", "tenant moves in", "they move in on [date]" → lease_move_in_date
- "move-out date", "tenant moving out", "lease ends and move out" → lease_move_out_date
- "tenant name", "tenant 1 name", "who is the tenant", "renter name" → lease_tenant1_name
- "tenant phone", "tenant 1 phone" → lease_tenant1_phone
- "tenant email", "tenant 1 email" → lease_tenant1_email
- "second tenant", "tenant 2", "co-tenant" → lease_tenant2_name
- "background check done", "background check complete", "ran the background check" → lease_background_check_done (set to "true")
- "credit check done", "credit check complete", "ran the credit check" → lease_credit_check_done (set to "true")
- "property manager", "PM name", "property management contact" → lease_property_manager_name
- "PM phone", "property manager phone" → lease_property_manager_phone
- "PM email", "property manager email" → lease_property_manager_email
- "HOA approval required", "needs HOA approval", "HOA must approve tenant" → lease_hoa_approval_required (set to "true")
- "HOA approved", "HOA approved the tenant", "got HOA approval" → lease_hoa_approval_received (set to "true") and lease_hoa_approval_received_date (today)
- "landlord name", "owner name", "who owns the property" → lease_landlord_name
- "landlord phone", "owner phone" → lease_landlord_phone
- "landlord email", "owner email" → lease_landlord_email
- "move-in condition report done", "condition report completed", "walk-through done" → lease_move_in_condition_completed (set to "true") and lease_move_in_condition_date (today)
- "pre-existing damage", "existing damage notes", "noted damage" → lease_pre_existing_damage_notes

CANONICAL EMAIL TYPES — use ONLY these exact values for draft_email.email_type:
- buyer-welcome (welcome email to buyer at contract start)
- lender-introduction (introduce agent to lender)
- title-order (order title from title company)
- option-reminder (remind about option period expiration)
- financing-reminder (remind about financing deadline)
- clear-to-close (notify all parties of CTC)
- closing-day (day of closing notification)
- post-closing (thank you after closing)

CANONICAL ROLE VALUES for create_dossier.role:
- buyer (agent represents the buyer)
- seller (agent represents the seller / listing side)
- both (agent represents both sides)

DATE FORMAT: When the agent says relative dates, resolve them to YYYY-MM-DD format.
- "June 26th" → "2026-06-26"
- "next Friday" → calculate from today (${today})
- "in 3 days" → calculate from today
- "extend by 2 days" → calculate from the existing field value + 2 days

APP-SPECIFIC HOW-TO ANSWERS (use the answer_question tool):
When the agent asks how to do something in this app — including vague phrasing like "how do I send compliance" or "how do I track a deadline" — ALWAYS answer in terms of Dossie's own features. NEVER describe Skyslope, Dotloop, DocuSign, Folio, Brokermint, kvCORE, Brokerkit, Command, or any other third-party tool unless the agent explicitly names that tool first. NEVER give generic real-estate workflow advice when there is a Dossie feature that does the thing. If the agent asks "how do I send compliance documents", they mean inside Dossie — answer with the Send to Compliance button, not Skyslope.

WHEN THE AGENT ASKS "HOW DO I X" — OFFER THE TUTORIAL VIDEO:
After the short factual answer, in the SAME answer_question response, add: "Want to see it? I have a tutorial showing exactly this — meetdossie.com/help has the 60-second walkthrough." Use that pattern for compliance, DossieSign, scanning, fill-and-sign, amendments, morning brief, voice commands, document upload, deadline tracking, founding member onboarding. Do NOT add the video offer when the agent's question is about a TREC rule or a deal-status question (those are factual answers, not how-to). If they specifically say "show me a video" or "is there a video for that", direct them to meetdossie.com/help. If the question is broader (pricing, security, integrations, founding spots), point them to meetdossie.com/faq. For Texas-TC fundamentals (option period, earnest money, deadline counting), point them to meetdossie.com/guides. Final fallback for anything Dossie can't answer is meetdossie.com/learn (the full resource hub) or emailing heath@meetdossie.com.

Reference facts (weave into one or two natural sentences when calling answer_question — never bullets, never numbered steps):
- Adding a document — open the dossier and use the Documents section to upload or scan a contract.
- Calculating TREC deadlines — they're auto-calculated from the contract effective date entered when the dossier is created.
- Sending compliance documents — tap the "Send to Compliance" button in the top action row of any open dossier. Dossie compiles every document attached to that dossier and emails them as one packet to the brokerage compliance email. Works at any stage (under contract, option period, financing, clear-to-close, closed) — not just at closing. The compliance email is set once in Settings → Brokerage compliance email.
- Inviting their TC — team features are coming soon; for now they're flying solo.
- The Morning Brief — the daily audio summary of every active deal, playable from the Today view.
- Talking to Dossie — this conversation, anytime, from the Talk to Dossie button.
- Sharing a closing card — pops up automatically when a deal hits a milestone (Under Contract, Closed, etc.); savable and re-shareable from the Milestones section of the dossier.
- Updating a deadline — open the dossier and tap the deadline field directly to edit it.

PERSONALITY:
You are confident without being cold. Thorough without being verbose. You sound like the best TC the agent has ever worked with — the one who always has the answer, always has the file moving, and never needs to be chased down. You are the TC that never sleeps.`;
};

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
      titleCompany: d.titleCompany || null,
      titleOfficerName: d.titleOfficerName || null,
      titleOfficerEmail: d.titleOfficerEmail || null,
      titleOfficerPhone: d.titleOfficerPhone || null,
      lenderName: d.lenderName || null,
      loanOfficerName: d.loanOfficerName || null,
      loanOfficerEmail: d.loanOfficerEmail || null,
      loanOfficerPhone: d.loanOfficerPhone || null,
      hoaName: d.hoaName || null,
      hoaPhone: d.hoaPhone || null,
      hoaManagementCompany: d.hoaManagementCompany || null,
      inspectorName: d.inspectorName || null,
      inspectorPhone: d.inspectorPhone || null,
      inspectorEmail: d.inspectorEmail || null,
      mlsNumber: d.mlsNumber || null,
      bedrooms: d.bedrooms ?? null,
      bathrooms: d.bathrooms ?? null,
      sqft: d.sqft ?? null,
      yearBuilt: d.yearBuilt ?? null,
      possessionDate: d.possessionDate || null,
      appraisalDeadline: d.appraisalDeadline || null,
      surveyDeadline: d.surveyDeadline || null,
      hoaDocumentDeadline: d.hoaDocumentDeadline || null,
      loanApprovalDeadline: d.loanApprovalDeadline || null,
    }));
}

async function handleActionMode({ message, deals, messages, userId }) {
  const today = new Date().toISOString().slice(0, 10);
  const compactDeals = compactDealsForAction(deals);
  // Split system into static (persona + rules + tools — cache-eligible) and
  // variable (today's date + per-user deals snapshot — too unique to cache).
  // We split on the TODAY: marker which the action prompt uses to anchor
  // today's date + deals JSON.
  const fullSystem = buildActionSystemPrompt(compactDeals, today);
  const variableMarker = `TODAY: ${today}`;
  const varIdx = fullSystem.indexOf(variableMarker);
  const systemStatic = varIdx > 0 ? fullSystem.slice(0, varIdx) : fullSystem;
  const systemVariable = varIdx > 0 ? fullSystem.slice(varIdx) : '';

  console.log('[Chat] prompt first 150 chars:', systemStatic.slice(0, 150));

  const finalMessages = (Array.isArray(messages) && messages.length > 0)
    ? messages
    : [{ role: 'user', content: message }];

  console.log('[Chat] messages array len:', finalMessages.length, 'preview:', finalMessages.map((m) => ({ role: m.role, contentLen: typeof m.content === 'string' ? m.content.length : 0, head: typeof m.content === 'string' ? m.content.slice(0, 80) : '<non-string>' })));

  const response = await messagesCreateCached(anthropic, {
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    systemStatic,
    systemVariable,
    tools: TOOLS,
    tool_choice: { type: 'auto' },
    messages: finalMessages,
    metadata: { endpoint: 'chat:action', user_id: userId },
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
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed. Use POST.'
    });
  }

  try {
    // JWT auth — must come before any AI call or DB query.
    let jwtUserId;
    try {
      const authResult = await verifySupabaseToken(req);
      jwtUserId = authResult.userId;
    } catch (authErr) {
      return res.status(authErr.status || 401).json({ ok: false, error: authErr.message });
    }

    // IP-based rate limit (30/hour). Layered on top of the per-user/plan
    // limit below — this catches abusive callers regardless of userId.
    const ip = clientIpFromReq(req);
    await checkIpRateLimit(ip, 'chat', 30, 60 * 60 * 1000);

    const { message, transactionContext, userPlan, mode, deals, messages } = req.body;

    // userId comes from the verified JWT, not the request body.
    const userId = jwtUserId;

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

      const result = await handleActionMode({ message: effectiveMessage, deals, messages, userId });
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
    const reply = await callClaude(model, effectiveMessage, systemPrompt, messages, { user_id: userId });

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

    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }

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
