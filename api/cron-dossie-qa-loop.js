// Vercel Serverless Function: /api/cron-dossie-qa-loop
//
// Continuous Dossie QA loop. Runs daily at 6 AM CDT to test one agent scenario
// end-to-end against the human-TC equivalence benchmark. Cycles through 5 scenario
// types (Day 1-5 rotation). Captures failures, ships top 1-2 fixes per iteration.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json – "0 11 * * *" (11:00 UTC = 6:00 AM CDT during DST)
//
// Scenarios (rotate daily):
//   Day 1: New buyer dossier → TREC 20-18 via Talk to Dossie → DossieSign → track
//   Day 2: Seller dossier → TREC 1-4 forms → welcome email → milestone share
//   Day 3: Inbound amendment → TREC 39-10 via voice → DossieSign
//   Day 4: Lender intro + title company emails via Talk to Dossie
//   Day 5: Deadline-driven (option period expiring) → morning brief + notifications
//
// Output: appends to dossie-qa-loop.md with findings, severity, failure class
//
// Benchmark (loop exits when ALL pass):
//   ✅ Dossie fills ANY TREC form correctly with one natural-language request
//   ✅ Dossie drafts ANY standard agent-to-X email (buyer, lender, title, agent-agent)
//   ✅ Dossie answers "what's next?" with concrete next actions + form names + citations
//   ✅ Dossie identifies TREC compliance issues proactively
//   ✅ Dossie manages full transaction lifecycle autonomously

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CRON_SECRET = process.env.CRON_SECRET;

// Scenario rotation (Monday=0, Sunday=6)
const SCENARIOS = [
  {
    day: 1,
    title: 'New buyer dossier → TREC 20-18 via Talk to Dossie → DossieSign',
    testFn: 'testBuyerContractFlow',
  },
  {
    day: 2,
    title: 'Seller dossier → TREC 1-4 forms → welcome email → milestone',
    testFn: 'testSellerListingFlow',
  },
  {
    day: 3,
    title: 'Inbound amendment → TREC 39-10 via voice → DossieSign',
    testFn: 'testAmendmentFlow',
  },
  {
    day: 4,
    title: 'Lender intro + title company emails via Talk to Dossie',
    testFn: 'testServiceProviderEmailFlow',
  },
  {
    day: 5,
    title: 'Deadline-driven: option period expiring → morning brief + notifications',
    testFn: 'testDeadlineFlow',
  },
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
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  return { ok: res.ok, status: res.status, data };
}

// Stub test functions (will be expanded into full scenario tests)
async function testBuyerContractFlow() {
  return {
    passed: false,
    failures: [
      {
        step: 'Fill TREC 20-18 via Talk to Dossie',
        severity: 'P0',
        failureClass: 'C',
        description: 'Talk to Dossie did not route "fill contract" request to extract-form-fields.js',
      },
    ],
  };
}

async function testSellerListingFlow() {
  return { passed: false, failures: [] };
}

async function testAmendmentFlow() {
  return { passed: false, failures: [] };
}

async function testServiceProviderEmailFlow() {
  return { passed: false, failures: [] };
}

async function testDeadlineFlow() {
  return { passed: false, failures: [] };
}

async function notifyTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: 'Markdown',
      }),
    });
  } catch (err) {
    console.error('Telegram notification failed:', err.message);
  }
}

async function handler(req, res) {
  // Auth check
  const auth = req.headers.authorization || req.headers['x-vercel-cron'];
  if (auth !== `Bearer ${CRON_SECRET}` && auth !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const now = new Date();
    const dayOfWeek = now.getUTCDay();
    // Map to scenario index (0=Monday=Day1, 1=Tuesday=Day2, etc)
    const scenarioIndex = (dayOfWeek - 1) % 5;
    const scenario = SCENARIOS[scenarioIndex < 0 ? 4 : scenarioIndex];

    console.log(`[QA Loop] Running Day ${scenario.day}: ${scenario.title}`);

    // Stub: findings would be populated by actual test execution
    const findings = {
      passed: false,
      failures: [
        {
          step: 'Example failure',
          severity: 'P1',
          failureClass: 'D',
          description: 'Stub implementation',
        },
      ],
    };

    // Notify Health only on milestone completions (silent otherwise)
    const hasP0 = findings.failures.some(f => f.severity === 'P0');
    if (findings.passed) {
      await notifyTelegram(`✅ QA Loop benchmark PASSED – Day ${scenario.day}`);
    } else if (hasP0) {
      await notifyTelegram(`🚨 QA Loop P0 detected – Day ${scenario.day}`);
    }

    return res.status(200).json({
      success: true,
      scenario: scenario.day,
      findings: findings.failures.length,
      passed: findings.passed,
    });
  } catch (err) {
    console.error('[QA Loop] Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;
