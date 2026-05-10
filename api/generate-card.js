/**
 * /api/generate-card
 *
 * Node.js canvas-based social card renderer. Generates branded image cards
 * for Instagram and Facebook posts, uploads to Supabase Storage.
 */

const { createCanvas, registerFont } = require('canvas');
const path = require('path');
const fetch = require('node-fetch');

// Brand colors
const COLORS = {
  BLUSH: '#F5E6E0',
  BLUSH_DEEP: '#D4A0A0',
  CORAL: '#E8836B',
  SAGE: '#8BA888',
  NAVY: '#1A1A2E',
  GOLD: '#C9A96E',
  BODY_INK: '#444444',
  WHITE: '#FFFFFF',
};

const PERSONA_COLORS = {
  brenda: COLORS.CORAL,
  patricia: COLORS.SAGE,
  victor: COLORS.NAVY,
};

const PLATFORM_DIMS = {
  instagram: { width: 1080, height: 1080 },
  facebook: { width: 1200, height: 630 },
};

// Register fonts
const fontsDir = path.join(process.cwd(), 'public', 'fonts');
try {
  registerFont(path.join(fontsDir, 'CormorantGaramond-Bold.ttf'), { family: 'Cormorant Garamond', weight: 'bold' });
  registerFont(path.join(fontsDir, 'PlusJakartaSans-Regular.ttf'), { family: 'Plus Jakarta Sans', weight: 'normal' });
  registerFont(path.join(fontsDir, 'PlusJakartaSans-Bold.ttf'), { family: 'Plus Jakarta Sans', weight: 'bold' });
} catch (err) {
  console.warn('Font registration failed:', err.message);
}

/**
 * Wrap text to fit within maxWidth
 */
function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    const metrics = ctx.measureText(testLine);
    if (metrics.width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) {
    lines.push(currentLine);
  }
  return lines;
}

/**
 * Query live founding member count from Supabase
 */
