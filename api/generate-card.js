/**
 * /api/generate-card
 *
 * HTML/CSS-based social card renderer using htmlcsstoimage.com.
 * Generates branded image cards for Instagram and Facebook posts,
 * uploads to Supabase Storage.
 */

const fetch = require('node-fetch');
const { retryFetch } = require('./_lib/retry.js');

// Brand colors (matching CLAUDE.md spec exactly)
const COLORS = {
  BLUSH: '#F5E6E0',      // Primary accent, card background
  BLUSH_DEEP: '#D4A0A0', // Border (not used in current template but kept for consistency)
  CORAL: '#E8836B',      // Accent line, CTA
  SAGE: '#8BA888',       // Footer URL, success
  NAVY: '#1A1A2E',       // Headlines, body text
  GOLD: '#C9A96E',       // Founding badge
  WHITE: '#FFFFFF',
};

const PLATFORM_DIMS = {
  instagram: { width: 1080, height: 1080 },
  facebook: { width: 1200, height: 630 },
};

// Founding cohort is CAPPED AT 25 spots for LIFE of membership.
// Canonical per CLAUDE.md Section 5 and memory feedback_founding_25_locked_forever.
// Do NOT change this number without an explicit instruction from Heath.
const FOUNDING_COHORT_CAP = 25;

/**
 * Query live founding member count from Supabase
 */
async function getFoundingMemberCount() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('Cannot query founding count - Supabase not configured');
    return { count: 0, remaining: FOUNDING_COHORT_CAP };
  }

  try {
    const response = await retryFetch(
      `${supabaseUrl}/rest/v1/subscriptions?plan=eq.founding&status=eq.active&select=id`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
      },
      { name: 'Supabase-founding-count', maxAttempts: 3, baseDelay: 500 }
    );

    if (!response.ok) {
      console.warn('Failed to query founding count:', response.status);
      return { count: 0, remaining: FOUNDING_COHORT_CAP };
    }

    const data = await response.json();
    const count = Array.isArray(data) ? data.length : 0;
    const remaining = Math.max(0, FOUNDING_COHORT_CAP - count);

    return { count, remaining };
  } catch (error) {
    console.warn('Error querying founding count:', error.message);
    return { count: 0, remaining: FOUNDING_COHORT_CAP };
  }
}

/**
 * Upload buffer to Supabase Storage
 */
