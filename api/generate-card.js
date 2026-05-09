/**
 * /api/generate-card
 *
 * Node.js canvas-based social card renderer. Generates branded image cards
 * for Instagram and Facebook posts, uploads to Supabase Storage.
 *
 * Replaces the Python/Pillow implementation with pure Node.js.
 */

const { createCanvas, registerFont, loadImage } = require('canvas');
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

// Register fonts (absolute paths for Vercel serverless)
const fontsDir = path.join(process.cwd(), 'public', 'fonts');
try {
  registerFont(path.join(fontsDir, 'CormorantGaramond-Bold.ttf'), { family: 'Cormorant Garamond', weight: 'bold' });
  registerFont(path.join(fontsDir, 'CormorantGaramond-SemiBold.ttf'), { family: 'Cormorant Garamond', weight: '600' });
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
 * Derive stat and label from provided fields or fallbacks
 */
function deriveStatAndLabel(stat, statLabel, hook, content) {
  let derivedStat = stat || hook || 'Your deals.';
  let derivedLabel = statLabel || content?.split('.')[0] || 'Transform your transaction coordination';

  // Trim to reasonable lengths
  if (derivedStat.length > 40) {
    derivedStat = derivedStat.slice(0, 37) + '…';
  }
  if (derivedLabel.length > 120) {
    derivedLabel = derivedLabel.slice(0, 117) + '…';
  }

  return { derivedStat, derivedLabel };
}

/**
 * Upload buffer to Supabase Storage
 */
async function uploadToStorage(buffer, objectPath) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
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
function renderCard({ platform, hook, content, persona, stat, statLabel }) {
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
  const { derivedStat, derivedLabel } = deriveStatAndLabel(stat, statLabel, hook, content);

  // ─── Stat line (big serif, persona-colored) ─────────────────────────────
  const statTargetSize = isInstagram ? 96 : 72;
  ctx.font = `bold ${statTargetSize}px "Cormorant Garamond"`;
  ctx.fillStyle = statColor;

  const statLines = wrapText(ctx, derivedStat, contentW);
  const truncatedStatLines = statLines.slice(0, 2);
  if (truncatedStatLines.length === 2 && !truncatedStatLines[1].endsWith('…')) {
    truncatedStatLines[1] = truncatedStatLines[1].slice(0, -1) + '…';
  }

  let y = padTop;
  const statLineHeight = statTargetSize * 1.05;
  for (const line of truncatedStatLines) {
    ctx.fillText(line, contentLeft, y + statTargetSize);
    y += statLineHeight;
  }

  // ─── Stat label (sans, navy) ────────────────────────────────────────────
  const labelGap = Math.floor(H * (isInstagram ? 0.025 : 0.030));
  const labelSize = isInstagram ? 28 : 22;
  ctx.font = `${labelSize}px "Plus Jakarta Sans"`;
  ctx.fillStyle = COLORS.NAVY;

  const labelLines = wrapText(ctx, derivedLabel, contentW);
  const truncatedLabelLines = labelLines.slice(0, 2);
  if (truncatedLabelLines.length === 2 && !truncatedLabelLines[1].endsWith('…')) {
    truncatedLabelLines[1] = truncatedLabelLines[1].slice(0, -1) + '…';
  }

  y += labelGap;
  const labelLineHeight = labelSize * 1.30;
  for (const line of truncatedLabelLines) {
    ctx.fillText(line, contentLeft, y + labelSize);
    y += labelLineHeight;
  }

  // ─── Bottom row geometry ─────────────────────────────────────────────────
  const pillH = Math.floor(H * (isInstagram ? 0.060 : 0.090));
  const bottomRowY = H - padBot - pillH;

  // ─── Gold left-bar quote (body content) ──────────────────────────────────
  const quoteTop = y + Math.floor(H * 0.05);
  const quoteBottom = bottomRowY - Math.floor(H * 0.05);
  const quoteHAvail = Math.max(quoteBottom - quoteTop, Math.floor(H * 0.10));

  const barW = 4;
  const barX = contentLeft;
  const quoteTextX = contentLeft + barW + Math.floor(W * 0.020);
  const quoteTextW = contentRight - quoteTextX;

  const bodyText = (content || hook || '').trim();
  const quoteSize = isInstagram ? 30 : 22;
  ctx.font = `${quoteSize}px "Plus Jakarta Sans"`;
  ctx.fillStyle = COLORS.BODY_INK;

  const quoteLines = wrapText(ctx, bodyText, quoteTextW);
  const quoteLineHeight = quoteSize * 1.65;
  const maxQuoteLines = Math.max(1, Math.floor(quoteHAvail / quoteLineHeight));
  const truncatedQuoteLines = quoteLines.slice(0, maxQuoteLines);
  if (truncatedQuoteLines.length > 0 && truncatedQuoteLines.length === maxQuoteLines && !truncatedQuoteLines[maxQuoteLines - 1].endsWith('…')) {
    truncatedQuoteLines[maxQuoteLines - 1] = truncatedQuoteLines[maxQuoteLines - 1].slice(0, -1) + '…';
  }

  const renderedQuoteH = truncatedQuoteLines.length * quoteLineHeight;

  // Draw gold bar
  if (renderedQuoteH > 0) {
    ctx.fillStyle = COLORS.GOLD;
    ctx.fillRect(barX, quoteTop, barW, renderedQuoteH);
  }

  // Draw quote text
  ctx.fillStyle = COLORS.BODY_INK;
  y = quoteTop;
  for (const line of truncatedQuoteLines) {
    if (line) {
      ctx.fillText(line, quoteTextX, y + quoteSize);
    }
    y += quoteLineHeight;
  }

  // ─── Bottom row: pill (left) + URL (right) ───────────────────────────────
  const foundingSpotsRemaining = process.env.FOUNDING_SPOTS_REMAINING || '50';
  const pillText = `Founding · ${foundingSpotsRemaining} spots left`;
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
    const buffer = renderCard({
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
