module.exports = async (req, res) => {
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
