// api/cron-customer-view-digest.js
//
// SV-ENG-RIDGE-CUSTOMER-VIEW (Ridge, 2026-06-12)
//
// Monday 6 AM CDT (11:00 UTC).
//
// Walks the 5 customer-facing URLs, takes a full-page screenshot of each,
// emails Heath the bundle via Resend, and logs the run to customer_view_digests.
//
// URLs (locked):
//   https://meetdossie.com
//   https://meetdossie.com/app
//   https://meetdossie.com/founding
//   https://meetdossie.com/faq
//   https://meetdossie.com/coordinators
//
// Catches staging/prod drift, broken images, layout regressions before customers do.
//
// Storage: screenshots uploaded to Supabase Storage bucket "customer-view-digests"
// under [YYYY-MM-DD]/[slug].png. The Engineering/customer-view-digests/ local
// folder reference in Ridge's brief is the on-disk mirror for sessions where
// Playwright runs locally; cloud runs use Storage instead.
//
// Auth: Bearer ${CRON_SECRET}  or  x-vercel-cron: 1
// Schedule: vercel.json "0 11 * * 1" (Mondays at 6 AM CDT)

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const URLS = [
  { url: 'https://meetdossie.com',             slug: 'home' },
  { url: 'https://meetdossie.com/app',         slug: 'app' },
  { url: 'https://meetdossie.com/founding',    slug: 'founding' },
  { url: 'https://meetdossie.com/faq',         slug: 'faq' },
  { url: 'https://meetdossie.com/coordinators',slug: 'coordinators' },
];

const RECIPIENT = 'heath@meetdossie.com';
const SENDER = 'Ridge <heath@meetdossie.com>';
const BUCKET = 'customer-view-digests';

// Cap attachment size in email — Resend max ~40MB total. Keep each ~< 2MB.
const MAX_ATTACHMENT_BYTES = 2_000_000;

