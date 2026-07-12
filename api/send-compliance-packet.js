// Vercel Serverless Function: /api/send-compliance-packet
// POST /api/send-compliance-packet  body: { transaction_id }
// Authorization: Bearer <supabase user JWT>
//
// Compiles every document attached to a transaction and emails them as a
// single packet to the agent's brokerage compliance email (stored on the
// agent profile). Logs the send to compliance_sends.
//
// Sends from heath@meetdossie.com with a "<agent name> via Dossie" display
// name and reply_to set to the agent's email — so a compliance reply lands
// directly in the agent's inbox, not Heath's. (Native send-as-agent waits on
// the Connect-Gmail / Connect-Outlook integrations.)

const { sanitizeString, validateEmail, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { resolveBlankTemplatePdf } = require('./_lib/resolve-blank-template-pdf');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const BUCKET = 'documents';

// Resend caps combined attachment size at 40 MB (base64-inflated). Cap raw
// bytes at 25 MB so post-encoding we land cleanly under 35 MB with headroom
// for the body itself.
const MAX_PACKET_BYTES = 25 * 1024 * 1024;

const ALLOWED_ORIGINS = new Set([
  'https://meetdossie.com',
  'https://www.meetdossie.com',
]);
const LOCALHOST_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+\.vercel\.app$/;

function applyCors(req, res) {
  const origin = (req && req.headers && req.headers.origin) || '';
  let allowOrigin = null;
  if (typeof origin === 'string' && origin.length > 0) {
    if (ALLOWED_ORIGINS.has(origin) || LOCALHOST_ORIGIN_RE.test(origin) || VERCEL_PREVIEW_RE.test(origin)) {
      allowOrigin = origin;
    }
  }
  if (allowOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
  return Boolean(allowOrigin);
}

async function supabaseRest(path, init) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
    ...((init && init.headers) || {}),
  };
  return fetch(url, { ...init, headers });
}

async function downloadStorageObject(storagePath) {
  const url = `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${storagePath}`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`storage download ${r.status} for ${storagePath}: ${text.slice(0, 200)}`);
  }
  const buf = await r.arrayBuffer();
  return Buffer.from(buf);
}

