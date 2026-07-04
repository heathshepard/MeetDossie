'use strict';

// api/cron-autonomous-loop.js
// =============================================================================
// SV-ENG-RIDGE-AUTONOMOUS-LOOP-001 (Ridge, 2026-07-01)
//
// The self-improvement loop. Every 4 hours:
//   1. Read all signal sources (customer bugs, prod errors, KPI drift, tech
//      debt, Dossie Sign last-mile blockers, agent backlogs)
//   2. Score every candidate and pick THE ONE highest-priority item
//   3. Enforce guardrails (spend, legal, strategy → escalate, don't ship)
//   4. Dispatch to the right agent via direct agent_queue insert
//      + create a jarvis_future_builds row so the HUD shows it
//   5. Log the run to autonomous_loop_runs
//   6. Set cooldown so we don't re-pick this signal for 24h (short cooldown
//      for customer bugs — 4h — so we can iterate fast)
//
// GUARDRAILS (auto-escalate, don't ship):
//   - anything requiring spend > $0 (new tools, paid tiers)
//   - anything customer-facing that requires legal/brand approval
//   - anything strategy-pivoting
//   - merge-to-main (queue writes but Atlas holds until Heath says merge)
//   - Hadley "cannot proceed without licensed attorney" flags
//
// STUCK-LOOP GUARD:
//   - If a signal has dispatched >3 times without cooldown expiry, mark
//     'skipped_stuck' + Telegram-alert Heath. Human review required.
//
// SCHEDULE: every 4h via vercel.json → "0 */4 * * *"
// AUTH: Bearer ${CRON_SECRET} OR x-vercel-cron header
// =============================================================================

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const fs = require('fs');
const path = require('path');
const pausedCrons = require('./_lib/paused-crons.js');

const SUPABASE_URL              = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET               = process.env.CRON_SECRET;
const TELEGRAM_BOT_TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID          = process.env.TELEGRAM_CHAT_ID;

const HEATH_TENANT_ID = '0cd05e2f-491f-411f-afe7-f8d3fbbdbff6';

// ─── Constants ────────────────────────────────────────────────────────────────

// Signal scoring (higher = more urgent). Customer bugs preempt everything.
const SCORE = {
  CUSTOMER_BUG:            100,   // per feedback_customer_bugs_top_priority.md
  DOSSIE_SIGN_LOW_CONF:    100,   // Heath's directive: last-mile <8 confidence = customer-bug tier
  PROD_ERROR:               80,
  KPI_DRIFT:                60,
  TECH_DEBT_URGENT:         50,   // "🚨" or "URGENT" prefix
  TECH_DEBT_ACTIVE:         30,
  DOSSIE_SIGN_MID_CONF:     40,   // 8 <= confidence < 10
  SAGE_BACKLOG:             20,
  HADLEY_BACKLOG:           20,
  PIERCE_BACKLOG:           15,
  RIDGE_RELIABILITY:        25,
};

// Cooldown windows per signal source. Prevents the same item being re-picked
// on the next 4h run while agents are still working on it.
const COOLDOWN_HOURS = {
  customer_bug:            4,    // fast — customers can't wait
  dossie_sign_lastmile:    8,
  prod_error:              8,
  kpi_drift:               24,
  tech_debt:               24,
  sage_backlog:            12,
  hadley_backlog:          12,
  pierce_backlog:          24,
  ridge_reliability:       12,
};

// Guardrail regex — if title/description trips these, we escalate instead of ship.
const GUARDRAIL_PATTERNS = [
  {
    key: 'spend',
    re: /\b(subscribe to|purchase|buy|upgrade to paid|new paid tier|business plan|enterprise plan|\$\d+\/mo|monthly subscription|charge card|add credit card)\b/i,
  },
  {
    key: 'legal',
    re: /\b(attorney review required|licensed attorney|legal counsel|court filing|litigation|lawsuit|subpoena|regulatory filing|CAN-SPAM violation|GDPR violation)\b/i,
  },
  {
    key: 'strategy_pivot',
    re: /\b(pivot the product|change target market|kill this feature|shut down|deprecate.*(?:core|founding)|change pricing)\b/i,
  },
  {
    key: 'merge_to_main',
    re: /\b(merge to main|force merge|deploy to production without staging)\b/i,
  },
];

