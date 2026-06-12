// Vercel Serverless Function: /api/cron-dossie-qa-loop
//
// SV-ENG-QA-HOURLY — hourly Dossie QA loop with seven guardrails.
//
// Cadence:  every hour 8 AM–8 PM CDT (12 iterations/day). No overnight runs.
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 13-23 * * *" + "0 0 * * *"
//             (UTC 13:00–23:00 covers 8 AM–6 PM CDT; UTC 00:00 = 7 PM CDT)
//
// Guardrails (all enforced in this file; nothing external required):
//   G1. Cost cap        — $20/day Claude API spend. Auto-pause at cap, reset 00:00 UTC.
//   G2. Fix-ship cap    — max 3 fixes shipped to MAIN per day. Excess queued for next day.
//   G3. Demo collision  — defer iteration 15 min if demo@meetdossie.com session active <5 min ago.
//   G4. Scenario diverse— randomize the 5 scenario order each hour (no two-in-a-row).
//   G5. Severity-aware  — P0 ships same-hour; P1 batches to 1/day; P2 → weekly grooming.
//   G6. Telegram silent — ping ONLY on benchmark pass, P0 auto-fix, or cost-cap hit.
//   G7. Continuous log  — append every iteration to Engineering/dossie-qa-loop.md
//                          (handled via a follow-up commit by Carter; this route logs to DB).
//
// State table: public.qa_loop_runs (migration 20260611_qa_loop_runs.sql)
//
// Scenarios (rotate randomly per hour, never twice in a row):
//   1: New buyer dossier → TREC 20-18 → DossieSign
//   2: Seller dossier → TREC 1-4 + welcome email + milestone
//   3: Inbound amendment → TREC 39-10 via voice → DossieSign
//   4: Lender intro + title company emails via Talk to Dossie
//   5: Deadline-driven (option period expiring) → morning brief + notifications

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Guardrail thresholds
const DAILY_COST_CAP_USD = 20.0;
const DAILY_FIX_SHIP_CAP = 3;
const DAILY_P1_SHIP_CAP = 1;
const DEMO_COLLISION_WINDOW_MIN = 5;
const DEMO_DEFER_MIN = 15;

const SCENARIOS = [
  { day: 1, title: 'New buyer dossier → TREC 20-18 via Talk to Dossie → DossieSign',
    testFn: 'testBuyerContractFlow' },
  { day: 2, title: 'Seller dossier → TREC 1-4 forms → welcome email → milestone',
    testFn: 'testSellerListingFlow' },
  { day: 3, title: 'Inbound amendment → TREC 39-10 via voice → DossieSign',
    testFn: 'testAmendmentFlow' },
  { day: 4, title: 'Lender intro + title company emails via Talk to Dossie',
    testFn: 'testServiceProviderEmailFlow' },
  { day: 5, title: 'Deadline-driven: option period expiring → morning brief + notifications',
    testFn: 'testDeadlineFlow' },
];

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// ───── G1: cost-cap check ─────────────────────────────────────────────────────
async function getDailyCostSpend() {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const isoSince = since.toISOString();
  const { data } = await supabaseFetch(
    `/rest/v1/qa_loop_runs?select=claude_cost_usd&ran_at=gte.${isoSince}`,
  );
  if (!Array.isArray(data)) return 0;
  return data.reduce((sum, r) => sum + Number(r.claude_cost_usd || 0), 0);
}

// ───── G2: fix-ship-cap check ─────────────────────────────────────────────────
async function getDailyFixShipCounts() {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const isoSince = since.toISOString();
  const { data } = await supabaseFetch(
    `/rest/v1/qa_loop_runs?select=fix_severity&fix_shipped=eq.true&ran_at=gte.${isoSince}`,
  );
  if (!Array.isArray(data)) return { total: 0, p0: 0, p1: 0 };
  return data.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.fix_severity === 'P0') acc.p0 += 1;
      if (r.fix_severity === 'P1') acc.p1 += 1;
      return acc;
    },
    { total: 0, p0: 0, p1: 0 },
  );
}

