'use strict';

// api/_lib/auto-merge-risk-gate.js
//
// Risk classifier for the daily staging->main auto-merge gate
// (.github/workflows/staging-auto-merge-gate.yml).
//
// WHY (Heath, 2026-09-28): 89 commits / 188 files sat unmerged on staging,
// oldest 11 days, all his own work, mostly social/cron infrastructure,
// stuck purely because merging requires him and he's busy. Approved design:
// daily automated merge IF the test suite is green AND nothing touches
// contracts/e-sign, client sends, money, auth/RLS/migrations, or the cron
// config. He remains the gate for those. Everything else flows.
//
// THIS FILE DOES ONE THING: given the list of files changed between main
// and staging, decide CLEAR (auto-mergeable) or HOLD (needs Heath). It does
// not run tests, does not touch git, does not talk to Supabase or Telegram.
// Pure function, easy to unit-test, easy for Heath to audit and extend.
//
// FAIL CLOSED (Heath's explicit instruction): a file that doesn't match a
// known-risk pattern AND doesn't match the known-safe allowlist HOLDS as
// "unclassified" rather than silently merging. A false hold costs a day; a
// false merge can send a client a broken contract.
//
// Categories, in the order Heath specified:
//   1. e-sign / contract
//   2. outbound client communication (email/SMS to a recipient)
//   3. payments / billing
//   4. auth / RLS / migrations
//   5. vercel.json (cron config lives here)
//   6. (added here, not in Heath's list, but the obvious extension of
//      "fail closed": the gate must never approve a change to its own
//      trust boundary — the workflow file and this module itself.)
//
// Anything else is checked against SAFE_ALLOWLIST. No match on either side
// -> HOLD, reason 'unclassified_path'.

// ─── Category 1: e-sign / contract ─────────────────────────────────────────
// Heath's explicit list: api/esign-create.js, api/_lib/esign-*,
// api/_assets/esign-field-maps.json, scripts/esign-role-maps/,
// api/_lib/docuseal-*, "anything DocuSeal". Generalized to any path
// containing esign/docuseal (case-insensitive) plus the contract-adjacent
// keywords implied by the category name "e-sign / contract" — signature
// verification, TREC form-filling, and the field-map/checkbox-election
// logic that feeds the same packets.
const ESIGN_CONTRACT_RE = /(^|\/)(api\/esign-create\.js|api\/_assets\/esign-field-maps\.json)$|scripts\/esign-role-maps\/|esign|docuseal|signature-verifier|trec-2\d-\d\d|trec-validator|fill-form|checkbox-election|contract-safety|contract-term|contract-field/i;

// ─── Category 2: outbound client communication ─────────────────────────────
// "anything that sends email or SMS to a recipient." Scoped to 1:1 /
// targeted sends (client, lead, prospect) — NOT public social/group
// posting (Zernio, fb-group-poster, comment-hunt), which is exactly the
// "social/cron infrastructure" Heath wants flowing automatically.
const OUTBOUND_CLIENT_COMM_RE = /\b(email|sms|resend|twilio|mail|gmail|dm-link|notify-sales-lead|notify-founding|outbound|kw-mail)\b/i;

// ─── Category 3: payments / billing ─────────────────────────────────────────
const PAYMENTS_RE = /stripe|subscription|checkout-session|billing|dunning|pricing-tier/i;

// ─── Category 4: auth, RLS, migrations ─────────────────────────────────────
const AUTH_RLS_MIGRATION_RE = /^supabase\/migrations\//i;
const AUTH_RLS_MIGRATION_KEYWORD_RE = /\brls\b|\bauth\b|-migrate-|-migration|oauth|admin-migrate|admin-cleanup/i;

// ─── Category 5: cron config ────────────────────────────────────────────────
const VERCEL_CONFIG_RE = /^vercel\.json$/;

// ─── Category 6: the gate's own trust boundary ─────────────────────────────
const GATE_SELF_RE = /^\.github\/workflows\/staging-auto-merge-gate\.yml$|^api\/_lib\/auto-merge-risk-gate(\.test)?\.js$|^scripts\/auto-merge-test-suite\.js$/;

const RISK_CATEGORIES = [
  { key: 'esign_contract', label: 'e-sign / contract', test: (f) => ESIGN_CONTRACT_RE.test(f) },
  { key: 'outbound_client_comm', label: 'outbound client communication', test: (f) => OUTBOUND_CLIENT_COMM_RE.test(f) },
  { key: 'payments_billing', label: 'payments / billing', test: (f) => PAYMENTS_RE.test(f) },
  {
    key: 'auth_rls_migration',
    label: 'auth / RLS / migrations',
    test: (f) => AUTH_RLS_MIGRATION_RE.test(f) || AUTH_RLS_MIGRATION_KEYWORD_RE.test(f),
  },
  { key: 'cron_config', label: 'vercel.json cron config', test: (f) => VERCEL_CONFIG_RE.test(f) },
  { key: 'gate_self_modification', label: 'auto-merge gate self-modification', test: (f) => GATE_SELF_RE.test(f) },
];

// ─── Known-safe allowlist — everything else must match this to auto-merge ──
// Deliberately broad over the actual bulk of Heath's stuck backlog (social/
// cron infra, regression scripts, docs, memory) and nothing else. A file
// under one of these prefixes that ALSO matched a risk category above was
// already caught (risk check runs first) — this only gates what's left.
const SAFE_ALLOWLIST_RE = [
  /^api\/cron-/i,
  /^api\/_lib\//i,
  /^api\/[a-z0-9_-]+\.js$/i,        // flat api/*.js handlers (non-risk ones)
  /^scripts\//i,
  /^docs\//i,
  /^\.claude\/(?!worktrees\/)/i,     // memory/config, not worktree scratch
  /^Engineering\//i,
  /^marketing\//i,
  /^supabase\/(?!migrations\/)/i,    // non-migration supabase config (functions, seed docs)
  /^\.github\/workflows\/(?!staging-auto-merge-gate\.yml$)/i, // other CI, not the gate itself
  /^(CLAUDE\.md|HANDOFF\.md|README\.md|\.gitignore|package\.json|package-lock\.json)$/,
];

/**
 * Classify one file path.
 * @returns {{decision:'clear'|'hold', reason:string|null, category:string|null}}
 */
function classifyFile(filePath) {
  const f = String(filePath || '').replace(/^\/+/, '');
  for (const cat of RISK_CATEGORIES) {
    if (cat.test(f)) {
      return { decision: 'hold', reason: cat.label, category: cat.key };
    }
  }
  if (SAFE_ALLOWLIST_RE.some((re) => re.test(f))) {
    return { decision: 'clear', reason: null, category: null };
  }
  return { decision: 'hold', reason: 'unclassified path — not on the safe allowlist and not a recognized risk pattern', category: 'unclassified' };
}

/**
 * Classify a full changeset.
 * @param {string[]} files - paths changed between main and staging (e.g. `git diff --name-only main...staging`)
 * @returns {{decision:'clear'|'hold', holds: Array<{file:string, reason:string, category:string}>, cleared: string[]}}
 */
function classifyFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const holds = [];
  const cleared = [];
  for (const f of list) {
    const c = classifyFile(f);
    if (c.decision === 'hold') {
      holds.push({ file: f, reason: c.reason, category: c.category });
    } else {
      cleared.push(f);
    }
  }
  return {
    decision: holds.length > 0 ? 'hold' : 'clear',
    holds,
    cleared,
    total: list.length,
  };
}

module.exports = {
  classifyFile,
  classifyFiles,
  RISK_CATEGORIES,
  SAFE_ALLOWLIST_RE,
};
