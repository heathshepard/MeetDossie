module.exports = (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    supabaseUrl: (process.env.FITNESS_SUPABASE_URL || '').trim(),
    supabaseKey: (process.env.FITNESS_SUPABASE_ANON_KEY || '').trim(),
  });
};
