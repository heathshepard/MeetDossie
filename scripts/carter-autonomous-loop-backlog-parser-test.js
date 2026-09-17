#!/usr/bin/env node
'use strict';

// scripts/carter-autonomous-loop-backlog-parser-test.js
// =============================================================================
// Unit tests for api/_lib/backlog-parser.js — the closed-item filter and the
// `Blocked by` eligibility gate that decide what the autonomous loop may pick up.
//
// Run: node scripts/carter-autonomous-loop-backlog-parser-test.js
// Exit 0 = all pass, 1 = failure. No network, no DB, no env needed.
//
// Two regressions these tests exist to prevent:
//   1. The loop dispatching a TECH-DEBT line that is struck through or marked
//      RESOLVED (it did, to carter, on 2026-09-13 and 2026-09-15).
//   2. The loop picking up a backlog item whose `Blocked by` field needs Heath
//      personally — a credential, a payment, a legal call, a physical action,
//      or a message to a real person.
// =============================================================================

const fs = require('fs');
const path = require('path');
const P = require('../api/_lib/backlog-parser.js');

let pass = 0;
let fail = 0;

function check(name, cond, detail) {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ─── 1. classifyClosed ───────────────────────────────────────────────────────

console.log('\n[1] classifyClosed — closed markers');

const CLOSED_CASES = [
  // The exact line the loop dispatched twice. Both markers present.
  ['- ~~`cron-comment-opp-approval` never left staging~~ — RESOLVED 2026-09-09 (same day as flagged), merged in `b9264c58`.', 'strikethrough'],
  ['- ~~Fill-and-sign Phase 2~~ — RESOLVED (already built, stale entry corrected 2026-08-24).', 'strikethrough'],
  ['- ~~Lifestyle video Zernio video-post creation~~ — see KNOWN TECH DEBT item 4, RESOLVED 2026-08-10.', 'strikethrough'],
  // Strikethrough with no status word at all.
  ['- ~~Some abandoned thing~~', 'strikethrough'],
  ['- **~~Bolded and struck~~** — superseded by the new flow', 'strikethrough'],
  // Status word, no strikethrough.
  ['- Stripe Payment Links — DONE 2026-05-07', 'status_word'],
  ['- MCP npm publish (SHIPPED)', 'status_word'],
  ['- Milestone card migration: FIXED', 'status_word'],
  ['- **Amendment drafting** — LIVE incl. NL entry. Wired 2026-05-28.', 'status_word'],
  ['- Old renderer — DEPRECATED in favour of the new one', 'status_word'],
  // Checkbox and glyph forms.
  ['- [x] Wire the webhook', 'checkbox'],
  ['- ✅ Zernio account IDs captured', 'checkmark'],
  // Phrases.
  ['- Fill-and-sign Phase 2 — stale entry, no action needed', 'phrase'],
  ['- HOA generators — already built, verified on origin/main', 'phrase'],
];

for (const [line, expectPrefix] of CLOSED_CASES) {
  const r = P.classifyClosed(line);
  check(
    `closed: ${line.slice(0, 62)}…`,
    r.closed && String(r.reason).startsWith(expectPrefix),
    `got closed=${r.closed} reason=${r.reason}`
  );
}

console.log('\n[1b] classifyClosed — open items must NOT be closed');

const OPEN_CASES = [
  '- Brokerage compliance document sending (specced, not built — high value)',
  '- Stripe Payment Links (permanent, non-expiring) — current checkout sessions expire 24h',
  // "Smithery ✅ live" — a done SUB-item inside an open one. Must stay open.
  '- MCP server registry submissions: MCPT / OpenTools (Smithery ✅ live)',
  '- TikTok automation (manual only until ~May 20, 2026)',
  '- Zernio analytics feedback loop (`post_analytics` table specced, not built)',
  '- **Dossier transaction type expansion** — add `transaction_type` field to transactions',
  // Regression: a bare `-` boundary once closed this (the "-done" in "half-done").
  '`dossier_milestones` base64 migration is half-done and the app still writes base64',
  // Regression: an `\\bis\\s` boundary once closed this as prose.
  'Plate breakdown is dropped whenever a weight is edited by hand',
  'The fix resolved one case but the other three still reproduce',
  'Two crons are done being retried and now fail silently',
  // Regression: a completed SUB-part deep in the body of an OPEN item. Scanning
  // the whole line closed this one on "(done)".
  '- **SMS escalation (Twilio)** — critical deadline + draft-aging alerts. ~$0.0075/msg, ~50¢/agent/mo. Needs phone capture (done) + opt-in toggle. Phase 2 deferred.',
  // Same shape, different marker: the sub-item shipped, the parent has not.
  '- **Customer Education** — Phase 1 welcome email. Phase 2 drip is DONE but Phase 3 knowledge base is not started.',
];

for (const line of OPEN_CASES) {
  const r = P.classifyClosed(line);
  check(`open: ${line.slice(0, 62)}…`, r.closed === false, `wrongly closed as ${r.reason}`);
}

// ─── 2. classifyBlockedBy ────────────────────────────────────────────────────

console.log('\n[2] classifyBlockedBy — ELIGIBLE (agent can finish unattended)');

const ELIGIBLE = [
  'agent.',
  '— agent.',
  '**agent.**',
  'agent, Heath gates merge.',
  '— agent, Heath gates merge.',
  'agent, Heath gates merge. ("Submit to MC" stays a human click by design.)',
  'agent (needs the product driven, not a code read).',
  'agent (triage only).',
  'agent (the render side). Note the video approval gate below.',
  'agent, after confirming which route the Jarvis PWA calls.',
  'agent, after G2/G5.',
];
for (const v of ELIGIBLE) {
  const r = P.classifyBlockedBy(v);
  check(`eligible: ${v.slice(0, 58)}`, r.eligible === true, `reason=${r.reason}`);
}

console.log('\n[2b] classifyBlockedBy — NOT eligible (needs Heath)');

const NOT_ELIGIBLE = [
  // Heath outright.
  ['**Heath.**', 'heath'],
  ['Heath (Stripe dashboard). The reconcile afterwards is agent work.', 'heath'],
  ['Heath (signature, payment).', 'heath'],
  ['Heath (relationship).', 'heath'],
  ['**Heath** + Hadley → a real Texas attorney.', 'heath'],
  ['Heath — "Submit to MC is Heath\'s click, always."', 'heath'],
  // Mixed — the dangerous class, because the word "agent" appears inside.
  ['mixed — agent drafts; Heath approves the send.', 'mixed'],
  ['mixed — **agent can prepare the form**; Heath signs.', 'mixed'],
  ['mixed — agent can configure and verify; Heath owns the DNS record.', 'mixed'],
  ['mixed — the alarm names the cause (logged out). Check Bitwarden first.', 'mixed'],
  ['mixed — **list-building and UTM minting are agent work**; warming is Heath.', 'mixed'],
  // Agent-lead but with a real Heath dependency after it.
  ['agent writes it; **Heath** registers the Windows scheduled task.', 'agent_then_heath'],
  ['agent proposes; **Heath** approves the deletions.', 'agent_then_heath'],
  ['agent for the build; **Heath** signs off the taxonomy.', 'agent_then_heath'],
  ['agent for the logging. **Heath** must confirm the webhook is registered.', 'agent_then_heath'],
  ['agent for the fix; **Heath** for the 9 pending approvals.', 'agent_then_heath'],
  ['**agent** does the research; Heath submits the form.', 'agent_then_heath'],
  ['agent for the purge; Heath for approvals.', 'agent_then_heath'],
  ['**agent** if `BW_SESSION` is available; otherwise Heath\'s master password.', 'agent_then_heath'],
  // Parked behind a trigger.
  ['gated on RM1.', 'gated'],
  ['gated on the insurance work (BA1-BA12) finishing.', 'gated'],
  // Absent / unparseable.
  ['', 'missing_blocked_by'],
  ['TBD', 'unrecognized'],
];
for (const [v, reason] of NOT_ELIGIBLE) {
  const r = P.classifyBlockedBy(v);
  check(
    `not eligible (${reason}): ${v.slice(0, 50)}`,
    r.eligible === false && r.reason === reason,
    `got eligible=${r.eligible} reason=${r.reason}`
  );
}

// ─── 3. parseTechDebt against the real file ──────────────────────────────────

console.log('\n[3] parseTechDebt — real docs/TECH-DEBT.md');

const techDebtPath = path.join(__dirname, '..', 'docs', 'TECH-DEBT.md');
if (!fs.existsSync(techDebtPath)) {
  check('docs/TECH-DEBT.md exists', false, techDebtPath);
} else {
  const td = P.parseTechDebt(fs.readFileSync(techDebtPath, 'utf8'), { limit: 10 });
  const kept = td.items.map(i => `${i.title} ${i.line}`).join('\n');

  check('at least one open item survives', td.items.length > 0, `got ${td.items.length}`);
  check('no kept item contains RESOLVED', !/\bRESOLVED\b/i.test(kept));
  check('no kept item contains a ~~strikethrough~~ title',
    td.items.every(i => !/~~/.test(i.title)));
  check('no kept item is the cron-comment-opp-approval entry',
    !/cron-comment-opp-approval/.test(kept));
  check('the Heath-owned TX LLC item is withheld', !/Form TX LLC/.test(kept));
  eq('limit is applied after filtering, not before', td.items.length, 10);
  check('at least 3 closed lines were skipped', td.skipped.length >= 3,
    `skipped ${td.skipped.length}`);
}

// ─── 4. parseBacklogDoc against the real files ───────────────────────────────

console.log('\n[4] parseBacklogDoc — real docs/BACKLOG-*.md');

for (const file of ['BACKLOG-ENGINEERING.md', 'BACKLOG-BUSINESS.md']) {
  const p = path.join(__dirname, '..', 'docs', file);
  if (!fs.existsSync(p)) { check(`docs/${file} exists`, false, p); continue; }

  const r = P.parseBacklogDoc(fs.readFileSync(p, 'utf8'));
  const total = r.items.length + r.skipped.length;

  console.log(`  -- ${file}: ${r.items.length} eligible / ${total} parsed`);
  check(`${file}: parsed a plausible item count`, total >= 80 && total <= 100, `got ${total}`);
  check(`${file}: some items are eligible`, r.items.length > 0);
  // A meaningful share must be withheld. If this ever approaches zero the
  // `Blocked by` gate has stopped biting and Heath-only work is reaching the
  // queue. (Engineering runs ~57% eligible, business ~20% — the business doc
  // is mostly relationships, money and signatures, which is the point.)
  check(`${file}: a substantial share is withheld`,
    r.skipped.length >= Math.ceil(total * 0.25),
    `only ${r.skipped.length} of ${total} withheld`);

  // THE critical invariant: nothing eligible may name Heath outside a merge gate.
  const leaked = r.items.filter(i => {
    const bb = i.blocked_by.toLowerCase();
    if (!bb.includes('heath')) return false;
    return !/heath\s+(gates|approves|gate)[^;,]*merge/.test(bb);
  });
  check(`${file}: no eligible item needs Heath beyond the merge gate`,
    leaked.length === 0,
    leaked.map(i => `${i.id}: ${i.blocked_by}`).join(' | '));

  // No eligible item may come from a "closed / do not re-open" section.
  const fromClosed = r.items.filter(i =>
    /verified resolved|do not re-?open|things that are closed|open questions/i.test(i.section));
  check(`${file}: nothing pulled from a closed section`, fromClosed.length === 0,
    fromClosed.map(i => i.id).join(', '));

  // Every eligible item must carry an id and a blocked_by we can show Heath.
  check(`${file}: every eligible item has an id`, r.items.every(i => !!i.id));
  check(`${file}: every eligible item records its blocked_by`,
    r.items.every(i => !!i.blocked_by));
}

// ─── 5. The loop's own gatherers, read-only ──────────────────────────────────
//
// Exercises api/cron-autonomous-loop.js end to end up to (never including)
// dispatch(). The alert_state part needs SUPABASE_URL +
// SUPABASE_SERVICE_ROLE_KEY; it skips cleanly without them.

(async function integration() {
  console.log('\n[5] cron-autonomous-loop gatherers (read-only)');

  loadEnvLocal();
  const loop = require('../api/cron-autonomous-loop.js');
  const T = loop.__testOnly;
  check('loop exposes its test surface', !!T);
  if (!T) return finish();

  // 5a — tech debt
  const td = await T.gatherTechDebt();
  const blob = td.map(c => `${c.title}\n${c.description}`).join('\n');
  check('gatherTechDebt emits candidates', td.length > 0);
  check('gatherTechDebt emits nothing marked RESOLVED', !/\bRESOLVED\b/i.test(blob));
  check('gatherTechDebt emits no struck-through title', td.every(c => !/~~/.test(c.title)));

  // 5b — the two backlog docs
  for (const doc of ['engineering', 'business']) {
    const cands = await T.gatherBacklogDoc(doc);
    console.log(`  -- backlog_${doc}: ${cands.length} candidates`);
    check(`backlog_${doc}: emits candidates`, cands.length > 0);
    check(`backlog_${doc}: signal_source is right`,
      cands.every(c => c.signal_source === `backlog_${doc}`));
    check(`backlog_${doc}: every candidate records blocked_by in meta`,
      cands.every(c => !!(c.meta && c.meta.blocked_by)));
    check(`backlog_${doc}: no candidate's blocked_by needs Heath past the merge gate`,
      cands.every(c => {
        const bb = String(c.meta.blocked_by).toLowerCase();
        return !bb.includes('heath') || /heath\s+(gates|approves|gate)[^;,]*merge/.test(bb);
      }));
    check(`backlog_${doc}: routes only to real agent_queue agent names`,
      cands.every(c => ['cole', 'atlas', 'carter', 'sage', 'pierce', 'hadley', 'quinn',
        'sterling', 'ridge', 'brokerage', 'sawyer', 'warden', 'content-verifier']
        .includes(c.agent)),
      [...new Set(cands.map(c => c.agent))].join(','));
    check(`backlog_${doc}: scores sit between tech debt and prod errors`,
      cands.every(c => c.signal_score > T.SCORE.TECH_DEBT_ACTIVE &&
                       c.signal_score < T.SCORE.PROD_ERROR));
    check(`backlog_${doc}: task_subject fits the 200-char DB check`,
      cands.every(c => c.title.length <= 200));
    check(`backlog_${doc}: signal_keys are unique`,
      new Set(cands.map(c => c.signal_key)).size === cands.length);
    check(`backlog_${doc}: has a cooldown window configured`,
      typeof T.COOLDOWN_HOURS[`backlog_${doc}`] === 'number');
  }

  // 5c — alert_state (live)
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log('  -- alert_state: SKIPPED (no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)');
  } else {
    const alerts = await T.gatherAlertState();
    console.log(`  -- alert_state: ${alerts.length} candidates ` +
      `(${alerts.map(a => a.meta.alert_family).join(', ')})`);
    check('alert_state: query succeeded and returned candidates', alerts.length > 0);
    check('alert_state: capped at 20 candidates', alerts.length <= 20);
    // The whole point of the source: this alarm has fired daily with nobody
    // answering, and Heath's personal LinkedIn has never once published.
    check('alert_state: linkedin_login_required is actually surfaced',
      alerts.some(a => a.meta.alert_family === 'linkedin_login_required'),
      alerts.map(a => a.meta.alert_family).join(', '));
    check('alert_state: per-instance dead-letter keys collapse to one candidate',
      alerts.filter(a => a.meta.alert_family === 'linkedin_publish_dead_letter').length <= 1);
    check('alert_state: distinct accounts stay distinct (no over-collapsing)',
      !alerts.some(a => a.meta.alert_family === 'silence:instagram'),
      'silence:instagram:dossie and :heath-realtor must not merge');
    check('alert_state: every candidate routes to ridge',
      alerts.every(a => a.agent === 'ridge'));
    check('alert_state: every brief forbids posting/publishing/sending/merging',
      alerts.every(a => /do not post, publish, send, or merge/i.test(a.description)));
    check('alert_state: signal_keys are unique',
      new Set(alerts.map(a => a.signal_key)).size === alerts.length);
    check('alert_state: titles fit the 200-char DB check',
      alerts.every(a => a.title.length <= 200));

    // 5d — batched cooldown lookup must agree with the per-key one it replaced.
    const engCands = await T.gatherBacklogDoc('engineering');
    const sample = [
      ...engCands.slice(0, 5).map(c => c.signal_key),
      ...alerts.slice(0, 3).map(c => c.signal_key),
      'nonexistent-signal-key-for-this-test',
    ];
    const batch = await T.checkCooldownBatch(sample);
    check('checkCooldownBatch: returns an entry for every key',
      sample.every(k => batch.has(k)));
    let agree = true;
    for (const k of sample) {
      const one = await T.checkCooldown(k);
      const many = batch.get(k);
      if (one.onCooldown !== many.onCooldown || one.dispatchCount !== many.dispatchCount) {
        agree = false;
        console.log(`    mismatch on ${k}: single=${JSON.stringify(one)} batch=${JSON.stringify(many)}`);
      }
    }
    check('checkCooldownBatch: agrees with per-key checkCooldown', agree);
    check('checkCooldownBatch: an unseen key is not on cooldown',
      batch.get('nonexistent-signal-key-for-this-test').onCooldown === false);
  }

  // 5e — alertFamily collapses instance ids only.
  eq('alertFamily: dead-letter key collapses',
    T.alertFamily('linkedin_publish_dead_letter:heath-linkedin-2026-09-14'),
    'linkedin_publish_dead_letter');
  eq('alertFamily: account-scoped silence key is preserved',
    T.alertFamily('silence:instagram:dossie'), 'silence:instagram:dossie');
  eq('alertFamily: two-segment key is preserved',
    T.alertFamily('approvals_stale:group_posts'), 'approvals_stale:group_posts');
  eq('alertFamily: bare key is preserved',
    T.alertFamily('linkedin_login_required'), 'linkedin_login_required');

  finish();
})().catch(err => {
  console.error('\nintegration section threw:', err);
  process.exit(1);
});

// Vercel holds the real values; locally they live in .env.local. The leading
// BOM on that file breaks the first variable if it isn't stripped.
function loadEnvLocal() {
  const p = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(p)) return;
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    if (process.env[key]) continue;
    process.env[key] = m[2].trim().replace(/^["'](.*)["']$/, '$1');
  }
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
