// Shared helper for picking the right name to greet a customer with.
//
// Source of truth precedence:
//   1. profiles.preferred_name  — what the customer told us to call them
//                                  (e.g. "Suzanne" for "Kay Suzanne Page")
//   2. profiles.full_name        — split on whitespace, take first token
//   3. email local-part           — fallback when full_name is missing
//   4. 'there'                    — last-resort greeting
//
// Any code that emails / texts / TTS-greets a customer should call this
// instead of inlining a `full_name.split(' ')[0]` to avoid drift the next
// time a customer asks to be called something different from their legal
// name on file.
//
// Usage:
//   const { customerFirstName } = require('./_lib/personalization.js');
//   const greeting = `Good morning, ${customerFirstName(profile)}.`;
//
// `profile` is whatever shape the caller has — we only read the three
// fields we care about, so it's safe to pass either a Supabase row or a
// normalized object.

function customerFirstName(profile) {
  if (!profile) return 'there';
  const preferred = (profile.preferred_name || '').trim();
  if (preferred) return preferred;
  const full = (profile.full_name || '').trim();
  if (full) {
    const token = full.split(/\s+/)[0];
    if (token) return token;
  }
  const email = (profile.email || '').trim();
  if (email) {
    const local = email.split('@')[0];
    if (local) return local.split(/[._-]/)[0] || local;
  }
  return 'there';
}

module.exports = { customerFirstName };
