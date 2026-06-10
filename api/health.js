// Capture up to 500 chars of an error response body to surface in alerts.
// Truncation is hard — upstream HTML 500 pages can be huge.
async function readBodySnippet(response) {
  try {
    const text = await response.text()
    if (!text) return ''
    const cleaned = text.replace(/\s+/g, ' ').trim()
    return cleaned.length > 500 ? cleaned.slice(0, 500) + '...[truncated]' : cleaned
  } catch (e) {
    return `<body-read-failed:${e.message}>`
  }
}

module.exports = async (req, res) => {
  const results = {}
  const errorBodies = {}
  const start = Date.now()

  // Check Supabase
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY }
    })
    if (r.status === 200) {
      results.supabase = 'ok'
    } else {
      results.supabase = `error:${r.status}`
      errorBodies.supabase = await readBodySnippet(r)
    }
  } catch (e) {
    results.supabase = `error:${e.message}`
  }

  // Check Telegram bot
  try {
    const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
    const r = await fetch(`https://api.telegram.org/bot${token}/getMe`)
    const d = await r.json()
    if (d.ok) {
      results.telegram = 'ok'
    } else {
      results.telegram = 'error:invalid_token'
      errorBodies.telegram = JSON.stringify(d).slice(0, 500)
    }
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
    if (r.status === 200) {
      results.creatomate = 'ok'
    } else {
      results.creatomate = `error:${r.status}`
      errorBodies.creatomate = await readBodySnippet(r)
    }
  } catch (e) {
    results.creatomate = `error:${e.message}`
  }

  const allOk = Object.values(results).every(v => v === 'ok')

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'degraded',
    services: results,
    errorBodies,
    responseMs: Date.now() - start,
    timestamp: new Date().toISOString()
  })
}
