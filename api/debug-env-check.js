// Debug endpoint to check which env vars are set
// DELETE THIS FILE after debugging is complete

module.exports = async function handler(req, res) {
  const checks = {
    TELEGRAM_BOT_TOKEN: !!process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_BOT_TOKEN_length: process.env.TELEGRAM_BOT_TOKEN?.length || 0,
    TELEGRAM_CHAT_ID: !!process.env.TELEGRAM_CHAT_ID,
    TELEGRAM_CHAT_ID_value: process.env.TELEGRAM_CHAT_ID || 'not set',
    TELEGRAM_MARKETING_BOT_TOKEN: !!process.env.TELEGRAM_MARKETING_BOT_TOKEN,
    CRON_SECRET: !!process.env.CRON_SECRET,
  };

  return res.status(200).json(checks);
};
