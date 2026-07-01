// api/_lib/check-suppression.js
//
// Shared suppression-list checker: prevents emails to unsubscribed recipients.
// Reads from two sources:
//   1. email_suppression_list — explicit unsubscribes via /api/unsubscribe
//   2. email_events with type='bounce' or 'complaint' — hard bounces, spam complaints
//
// Usage:
//   const { isSuppressed } = require('./_lib/check-suppression');
//   if (await isSuppressed(recipient.email, supabaseUrl, serviceRoleKey)) {
//     console.log('Skipping suppressed email');
//     return; // or log to email_events
//   }
//
// Caching: In-memory cache per handler invocation to avoid N queries in a loop.
// Safe for per-row checks in a batch send (cron-send-outbound-emails loop).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Per-invocation cache: { email -> boolean }
let suppressionCache = {};

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

async function isSuppressed(email, supabaseUrl, serviceRoleKey) {
  if (!email || typeof email !== 'string') return false;

  const normalized = normalizeEmail(email);
  if (!normalized) return false;

  // Check cache first
  if (normalized in suppressionCache) {
    return suppressionCache[normalized];
  }

  const baseUrl = supabaseUrl || SUPABASE_URL;
  const key = serviceRoleKey || SUPABASE_SERVICE_ROLE_KEY;

  if (!baseUrl || !key) {
    console.warn('[check-suppression] Supabase not configured');
    return false;
  }

  try {
    // Check email_suppression_list (explicit unsubscribes)
    const suppRes = await fetch(
      `${baseUrl}/rest/v1/email_suppression_list?email=eq.${encodeURIComponent(normalized)}`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );

    if (suppRes.ok) {
      const rows = await suppRes.json().catch(() => []);
      if (Array.isArray(rows) && rows.length > 0) {
        suppressionCache[normalized] = true;
        return true;
      }
    }

    // Check email_events for hard bounces or complaints.
    // NOTE: table uses recipient_email + event_type (not email + type).
    // Fixed 2026-06-28 by pierce_5 - prior version silently failed open.
    const eventsRes = await fetch(
      `${baseUrl}/rest/v1/email_events?recipient_email=eq.${encodeURIComponent(normalized)}&event_type=in.(bounce,complaint)`,
      {
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
        },
      }
    );

    if (eventsRes.ok) {
      const events = await eventsRes.json().catch(() => []);
      if (Array.isArray(events) && events.length > 0) {
        suppressionCache[normalized] = true;
        return true;
      }
    }

    suppressionCache[normalized] = false;
    return false;
  } catch (err) {
    console.warn('[check-suppression] query failed:', err && err.message);
    // Fail open: if we can't check, allow send (don't block on infrastructure error)
    return false;
  }
}

// Clear cache between batch invocations (optional; called manually by batch ops)
function clearCache() {
  suppressionCache = {};
}

module.exports = {
  isSuppressed,
  clearCache,
  normalizeEmail,
};
