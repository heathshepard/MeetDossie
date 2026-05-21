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

  // Check ElevenLabs (credit-free GET /v1/voices — list voices doesn't burn credits like TTS did)
  try {
    const r = await fetch('https://api.elevenlabs.io/v1/voices', {
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY?.trim() }
    })
    results.elevenlabs = r.status === 200 ? 'ok' : `error:${r.status}`
  } catch (e) {
    results.elevenlabs = `error:${e.message}`
  }

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
