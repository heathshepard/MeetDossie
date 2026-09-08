// api/_lib/mail-provider-detect.js
//
// Best-effort mail-provider guess from an email address's MX records, used
// ONLY as a pre-purchase guard on api/create-addon-checkout-session.js — not
// as a source of truth anywhere else (the real source of truth is whichever
// user_integrations row the customer actually connects; see mail-client.js).
//
// Why this exists: 2026-08-30 Heath checked the MX records of all 10 active
// paying customers by hand — 6 Google, 4 Microsoft — and found the Email
// Integration add-on checkout let ANY of them pay for a capability that, at
// the time, only worked for Gmail. Buying something you then can't connect
// is a refund-and-trust bug regardless of which specific provider is
// unsupported today vs. tomorrow, so this is written as a general "can this
// account's mailbox even work with either supported provider" check, not a
// hardcoded Google-vs-Microsoft-only check.
//
// Deliberately fails OPEN: DNS is flaky in a serverless sandbox, and a false
// "unsupported" block costs a sale for a legitimate Google/Microsoft
// customer, which is worse than occasionally letting an ambiguous case
// through to the real, authoritative check (whether they can actually
// connect in Settings).
//
// Built 2026-09-01 (SV-ENG-EMAIL-INTEGRATION-MS-GRAPH).

// Looked up dynamically (not cached at module load) so tests can monkeypatch
// dns.promises.resolveMx without needing a mocking library.
const dns = require('node:dns');

const GOOGLE_MX_PATTERNS = [/\.google\.com$/i, /\.googlemail\.com$/i, /aspmx\.l\.google\.com$/i];
const MICROSOFT_MX_PATTERNS = [/\.outlook\.com$/i, /mail\.protection\.outlook\.com$/i];

/**
 * @param {string} email
 * @returns {Promise<{provider: 'google'|'microsoft'|'unsupported'|'unknown', mx: string[]}>}
 *   'unknown' means the lookup itself failed or the address had no domain —
 *   callers should treat 'unknown' the same as a supported provider (fail
 *   open), NOT the same as 'unsupported'.
 */
async function detectMailProvider(email) {
  const domain = String(email || '').split('@')[1];
  if (!domain) return { provider: 'unknown', mx: [] };

  let records;
  try {
    records = await dns.promises.resolveMx(domain);
  } catch (err) {
    return { provider: 'unknown', mx: [] };
  }

  const hosts = (records || []).map((r) => String(r.exchange || '').toLowerCase());
  if (!hosts.length) return { provider: 'unknown', mx: [] };

  if (hosts.some((h) => GOOGLE_MX_PATTERNS.some((re) => re.test(h)))) {
    return { provider: 'google', mx: hosts };
  }
  if (hosts.some((h) => MICROSOFT_MX_PATTERNS.some((re) => re.test(h)))) {
    return { provider: 'microsoft', mx: hosts };
  }
  return { provider: 'unsupported', mx: hosts };
}

module.exports = { detectMailProvider };