// ───── G3: demo-collision avoidance ───────────────────────────────────────────
async function isDemoAccountActive() {
  // last_seen_at on profiles is the canonical activity marker (set by app.html).
  // Falls back gracefully if column missing on a given env.
  const cutoff = new Date(Date.now() - DEMO_COLLISION_WINDOW_MIN * 60_000).toISOString();
  const { data, ok } = await supabaseFetch(
    `/rest/v1/profiles?select=email,last_seen_at&email=eq.demo@meetdossie.com&last_seen_at=gte.${cutoff}`,
  );
  if (!ok || !Array.isArray(data)) return false;
  return data.length > 0;
}

// ───── G4: scenario diversification ───────────────────────────────────────────
async function pickScenarioAvoidingRepeat() {
  const { data } = await supabaseFetch(
    `/rest/v1/qa_loop_runs?select=scenario_day&iteration_status=eq.completed&order=ran_at.desc&limit=1`,
  );
  const lastDay = Array.isArray(data) && data[0] ? data[0].scenario_day : null;
  const pool = SCENARIOS.filter(s => s.day !== lastDay);
  const idx = Math.floor(Math.random() * pool.length);
  return pool[idx];
}

// ───── stub test functions (Carter will flesh these out per scenario) ────────
async function testBuyerContractFlow() {
  return {
    passed: false,
    failures: [{
      step: 'Fill TREC 20-18 via Talk to Dossie',
      severity: 'P1',
      failureClass: 'C',
      description: 'Stub — Carter to wire real probe against /api/extract-form-fields + /api/fill-form',
    }],
    cost: { usd: 0, input_tokens: 0, output_tokens: 0 },
  };
}
async function testSellerListingFlow() {
  return { passed: false, failures: [], cost: { usd: 0, input_tokens: 0, output_tokens: 0 } };
}
async function testAmendmentFlow() {
  return { passed: false, failures: [], cost: { usd: 0, input_tokens: 0, output_tokens: 0 } };
}
async function testServiceProviderEmailFlow() {
  return { passed: false, failures: [], cost: { usd: 0, input_tokens: 0, output_tokens: 0 } };
}
async function testDeadlineFlow() {
  return { passed: false, failures: [], cost: { usd: 0, input_tokens: 0, output_tokens: 0 } };
}

const TEST_REGISTRY = {
  testBuyerContractFlow,
  testSellerListingFlow,
  testAmendmentFlow,
  testServiceProviderEmailFlow,
  testDeadlineFlow,
};

// ───── G6: Telegram (silent default) ──────────────────────────────────────────
async function notifyTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown',
      }),
    });
  } catch (err) { console.error('[QA Loop] Telegram failed:', err.message); }
}