async function sb(p, init = {}) {
  const headers = {
    'Content-Type': 'application/json',
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    ...(init.headers || {}),
  };
  const res = await fetch(`${SUPABASE_URL}${p}`, { ...init, headers });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

async function uploadScreenshot(dateKey, slug, buffer) {
  const path = `${dateKey}/${slug}.png`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SUPABASE_KEY}`,
      apikey: SUPABASE_KEY,
      'Content-Type': 'image/png',
      'x-upsert': 'true',
    },
    body: buffer,
  });
  if (!res.ok) {
    const t = await res.text();
    return { ok: false, error: `storage ${res.status}: ${t.slice(0, 200)}` };
  }
  return { ok: true, path };
}

async function tg(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text.slice(0, 4090),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
  } catch (err) { console.error('[customer-view] tg error:', err && err.message); }
}

async function captureAll() {
  const playwright = require('playwright');
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const results = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Ridge-CustomerViewDigest/1.0 (Shepard Ventures reliability bot)',
    });
    for (const target of URLS) {
      const page = await ctx.newPage();
      try {
        await page.goto(target.url, { waitUntil: 'networkidle', timeout: 30000 });
        // Allow lazy-load + fonts to settle.
        await page.waitForTimeout(1500);
        const buf = await page.screenshot({ fullPage: true, type: 'png' });
        results.push({ ...target, buffer: buf, ok: true });
      } catch (err) {
        results.push({ ...target, ok: false, error: err.message });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return results;
}

async function sendEmail(dateKey, captures, screenshotUrls) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY missing' };

  const okOnes = captures.filter((c) => c.ok);
  const failedOnes = captures.filter((c) => !c.ok);

  const subject = `Ridge: customer-view digest — ${dateKey}`;

  const okList = okOnes.map((c) => `  • ${c.url}`).join('\n');
  const failList = failedOnes.length === 0
    ? '  (none)'
    : failedOnes.map((c) => `  • ${c.url} — ${c.error}`).join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:680px;margin:0 auto;color:#1A1A2E;">
      <h2 style="font-family:'Cormorant Garamond',serif;color:#1A1A2E;margin:0 0 .25rem;">Ridge — customer-view digest</h2>
      <p style="color:#666;margin:0 0 1.5rem;font-size:14px;">${dateKey} · what Dossie actually looks like to a customer this morning</p>

      <p style="font-size:14px;line-height:1.6;">
        Heath — Ridge here. These are full-page screenshots of every customer-facing URL,
        captured this morning at 6 AM CDT. Skim them before the day starts so you catch
        layout regressions, broken images, or stale content before a customer does.
      </p>

      <h3 style="font-size:14px;color:#1A1A2E;margin:1.5rem 0 .5rem;">Captured</h3>
      <pre style="background:#f6f8fa;padding:.75rem 1rem;border-radius:8px;font-size:13px;white-space:pre-wrap;">${okList || '  (none)'}</pre>

      ${failedOnes.length > 0 ? `
        <h3 style="font-size:14px;color:#C62828;margin:1.5rem 0 .5rem;">Failed</h3>
        <pre style="background:#FFEBEE;padding:.75rem 1rem;border-radius:8px;font-size:13px;white-space:pre-wrap;">${failList}</pre>
      ` : ''}

      <h3 style="font-size:14px;color:#1A1A2E;margin:1.5rem 0 .5rem;">Storage</h3>
      <p style="font-size:13px;color:#666;">
        All ${captures.length} screenshots also live in Supabase Storage bucket
        <code>${BUCKET}/${dateKey}/</code> for permanent reference.
      </p>

      <p style="font-size:12px;color:#999;margin-top:2rem;">— Ridge · Reliability & Observability</p>
    </div>
  `;

  // Build attachments (cap size).
  const attachments = [];
  for (const c of okOnes) {
    if (!c.buffer) continue;
    if (c.buffer.length > MAX_ATTACHMENT_BYTES) {
      // Too big to attach — link in Storage only.
      continue;
    }
    attachments.push({
      filename: `${dateKey}-${c.slug}.png`,
      content: c.buffer.toString('base64'),
      content_type: 'image/png',
    });
  }

  const body = {
    from: SENDER,
    to: [RECIPIENT],
    subject,
    html,
    attachments,
  };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      return { ok: false, error: `resend ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = withTelemetry('cron-customer-view-digest', async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const dateKey = new Date().toISOString().slice(0, 10);
  let captures = [];
  let storagePaths = {};
  let storageErrors = [];

  try {
    captures = await captureAll();
  } catch (err) {
    console.error('[customer-view] capture crashed:', err);
    await sb('/rest/v1/customer_view_digests', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        taken_at: new Date().toISOString(),
        urls: URLS.map((u) => u.url),
        screenshot_paths: {},
        email_status: 'capture_failed',
        errors: [{ stage: 'capture', error: err.message }],
      }),
    });
    return res.status(500).json({ ok: false, error: `capture failed: ${err.message}` });
  }

  // Upload each captured shot to Storage.
  for (const c of captures) {
    if (!c.ok || !c.buffer) continue;
    const up = await uploadScreenshot(dateKey, c.slug, c.buffer);
    if (up.ok) {
      storagePaths[c.slug] = up.path;
    } else {
      storageErrors.push({ slug: c.slug, error: up.error });
    }
  }

  const email = await sendEmail(dateKey, captures, storagePaths);

  await sb('/rest/v1/customer_view_digests', {
    method: 'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      taken_at: new Date().toISOString(),
      urls: URLS.map((u) => u.url),
      screenshot_paths: storagePaths,
      email_status: email.ok ? 'sent' : 'failed',
      email_id: email.id || null,
      errors: storageErrors.length || !email.ok
        ? { storage: storageErrors, email: email.ok ? null : email.error }
        : null,
    }),
  });

  // Telegram ping ONLY when something failed — silence = healthy (Ridge rule).
  const failedCaps = captures.filter((c) => !c.ok);
  if (failedCaps.length > 0 || !email.ok) {
    const lines = ['🟡 <b>RIDGE — Customer-view digest issues</b>', ''];
    if (failedCaps.length > 0) {
      lines.push(`<b>${failedCaps.length} URL(s) failed to capture:</b>`);
      for (const f of failedCaps) lines.push(`• ${f.url} — ${f.error}`);
    }
    if (!email.ok) lines.push(`<b>Email failed:</b> ${email.error}`);
    lines.push('');
    lines.push(`Storage: ${Object.keys(storagePaths).length}/${captures.length} uploaded.`);
    await tg(lines.join('\n'));
  }

  return res.status(200).json({
    ok: true,
    date: dateKey,
    captured: captures.map((c) => ({ url: c.url, slug: c.slug, ok: c.ok, error: c.error })),
    storage_paths: storagePaths,
    storage_errors: storageErrors,
    email,
  });
});