const STUCK_LOOP_THRESHOLD = 3;   // dispatch_count > this → skipped_stuck

// ─── Supabase REST helper ─────────────────────────────────────────────────────

async function sb(pathAndQuery, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  return { ok: res.ok, status: res.status, data };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error('[autonomous-loop] tg error:', err && err.message);
  }
}

// ─── Signal gatherers ─────────────────────────────────────────────────────────
// Each returns an array of candidate objects:
//   { signal_source, signal_key, signal_score, title, description, agent, meta }

// 1) Customer bug reports — support_tickets, unresolved bugs
async function gatherCustomerBugs() {
  const out = [];
  // support_tickets is created outside migrations. Column names inferred from
  // api/support.js. If the table isn't there yet, sb returns ok=false — swallow.
  const q = 'support_tickets?select=id,ticket_type,message,user_id,agent_email,created_at,status'
          + '&status=in.(open,new,in_progress,null)&order=created_at.asc&limit=25';
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data)) return out;
  for (const t of data) {
    if (t.ticket_type !== 'bug') continue;
    const key = `customer_bug:${t.id}`;
    out.push({
      signal_source: 'customer_bug',
      signal_key: key,
      signal_score: SCORE.CUSTOMER_BUG,
      title: `Customer bug: ${String(t.message || '').slice(0, 140)}`,
      description: `Ticket ${t.id} from ${t.agent_email || t.user_id || 'unknown'}, filed ${t.created_at}.\n\nCustomer report:\n${t.message}\n\nInvestigate, reproduce, ship fix. Per feedback_customer_bugs_top_priority.md this preempts other work. Ship via drafter/shipper split: Carter drafts, Atlas ships. Email customer back per feedback_customer_emails_minimize_problem.md.`,
      agent: 'carter',
      meta: { ticket_id: t.id, created_at: t.created_at, ticket_type: t.ticket_type },
    });
  }
  return out;
}

// 2) Prod error signals — cron_runs failures + email_events complaints/bounces
async function gatherProdErrors() {
  const out = [];

  // 2a — crons in status='error' for >6h (persistent breakage, not a blip).
  //
  // PAUSE-AWARE (2026-07-04): skip crons that are intentionally paused
  // (freeze schedule `0 0 1 1 *` in vercel.json) OR absent from vercel.json
  // entirely. Either state means the cron can't fire, so a stale error row
  // in cron_runs is historical noise — not a signal that anything is broken.
  const cutoff6h = new Date(Date.now() - 6 * 3600 * 1000).toISOString();
  const q1 = `cron_runs?select=cron_name,last_run,last_status,last_meta`
           + `&last_status=eq.error&last_run=lt.${encodeURIComponent(cutoff6h)}&limit=20`;
  const r1 = await sb(q1);
  if (r1.ok && Array.isArray(r1.data)) {
    for (const row of r1.data) {
      // Skip if paused / not registered. The cron literally cannot fire, so
      // its stale error row is not actionable — filing an Atlas ticket for it
      // just creates queue noise (and, if the dispatcher is paused, jams the
      // ready-queue watchdog too).
      if (pausedCrons.isPaused(row.cron_name)) {
        console.log(
          `[autonomous-loop] skipping stale error signal for ${row.cron_name} ` +
            `(pause_reason=${pausedCrons.pauseReason(row.cron_name)})`,
        );
        continue;
      }
      const key = `prod_error:cron:${row.cron_name}`;
      const errMsg = (row.last_meta && row.last_meta.error) || 'unknown';
      out.push({
        signal_source: 'prod_error',
        signal_key: key,
        signal_score: SCORE.PROD_ERROR,
        title: `Cron persistently failing: ${row.cron_name}`,
        description: `Cron ${row.cron_name} has been in error status since ${row.last_run}.\nLast error: ${errMsg}\n\nDiagnose the root cause and ship a fix. Check Vercel runtime logs for the endpoint. Route around if a vendor is down; fix the underlying issue if it's our code.`,
        agent: 'atlas',
        meta: { cron_name: row.cron_name, last_error: errMsg, last_run: row.last_run },
      });
    }
  }

  // 2b — email complaints/bounces in last 24h (deliverability risk)
  const cutoff24h = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const q2 = `email_events?select=recipient_email,event_type,event_ts`
           + `&event_type=in.(complained,bounced)&event_ts=gte.${encodeURIComponent(cutoff24h)}&limit=100`;
  const r2 = await sb(q2);
  if (r2.ok && Array.isArray(r2.data) && r2.data.length > 0) {
    const complaints = r2.data.filter(e => e.event_type === 'complained').length;
    const bounces    = r2.data.filter(e => e.event_type === 'bounced').length;
    // Only surface if the counts are meaningful. Single bounce = noise.
    if (complaints >= 1 || bounces >= 5) {
      const key = `prod_error:email_deliverability:${new Date().toISOString().slice(0,10)}`;
      out.push({
        signal_source: 'prod_error',
        signal_key: key,
        signal_score: SCORE.PROD_ERROR,
        title: `Email deliverability warning: ${complaints} complaints, ${bounces} bounces in 24h`,
        description: `Resend recorded ${complaints} complaint(s) and ${bounces} bounce(s) in the last 24 hours.\n\nInvestigate: (1) which campaign/batch drove it, (2) whether affected addresses need suppression, (3) whether our sending domain reputation is at risk. Pierce owns campaign audit; Atlas owns suppression list update.`,
        agent: 'pierce',
        meta: { complaints, bounces },
      });
    }
  }

  return out;
}

