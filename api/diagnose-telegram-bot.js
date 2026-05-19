// Diagnostic endpoint to check Telegram bot configuration and connectivity
// Helps diagnose why bot receives but doesn't respond

const TELEGRAM_MARKETING_BOT_TOKEN = process.env.TELEGRAM_MARKETING_BOT_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  // Require auth
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const effectiveToken = TELEGRAM_MARKETING_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  const diagnostics = {
    timestamp: new Date().toISOString(),
    tokens: {
      TELEGRAM_MARKETING_BOT_TOKEN: TELEGRAM_MARKETING_BOT_TOKEN ? `set (${TELEGRAM_MARKETING_BOT_TOKEN.substring(0, 10)}...)` : 'NOT SET',
      TELEGRAM_BOT_TOKEN: TELEGRAM_BOT_TOKEN ? `set (${TELEGRAM_BOT_TOKEN.substring(0, 10)}...)` : 'NOT SET',
      effectiveToken: effectiveToken ? `set (${effectiveToken.substring(0, 10)}...)` : 'NOT SET'
    },
    tests: {}
  };

  // Test 1: Get bot info (getMe)
  if (effectiveToken) {
    try {
      const getMeUrl = `https://api.telegram.org/bot${effectiveToken}/getMe`;
      const getMeRes = await fetch(getMeUrl);
      const getMeData = await getMeRes.json();
      diagnostics.tests.getMe = {
        status: getMeRes.status,
        ok: getMeRes.ok,
        botInfo: getMeData.ok ? getMeData.result : null,
        error: getMeData.ok ? null : getMeData
      };
    } catch (err) {
      diagnostics.tests.getMe = {
        error: err.message,
        stack: err.stack
      };
    }
  } else {
    diagnostics.tests.getMe = { error: 'No token available' };
  }

  // Test 2: Try answerCallbackQuery with a fake ID (will fail with "query not found" but proves connectivity)
  if (effectiveToken) {
    try {
      const answerUrl = `https://api.telegram.org/bot${effectiveToken}/answerCallbackQuery`;
      const answerRes = await fetch(answerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: 'test-diagnostic-query-id',
          text: 'Diagnostic test'
        })
      });
      const answerData = await answerRes.json();
      diagnostics.tests.answerCallbackQuery = {
        status: answerRes.status,
        ok: answerRes.ok,
        response: answerData,
        note: 'Expected to fail with "query not found" - proves bot can send API calls'
      };
    } catch (err) {
      diagnostics.tests.answerCallbackQuery = {
        error: err.message,
        stack: err.stack
      };
    }
  } else {
    diagnostics.tests.answerCallbackQuery = { error: 'No token available' };
  }

  return res.status(200).json(diagnostics);
};