async function getFoundingMemberCount() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.warn('Cannot query founding count - Supabase not configured');
    return { count: 0, remaining: 50 };
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/subscriptions?plan=eq.founding&status=eq.active&select=id`,
      {
        headers: {
          'apikey': serviceRoleKey,
          'Authorization': `Bearer ${serviceRoleKey}`,
        },
      }
    );

    if (!response.ok) {
      console.warn('Failed to query founding count:', response.status);
      return { count: 0, remaining: 50 };
    }

    const data = await response.json();
    const count = Array.isArray(data) ? data.length : 0;
    const remaining = Math.max(0, 50 - count);

    return { count, remaining };
  } catch (error) {
    console.warn('Error querying founding count:', error.message);
    return { count: 0, remaining: 50 };
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
  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${serviceRoleKey}`,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body: buffer,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Storage upload failed: ${response.status} ${text.slice(0, 200)}`);
  }

  return `${supabaseUrl}/storage/v1/object/public/${bucket}/${objectPath}`;
}

/**
 * Render the social card
 */
async function renderCard({ platform, hook, content, persona, stat, statLabel }) {
  const dims = PLATFORM_DIMS[platform];
  if (!dims) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  const { width: W, height: H } = dims;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  const isInstagram = platform === 'instagram';

  // Background
  ctx.fillStyle = COLORS.BLUSH;
  ctx.fillRect(0, 0, W, H);

  // Border
  const inset = 12;
  const radius = 16;
  ctx.strokeStyle = COLORS.BLUSH_DEEP;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(inset, inset, W - 2 * inset, H - 2 * inset, radius);
  ctx.stroke();

  // Margins
  const marginX = Math.floor(W * 0.07);
  const padTop = Math.floor(H * (isInstagram ? 0.09 : 0.10));
  const padBot = Math.floor(H * (isInstagram ? 0.08 : 0.10));
  const contentLeft = marginX;
  const contentRight = W - marginX;
  const contentW = contentRight - contentLeft;

  const statColor = PERSONA_COLORS[persona?.toLowerCase()] || COLORS.CORAL;

  // Get live founding count
  const { remaining: foundingRemaining } = await getFoundingMemberCount();

  let y = padTop;

  // ─── 1. STAT LINE (big serif, persona-colored) ──────────────────────────
  const actualStat = (stat || hook || '80').trim();
  const actualStatLabel = (statLabel || 'transactions per year').trim();

  const statSize = isInstagram ? 96 : 72;
  ctx.font = `bold ${statSize}px "Cormorant Garamond"`;
  ctx.fillStyle = statColor;
  ctx.textBaseline = 'top';

  const statLines = wrapText(ctx, actualStat, contentW);
  const truncatedStatLines = statLines.slice(0, 2);

  for (const line of truncatedStatLines) {
    ctx.fillText(line, contentLeft, y);
    y += statSize * 1.05;
  }

  // ─── 2. STAT LABEL (sans, navy) ─────────────────────────────────────────
  const labelGap = Math.floor(H * 0.025);
  y += labelGap;

  const labelSize = isInstagram ? 28 : 22;
  ctx.font = `${labelSize}px "Plus Jakarta Sans"`;
  ctx.fillStyle = COLORS.NAVY;

  const labelLines = wrapText(ctx, actualStatLabel, contentW);
  const truncatedLabelLines = labelLines.slice(0, 2);

  for (const line of truncatedLabelLines) {
    ctx.fillText(line, contentLeft, y);
    y += labelSize * 1.30;
  }

  // ─── 3. VERTICAL DIVIDER + HOOK TEXT ────────────────────────────────────
  const hookGap = Math.floor(H * (isInstagram ? 0.04 : 0.05));
  y += hookGap;

  const actualHook = (hook || '').trim();
  if (actualHook) {
    // Draw vertical sage divider line (left side)
    const dividerHeight = Math.floor(H * 0.025);
    ctx.fillStyle = COLORS.SAGE;
    ctx.fillRect(contentLeft, y, 3, dividerHeight);

    // Hook text next to divider
    const hookTextX = contentLeft + 15;
    const hookSize = isInstagram ? 32 : 26;
    ctx.font = `bold ${hookSize}px "Plus Jakarta Sans"`;
    ctx.fillStyle = COLORS.NAVY;

    const hookLines = wrapText(ctx, actualHook, contentRight - hookTextX);
    const truncatedHookLines = hookLines.slice(0, 2);

    for (const line of truncatedHookLines) {
      ctx.fillText(line, hookTextX, y);
      y += hookSize * 1.2;
    }
  }

  // ─── 4. BODY CONTENT (with gold left bar) ───────────────────────────────
  const contentGap = Math.floor(H * (isInstagram ? 0.04 : 0.05));
  y += contentGap;

  const pillH = Math.floor(H * (isInstagram ? 0.060 : 0.090));
  const bottomRowY = H - padBot - pillH;
  const contentBottom = bottomRowY - Math.floor(H * 0.04);
  const contentHAvail = Math.max(contentBottom - y, Math.floor(H * 0.10));

  const barW = 4;
  const barX = contentLeft;
  const bodyTextX = contentLeft + barW + Math.floor(W * 0.020);
  const bodyTextW = contentRight - bodyTextX;

  // Truncate body to 200 chars max
  let bodyText = (content || '').trim();
  if (bodyText.length > 200) {
    bodyText = bodyText.slice(0, 200).trim() + '…';
  }

  const bodySize = isInstagram ? 30 : 22;
  ctx.font = `${bodySize}px "Plus Jakarta Sans"`;
  ctx.fillStyle = COLORS.BODY_INK;

  const bodyLines = wrapText(ctx, bodyText, bodyTextW);
  const bodyLineHeight = bodySize * 1.65;

  // Hard limit: max 4 lines to prevent overlap with bottom pill
  const maxBodyLines = 4;
  const truncatedBodyLines = bodyLines.slice(0, maxBodyLines);

  const renderedBodyH = truncatedBodyLines.length * bodyLineHeight;

  // Draw gold bar
  if (renderedBodyH > 0) {
    ctx.fillStyle = COLORS.GOLD;
    ctx.fillRect(barX, y, barW, renderedBodyH);
  }

  // Draw body text
  ctx.fillStyle = COLORS.BODY_INK;
  const bodyStartY = y;
  for (const line of truncatedBodyLines) {
    if (line) {
      ctx.fillText(line, bodyTextX, y);
    }
    y += bodyLineHeight;
  }

  // ─── 5. BOTTOM ROW: PILL (left) + URL (right) ───────────────────────────
  const pillText = `Founding · ${foundingRemaining} spots left`;
  const pillSize = isInstagram ? 22 : 20;
  ctx.font = `${pillSize}px "Plus Jakarta Sans"`;

  const pillTextMetrics = ctx.measureText(pillText);
  const pillPadX = 20;
  const pillW = pillTextMetrics.width + 2 * pillPadX;
  const pillRadius = pillH / 2;

  // Draw pill
  ctx.fillStyle = COLORS.GOLD;
  ctx.beginPath();
  ctx.roundRect(contentLeft, bottomRowY, pillW, pillH, pillRadius);
  ctx.fill();

  // Draw pill text
  ctx.fillStyle = COLORS.WHITE;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(pillText, contentLeft + pillPadX, bottomRowY + pillH / 2);

  // Draw URL (right-aligned)
  const urlText = 'meetdossie.com/founding';
  const urlSize = isInstagram ? 24 : 20;
  ctx.font = `600 ${urlSize}px "Plus Jakarta Sans"`;
  ctx.fillStyle = COLORS.SAGE;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(urlText, contentRight, bottomRowY + pillH / 2);

  return canvas.toBuffer('image/png');
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
      persona: persona || null,
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
