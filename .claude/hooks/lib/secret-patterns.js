'use strict';
/**
 * Literal-secret detection for Edit/Write content, per CLAUDE.md Section 15:
 * "NEVER hardcode auth tokens, API keys, or secrets in source code."
 * Deliberately pattern-based and conservative — false positives are cheap
 * (a shadow-log line), false negatives are the thing we're trying to kill.
 */
const PATTERNS = [
  { name: 'stripe_secret_key', re: /\bsk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'stripe_restricted_key', re: /\brk_(live|test)_[A-Za-z0-9]{16,}\b/ },
  { name: 'supabase_service_jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'openai_key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'slack_token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'generic_bearer_literal', re: /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{15,}/ },
  { name: 'private_key_block', re: /-----BEGIN (RSA |EC |OPENSSH |)PRIVATE KEY-----/ },
  { name: 'telegram_bot_token', re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  {
    name: 'one_shot_bypass_token',
    re: /\b(ONE_SHOT_TOKEN|BYPASS_TOKEN|const\s+ONE_SHOT)\b/i,
  },
];

/** Returns an array of {name} matches found in `text`. Never throws. */
function findSecrets(text) {
  if (typeof text !== 'string' || !text) return [];
  const hits = [];
  for (const p of PATTERNS) {
    try {
      if (p.re.test(text)) hits.push(p.name);
    } catch (e) { /* a bad pattern should never take the whole scan down */ }
  }
  return hits;
}

module.exports = { findSecrets, PATTERNS };
