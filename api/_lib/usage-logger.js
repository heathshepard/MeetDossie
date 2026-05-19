/**
 * Usage Logger Utility
 * Fire-and-forget logging for metered service usage
 * Excludes demo users automatically
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Pricing constants (updated as of 2026-05-19)
const PRICING = {
  elevenlabs_per_1k_chars: 0.30,
  anthropic_sonnet_input_per_1m: 3.00,
  anthropic_sonnet_output_per_1m: 15.00,
  anthropic_haiku_input_per_1m: 0.25,
  anthropic_haiku_output_per_1m: 1.25,
  resend_per_1k_emails: 1.00,
  hcti_per_render: 0, // First 50 free, then flat $14/mo
  creatomate_per_render: 0.05, // Estimated
};

/**
 * Check if a user is a demo account (should be excluded from logging)
 */
async function isDemoUser(userId) {
  if (!userId) return false;

  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=is_demo`, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!res.ok) return false;
    const data = await res.json();
    return data && data[0] && data[0].is_demo === true;
  } catch (err) {
    console.error('[usage-logger] Failed to check is_demo:', err);
    return false;
  }
}

/**
 * Log ElevenLabs TTS usage
 * @param {string} userId - User ID from auth
 * @param {number} characterCount - Number of characters synthesized
 * @param {object} metadata - Optional metadata (text_length, speed, etc.)
 */
async function logElevenLabs(userId, characterCount, metadata = {}) {
  if (!userId) return;
  if (await isDemoUser(userId)) return;

  const cost = (characterCount / 1000) * PRICING.elevenlabs_per_1k_chars;

  await insertLog({
    user_id: userId,
    service: 'elevenlabs',
    usage_type: 'voice_tts',
    units_consumed: characterCount,
    estimated_cost: cost,
    metadata: { ...metadata, character_count: characterCount },
  });
}

/**
 * Log Anthropic API usage
 * @param {string} userId - User ID from auth
 * @param {string} endpoint - 'chat' or 'scan'
 * @param {object} usage - Token usage object from Anthropic response
 * @param {string} model - Model name (e.g., 'claude-sonnet-4-6')
 * @param {object} metadata - Optional metadata
 */
async function logAnthropic(userId, endpoint, usage, model, metadata = {}) {
  if (!userId) return;
  if (await isDemoUser(userId)) return;

  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const totalTokens = inputTokens + outputTokens;

  // Calculate cost based on model
  let inputCostPerM, outputCostPerM;
  if (model.includes('sonnet')) {
    inputCostPerM = PRICING.anthropic_sonnet_input_per_1m;
    outputCostPerM = PRICING.anthropic_sonnet_output_per_1m;
  } else if (model.includes('haiku')) {
    inputCostPerM = PRICING.anthropic_haiku_input_per_1m;
    outputCostPerM = PRICING.anthropic_haiku_output_per_1m;
  } else {
    // Default to Sonnet pricing for unknown models
    inputCostPerM = PRICING.anthropic_sonnet_input_per_1m;
    outputCostPerM = PRICING.anthropic_sonnet_output_per_1m;
  }

  const cost = (inputTokens / 1_000_000) * inputCostPerM + (outputTokens / 1_000_000) * outputCostPerM;

  await insertLog({
    user_id: userId,
    service: 'anthropic',
    usage_type: endpoint, // 'chat' or 'scan'
    units_consumed: totalTokens,
    estimated_cost: cost,
    metadata: {
      ...metadata,
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  });
}

/**
 * Log Resend email usage
 * @param {string} userId - User ID from auth (NULL for system emails)
 * @param {number} emailCount - Number of emails sent (default 1)
 * @param {object} metadata - Optional metadata (to, subject, etc.)
 */
async function logResend(userId, emailCount = 1, metadata = {}) {
  // Allow system emails (userId = null), but skip demo users
  if (userId && await isDemoUser(userId)) return;

  const cost = (emailCount / 1000) * PRICING.resend_per_1k_emails;

  await insertLog({
    user_id: userId, // Can be NULL for system emails
    service: 'resend',
    usage_type: 'email',
    units_consumed: emailCount,
    estimated_cost: cost,
    metadata: { ...metadata, email_count: emailCount },
  });
}

/**
 * Log Creatomate video render
 * @param {string} userId - User ID (usually NULL for system renders)
 * @param {object} metadata - Optional metadata (template_id, duration, etc.)
 */
async function logCreatomate(userId = null, metadata = {}) {
  if (userId && await isDemoUser(userId)) return;

  const cost = PRICING.creatomate_per_render;

  await insertLog({
    user_id: userId,
    service: 'creatomate',
    usage_type: 'video_render',
    units_consumed: 1,
    estimated_cost: cost,
    metadata,
  });
}

/**
 * Log HCTI image card render
 * @param {string} userId - User ID (usually NULL for system renders)
 * @param {object} metadata - Optional metadata (post_id, platform, etc.)
 */
async function logHCTI(userId = null, metadata = {}) {
  if (userId && await isDemoUser(userId)) return;

  // HCTI cost is flat monthly after 50 renders, so we log $0 per render
  // Admin dashboard shows total count and alerts when approaching/exceeding free tier
  const cost = 0;

  await insertLog({
    user_id: userId,
    service: 'hcti',
    usage_type: 'image_render',
    units_consumed: 1,
    estimated_cost: cost,
    metadata,
  });
}

/**
 * Insert a log entry into usage_logs table
 * Fire-and-forget - failures are logged but don't throw
 */
async function insertLog(logEntry) {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/usage_logs`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(logEntry),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[usage-logger] Insert failed (${res.status}):`, text.slice(0, 200));
    }
  } catch (err) {
    console.error('[usage-logger] Insert error:', err);
    // Don't throw - logging is fire-and-forget
  }
}

module.exports = {
  logElevenLabs,
  logAnthropic,
  logResend,
  logCreatomate,
  logHCTI,
};