function formatClosingDate(value) {
  if (!value) return 'Not set';
  // closing_date arrives as 'YYYY-MM-DD' (Postgres date). Render in agent's
  // locale-friendly long form without timezone shifting.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!m) return String(value);
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return `${months[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

function transactionTypeLabel(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'buyer' || r === 'buyers' || r === 'buyer-side') return "Buyer's side";
  if (r === 'seller' || r === 'sellers' || r === 'seller-side' || r === 'listing') return "Seller's side";
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : '—';
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildCover({ tx, profile, documents }) {
  const property = tx.property_address || 'Property address pending';
  const cityZip = tx.city_state_zip ? `, ${tx.city_state_zip}` : '';
  const closing = formatClosingDate(tx.closing_date);
  const txType = transactionTypeLabel(tx.role);
  const agentName = profile.full_name || profile.email || 'Agent';
  const brokerage = profile.brokerage || '';
  const docList = documents.map((d) => `  • ${d.file_name}`).join('\n');
  const docListHtml = documents
    .map((d) => `<li style="margin:4px 0;">${escapeHtml(d.file_name)}</li>`)
    .join('');

  const text = [
    `Closing packet — ${property}${cityZip}`,
    '',
    `Agent: ${agentName}${brokerage ? ` (${brokerage})` : ''}`,
    `Transaction type: ${txType}`,
    `Closing date: ${closing}`,
    `Documents attached: ${documents.length}`,
    '',
    'Documents:',
    docList,
    '',
    `Sent via Dossie on behalf of ${agentName}.`,
    'Reply to this email to reach the agent directly.',
  ].join('\n');

  const html = `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FDFCFA;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="font-family:'Cormorant Garamond',Georgia,serif;font-size:24px;line-height:1.3;margin:0 0 18px;">Closing packet — ${escapeHtml(property)}${escapeHtml(cityZip)}</p>
    <table style="border-collapse:collapse;font-size:15px;line-height:1.6;margin:0 0 20px;">
      <tr><td style="padding:2px 14px 2px 0;color:#7A7468;">Agent</td><td>${escapeHtml(agentName)}${brokerage ? ` (${escapeHtml(brokerage)})` : ''}</td></tr>
      <tr><td style="padding:2px 14px 2px 0;color:#7A7468;">Transaction type</td><td>${escapeHtml(txType)}</td></tr>
      <tr><td style="padding:2px 14px 2px 0;color:#7A7468;">Closing date</td><td>${escapeHtml(closing)}</td></tr>
      <tr><td style="padding:2px 14px 2px 0;color:#7A7468;">Documents attached</td><td>${documents.length}</td></tr>
    </table>
    <p style="font-size:15px;line-height:1.6;margin:0 0 6px;color:#1A1A2E;"><strong>Documents in this packet:</strong></p>
    <ul style="font-size:14px;line-height:1.6;margin:0 0 24px;padding-left:20px;">${docListHtml}</ul>
    <p style="font-size:13px;line-height:1.6;color:#7A7468;margin:24px 0 0;">Sent via Dossie on behalf of ${escapeHtml(agentName)}. Reply to this email to reach the agent directly.</p>
  </div>
</body>
</html>`.trim();

  return { text, html };
}

async function sendPacketEmail({
  fromAgentName,
  agentReplyToEmail,
  toEmail,
  subject,
  text,
  html,
  attachments,
}) {
  const fromDisplay = fromAgentName ? `${fromAgentName} via Dossie` : 'Dossie';
  const safeFromDisplay = fromDisplay.replace(/[<>"\\]/g, '');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: `${safeFromDisplay} <heath@meetdossie.com>`,
      to: [toEmail],
      reply_to: agentReplyToEmail || 'heath@meetdossie.com',
      subject,
      text,
      html,
      attachments,
      tags: [{ name: 'category', value: 'compliance_packet' }],
      bcc: ['heath@meetdossie.com'],
    }),
  });
  const body = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  if (!r.ok) {
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
  return parsed;
}

async function logComplianceSend({ transactionId, userId, sentToEmail, documentCount, resendMessageId, error }) {
  try {
    await supabaseRest('compliance_sends', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({
        transaction_id: transactionId,
        user_id: userId,
        sent_to_email: sentToEmail,
        document_count: documentCount,
        resend_message_id: resendMessageId || null,
        error: error || null,
      }),
    });
  } catch (err) {
    console.error('[send-compliance-packet] log insert failed:', err && err.message);
  }
}

module.exports = async function handler(req, res) {
  const corsAllowed = applyCors(req, res);

  if (req.method === 'OPTIONS') {
    res.status(corsAllowed ? 204 : 403).end();
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error('[send-compliance-packet] Supabase not configured.');
    return res.status(500).json({ ok: false, error: 'Compliance send is not configured.' });
  }
  if (!RESEND_API_KEY) {
    console.error('[send-compliance-packet] RESEND_API_KEY missing.');
    return res.status(500).json({ ok: false, error: 'Email sending is not configured.' });
  }

  try {
    const ip = clientIpFromReq(req);
    // 30/hour: legitimate use is ~1 per closed deal. This catches a runaway
    // client without throttling normal flow.
    await checkRateLimit(ip, 'send-compliance-packet', 30, 60 * 60 * 1000);

    const { userId, email: agentAuthEmail } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};
    const transactionId = sanitizeString(body.transaction_id || body.transactionId || '', { maxLength: 200 });
    if (!transactionId) {
      throw new ValidationError('transaction_id is required.');
    }

    // Profile (compliance email + name + brokerage live here).
    const safeUid = encodeURIComponent(userId);
    const profileResp = await supabaseRest(
      `profiles?id=eq.${safeUid}&select=full_name,email,brokerage,compliance_email&limit=1`,
      { method: 'GET' },
    );
    if (!profileResp.ok) {
      const text = await profileResp.text().catch(() => '');
      throw new Error(`profile fetch failed (${profileResp.status}): ${text.slice(0, 200)}`);
    }
    const profileRows = await profileResp.json();
    const profile = (Array.isArray(profileRows) && profileRows[0]) || null;
    if (!profile) {
      throw new ValidationError('Agent profile not found.', 404);
    }
    const complianceEmail = sanitizeString(profile.compliance_email, { maxLength: 320 });
    if (!complianceEmail || !validateEmail(complianceEmail)) {
      throw new ValidationError(
        'Set your brokerage compliance email in Settings before sending a packet.',
      );
    }

    // Transaction (owner-scoped).
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}&select=id,property_address,city_state_zip,role,closing_date,buyer_name,seller_name,stage,status&limit=1`,
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(() => '');
      throw new Error(`transaction fetch failed (${txResp.status}): ${text.slice(0, 200)}`);
    }
    const txRows = await txResp.json();
    const tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) {
      return res.status(404).json({ ok: false, error: 'Dossier not found.' });
    }

    // Documents (owner-scoped).
    // 2026-07-13 CARTER — SELECT widened to include document_type, status,
    // form_template_id so blank template docs can be resolved from base64
    // assets instead of the placeholder storage_path.
    const docsResp = await supabaseRest(
      `documents?select=id,file_name,file_type,file_size,storage_path,document_type,status,form_template_id&user_id=eq.${safeUid}&transaction_id=eq.${safeTx}&order=created_at.asc`,
      { method: 'GET' },
    );
    if (!docsResp.ok) {
      const text = await docsResp.text().catch(() => '');
      throw new Error(`documents fetch failed (${docsResp.status}): ${text.slice(0, 200)}`);
    }
    const documents = await docsResp.json();
    if (!Array.isArray(documents) || documents.length === 0) {
      throw new ValidationError(
        'No documents attached to this dossier yet. Upload at least one before sending.',
      );
    }

    const totalReportedBytes = documents.reduce((sum, d) => sum + (Number(d.file_size) || 0), 0);
    if (totalReportedBytes > MAX_PACKET_BYTES) {
      throw new ValidationError(
        `Packet is ${(totalReportedBytes / 1024 / 1024).toFixed(1)} MB — too large for one email (${MAX_PACKET_BYTES / 1024 / 1024} MB max). Split into multiple sends.`,
        413,
      );
    }

    // Download attachments. Sequential to keep memory predictable for the
    // 25 MB cap; the storage object endpoint is fast anyway.
    //
    // 2026-07-13 CARTER — Two changes:
    //   1. Blank form_template placeholders (storage_path "template/{id}.pdf")
    //      are resolved from base64 assets via resolveBlankTemplatePdf() so a
    //      dossier with an attached-but-unfilled TREC form still ships a
    //      complete packet.
    //   2. Each doc download is wrapped in try/catch. If a single doc can't
    //      be resolved AND can't be downloaded, we log + skip it and keep
    //      assembling — partial packet > no packet at all. The cover sheet
    //      only lists what actually made it into the attachments.
    const attachments = [];
    const attachedDocs = [];
    let totalActualBytes = 0;
    for (const doc of documents) {
      let buf = null;
      try {
        const resolvedBlank = await resolveBlankTemplatePdf(doc);
        if (resolvedBlank) {
          buf = resolvedBlank.buffer;
          console.log(`[send-compliance-packet] Blank template ${doc.id} resolved from base64 assets (${buf.length} bytes).`);
        } else {
          buf = await downloadStorageObject(doc.storage_path);
        }
      } catch (err) {
        console.warn(`[send-compliance-packet] Skipping doc ${doc.id} (${doc.file_name}) — ${err && err.message}`);
        continue;
      }
      totalActualBytes += buf.length;
      if (totalActualBytes > MAX_PACKET_BYTES) {
        throw new ValidationError(
          `Packet exceeded ${MAX_PACKET_BYTES / 1024 / 1024} MB while assembling. Split into multiple sends.`,
          413,
        );
      }
      attachments.push({
        filename: doc.file_name,
        content: buf.toString('base64'),
        content_type: doc.file_type || 'application/pdf',
      });
      attachedDocs.push(doc);
    }

    if (attachedDocs.length === 0) {
      throw new ValidationError(
        'None of the attached documents could be assembled into a packet. Try again or contact support.',
        422,
      );
    }

    const cover = buildCover({ tx, profile, documents: attachedDocs });
    const subject = `Closing packet — ${tx.property_address || 'Dossie deal'}`;

    let resendMessageId = null;
    let sendError = null;
    try {
      const resp = await sendPacketEmail({
        fromAgentName: profile.full_name || null,
        agentReplyToEmail: profile.email || agentAuthEmail || null,
        toEmail: complianceEmail,
        subject,
        text: cover.text,
        html: cover.html,
        attachments,
      });
      resendMessageId = resp?.id || null;
    } catch (err) {
      sendError = (err && err.message) || String(err);
    }

    await logComplianceSend({
      transactionId,
      userId,
      sentToEmail: complianceEmail,
      documentCount: documents.length,
      resendMessageId,
      error: sendError,
    });

    if (sendError) {
      return res.status(502).json({ ok: false, error: 'Email send failed. Logged for review.' });
    }

    return res.status(200).json({
      ok: true,
      sent_to_email: complianceEmail,
      document_count: documents.length,
      resend_message_id: resendMessageId,
    });
  } catch (error) {
    if (error instanceof AuthError) {
      return res.status(error.status || 401).json({ ok: false, error: error.message });
    }
    if (error instanceof ValidationError) {
      return res.status(error.status || 400).json({ ok: false, error: error.message });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfterSeconds) res.setHeader('Retry-After', String(error.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: 'Too many compliance sends. Try again later.' });
    }
    console.error('[send-compliance-packet] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not send compliance packet.' });
  }
};