// 3) KPI drift — read most recent kpi_snapshots and drift-detector output
async function gatherKpiDrift() {
  const out = [];
  // Look at last 2 snapshots. If diff crosses ±10%, surface as a signal
  // (the drift detector already telegrams Heath — this ensures the loop
  // also creates a fix task).
  const q = 'kpi_snapshots?select=taken_at,metrics&order=taken_at.desc&limit=2';
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data) || data.length < 2) return out;

  const [curr, prev] = data;
  const metrics = ['mrr', 'engagement_rate_7d', 'comment_ship_7d', 'signup_conversion_7d'];
  for (const m of metrics) {
    const c = Number(curr.metrics?.[m] ?? NaN);
    const p = Number(prev.metrics?.[m] ?? NaN);
    if (!Number.isFinite(c) || !Number.isFinite(p) || p === 0) continue;
    const drift = (c - p) / Math.abs(p);
    if (Math.abs(drift) < 0.10) continue;

    const direction = drift < 0 ? 'down' : 'up';
    const key = `kpi_drift:${m}:${curr.taken_at.slice(0,10)}`;
    // Only DOWN drifts get auto-fixed. UP drifts get an "investigate why" note.
    out.push({
      signal_source: 'kpi_drift',
      signal_key: key,
      signal_score: SCORE.KPI_DRIFT,
      title: `KPI drift: ${m} ${direction} ${(drift*100).toFixed(1)}%`,
      description: `${m} moved from ${p} to ${c} (${direction} ${(drift*100).toFixed(1)}%) week-over-week.\n\nInvestigate root cause. Compare against recent product changes (git log last 7d), Sage schedule flips, Pierce activation cadence, Sterling market moves. Surface hypothesis + a 3-step recovery plan if the drift is negative. If positive, document what worked so we can double down.`,
      agent: 'ridge',
      meta: { metric: m, prev: p, curr: c, drift },
    });
  }
  return out;
}

