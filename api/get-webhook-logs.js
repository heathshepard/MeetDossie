// Retrieve debug logs from telegram-webhook
// Auth: Authorization: Bearer ${CRON_SECRET} (added 2026-06-10 Atlas)
const CRON_SECRET = process.env.CRON_SECRET;

module.exports = async function handler(req, res) {
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const logs = global.webhookDebugLogs || [];
  return res.status(200).json({
    count: logs.length,
    logs: logs.slice(-20) // Last 20 entries
  });
};