async function uploadToStorage(buffer, objectPath) {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = 'social-cards';

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured');
  }

  const uploadUrl = `${supabaseUrl}/storage/v1/object/${bucket}/${objectPath}`;
  const response = await retryFetch(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${serviceRoleKey}`,
        'Content-Type': 'image/png',
        'x-upsert': 'true',
      },
      body: buffer,
    },
    { name: 'Supabase-Storage', maxAttempts: 3, baseDelay: 1000 }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${response.status} ${text.slice(0, 200)}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/**
 * Build HTML for the card
 */
function buildCardHTML({ platform, hook, content, stat, statLabel, foundingRemaining }) {
  const dims = PLATFORM_DIMS[platform];
  const { width: W, height: H } = dims;
  const isInstagram = platform === 'instagram';

  // Escape HTML entities
  const escape = (str) => String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

  const actualStat = escape((stat || hook || '80').trim());
  const actualStatLabel = escape((statLabel || 'transactions per year').trim());
  const actualHook = escape((hook || '').trim());
  const bodyText = escape((content || '').trim());
  const pillText = `Founding · ${foundingRemaining} spots left`;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 0;
      width: ${W}px;
      height: ${H}px;
      background: ${COLORS.BLUSH};
      font-family: 'Plus Jakarta Sans', sans-serif;
      overflow: hidden;
    }
    .card {
      width: ${W}px;
      height: ${H}px;
      padding: ${isInstagram ? 70 : 80}px ${Math.floor(W * 0.07)}px;
      position: relative;
      display: flex;
      flex-direction: column;
    }
    .stat {
      font-family: 'Cormorant Garamond', serif;
      font-weight: 700;
      font-size: ${isInstagram ? 96 : 72}px;
      line-height: 1.05;
      color: ${COLORS.CORAL};
      margin-bottom: ${Math.floor(H * 0.025)}px;
    }
    .stat-label {
      font-size: ${isInstagram ? 28 : 22}px;
      line-height: 1.3;
      color: ${COLORS.NAVY};
      margin-bottom: ${Math.floor(H * (isInstagram ? 0.05 : 0.05))}px;
    }
    .body-container {
      display: flex;
      align-items: flex-start;
      margin-bottom: auto;
    }
    .body-bar {
      width: 4px;
      background: ${COLORS.CORAL};
      margin-right: ${Math.floor(W * 0.020)}px;
      flex-shrink: 0;
      align-self: stretch;
    }
    .body {
      font-size: ${isInstagram ? 30 : 22}px;
      line-height: 1.65;
      color: ${COLORS.NAVY};
    }
    .bottom-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-top: ${Math.floor(H * 0.04)}px;
    }
    .pill {
      background: ${COLORS.GOLD};
      color: ${COLORS.WHITE};
      padding: ${Math.floor(H * (isInstagram ? 0.030 : 0.045))}px 20px;
      border-radius: ${Math.floor(H * (isInstagram ? 0.060 : 0.090)) / 2}px;
      font-size: ${isInstagram ? 22 : 20}px;
    }
    .url {
      font-weight: 600;
      font-size: ${isInstagram ? 24 : 20}px;
      color: ${COLORS.SAGE};
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="stat">${actualStat}</div>
    <div class="stat-label">${actualStatLabel}</div>
    <div class="body-container">
      <div class="body-bar"></div>
      <div class="body">${bodyText}</div>
    </div>
    <div class="bottom-row">
      <div class="pill">${pillText}</div>
      <div class="url">meetdossie.com/founding</div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Render card using htmlcsstoimage.com
 */
async function renderCard({ platform, hook, content, stat, statLabel }) {
  const hctiUserId = process.env.HCTI_USER_ID;
  const hctiApiKey = process.env.HCTI_API_KEY;

  if (!hctiUserId || !hctiApiKey) {
    throw new Error('HCTI_USER_ID / HCTI_API_KEY not configured');
  }

  // Get live founding count
  const { remaining: foundingRemaining } = await getFoundingMemberCount();

  // Build HTML
  const html = buildCardHTML({
    platform,
    hook,
    content,
    stat,
    statLabel,
    foundingRemaining,
  });

  // Call htmlcsstoimage API with retry.
  // CRITICAL: `google_fonts` is a STRING (pipe-separated font family names),
  // not a boolean. HCTI's deserializer rejects the request with HTTP 400
  // "Error deserializing request" when `google_fonts: true` is sent — that
  // bug went unnoticed since 2026-05-18 and silently failed today's batch.
  // The font names must match what the <link> tag in the HTML loads.
  const auth = Buffer.from(`${hctiUserId}:${hctiApiKey}`).toString('base64');
  const response = await retryFetch(
    'https://hcti.io/v1/image',
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        html,
        google_fonts: 'Cormorant Garamond|Plus Jakarta Sans',
        ms_delay: 2000,
      }),
    },
    { name: 'HCTI', maxAttempts: 3, baseDelay: 1000 }
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HCTI API failed: ${response.status} ${text.slice(0, 200)}`);
  }

  const data = await response.json();
  const imageUrl = data.url;

  if (!imageUrl) {
    throw new Error('HCTI API did not return an image URL');
  }

  // Download the image with retry
  const imageResponse = await retryFetch(
    imageUrl,
    {},
    { name: 'HCTI-download', maxAttempts: 3, baseDelay: 1000 }
  );
  if (!imageResponse.ok) {
    throw new Error(`Failed to download image from HCTI: ${imageResponse.status}`);
  }

  const buffer = Buffer.from(await imageResponse.arrayBuffer());
  return buffer;
}

/**
 * Main handler
 */
module.exports = async (req, res) => {
  // Auth check
  const auth = req.headers.authorization || req.headers.Authorization || '';
  const expectedAuth = `Bearer ${process.env.CRON_SECRET}`;
  if (!process.env.CRON_SECRET || auth !== expectedAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const { platform, post_id, hook, content, persona, stat, stat_label } = req.body || {};

  // Validation
  if (!platform || !['instagram', 'facebook'].includes(platform)) {
    return res.status(400).json({ ok: false, error: 'platform must be instagram or facebook' });
  }
  if (!post_id) {
    return res.status(400).json({ ok: false, error: 'post_id required' });
  }
  if (!content && !hook && !stat) {
    return res.status(400).json({ ok: false, error: 'content, hook, or stat required' });
  }

  try {
    // Render card
    const buffer = await renderCard({
      platform,
      hook: hook || '',
      content: content || '',
      stat: stat || '',
      statLabel: stat_label || '',
    });

    // Upload to Supabase Storage
    const safeId = post_id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 120);
    const objectPath = `${platform}/${safeId}.png`;
    const publicUrl = await uploadToStorage(buffer, objectPath);

    return res.status(200).json({
      ok: true,
      publicUrl,
      platform,
      size_bytes: buffer.length,
      storage_path: objectPath,
    });
  } catch (error) {
    console.error('Card generation failed:', error);
    return res.status(500).json({
      ok: false,
      error: error.message || 'Card generation failed',
    });
  }
};
