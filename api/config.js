module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    supabaseUrl: process.env.SUPABASE_URL?.trim(),
    supabaseKey: (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)?.trim(),
    // VAPID public key — safe to expose client-side by design (it's the
    // "applicationServerKey" PushManager.subscribe() needs). The private
    // key never leaves Vercel env vars. See api/jarvis-push-send.js.
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY?.trim()
  })
}
