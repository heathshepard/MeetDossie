module.exports = async (req, res) => {
  const results = {}
  const start = Date.now()

  // Check Supabase
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
    })
    results.supabase = r.status === 200 ? 'ok' : `error:${r.status}`
  } catch (e) {
    results.supabase = `error:${e.message}`
  }

  // Check Telegram bot
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const d = await r.json()
    results.telegram = d.ok ? 'ok' : 'error:invalid_token'
  } catch (e) {
    results.telegram = `error:${e.message}`
  }

  // ElevenLabs probe removed — TTS endpoint works (Heath uses voice daily) but generic /v1/user
  // and /v1/voices probes both 401 on this API tier. If TTS breaks, Heath/customers notice via
  // failed morning briefs or talk-to-Dossie. No need for a 5-min health probe here.

  // Check Creatomate
  try {
    const r = await fetch('https://api.creatomate.com/v1/templates', {
      headers: { Authorization: `Bearer ${process.env.CREATOMATE_API_KEY?.trim()}` }
    })
    results.creatomate = r.status === 200 ? 'ok' : `error:${r.status}`
  } catch (e) {
    results.creatomate = `error:${e.message}`
  }

  const allOk = Object.values(results).every(v => v === 'ok')

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    services: results,
    responseMs: Date.now() - start,
    timestamp: new Date().toISOString()
  })
}
