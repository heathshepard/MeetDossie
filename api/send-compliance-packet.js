// Vercel Serverless Function: /api/send-compliance-packet
//
// Compiles every document attached to a dossier into one email with
// attachments, optionally including a freshly-built seller's net sheet, and
// sends it to a named party on the deal.
//
// POST body:
//   transaction_id        required
//   mode                  'preview' (default) | 'send'
//   recipient_role        one of packet-recipients.ROLE_DEFS — resolved off
//                         the deal record. Defaults to 'compliance', which is
//                         what this endpoint used to do unconditionally.
//   recipient_email       explicit override, only honoured when the member
//                         typed it; still refused if it belongs to the other
//                         side's client
//   recipient_name        display name for an explicit address
//   subject               optional override
//   note                  optional line from the member, shown above the
//                         document list
//   net_sheet             optional { sale_price, commission_pct, figures{} } —
//                         builds an estimate and attaches it
//   confirmation_token    required when mode='send'
//   dry_run               true => assemble and return everything, call no
//                         mail provider at all
// Authorization: Bearer <supabase user JWT>
//
// ---------------------------------------------------------------------------
// WHY THIS IS TWO-PHASE
// ---------------------------------------------------------------------------
// This endpoint puts real attachments in a real client's inbox. A spoken
// sentence must never be sufficient to do that. So mode='preview' resolves
// everything and sends nothing, returning a signed token that commits to the
// exact recipient, subject and document set; mode='send' will not proceed
// without that token back. If the packet changed in between, the token stops
// verifying and the member looks again. See api/_lib/packet-recipients.js.
//
// The send is only ever recorded against a real provider message id. A row
// that says "sent" with no id is how ten profiles came to be marked as
// emailed when nothing had gone out, so a failed send is logged with its
// error and reported as a failure — never quietly marked done.
//
// Sends from heath@meetdossie.com with a "<agent name> via Dossie" display
// name and reply_to set to the agent's email, so a reply lands in the
// agent's inbox. (Native send-as-agent waits on Connect-Gmail / Outlook.)

const { sanitizeString, validateEmail, ValidationError } = require('./_middleware/validate');
const {
  checkRateLimit,
  RateLimitError,
  clientIpFromReq,
} = require('./_middleware/rateLimit');
const { verifySupabaseToken, AuthError } = require('./_middleware/auth');
const { resolveBlankTemplatePdf } = require('./_lib/resolve-blank-template-pdf');
const {
  ROLE_DEFS,
  resolveRoleRecipients,
  assertNotOpposingPrincipal,
  issueConfirmationToken,
  verifyConfirmationToken,
  isEmail,
} = require('./_lib/packet-recipients');
const {
  buildNetSheetEstimate,
  buildEstimateHtml,
  disclaimerHtml,
  normalizeMemberFigure,
  normalizeMemberFigures,
} = require('./_lib/net-sheet-estimate');

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

