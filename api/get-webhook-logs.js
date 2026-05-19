// Retrieve debug logs from telegram-webhook
module.exports = async function handler(req, res) {
  const logs = global.webhookDebugLogs || [];
  return res.status(200).json({
    count: logs.length,
    logs: logs.slice(-20) // Last 20 entries
  });
};