// 4) Tech debt — parse docs/TECH-DEBT.md
async function gatherTechDebt() {
  const out = [];
  const debtPath = path.join(process.cwd(), 'docs', 'TECH-DEBT.md');
  let text = '';
  try {
    text = fs.readFileSync(debtPath, 'utf8');
  } catch (e) {
    return out; // no file → no signal
  }

  // Grab items under "NOT DONE / ACTIVE BLOCKERS" section
  const activeMatch = text.match(/## NOT DONE \/ ACTIVE BLOCKERS\s+([\s\S]*?)(?=\n## |\n---)/);
  if (!activeMatch) return out;

  const activeBlock = activeMatch[1];
  const lines = activeBlock.split('\n').filter(l => l.trim().startsWith('- '));

  // Only take the first ~10 items to stay focused
  for (const line of lines.slice(0, 10)) {
    // Skip lines that look like they need Heath action (URGENT + personal items)
    const isUrgent = /🚨|\bURGENT\b/i.test(line);
    const isPersonal = /\b(Form TX LLC|EIN|personal action|Heath.*must|attorney review before live)\b/i.test(line);
    if (isPersonal) continue; // these are Heath-owned, not agent-owned

    // Extract short title (first bold section or first 100 chars)
    const boldMatch = line.match(/\*\*(.+?)\*\*/);
    const shortTitle = boldMatch ? boldMatch[1] : line.replace(/^- /, '').slice(0, 100);
    const key = `tech_debt:${shortTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;

    out.push({
      signal_source: 'tech_debt',
      signal_key: key,
      signal_score: isUrgent ? SCORE.TECH_DEBT_URGENT : SCORE.TECH_DEBT_ACTIVE,
      title: `Tech debt: ${shortTitle}`,
      description: `From docs/TECH-DEBT.md:\n\n${line}\n\nRead the full context in TECH-DEBT.md, produce a concrete plan (files touched, test approach), and ship via drafter/shipper split. If the scope is unclear or spend is required, escalate to Heath instead of guessing.`,
      agent: 'carter',
      meta: { source_line: line.slice(0, 500), urgent: isUrgent },
    });
  }
  return out;
}

// 5) Dossie Sign last-mile — HIGHEST priority when Hadley's audit lands
//    NOTE: as of 2026-07-01 the dedicated cron-dossie-sign-completion-loop runs
//    every 20min against the dossie_sign_dod_progress table. This function
//    stays as a fallback for pre-DoD-table audits, but yields to the dedicated
//    loop if that table exists AND has any pending red gates. Prevents thrash.
async function gatherDossieSignLastMile() {
  const out = [];

  // Coordinator check — if the dedicated loop is actively picking up dossie
  // sign work (i.e., the DoD table exists and has red gates), yield.
  try {
    const dodCheck = await sb('dossie_sign_dod_progress?select=id&status=eq.red&limit=1');
    if (dodCheck.ok && Array.isArray(dodCheck.data) && dodCheck.data.length > 0) {
      // The dedicated loop owns Dossie Sign work right now. Skip.
      return out;
    }
  } catch (e) {
    // Table doesn't exist yet — fall through to legacy last-mile scan.
  }

  const docsDir = path.join(process.cwd(), 'docs');
  let files = [];
  try {
    files = fs.readdirSync(docsDir).filter(f => /^dossie-sign-last-mile.*\.md$/i.test(f));
  } catch (e) {
    return out;
  }
  if (files.length === 0) return out;

  // Newest file wins
  files.sort();
  const latest = files[files.length - 1];
  const fullPath = path.join(docsDir, latest);

  let text = '';
  try { text = fs.readFileSync(fullPath, 'utf8'); } catch (e) { return out; }

  // Hadley's audits typically have a "confidence: N/10" or "confidence N/10" tag
  // per blocker. We look for blocker headings + confidence scores.
  //
  // Format we expect (loose match, per Hadley's usual style):
  //   ### Blocker N: <title>
  //   confidence: <n>/10
  //   <details>
  //
  // If the format differs, we fall back to grabbing all "### Blocker" headings
  // and treating them as priority-100 (Heath said any item <8 confidence gets
  // top-tier, so unknown-confidence defaults to top-tier to be safe).
  const blockerRe = /###\s*(?:Blocker\s*)?(\d+)[:\s.]+([^\n]+)\n([\s\S]*?)(?=\n###|\n##|$)/gi;
  let m;
  let idx = 0;
  while ((m = blockerRe.exec(text)) !== null) {
    idx++;
    const num = m[1];
    const title = m[2].trim();
    const body = m[3];
    const confMatch = body.match(/confidence\s*[:\-]?\s*(\d+(?:\.\d+)?)\s*\/\s*10/i);
    const confidence = confMatch ? Number(confMatch[1]) : null;

    // Per Heath's spec: any item with confidence < 8 = Priority 100 (customer-bug tier)
    // Items with confidence >= 8 still get MID_CONF (40) so they don't stall.
    const isTopTier = confidence === null || confidence < 8;
    const score = isTopTier ? SCORE.DOSSIE_SIGN_LOW_CONF : SCORE.DOSSIE_SIGN_MID_CONF;

    const key = `dossie_sign_lastmile:${latest}#${num}`;
    out.push({
      signal_source: 'dossie_sign_lastmile',
      signal_key: key,
      signal_score: score,
      title: `Dossie Sign blocker #${num}: ${title.slice(0, 120)}`,
      description: `From ${latest}, Blocker ${num}: ${title}\n\nConfidence: ${confidence ?? 'not specified'}/10\n\nContext:\n${body.trim().slice(0, 2000)}\n\nRead the full audit at docs/${latest}. Per feedback_dossie_sign_must_work_before_new_ships.md this is the highest-priority Dossie work — nothing new ships until Dossie Sign works end-to-end. Ship via drafter/shipper split.`,
      agent: 'carter',
      meta: { source_file: latest, blocker_num: num, confidence, top_tier: isTopTier },
    });

    if (idx > 20) break; // don't flood the queue
  }

  // Fallback: if the regex didn't match anything, surface the whole doc as one
  // top-tier item so we don't miss it.
  if (out.length === 0 && text.trim().length > 0) {
    const key = `dossie_sign_lastmile:${latest}#full`;
    out.push({
      signal_source: 'dossie_sign_lastmile',
      signal_key: key,
      signal_score: SCORE.DOSSIE_SIGN_LOW_CONF,
      title: `Dossie Sign last-mile audit needs execution: ${latest}`,
      description: `Hadley shipped ${latest} but the automated parser didn't recognize the blocker format. Read the doc, extract the top blocker, and ship it. Per feedback_dossie_sign_must_work_before_new_ships.md this is highest-priority.`,
      agent: 'carter',
      meta: { source_file: latest, parse_failed: true },
    });
  }

  return out;
}

// 6) Agent backlogs — pending queue rows per agent (Sage/Hadley/Pierce/Ridge)
// The loop's job here is NOT to compete with cron-agent-queue-dispatch (which
// executes the queue). It's to detect UNDERFED queues — if Sage has been idle
// for >24h with no pending work, generate a proactive research/content task.
async function gatherAgentBacklogs() {
  const out = [];

  const now = Date.now();
  const idleThresholdMs = 24 * 3600 * 1000;

  const agents = ['sage', 'hadley', 'pierce', 'ridge'];
  for (const agentName of agents) {
    // Any pending or in_progress row?
    const r = await sb(`agent_queue?select=id,status,created_at&agent_name=eq.${agentName}&status=in.(pending,in_progress)&limit=1`);
    if (r.ok && Array.isArray(r.data) && r.data.length > 0) continue; // has work

    // Also check when their last completed task finished
    const r2 = await sb(`agent_queue?select=completed_at&agent_name=eq.${agentName}&status=eq.completed&order=completed_at.desc&limit=1`);
    const lastCompleted = r2.ok && r2.data && r2.data[0] && r2.data[0].completed_at
      ? new Date(r2.data[0].completed_at).getTime()
      : 0;
    const idleFor = now - lastCompleted;
    if (idleFor < idleThresholdMs && lastCompleted !== 0) continue;

    const key = `${agentName}_backlog:idle_${new Date().toISOString().slice(0,10)}`;
    const scoreMap = {
      sage:   SCORE.SAGE_BACKLOG,
      hadley: SCORE.HADLEY_BACKLOG,
      pierce: SCORE.PIERCE_BACKLOG,
      ridge:  SCORE.RIDGE_RELIABILITY,
    };
    const briefMap = {
      sage:   'You have no pending work. Run a proactive research pass: (1) scan Reddit/X/FB groups for trending TX REALTOR pain points from the last 7d, (2) surface 3 hook ideas for reels this week, (3) create 1 draft post per persona ready for approval.',
      hadley: 'You have no pending work. Run a proactive compliance pass: (1) scan the last 14d of outbound email templates for CAN-SPAM/TCPA drift, (2) audit any new customer-facing pages added since your last review, (3) check the ToS/PP change queue.',
      pierce: 'You have no pending work. Run a proactive activation pass: (1) list founding members with zero doc uploads or zero dossier creations in the last 14d, (2) draft one warm re-engagement email per stalled founder (do not send — draft only), (3) surface any activation funnel drop-off worth investigating.',
      ridge:  'You have no pending work. Run a proactive reliability pass: (1) audit cron_runs for any silence patterns (crons that last fired > their schedule window), (2) check for KPI drift signals kpi-drift-detector didn\'t flag, (3) verify no Playwright APV runs are queued but never completed.',
    };
    out.push({
      signal_source: `${agentName}_backlog`,
      signal_key: key,
      signal_score: scoreMap[agentName],
      title: `${agentName.charAt(0).toUpperCase() + agentName.slice(1)} idle — proactive pass`,
      description: briefMap[agentName],
      agent: agentName,
      meta: { idle_hours: Math.round(idleFor / 3600000) },
    });
  }
  return out;
}

// ─── Guardrails ───────────────────────────────────────────────────────────────

function tripsGuardrail(title, description) {
  const hay = `${title}\n${description}`;
  for (const g of GUARDRAIL_PATTERNS) {
    if (g.re.test(hay)) return g.key;
  }
  return null;
}

// ─── Cooldown + stuck-loop check ──────────────────────────────────────────────

async function checkCooldown(signalKey) {
  const q = `autonomous_loop_signals_seen?select=cooldown_until,dispatch_count&signal_key=eq.${encodeURIComponent(signalKey)}&limit=1`;
  const { ok, data } = await sb(q);
  if (!ok || !Array.isArray(data) || data.length === 0) return { onCooldown: false, dispatchCount: 0 };
  const row = data[0];
  const onCooldown = new Date(row.cooldown_until).getTime() > Date.now();
  return { onCooldown, dispatchCount: row.dispatch_count || 0 };
}

async function stampCooldown(signalKey, signalSource) {
  const hours = COOLDOWN_HOURS[signalSource] || 24;
  const cooldownUntil = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  // Upsert with dispatch_count increment. PostgREST upsert with merge-duplicates
  // doesn't natively do count++, so we do a read-then-write.
  const r = await sb(`autonomous_loop_signals_seen?select=dispatch_count&signal_key=eq.${encodeURIComponent(signalKey)}&limit=1`);
  const existing = r.ok && Array.isArray(r.data) && r.data[0];
  const nextCount = (existing?.dispatch_count || 0) + 1;

  await sb('autonomous_loop_signals_seen?on_conflict=signal_key', {
    method: 'POST',
    headers: {
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      signal_key: signalKey,
      signal_source: signalSource,
      last_dispatched_at: new Date().toISOString(),
      cooldown_until: cooldownUntil,
      dispatch_count: nextCount,
    }),
  });
  return nextCount;
}

