// Two-strike alert policy: a single failed probe never pages Heath.
// We re-probe after 10s and only fire Telegram if BOTH probes show the same service unhealthy.
// Kills single-blip false positives without adding any state.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probeHealth() {
  try {
    const r = await fetch('https://meetdossie.com/api/health')
    return await r.json()
  } catch (e) {
    return { status: 'error', services: {}, errorBodies: {}, fetchError: e.message }
  }
}

function brokenServices(health) {
  if (!health || !health.services) return []
  return Object.entries(health.services)
    .filter(([, v]) => v !== 'ok')
    .map(([k, v]) => ({ name: k, status: v, body: (health.errorBodies && health.errorBodies[k]) || '' }))
}

module.exports = async (req, res) => {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
  const CRON_SECRET = process.env.CRON_SECRET;
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const first = await probeHealth()

  if (first.status === 'ok') {
    return res.json({ ...first, retried: false })
  }

  // First probe unhealthy — wait 10s and re-probe before paging.
  await sleep(10000)
  const second = await probeHealth()

  // Only fire if the SAME service is unhealthy in BOTH probes.
  const firstBroken = brokenServices(first)
  const secondBroken = brokenServices(second)
  const secondNames = new Set(secondBroken.map((b) => b.name))

  const stillBroken = firstBroken
    .filter((b) => secondNames.has(b.name))
    .map((b) => {
      // Prefer the second probe's body since it's the freshest evidence.
      const secondHit = secondBroken.find((s) => s.name === b.name)
      return {
        name: b.name,
        firstStatus: b.status,
        secondStatus: secondHit ? secondHit.status : b.status,
        body: (secondHit && secondHit.body) || b.body || ''
      }
    })

  if (stillBroken.length === 0) {
    return res.json({
      status: 'recovered',
      firstProbe: first,
      secondProbe: second,
      retried: true,
      note: 'Transient failure — second probe clean, no alert sent.'
    })
  }

  // Build the alert. HTML parse_mode so we can bold service names.
  const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

  const blocks = stillBroken.map((b) => {
    const head = `<b>${escape(b.name)}</b> — still failing after retry`
    const statusLine = b.firstStatus === b.secondStatus
      ? `status: ${escape(b.firstStatus)}`
      : `status: ${escape(b.firstStatus)} -> ${escape(b.secondStatus)}`
    const bodyLine = b.body ? `upstream said: <code>${escape(b.body)}</code>` : 'upstream returned no body'
    return `${head}\n${statusLine}\n${bodyLine}`
  }).join('\n\n')

  const ts = second.timestamp || new Date().toISOString()
  const message = `🚨 DOSSIE ALERT\n\n${blocks}\n\n${ts}`

  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  })

  res.json({
    status: 'alerted',
    firstProbe: first,
    secondProbe: second,
    retried: true,
    stillBroken: stillBroken.map((b) => b.name)
  })
}