// The cover letter. `audience` is 'compliance' for a brokerage submission and
// 'party' for a human on the deal — a seller reading this wants a short note
// and a list, not a compliance header block.
function buildCover({ tx, profile, documents, recipients, audience, note, netSheetEst }) {
  const property = tx.property_address || 'Property address pending';
  const cityZip = tx.city_state_zip ? `, ${tx.city_state_zip}` : '';
  const closing = formatClosingDate(tx.closing_date);
  const txType = transactionTypeLabel(tx.role);
  const agentName = profile.full_name || profile.email || 'Agent';
  const brokerage = profile.brokerage || '';
  const greetNames = recipients
    .map((r) => (r.name ? String(r.name).split(/\s+/)[0] : null))
    .filter(Boolean);
  const greeting = greetNames.length ? `Hi ${greetNames.join(' and ')},` : 'Hi,';

  const docList = documents.map((d) => `  • ${d.file_name}`).join('\n');
  const docListHtml = documents
    .map((d) => `<li style="margin:4px 0;">${escapeHtml(d.file_name)}</li>`)
    .join('');

  if (audience === 'compliance') {
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

  // Party-facing cover.
  const noteLine = note ? `${note}\n\n` : '';
  const netLine = netSheetEst
    ? `\nI've attached an estimated net sheet. ${netSheetEst.disclaimer.text}\n`
    : '';

  const text = [
    greeting,
    '',
    `${noteLine}Here's the paperwork for ${property}${cityZip}.`,
    netLine,
    'Attached:',
    docList,
    '',
    `— ${agentName}${brokerage ? `, ${brokerage}` : ''}`,
    '',
    'Sent via Dossie. Reply to this email to reach me directly.',
  ].join('\n');

  const html = `
<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#FDFCFA;font-family:'Plus Jakarta Sans',Arial,sans-serif;color:#1A1A2E;">
  <div style="max-width:560px;margin:0 auto;padding:32px 24px;">
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${escapeHtml(greeting)}</p>
    ${note ? `<p style="font-size:15px;line-height:1.6;margin:0 0 14px;">${escapeHtml(note)}</p>` : ''}
    <p style="font-size:15px;line-height:1.6;margin:0 0 14px;">Here&rsquo;s the paperwork for <strong>${escapeHtml(property)}${escapeHtml(cityZip)}</strong>.</p>
    ${netSheetEst ? disclaimerHtml(netSheetEst.disclaimer) : ''}
    <p style="font-size:15px;line-height:1.6;margin:0 0 6px;"><strong>Attached:</strong></p>
    <ul style="font-size:14px;line-height:1.6;margin:0 0 24px;padding-left:20px;">${docListHtml}</ul>
    <p style="font-size:15px;line-height:1.6;margin:0 0 4px;">&mdash; ${escapeHtml(agentName)}${brokerage ? `, ${escapeHtml(brokerage)}` : ''}</p>
    <p style="font-size:13px;line-height:1.6;color:#7A7468;margin:20px 0 0;">Sent via Dossie. Reply to this email to reach me directly.</p>
  </div>
</body>
</html>`.trim();

  return { text, html };
}

async function sendPacketEmail({
  fromAgentName,
  agentReplyToEmail,
  toEmails,
  bccEmails,
  subject,
  text,
  html,
  attachments,
  category,
}) {
  const fromDisplay = fromAgentName ? `${fromAgentName} via Dossie` : 'Dossie';
  const safeFromDisplay = fromDisplay.replace(/[<>"\\]/g, '');
  const payload = {
    from: `${safeFromDisplay} <heath@meetdossie.com>`,
    to: toEmails,
    reply_to: agentReplyToEmail || 'heath@meetdossie.com',
    subject,
    text,
    html,
    attachments,
    tags: [{ name: 'category', value: category }],
  };
  if (bccEmails && bccEmails.length) payload.bcc = bccEmails;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const body = await r.text().catch(() => '');
  let parsed = null;
  try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  if (!r.ok) {
    throw new Error(`Resend ${r.status}: ${body.slice(0, 300)}`);
  }
  return parsed;
}

// One row per recipient so a packet to two sellers is two auditable sends.
// `resend_message_id` is the provider's own id; a row without one is a
// failure and is stored with its error rather than being dressed up as a send.
async function logSend({
  transactionId, userId, recipients, documentCount, resendMessageId, error,
  recipientRole, dryRun,
}) {
  const base = recipients.map((r) => ({
    transaction_id: transactionId,
    user_id: userId,
    sent_to_email: r.email,
    document_count: documentCount,
    resend_message_id: resendMessageId || null,
    error: error || null,
  }));

  // Preferred shape, with the columns added by
  // supabase/migrations/20260920_compliance_sends_recipient.sql.
  const enriched = base.map((row, i) => ({
    ...row,
    sent_to_name: recipients[i].name || null,
    recipient_role: recipientRole || recipients[i].role || null,
    dry_run: Boolean(dryRun),
  }));

  async function insert(rows) {
    const resp = await supabaseRest('compliance_sends', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(rows),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${resp.status}: ${text.slice(0, 200)}`);
    }
  }

  // Falling back to the original column set matters more than the extra
  // detail: an unlogged send is precisely the failure this logging exists to
  // prevent, so a deployment running ahead of its migration still records
  // that the mail went out.
  try {
    await insert(enriched);
  } catch (err) {
    console.warn('[send-compliance-packet] enriched log insert failed, retrying base columns:', err && err.message);
    try {
      await insert(base);
    } catch (err2) {
      console.error('[send-compliance-packet] LOG INSERT FAILED — send not recorded:', err2 && err2.message);
    }
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
    return res.status(500).json({ ok: false, error: 'Sending is not configured.' });
  }

  try {
    const ip = clientIpFromReq(req);
    await checkRateLimit(ip, 'send-compliance-packet', 30, 60 * 60 * 1000);

    const { userId, email: agentAuthEmail } = await verifySupabaseToken(req);

    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body || {};

    const transactionId = sanitizeString(body.transaction_id || body.transactionId || '', { maxLength: 200 });
    if (!transactionId) throw new ValidationError('transaction_id is required.');

    const mode = String(body.mode || 'preview').toLowerCase() === 'send' ? 'send' : 'preview';
    const dryRun = body.dry_run === true || body.dryRun === true;
    const note = sanitizeString(body.note || '', { maxLength: 800 });

    // Default preserves the original behaviour of this endpoint exactly:
    // no recipient named => brokerage compliance.
    const recipientRole = sanitizeString(body.recipient_role || body.recipientRole || 'compliance', { maxLength: 40 })
      .toLowerCase();
    if (!ROLE_DEFS[recipientRole]) {
      throw new ValidationError(
        `"${recipientRole}" isn't a party I recognise on a deal. ` +
        `Pick one of: ${Object.keys(ROLE_DEFS).join(', ')}.`,
      );
    }

    // ----- Profile -----
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
    if (!profile) throw new ValidationError('Agent profile not found.', 404);

    // ----- Transaction (owner-scoped: multi-tenant boundary) -----
    const safeTx = encodeURIComponent(transactionId);
    const txResp = await supabaseRest(
      `transactions?id=eq.${safeTx}&user_id=eq.${safeUid}&select=id,property_address,city_state_zip,role,transaction_type,closing_date,` +
      `buyer_name,buyer_email,buyer2_name,buyer2_email,buyer_notice_name,buyer_notice_email,` +
      `seller_name,seller_email,seller2_name,seller2_email,seller_notice_name,seller_notice_email,` +
      `listing_agent_name,listing_agent_email_addr,other_agent_name,other_agent_email_addr,` +
      `title_officer_name,title_officer_email,escrow_officer_name,loan_officer_name,loan_officer_email,lender_name,` +
      `sale_price,commission_rate,option_fee,stage,status&limit=1`,
      { method: 'GET' },
    );
    if (!txResp.ok) {
      const text = await txResp.text().catch(() => '');
      throw new Error(`transaction fetch failed (${txResp.status}): ${text.slice(0, 200)}`);
    }
    const txRows = await txResp.json();
    const tx = (Array.isArray(txRows) && txRows[0]) || null;
    if (!tx) return res.status(404).json({ ok: false, error: 'Dossier not found.' });

    // ----- Resolve recipients -----
    let recipients;
    const explicitEmail = sanitizeString(body.recipient_email || body.recipientEmail || '', { maxLength: 320 });
    if (explicitEmail) {
      if (!isEmail(explicitEmail) || !validateEmail(explicitEmail)) {
        throw new ValidationError(`"${explicitEmail}" doesn't look like an email address.`);
      }
      // Even a hand-typed address cannot reach the other side's client.
      const guard = assertNotOpposingPrincipal({ tx, email: explicitEmail });
      if (!guard.ok) return res.status(403).json({ ok: false, error: guard.error, blocked: guard.blocked });
      recipients = [{
        name: sanitizeString(body.recipient_name || '', { maxLength: 200 }) || null,
        email: explicitEmail,
        role: recipientRole,
        roleLabel: ROLE_DEFS[recipientRole].label,
      }];
    } else {
      const resolved = resolveRoleRecipients({ tx, profile, role: recipientRole });
      if (!resolved.ok) {
        return res.status(resolved.blocked ? 403 : 400).json({
          ok: false, error: resolved.error, blocked: resolved.blocked || null,
        });
      }
      recipients = resolved.recipients;
      // Belt and braces: re-check each resolved address against the
      // opposing-principal blocklist in case a record has a client's address
      // sitting in an agent field.
      for (const r of recipients) {
        const guard = assertNotOpposingPrincipal({ tx, email: r.email });
        if (!guard.ok) return res.status(403).json({ ok: false, error: guard.error, blocked: guard.blocked });
      }
    }

    // ----- Documents (owner-scoped) -----
    const docsResp = await supabaseRest(
      `documents?select=id,file_name,file_type,file_size,storage_path,document_type,status,form_template_id&user_id=eq.${safeUid}&transaction_id=eq.${safeTx}&order=created_at.asc`,
      { method: 'GET' },
    );
    if (!docsResp.ok) {
      const text = await docsResp.text().catch(() => '');
      throw new Error(`documents fetch failed (${docsResp.status}): ${text.slice(0, 200)}`);
    }
    const documents = await docsResp.json();

    // ----- Optional net sheet -----
    // Built here rather than passed in as finished HTML so the disclaimer and
    // the unknown-handling cannot be bypassed by a caller assembling its own.
    let netSheetEst = null;
    if (body.net_sheet) {
      const ns = body.net_sheet;
      const nowTs = new Date();
      try {
        // Figures the member supplied carry 'entered by you'; anything they
        // did not supply falls back to the contract where the contract
        // actually holds it, and otherwise stays unknown. Nothing is defaulted.
        const salePrice = normalizeMemberFigure(ns.sale_price, nowTs)
          || (tx.sale_price != null ? { value: tx.sale_price, source: 'contract' } : undefined);
        const commissionPct = normalizeMemberFigure(ns.commission_pct, nowTs)
          || (tx.commission_rate ? { value: tx.commission_rate, source: 'listing_agreement' } : undefined);
        const figures = normalizeMemberFigures(ns.figures, nowTs);
        if (figures.option_fee_credit === undefined && tx.option_fee != null && Number(tx.option_fee) > 0) {
          figures.option_fee_credit = { value: tx.option_fee, source: 'contract' };
        }
        netSheetEst = buildNetSheetEstimate({
          salePrice,
          commissionPct,
          figures,
          propertyAddress: tx.property_address || '',
          sellerName: tx.seller_name || '',
          now: nowTs,
        });
      } catch (err) {
        throw new ValidationError(err.message || 'Could not build the net sheet.');
      }
    }

    const hasDocs = Array.isArray(documents) && documents.length > 0;
    if (!hasDocs && !netSheetEst) {
      throw new ValidationError(
        'No documents attached to this dossier yet, and no net sheet requested. ' +
        'Upload at least one document or ask me for a net sheet first.',
      );
    }

    const totalReportedBytes = (documents || []).reduce((sum, d) => sum + (Number(d.file_size) || 0), 0);
    if (totalReportedBytes > MAX_PACKET_BYTES) {
      throw new ValidationError(
        `Packet is ${(totalReportedBytes / 1024 / 1024).toFixed(1)} MB — too large for one email (${MAX_PACKET_BYTES / 1024 / 1024} MB max). Split into multiple sends.`,
        413,
      );
    }

    const subject = sanitizeString(body.subject || '', { maxLength: 300 })
      || (recipientRole === 'compliance'
        ? `Closing packet — ${tx.property_address || 'Dossie deal'}`
        : `${tx.property_address || 'Your transaction'} — documents${netSheetEst ? ' and estimated net sheet' : ''}`);

    // ------------------------------------------------------------------
    // PREVIEW: resolve and describe, send nothing.
    // ------------------------------------------------------------------
    if (mode === 'preview') {
      const previewDocs = (documents || []).map((d) => ({
        id: d.id,
        file_name: d.file_name,
        file_size: Number(d.file_size) || null,
      }));
      const attachmentNames = previewDocs.map((d) => d.file_name);
      if (netSheetEst) attachmentNames.push('Sellers-Net-Sheet-ESTIMATE.html');

      const documentIds = previewDocs.map((d) => d.id);
      if (netSheetEst) documentIds.push('net-sheet');

      const cover = buildCover({
        tx, profile,
        documents: [
          ...previewDocs,
          ...(netSheetEst ? [{ file_name: 'Sellers-Net-Sheet-ESTIMATE.html' }] : []),
        ],
        recipients,
        audience: recipientRole === 'compliance' ? 'compliance' : 'party',
        note,
        netSheetEst,
      });

      const confirmationToken = issueConfirmationToken({
        userId, transactionId, recipients, subject, documentIds,
      });

      return res.status(200).json({
        ok: true,
        mode: 'preview',
        requires_confirmation: true,
        confirmation_token: confirmationToken,
        recipients: recipients.map((r) => ({
          name: r.name, email: r.email, role: r.role, role_label: r.roleLabel,
        })),
        subject,
        note: note || null,
        body_text: cover.text,
        body_html: cover.html,
        attachments: attachmentNames,
        document_count: previewDocs.length + (netSheetEst ? 1 : 0),
        documents: previewDocs,
        net_sheet: netSheetEst
          ? {
            headline: netSheetEst.headline,
            has_unknowns: netSheetEst.hasUnknowns,
            unknown: netSheetEst.unknown.map((u) => u.label),
            disclaimer: netSheetEst.disclaimer,
          }
          : null,
        property_address: tx.property_address || null,
      });
    }

    // ------------------------------------------------------------------
    // SEND: requires the token issued by a preview of this exact packet.
    // ------------------------------------------------------------------
    const previewDocIds = (documents || []).map((d) => d.id);
    if (netSheetEst) previewDocIds.push('net-sheet');

    const verdict = verifyConfirmationToken(body.confirmation_token || body.confirmationToken, {
      userId, transactionId, recipients, subject, documentIds: previewDocIds,
    });
    if (!verdict.ok) {
      const messages = {
        malformed: 'I need you to confirm this send before it goes out.',
        missing: 'I need you to confirm this send before it goes out.',
        bad_signature: 'I need you to confirm this send before it goes out.',
        unconfigured: 'Sending is not configured on this deployment.',
        expired: 'That confirmation timed out. Take another look and confirm again.',
        packet_changed:
          'The packet changed since you approved it — the recipient, subject or documents are different now. ' +
          'Review it once more and confirm.',
      };
      return res.status(verdict.reason === 'unconfigured' ? 500 : 409).json({
        ok: false,
        needs_confirmation: true,
        reason: verdict.reason,
        error: messages[verdict.reason] || messages.malformed,
      });
    }

    if (!RESEND_API_KEY && !dryRun) {
      console.error('[send-compliance-packet] RESEND_API_KEY missing.');
      return res.status(500).json({ ok: false, error: 'Email sending is not configured.' });
    }

    // Assemble attachments. Sequential to keep memory predictable under the
    // 25 MB cap. A document that can neither be resolved from a blank
    // template nor downloaded is skipped and named in the response — a
    // partial packet the member is told about beats a silent omission.
    const attachments = [];
    const attachedDocs = [];
    const skipped = [];
    let totalActualBytes = 0;

    for (const doc of (documents || [])) {
      let buf = null;
      try {
        const resolvedBlank = await resolveBlankTemplatePdf(doc);
        if (resolvedBlank) {
          buf = resolvedBlank.buffer;
        } else {
          buf = await downloadStorageObject(doc.storage_path);
        }
      } catch (err) {
        console.warn(`[send-compliance-packet] Skipping doc ${doc.id} (${doc.file_name}) — ${err && err.message}`);
        skipped.push(doc.file_name);
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

    if (netSheetEst) {
      const nsHtml = buildEstimateHtml(netSheetEst);
      attachments.push({
        filename: 'Sellers-Net-Sheet-ESTIMATE.html',
        content: Buffer.from(nsHtml, 'utf8').toString('base64'),
        content_type: 'text/html',
      });
      attachedDocs.push({ file_name: 'Sellers-Net-Sheet-ESTIMATE.html' });
    }

    if (attachedDocs.length === 0) {
      throw new ValidationError(
        'None of the attached documents could be assembled into a packet. Try again or contact support.',
        422,
      );
    }

    const cover = buildCover({
      tx, profile, documents: attachedDocs, recipients,
      audience: recipientRole === 'compliance' ? 'compliance' : 'party',
      note, netSheetEst,
    });

    const toEmails = recipients.map((r) => r.email);
    // BCC the MEMBER, not Heath. On a compliance submission the original
    // behaviour BCC'd heath@meetdossie.com; on a send to another member's
    // client that would put their client correspondence in Heath's inbox,
    // which is a multi-tenant leak. The member gets their own copy instead.
    const memberEmail = profile.email || agentAuthEmail || null;
    const bccEmails = memberEmail ? [memberEmail] : [];

    // --------------------------------------------------------------
    // DRY RUN: everything assembled, nothing sent. Used in development
    // and testing so a test run can never reach a real client.
    // --------------------------------------------------------------
    if (dryRun) {
      await logSend({
        transactionId, userId, recipients,
        documentCount: attachedDocs.length,
        resendMessageId: null,
        error: null,
        recipientRole,
        dryRun: true,
      });
      return res.status(200).json({
        ok: true,
        dry_run: true,
        sent: false,
        would_send_to: toEmails,
        bcc: bccEmails,
        subject,
        document_count: attachedDocs.length,
        attachments: attachments.map((a) => ({ filename: a.filename, bytes: Buffer.byteLength(a.content, 'base64') })),
        skipped,
        body_text: cover.text,
      });
    }

    let resendMessageId = null;
    let sendError = null;
    try {
      const resp = await sendPacketEmail({
        fromAgentName: profile.full_name || null,
        agentReplyToEmail: profile.email || agentAuthEmail || null,
        toEmails,
        bccEmails,
        subject,
        text: cover.text,
        html: cover.html,
        attachments,
        category: recipientRole === 'compliance' ? 'compliance_packet' : 'party_packet',
      });
      resendMessageId = (resp && resp.id) || null;
      // A 2xx with no id means we cannot prove anything was accepted. Treat
      // it as a failure rather than recording an unverifiable success.
      if (!resendMessageId) {
        sendError = 'Provider accepted the request but returned no message id.';
      }
    } catch (err) {
      sendError = (err && err.message) || String(err);
    }

    await logSend({
      transactionId, userId, recipients,
      documentCount: attachedDocs.length,
      resendMessageId,
      error: sendError,
      recipientRole,
      dryRun: false,
    });

    if (sendError || !resendMessageId) {
      // Never retried automatically: a send that reports failure may still
      // have gone out, and a retry is how a client gets the same packet
      // three times.
      return res.status(502).json({
        ok: false,
        sent: false,
        error: 'That send failed and I logged it. Check before trying again — it may still have gone out.',
      });
    }

    return res.status(200).json({
      ok: true,
      sent: true,
      sent_to: recipients.map((r) => ({ name: r.name, email: r.email, role_label: r.roleLabel })),
      sent_to_email: toEmails[0],
      document_count: attachedDocs.length,
      skipped,
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
      return res.status(429).json({ ok: false, error: 'Too many sends. Try again later.' });
    }
    console.error('[send-compliance-packet] error:', error && error.message ? error.message : error);
    return res.status(500).json({ ok: false, error: 'Could not send that packet.' });
  }
};