// ─── Dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(candidate) {
  const priority = candidate.signal_score >= 80 ? 1
                 : candidate.signal_score >= 60 ? 2
                 : candidate.signal_score >= 40 ? 3
                 : 4;

  // Create the jarvis_future_builds row first
  const sourceKey = `autonomous-loop:${candidate.signal_key}:${Date.now()}`;
  const fb = await sb('jarvis_future_builds', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      tenant_id: HEATH_TENANT_ID,
      title: candidate.title.slice(0, 280),
      description: candidate.description.slice(0, 8000),
      source: 'autonomous-loop',
      source_key: sourceKey,
      status: 'building',
      score: candidate.signal_score,
      updated_at: new Date().toISOString(),
    }),
  });
  const futureBuildId = (fb.ok && Array.isArray(fb.data) && fb.data[0]) ? fb.data[0].id : null;

  // Insert agent_queue row
  const queuePayload = {
    agent_name: candidate.agent,
    task_subject: candidate.title.slice(0, 200),
    task_brief: candidate.description.slice(0, 8000),
    priority,
    depends_on: [],
    venture: 'general',
    status: 'pending',
    metadata: {
      source: 'autonomous-loop',
      source_table: futureBuildId ? 'jarvis_future_builds' : null,
      source_id: futureBuildId,
      source_key: sourceKey,
      signal_source: candidate.signal_source,
      signal_key: candidate.signal_key,
      signal_score: candidate.signal_score,
      signal_meta: candidate.meta || {},
      enqueued_at: new Date().toISOString(),
      enqueued_by: 'autonomous-loop',
    },
  };
  const qi = await sb('agent_queue', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(queuePayload),
  });
  const queueId = (qi.ok && Array.isArray(qi.data) && qi.data[0]) ? qi.data[0].id : null;

  return { queueId, futureBuildId, queueOk: qi.ok, futureBuildOk: fb.ok };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

