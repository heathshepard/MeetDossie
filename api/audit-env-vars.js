// Environment variable audit - checks for hidden characters and proper configuration
// Auth required: CRON_SECRET

const CRON_SECRET = process.env.CRON_SECRET;

const ENV_VARS_TO_CHECK = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ELEVENLABS_API_KEY',
  'ZERNIO_API_KEY',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_MARKETING_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'HCTI_USER_ID',
  'HCTI_API_KEY',
  'ANTHROPIC_API_KEY',
  'PEXELS_API_KEY',
  'CREATOMATE_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'RESEND_API_KEY',
  'CRON_SECRET',
];

function checkForHiddenChars(value, name) {
  if (!value) return { clean: true, issue: 'not set' };

  const issues = [];

  // Check for BOM at start
  if (value.charCodeAt(0) === 65279) {
    issues.push('BOM at start (65279)');
  }

  // Check for other non-ASCII at start
  if (value.charCodeAt(0) > 127) {
    issues.push(`Non-ASCII start char (${value.charCodeAt(0)})`);
  }

  // Check for trailing whitespace or non-ASCII
  if (value !== value.trim()) {
    issues.push('Leading/trailing whitespace');
  }

  // Check for zero-width characters
  const zeroWidthChars = [8203, 8204, 8205, 8288];
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (zeroWidthChars.includes(code)) {
      issues.push(`Zero-width char at index ${i} (${code})`);
    }
  }

  return {
    clean: issues.length === 0,
    issues: issues.length > 0 ? issues : undefined,
    length: value.length,
    firstCharCode: value.charCodeAt(0),
    lastCharCode: value.charCodeAt(value.length - 1),
    preview: value.length > 20 ? value.slice(0, 10) + '...' + value.slice(-5) : '***',
  };
}

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  const audit = {};
  let totalIssues = 0;

  for (const varName of ENV_VARS_TO_CHECK) {
    const value = process.env[varName];
    const check = checkForHiddenChars(value, varName);

    if (!check.clean) {
      totalIssues++;
    }

    audit[varName] = {
      set: !!value,
      ...check,
    };
  }

  return res.status(200).json({
    ok: totalIssues === 0,
    totalVars: ENV_VARS_TO_CHECK.length,
    totalIssues,
    audit,
    recommendation: totalIssues > 0
      ? 'Delete and re-add any vars with issues. Generate fresh API keys if needed.'
      : 'All environment variables are clean.',
  });
};
