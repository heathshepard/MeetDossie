#!/usr/bin/env node
/**
 * Calibration tool for DocuSeal -> pdf-lib coordinate conversion.
 *
 * Problem: DocuSeal returns field positions as {x, y, w, h} normalized 0-1,
 * page-relative, with TOP-LEFT origin. pdf-lib draws text in points with
 * BOTTOM-LEFT origin. We need to know exactly which y-conversion places the
 * text baseline INSIDE the blank, not 12pt above or below.
 *
 * What this does:
 *  1. Loads the 176-field map for TREC 20-19 (DocuSeal coords).
 *  2. For each candidate formula F1..F6, opens a fresh copy of the PDF and
 *     drops a red dot + tiny field-name label at the computed (x, y).
 *  3. Saves marker-F1.pdf .. marker-F6.pdf into .tmp-calibration/.
 *  4. Rasterizes pages 1 and 2 of every marker PDF to PNG via pdftoppm.
 *  5. Sends all 12 PNGs (6 formulas x 2 pages) to Heath's Telegram with
 *     a caption naming the formula.
 *
 * Pure offline tool. Doesn't touch the live fill function. No deploys.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');

const REPO_ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(REPO_ROOT, '.tmp-calibration');
const PDFTOPPM = 'C:/Users/Heath Shepard/AppData/Local/Microsoft/WinGet/Packages/oschwartz10612.Poppler_Microsoft.Winget.Source_8wekyb3d8bbwe/poppler-25.07.0/Library/bin/pdftoppm.exe';

const TREC_RESALE_B64 = require(path.join(REPO_ROOT, 'api/_assets/trec-resale-20-19-base64.js'));
const FIELD_MAP = require(path.join(REPO_ROOT, 'api/_assets/field-map-resale-docuseal.js'));

const FONT_SIZE = 10;   // size at which the live fill writes text
const LABEL_SIZE = 4.5; // tiny label next to each dot

/**
 * Six candidate y-conversion formulas. Each returns the pdf-lib y at which
 * page.drawText() should be called for that field, given DocuSeal coords.
 * x conversion is invariant: x = coord.x * pageWidth.
 */
const FORMULAS = {
  F1: {
    label: 'F1 — baseline at top of field box (y = H - top*H)',
    fn: ({ coord, pageHeight, fontSize }) => pageHeight - coord.y * pageHeight,
  },
  F2: {
    label: 'F2 — baseline at bottom of field box (y = H - (top+h)*H)',
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h) * pageHeight,
  },
  F3: {
    label: 'F3 — bottom of box + ascent nudge (F2 + fontSize*0.25)',
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h) * pageHeight + fontSize * 0.25,
  },
  F4: {
    label: 'F4 — vertical center of box, minus fontSize/4',
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4,
  },
  F5: {
    label: 'F5 — bottom of box, raised by full fontSize (deep nudge up)',
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h) * pageHeight + fontSize,
  },
  F6: {
    label: 'F6 — top of box, dropped by fontSize (mirror of F5)',
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - coord.y * pageHeight - fontSize,
  },
  // ---------------------------------------------------------------
  // F4 variants — F4 baseline + (X offset right, Y offset up) nudges.
  // Heath says F4 is closest but markers land too low + too left.
  // x = (coord.x * pageWidth) + X_OFFSET
  // y = pageHeight - ((coord.y + coord.h/2) * pageHeight) - fontSize/4 + Y_OFFSET_UP
  // ---------------------------------------------------------------
  F4a: {
    label: 'F4a (+5 X, +3 Y up)',
    xOffset: 5,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 3,
  },
  F4b: {
    label: 'F4b (+5 X, +6 Y up)',
    xOffset: 5,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 6,
  },
  F4c: {
    label: 'F4c (+5 X, +10 Y up)',
    xOffset: 5,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 10,
  },
  F4d: {
    label: 'F4d (+10 X, +3 Y up)',
    xOffset: 10,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 3,
  },
  F4e: {
    label: 'F4e (+10 X, +6 Y up)',
    xOffset: 10,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 6,
  },
  F4f: {
    label: 'F4f (+10 X, +10 Y up)',
    xOffset: 10,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 10,
  },
  F4g: {
    label: 'F4g (+15 X, +3 Y up)',
    xOffset: 15,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 3,
  },
  F4h: {
    label: 'F4h (+15 X, +6 Y up)',
    xOffset: 15,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 6,
  },
  F4i: {
    label: 'F4i (+15 X, +10 Y up)',
    xOffset: 15,
    fn: ({ coord, pageHeight, fontSize }) =>
      pageHeight - (coord.y + coord.h / 2) * pageHeight - fontSize / 4 + 10,
  },
};