async function logRun(payload) {
  await sb('autonomous_loop_runs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(payload),
  });
}

// ─── Main handler ─────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-autonomous-loop', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const startTs = Date.now();
  const runTs = new Date().toISOString();

  // Bail-out timer — if this handler runs >18min, log 'skipped_stuck' and exit.
  // (Vercel maxDuration is 20min; we bail at 18 for safety.)
  const BAIL_MS = 18 * 60 * 1000;
  const bailTimer = setTimeout(async () => {
    await logRun({
      run_ts: runTs,
      signal_source: 'no_signal',
      outcome: 'skipped_stuck',
      outcome_reason: 'handler_exceeded_18min',
      duration_ms: Date.now() - startTs,
    });
    if (!res.headersSent) {
      try { res.status(200).json({ ok: false, bailed: true }); } catch {}
    }
  }, BAIL_MS);

  try {
    // 1) Gather signals from all sources in parallel
    const [
      bugs,
      prodErrors,
      kpiDrifts,
      techDebt,
      dossieSign,
      backlogs,
    ] = await Promise.all([
      gatherCustomerBugs().catch(e => { console.warn('[loop] bugs err', e.message); return []; }),
      gatherProdErrors().catch(e => { console.warn('[loop] prodErr err', e.message); return []; }),
      gatherKpiDrift().catch(e => { console.warn('[loop] kpiDrift err', e.message); return []; }),
      gatherTechDebt().catch(e => { console.warn('[loop] techDebt err', e.message); return []; }),
      gatherDossieSignLastMile().catch(e => { console.warn('[loop] dossieSign err', e.message); return []; }),
      gatherAgentBacklogs().catch(e => { console.warn('[loop] backlogs err', e.message); return []; }),
    ]);

    const allCandidates = [
      ...bugs,
      ...dossieSign,     // top tier alongside bugs
      ...prodErrors,
      ...kpiDrifts,
      ...techDebt,
      ...backlogs,
    ];

    // 2) Filter out any candidate whose signal_key is still on cooldown
    const eligible = [];
    for (const c of allCandidates) {
      const { onCooldown, dispatchCount } = await checkCooldown(c.signal_key);
      if (onCooldown) continue;
      // Stuck-loop check — if we've re-dispatched this signal >3 times without
      // successful cooldown expiry, mark stuck instead of picking again.
      if (dispatchCount >= STUCK_LOOP_THRESHOLD) {
        c._stuck = true;
        c._dispatchCount = dispatchCount;
      }
      eligible.push(c);
    }

    // 3) Sort by score DESC, then by whether stuck (skip stuck ones)
    eligible.sort((a, b) => (b.signal_score - a.signal_score));

    // Find the first non-stuck eligible candidate
    let winner = null;
    let stuckWinner = null;
    for (const c of eligible) {
      if (c._stuck && !stuckWinner) stuckWinner = c;
      if (!c._stuck) { winner = c; break; }
    }

    // 3a) If everything is stuck, telegram Heath + log
    if (!winner && stuckWinner) {
      await logRun({
        run_ts: runTs,
        signal_source: stuckWinner.signal_source,
        signal_key: stuckWinner.signal_key,
        signal_score: stuckWinner.signal_score,
        signal_snapshot: { candidates_seen: allCandidates.length, eligible: eligible.length },
        item_picked: stuckWinner.title,
        item_details: stuckWinner.meta || {},
        agent_dispatched: stuckWinner.agent,
        outcome: 'skipped_stuck',
        outcome_reason: `dispatched ${stuckWinner._dispatchCount} times without resolution`,
        duration_ms: Date.now() - startTs,
      });
      await tg(
        `<b>Autonomous loop stuck signal.</b>\n\n` +
        `Signal: ${stuckWinner.signal_source} → ${stuckWinner.signal_key}\n` +
        `Title: ${stuckWinner.title}\n` +
        `Dispatched ${stuckWinner._dispatchCount} times. Needs human review.`
      );
      clearTimeout(bailTimer);
      return res.status(200).json({ ok: true, outcome: 'skipped_stuck', signal_key: stuckWinner.signal_key });
    }

    // 3b) No signal at all → log and exit quietly. Silence = healthy.
    if (!winner) {
      await logRun({
        run_ts: runTs,
        signal_source: 'no_signal',
        signal_snapshot: {
          candidates_seen: allCandidates.length,
          eligible: eligible.length,
          all_on_cooldown: allCandidates.length > 0 && eligible.length === 0,
        },
        outcome: allCandidates.length > 0 ? 'skipped_cooldown' : 'skipped_no_signal',
        outcome_reason: allCandidates.length > 0 ? 'all_signals_on_cooldown' : 'no_signals_detected',
        duration_ms: Date.now() - startTs,
      });
      clearTimeout(bailTimer);
      return res.status(200).json({
        ok: true,
        outcome: 'no_signal',
        candidates_seen: allCandidates.length,
        eligible: eligible.length,
      });
    }

    // 4) Guardrail check
    const guardrailKey = tripsGuardrail(winner.title, winner.description);
    if (guardrailKey) {
      await logRun({
        run_ts: runTs,
        signal_source: winner.signal_source,
        signal_key: winner.signal_key,
        signal_score: winner.signal_score,
        signal_snapshot: { candidates_seen: allCandidates.length, eligible: eligible.length },
        item_picked: winner.title,
        item_details: winner.meta || {},
        agent_dispatched: winner.agent,
        outcome: 'skipped_guardrail',
        outcome_reason: `guardrail:${guardrailKey}`,
        duration_ms: Date.now() - startTs,
      });
      await tg(
        `<b>Autonomous loop escalation needed.</b>\n\n` +
        `Picked: ${winner.title}\n` +
        `Guardrail tripped: <code>${guardrailKey}</code>\n\n` +
        `Loop did NOT ship. Decision needed from you.`
      );
      // Still stamp cooldown so we don't re-escalate every 4h
      await stampCooldown(winner.signal_key, winner.signal_source);
      clearTimeout(bailTimer);
      return res.status(200).json({
        ok: true,
        outcome: 'skipped_guardrail',
        guardrail: guardrailKey,
        signal_key: winner.signal_key,
      });
    }

    // 5) Dispatch
    const dispatchResult = await dispatch(winner);
    if (!dispatchResult.queueOk) {
      await logRun({
        run_ts: runTs,
        signal_source: winner.signal_source,
        signal_key: winner.signal_key,
        signal_score: winner.signal_score,
        signal_snapshot: { candidates_seen: allCandidates.length, eligible: eligible.length },
        item_picked: winner.title,
        item_details: winner.meta || {},
        agent_dispatched: winner.agent,
        outcome: 'error',
        outcome_reason: 'agent_queue_insert_failed',
        duration_ms: Date.now() - startTs,
      });
      clearTimeout(bailTimer);
      return res.status(500).json({ ok: false, error: 'dispatch_failed' });
    }

    // 6) Cooldown stamp
    await stampCooldown(winner.signal_key, winner.signal_source);

    // 7) Log the run
    await logRun({
      run_ts: runTs,
      signal_source: winner.signal_source,
      signal_key: winner.signal_key,
      signal_score: winner.signal_score,
      signal_snapshot: {
        candidates_seen: allCandidates.length,
        eligible: eligible.length,
        top_5_titles: eligible.slice(0, 5).map(c => ({ title: c.title, score: c.signal_score })),
      },
      item_picked: winner.title,
      item_details: winner.meta || {},
      agent_dispatched: winner.agent,
      queue_id: dispatchResult.queueId,
      future_build_id: dispatchResult.futureBuildId,
      outcome: 'dispatched',
      duration_ms: Date.now() - startTs,
    });

    clearTimeout(bailTimer);
    return res.status(200).json({
      ok: true,
      outcome: 'dispatched',
      picked: winner.title,
      signal_source: winner.signal_source,
      signal_key: winner.signal_key,
      signal_score: winner.signal_score,
      agent: winner.agent,
      queue_id: dispatchResult.queueId,
      future_build_id: dispatchResult.futureBuildId,
      candidates_seen: allCandidates.length,
      eligible: eligible.length,
    });
  } catch (err) {
    clearTimeout(bailTimer);
    console.error('[autonomous-loop] crashed:', err);
    await logRun({
      run_ts: runTs,
      signal_source: 'no_signal',
      outcome: 'error',
      outcome_reason: `crash:${(err && err.message) ? err.message.slice(0, 500) : 'unknown'}`,
      duration_ms: Date.now() - startTs,
    });
    return res.status(500).json({ ok: false, error: err.message });
  }
});
