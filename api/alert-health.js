module.exports = async (req, res) => {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
  const CRON_SECRET = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const health = await fetch('https://meetdossie.com/api/health').then(r => r.json())

  if (health.status !== 'ok') {
    const broken = Object.entries(health.services)
      .filter(([, v]) => v !== 'ok')
      .map(([k, v]) => `❌ ${k}: ${v}`)
      .join('\n')

    const message = `🚨 DOSSIE ALERT\n\n${broken}\n\n${health.timestamp}`

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: message
      })
    })
  }

  res.json(health)
}