async function buildMarkerPdf(formulaKey, formulaFn, xOffset = 0) {
  const pdfBytes = Buffer.from(TREC_RESALE_B64, 'base64');
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const pages = pdfDoc.getPages();

  let drawn = 0;
  let skipped = 0;

  for (const [name, coord] of Object.entries(FIELD_MAP)) {
    const page = pages[coord.page];
    if (!page) {
      skipped++;
      continue;
    }
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const x = coord.x * pageWidth + xOffset;
    const y = formulaFn({ coord, pageHeight, fontSize: FONT_SIZE });

    // Red dot marker
    page.drawCircle({
      x,
      y,
      size: 2,
      color: rgb(1, 0, 0),
      opacity: 0.85,
    });

    // Field name label slightly offset (right + up) so it doesn't obscure the dot
    // Truncate long names so labels don't bleed across the page
    const labelText = name.length > 22 ? name.slice(0, 22) : name;
    try {
      page.drawText(labelText, {
        x: x + 3,
        y: y + 1.5,
        size: LABEL_SIZE,
        color: rgb(0.7, 0, 0),
        font,
      });
    } catch (e) {
      // If a character isn't in WinAnsi, just skip the label — the dot stays.
    }
    drawn++;
  }

  const outBytes = await pdfDoc.save();
  const outPath = path.join(OUT_DIR, `marker-${formulaKey}.pdf`);
  fs.writeFileSync(outPath, outBytes);
  console.log(`  ${formulaKey}: drew ${drawn} markers (${skipped} skipped) -> ${path.basename(outPath)}`);
  return outPath;
}

function rasterize(pdfPath, formulaKey) {
  // pdftoppm -r 150 marker-F1.pdf <prefix> -png -f 1 -l 2
  const prefix = path.join(OUT_DIR, `${formulaKey}-page`);
  try {
    execFileSync(PDFTOPPM, [
      '-r', '150',
      '-png',
      '-f', '1',
      '-l', '2',
      pdfPath,
      prefix,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    console.error(`  pdftoppm failed for ${formulaKey}:`, e.message);
    return [];
  }
  // pdftoppm names files <prefix>-1.png, <prefix>-2.png OR with zero-pad <prefix>-01.png — depends on -l size
  // For -l 2 it uses no padding: -1.png and -2.png
  const candidates = [
    path.join(OUT_DIR, `${formulaKey}-page-1.png`),
    path.join(OUT_DIR, `${formulaKey}-page-2.png`),
    path.join(OUT_DIR, `${formulaKey}-page-01.png`),
    path.join(OUT_DIR, `${formulaKey}-page-02.png`),
  ].filter(p => fs.existsSync(p));
  return candidates;
}

function loadTelegramCreds() {
  // Try .env.local first, then process.env
  const envPath = path.join(REPO_ROOT, '.env.local');
  let token = process.env.TELEGRAM_BOT_TOKEN;
  let chatId = process.env.TELEGRAM_CHAT_ID || '7874782923';
  if (!token && fs.existsSync(envPath)) {
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/^TELEGRAM_BOT_TOKEN\s*=\s*(.+)$/m);
    if (m) token = m[1].trim().replace(/^['"]|['"]$/g, '');
    const c = env.match(/^TELEGRAM_CHAT_ID\s*=\s*(.+)$/m);
    if (c) chatId = c[1].trim().replace(/^['"]|['"]$/g, '');
  }
  return { token, chatId };
}

function sendPhoto({ token, chatId, photoPath, caption }) {
  return new Promise((resolve, reject) => {
    const boundary = '----calibrateBoundary' + Date.now();
    const fileBuf = fs.readFileSync(photoPath);
    const filename = path.basename(photoPath);

    const head = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="chat_id"',
      '',
      String(chatId),
      `--${boundary}`,
      'Content-Disposition: form-data; name="caption"',
      '',
      caption,
      `--${boundary}`,
      `Content-Disposition: form-data; name="photo"; filename="${filename}"`,
      'Content-Type: image/png',
      '',
      '',
    ].join('\r\n');
    const tail = `\r\n--${boundary}--\r\n`;

    const body = Buffer.concat([
      Buffer.from(head, 'utf8'),
      fileBuf,
      Buffer.from(tail, 'utf8'),
    ]);

    const req = https.request({
      method: 'POST',
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendPhoto`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, (res) => {
      let chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(text);
        } else {
          reject(new Error(`Telegram ${res.statusCode}: ${text}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  console.log(`Calibration tool: writing to ${OUT_DIR}`);
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`Field count: ${Object.keys(FIELD_MAP).length}`);

  // Allow filtering via CLI: `node calibrate-docuseal-coords.js F4a F4b F4c`
  const onlyKeys = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const skipTelegram = process.argv.includes('--no-telegram');

  const results = {};
  for (const [key, formula] of Object.entries(FORMULAS)) {
    if (onlyKeys.length && !onlyKeys.includes(key)) continue;
    const { label, fn, xOffset = 0 } = formula;
    console.log(`\n[${key}] ${label}`);
    const pdfPath = await buildMarkerPdf(key, fn, xOffset);
    const pngs = rasterize(pdfPath, key);
    results[key] = { label, pdfPath, pngs };
    console.log(`  PNGs: ${pngs.map(p => path.basename(p)).join(', ') || '(none)'}`);
  }

  // Telegram delivery
  if (skipTelegram) {
    console.log('\n--no-telegram flag set — skipping Telegram send.');
    return;
  }
  const { token, chatId } = loadTelegramCreds();
  if (!token) {
    console.warn('\nNo TELEGRAM_BOT_TOKEN found — skipping Telegram send. PNGs are in .tmp-calibration/.');
    return;
  }

  console.log(`\nSending PNGs to Telegram chat ${chatId}...`);
  for (const [key, { label, pngs }] of Object.entries(results)) {
    for (const png of pngs) {
      const caption = `${label} — ${path.basename(png)}`;
      try {
        await sendPhoto({ token, chatId, photoPath: png, caption });
        console.log(`  sent ${path.basename(png)}`);
      } catch (e) {
        console.error(`  failed ${path.basename(png)}: ${e.message}`);
      }
    }
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