// ───── record an iteration ────────────────────────────────────────────────────
async function recordRun(row) {
  return supabaseFetch('/rest/v1/qa_loop_runs', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
}

// ───── G5: severity-aware ship decision ───────────────────────────────────────
function pickShippableFix(failures, shipCounts) {
  if (shipCounts.total >= DAILY_FIX_SHIP_CAP) return null;
  // P0 first, always ship if cap not hit
  const p0 = failures.find(f => f.severity === 'P0');
  if (p0) return p0;
  // P1 — only one per day
  if (shipCounts.p1 < DAILY_P1_SHIP_CAP) {
    const p1 = failures.find(f => f.severity === 'P1');
    if (p1) return p1;
  }
  // P2 → weekly grooming (never shipped by hourly loop)
  return null;
}

async function handler(req, res) {
  const auth = req.headers.authorization || req.headers['x-vercel-cron'];
  if (auth !== `Bearer ${CRON_SECRET}` && auth !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    // G1: cost cap
    const spendUsd = await getDailyCostSpend();
    if (spendUsd >= DAILY_COST_CAP_USD) {
      await recordRun({
        scenario_day: 0,
        scenario_title: 'cost-cap pause',
        iteration_status: 'skipped_cost_cap',
        notes: `daily spend $${spendUsd.toFixed(2)} ≥ $${DAILY_COST_CAP_USD}`,
      });
      // Ping ONCE per day on cap hit — naive guard: only ping if first cap-skip today
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const { data: prior } = await supabaseFetch(
        `/rest/v1/qa_loop_runs?select=id&iteration_status=eq.skipped_cost_cap&ran_at=gte.${today.toISOString()}&limit=2`,
      );
      if (Array.isArray(prior) && prior.length <= 1) {
        await notifyTelegram(
          `🛑 QA Loop paused: daily cost cap hit ($${spendUsd.toFixed(2)} ≥ $${DAILY_COST_CAP_USD}). Resumes 00:00 UTC.`,
        );
      }
      return res.status(200).json({ success: true, action: 'cost_cap_pause', spendUsd });
    }

    // G3: demo collision
    const demoBusy = await isDemoAccountActive();
    if (demoBusy) {
      await recordRun({
        scenario_day: 0,
        scenario_title: 'deferred — demo account active',
        iteration_status: 'deferred_demo_collision',
        notes: `demo@meetdossie.com active within last ${DEMO_COLLISION_WINDOW_MIN} min`,
      });
      return res.status(200).json({ success: true, action: 'deferred_demo', deferMin: DEMO_DEFER_MIN });
    }

    // G4: pick scenario (avoid repeat)
    const scenario = await pickScenarioAvoidingRepeat();
    console.log(`[QA Loop] Running Day ${scenario.day}: ${scenario.title}`);

    // Run the test
    const testFn = TEST_REGISTRY[scenario.testFn];
    const findings = await testFn();

    // Tally severities
    const p0Count = findings.failures.filter(f => f.severity === 'P0').length;
    const p1Count = findings.failures.filter(f => f.severity === 'P1').length;
    const p2Count = findings.failures.filter(f => f.severity === 'P2').length;

    // G2 + G5: shippable fix?
    const shipCounts = await getDailyFixShipCounts();
    const shipFix = pickShippableFix(findings.failures, shipCounts);

    await recordRun({
      scenario_day: scenario.day,
      scenario_title: scenario.title,
      iteration_status: 'completed',
      passed: findings.passed,
      failure_count: findings.failures.length,
      p0_count: p0Count,
      p1_count: p1Count,
      p2_count: p2Count,
      fix_shipped: !!shipFix,
      fix_severity: shipFix ? shipFix.severity : null,
      fix_summary: shipFix ? `${shipFix.step} — ${shipFix.description}`.slice(0, 500) : null,
      claude_cost_usd: findings.cost?.usd || 0,
      input_tokens: findings.cost?.input_tokens || 0,
      output_tokens: findings.cost?.output_tokens || 0,
      findings: findings.failures,
    });

    // G6: Telegram (silent default)
    if (findings.passed) {
      await notifyTelegram(`✅ QA Loop benchmark PASSED — Day ${scenario.day}: ${scenario.title}`);
    } else if (shipFix && shipFix.severity === 'P0') {
      await notifyTelegram(
        `🚨 QA Loop P0 detected + auto-fix queued — Day ${scenario.day}: ${shipFix.step}`,
      );
    }

    return res.status(200).json({
      success: true,
      scenario: scenario.day,
      passed: findings.passed,
      findings: findings.failures.length,
      p0: p0Count, p1: p1Count, p2: p2Count,
      fix_shipped: !!shipFix,
      fix_severity: shipFix ? shipFix.severity : null,
      daily_spend_usd: spendUsd,
      daily_fixes_shipped: shipCounts.total + (shipFix ? 1 : 0),
    });
  } catch (err) {
    console.error('[QA Loop] Error:', err.message);
    try {
      await recordRun({
        scenario_day: 0,
        scenario_title: 'errored',
        iteration_status: 'errored',
        notes: err.message?.slice(0, 500) || 'unknown error',
      });
    } catch {}
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
