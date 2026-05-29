module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.json({
    supabaseUrl: process.env.SUPABASE_URL?.trim(),
    supabaseKey: (process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY)?.trim()
  })
}
