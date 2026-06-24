export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;

    // Check for idempotency: is email already in suppression list?
    const checkRes = await fetch(`${supabaseUrl}/rest/v1/email_suppression_list?email=eq.${encodeURIComponent(email)}`, {
      method: 'GET',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
      },
    });

    if (checkRes.ok) {
      const existing = await checkRes.json();
      if (existing && existing.length > 0) {
        // Already suppressed; return 200 (idempotent)
        return res.status(200).json({
          unsubscribed: true,
          unsubscribed_at: existing[0].unsubscribed_at,
        });
      }
    }

    // Insert into email_suppression_list
    // Add "Prefer: return=representation" to get the inserted row back in response
    const insertRes = await fetch(`${supabaseUrl}/rest/v1/email_suppression_list`, {
      method: 'POST',
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify({ email }),
    });

    if (!insertRes.ok) {
      const errorText = await insertRes.text();
      console.error('[unsubscribe] Supabase POST failed:', insertRes.status, errorText);
      return res.status(500).json({ error: 'Failed to process unsubscribe' });
    }

    // Now we can safely parse JSON because Prefer: return=representation guarantees a body
    const inserted = await insertRes.json();

    if (!Array.isArray(inserted) || inserted.length === 0) {
      console.error('[unsubscribe] Unexpected response format:', inserted);
      return res.status(500).json({ error: 'Failed to process unsubscribe' });
    }

    return res.status(200).json({
      unsubscribed: true,
      unsubscribed_at: inserted[0].unsubscribed_at,
    });
  } catch (error) {
    console.error('[unsubscribe] Uncaught error:', error.message);
    return res.status(500).json({ error: 'Failed to process unsubscribe' });
  }
}
