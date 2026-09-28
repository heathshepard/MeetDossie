'use strict';

// scripts/_lib/account-resolvability-check.js
//
// Same gate as scripts/_lib/group-resolvability-check.js, applied to
// comment_target_accounts rows (scripts/outbound-account-commenter.js).
//
// WHY: the seed migration (supabase/migrations/20260928_outbound_account_
// comments.sql) populated comment_target_accounts from general knowledge —
// this session had no live browser or working search tool to independently
// confirm each handle/URL resolves on the real platform (documented in the
// build report). A plausible-looking name is not the same thing as a real
// page. Exactly the failure this closed for FB groups on 2026-09-16
// ("Boerne Real Estate" / "Real Estate in Austin TX" — neither existed).
//
// A row is RESOLVABLE only if:
//   1. active === true
//   2. page_url is non-empty and matches a real facebook.com/instagram.com
//      page/profile URL shape (not a group, not a placeholder)
//   3. existence_verified === true — a live browser session has actually
//      loaded the page and confirmed it resolves. Set via
//      scripts/outbound-account-commenter.js --verify (or by hand in
//      Supabase) after a real visit, never by assumption.
//
// Anything else is refused and reported, never silently skipped.

const FB_PAGE_URL_RE = /^https:\/\/(www\.)?facebook\.com\/[^/\s?]+\/?$/i;
const IG_PAGE_URL_RE = /^https:\/\/(www\.)?instagram\.com\/[^/\s?]+\/?$/i;

function checkAccountResolvable(account) {
  const name = (account && account.account_name) || account?.handle || '(unnamed account)';
  const url = account && account.page_url;
  const platform = account && account.platform;

  if (account && account.active === false) {
    return { ok: false, reason: `${name}: active=false` };
  }
  if (!url || typeof url !== 'string' || !url.trim()) {
    return { ok: false, reason: `${name}: no page_url set` };
  }
  const trimmed = url.trim();
  if (trimmed.includes('PLACEHOLDER')) {
    return { ok: false, reason: `${name}: page_url is a PLACEHOLDER, never filled in` };
  }
  const shapeOk = platform === 'instagram' ? IG_PAGE_URL_RE.test(trimmed) : FB_PAGE_URL_RE.test(trimmed);
  if (!shapeOk) {
    return { ok: false, reason: `${name}: page_url "${trimmed}" doesn't look like a real ${platform || 'facebook/instagram'} page URL` };
  }
  if (account.existence_verified !== true) {
    return {
      ok: false,
      reason: `${name}: existence_verified is not true — nobody has confirmed this page actually exists live `
        + `(seeded from general knowledge, not a browser visit — see the 2026-09-28 build report)`,
    };
  }
  return { ok: true, reason: null };
}

/**
 * Splits an account list into resolvable / unresolved, reporting every
 * refusal. Never throws.
 *
 * @param {Array} accounts
 * @param {object} [opts] { report: function(reason) }
 * @returns {{ resolvable: Array, unresolved: Array<{account, reason}> }}
 */
function filterResolvableAccounts(accounts, opts = {}) {
  const report = opts.report || ((msg) => console.error(`[account-resolvability] REFUSED — ${msg}`));
  const resolvable = [];
  const unresolved = [];
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const result = checkAccountResolvable(account);
    if (result.ok) {
      resolvable.push(account);
    } else {
      unresolved.push({ account, reason: result.reason });
      report(result.reason);
    }
  }
  return { resolvable, unresolved };
}

module.exports = {
  FB_PAGE_URL_RE,
  IG_PAGE_URL_RE,
  checkAccountResolvable,
  filterResolvableAccounts,
};
