// Vercel Serverless Function: /api/studio/products
// Returns product portfolio
// Authorization: Bearer <supabase user JWT>, restricted to heath.shepard@kw.com

const { verifySupabaseToken, AuthError } = require('../_middleware/auth');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  const allowedOrigins = ['https://meetdossie.com', 'https://www.meetdossie.com', 'https://staging.meetdossie.com'];
  const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const isVercel = origin.endsWith('.vercel.app');

  if (allowedOrigins.includes(origin) || isLocalhost || isVercel) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

async function supabaseFetch(path, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${path}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  return data;
}

module.exports = async (req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const user = await verifySupabaseToken(req);

    // Restrict to heath.shepard@kw.com
    if (user.email !== 'heath.shepard@kw.com') {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Get all products
    const productsData = await supabaseFetch('/rest/v1/studio_products?select=*&order=created_at.asc');

    // For Dossie, fetch live MRR and customer count from subscriptions table
    const products = await Promise.all(
      productsData.map(async (product) => {
        let liveData = {
          mrr: parseFloat(product.mrr || 0),
          activeCustomers: parseInt(product.active_customers || 0, 10),
          growthRate: parseFloat(product.growth_rate || 0),
        };

        if (product.product_name === 'dossie') {
          try {
            // Get active subscriptions
            const subsData = await supabaseFetch(
              '/rest/v1/subscriptions?status=eq.active&select=plan,stripe_price_id'
            );

            // Calculate MRR from subscriptions
            let mrr = 0;
            subsData.forEach(sub => {
              // Founding members: $29/mo
              if (sub.plan === 'founding') {
                mrr += 29;
              }
              // TODO: Add other plans when they exist
            });

            liveData.mrr = mrr;
            liveData.activeCustomers = subsData.length;

            // Calculate growth rate (compare to last month - hardcoded for now)
            // TODO: Store historical data to calculate real growth
            liveData.growthRate = liveData.activeCustomers > 1 ? 50 : 0;
          } catch (err) {
            console.error('Error fetching Dossie live data:', err);
          }
        }

        return {
          id: product.id,
          name: product.product_name,
          displayName: product.display_name,
          logoUrl: product.logo_url,
          status: product.status,
          launchDate: product.launch_date,
          mrr: liveData.mrr,
          activeCustomers: liveData.activeCustomers,
          growthRate: liveData.growthRate,
          description: product.description,
          appUrl: product.app_url,
        };
      })
    );

    res.status(200).json({
      success: true,
      data: products,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      return res.status(401).json({ error: err.message });
    }
    console.error('Error fetching products:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
