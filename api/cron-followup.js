// Vercel Serverless Function: /api/cron-followup
// Daily cron handler.
//   - Marks pending action_items as overdue when due_date has passed.
//   - After 48h overdue (with throttling), sends a follow-up email via Resend.
//   - After 72h overdue, escalates the item to status='escalated'.
//   - Computes near-deadline alerts on transactions (option, financing, closing).
//
// Auth: Authorization: Bearer ${CRON_SECRET} — Vercel cron sets this when
// CRON_SECRET is configured. Returns 401 if missing/wrong.
//
// Schedule: vercel.json — 0 12 * * * (noon UTC = 7am Central).

const { withTelemetry } = require('./_lib/cron-telemetry.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

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
  return { ok: res.ok, status: res.status, data };
}

async function sendResendEmail({ from, to, subject, html }) {
  if (!RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not configured' };
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Document-linked follow-ups: action items that are really just "go deliver
// this document" nudges. Before nagging (or escalating) one of these, check
// whether the document is actually still missing — both the transaction's
// own delivery flag AND the documents table directly, since the flag alone
// can drift out of sync with what's really in the dossier (confirmed root
// cause of the 2026-08-10 104 Wild Cherry false positive: iabs_delivered_at
// was set correctly, but this cron never looked at it or at documents before
// sending "please send this over" for a form that was already on file).
//
// Generalized 2026-08-11 beyond IABS to every document type that has a
// matching transaction-level delivery/received flag (see the field enum in
// api/chat.js) — the same false-positive class applies to any of these, not
// just IABS. transactionFlag/documentType names are verified against the
// live schema; a doc type is deliberately left OFF this list rather than
// guessing a flag name that doesn't exist.
const DOCUMENT_FOLLOWUPS = [
  {
    match: /\biabs\b|information about brokerage services/i,
    transactionFlag: 'iabs_delivered_at',
    documentType: 'iabs-form',
    label: 'IABS',
  },
  {
    match: /seller'?s?\s+disclosure|\bsdn\b/i,
    transactionFlag: 'sellers_disclosure_received_at',
    documentType: 'trec-sellers-disclosure',
    label: "Seller's Disclosure Notice",
  },
  {
    match: /buyer representation/i,
    transactionFlag: 'buyer_rep_signed_at',
    documentType: 'trec-buyer-representation',
    label: 'Buyer Representation Agreement',
  },
  {
    match: /title commitment/i,
    transactionFlag: 'title_commitment_received_at',
    documentType: 'title-commitment',
    label: 'Title Commitment',
  },
  {
    match: /\bsurvey\b/i,
    transactionFlag: 'survey_received_at',
    documentType: 'survey',
    label: 'Survey',
  },
  {
    match: /pre-?approval/i,
    transactionFlag: 'pre_approval_received',
    documentType: 'pre-approval-letter',
    label: 'Pre-Approval Letter',
  },
  {
    match: /\bhoa\b.*(docs|documents|addendum)/i,
    transactionFlag: 'hoa_docs_received_at',
    documentType: 'trec-hoa-addendum',
    label: 'HOA Documents',
  },
];

function findDocumentFollowup(item) {
  const haystack = `${item.email_subject || ''} ${item.description || ''}`;
  return DOCUMENT_FOLLOWUPS.find((cfg) => cfg.match.test(haystack)) || null;
}

// Returns { resolved, document } — resolved is true if the transaction's own
// delivery flag is set OR a matching document already exists in the dossier.
async function checkDocumentFollowupResolved(transactionId, cfg) {
  if (!transactionId) return { resolved: false, document: null };

  const [{ data: txRows }, { data: docRows }] = await Promise.all([
    supabaseFetch(
      `/rest/v1/transactions?id=eq.${encodeURIComponent(transactionId)}&select=${encodeURIComponent(cfg.transactionFlag)}&limit=1`,
    ),
    supabaseFetch(
      `/rest/v1/documents?transaction_id=eq.${encodeURIComponent(transactionId)}&document_type=eq.${encodeURIComponent(cfg.documentType)}&order=created_at.desc&limit=1`,
    ),
  ]);

  const flagSet = Array.isArray(txRows) && txRows[0] && Boolean(txRows[0][cfg.transactionFlag]);
  const document = Array.isArray(docRows) && docRows[0] ? docRows[0] : null;

  return { resolved: Boolean(flagSet) || Boolean(document), document };
}

// Document-linked reminders never auto-send to the client. item.assigned_to_email
// on these items is the CLIENT the original email went to (sendEmail() in the
// app writes it that way) — auto re-sending them a nag every 48h with no human
// review is exactly what Heath asked us to stop doing. Instead we look up the
// AGENT who owns the dossier (profiles.id = item.user_id) and put a
// ready-to-review draft in front of THEM; they decide if/when/how to actually
// reach the client. Same human-in-the-loop shape as the content-pipeline
// Telegram approval.
async function getAgentContact(userId) {
  if (!userId) return null;
  const { data } = await supabaseFetch(
    `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=email,full_name&limit=1`,
  );
  return Array.isArray(data) && data[0] ? data[0] : null;
}

module.exports = withTelemetry('cron-followup', async function handler(req, res) {
  // Auth: accept EITHER Vercel's built-in cron header OR manual Bearer token
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;

  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const summary = { checked: 0, markedOverdue: 0, followUpsSent: 0, escalated: 0, autoResolved: 0 };

  // Resolve demo user_ids so we can exclude their action items.
  const { data: demoProfiles } = await supabaseFetch(
    `/rest/v1/profiles?is_demo=eq.true&select=id`,
  );
  const demoUserIds = Array.isArray(demoProfiles) && demoProfiles.length > 0
    ? demoProfiles.map((p) => p.id)
    : [];
  const demoExclusion = demoUserIds.length > 0
    ? `&user_id=not.in.(${demoUserIds.join(',')})`
    : '';

  // Fetch all pending or overdue action items with a due date that has passed,
  // excluding demo accounts.
  const { data: items } = await supabaseFetch(
    `/rest/v1/action_items?status=in.(pending,overdue)&due_date=lte.${today}&order=due_date.asc${demoExclusion}`,
  );

  if (Array.isArray(items) && items.length > 0) {
    summary.checked = items.length;

    for (const item of items) {
      if (!item.due_date) continue;
      const dueDate = new Date(item.due_date + 'T00:00:00Z');
      const hoursOverdue = (now - dueDate) / (1000 * 60 * 60);
      const daysOverdue = hoursOverdue / 24;

      // Mark overdue once.
      if (hoursOverdue > 0 && item.status === 'pending') {
        const { ok } = await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'overdue', updated_at: now.toISOString() }),
        });
        if (ok) summary.markedOverdue++;
      }

      // Document-linked follow-up: check reality before nagging or escalating.
      // If the document this item is chasing is already on file (or the
      // transaction's own delivery flag is set), the item is done — resolve
      // it and skip straight to the next item. This is what stops the false
      // positive: without it, a stale action_item keeps firing "please send
      // this over" purely off its own due_date, with zero awareness that the
      // thing it's chasing already showed up in Documents days ago.
      const docFollowup = findDocumentFollowup(item);
      let docCheck = null;
      if (docFollowup) {
        docCheck = await checkDocumentFollowupResolved(item.transaction_id, docFollowup);
        if (docCheck.resolved) {
          if (item.status !== 'completed') {
            const { ok } = await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({ status: 'completed', updated_at: now.toISOString() }),
            });
            if (ok) summary.autoResolved++;
          }
          continue;
        }
      }

      // Auto-follow-up at 48h+, with 24h throttle and a 3-attempt cap.
      // Document-linked items (docFollowup set + still unresolved) NEVER
      // auto-send to the client — see getAgentContact() above for why. They
      // route to the agent-review branch instead, which requires only
      // item.user_id (not item.assigned_to_email).
      const hasFollowUpTarget = docFollowup ? Boolean(item.user_id) : Boolean(item.assigned_to_email);
      if (daysOverdue >= 2 && hasFollowUpTarget && (item.follow_up_count || 0) < 3) {
        const lastFollowUp = item.last_follow_up_at ? new Date(item.last_follow_up_at) : null;
        const hoursSinceFollowUp = lastFollowUp ? (now - lastFollowUp) / (1000 * 60 * 60) : Infinity;

        if (hoursSinceFollowUp >= 24) {
          // Look up the deal this action item belongs to so the follow-up
          // email can reference it specifically. Without this the recipient
          // sees only "your previous message regarding [description]" with no
          // indication of which deal — confusing when an agent has multiple
          // active transactions involving the same counterparty.
          let propertyAddress = null;
          if (item.transaction_id) {
            const { data: txRows } = await supabaseFetch(
              `/rest/v1/transactions?id=eq.${encodeURIComponent(item.transaction_id)}&select=property_address&limit=1`,
            );
            if (Array.isArray(txRows) && txRows[0]) {
              propertyAddress = txRows[0].property_address || null;
            }
          }

          let sent;
          if (docFollowup) {
            // Agent-review path: a still-missing document never gets an
            // automatic client-facing send. Instead the AGENT gets a
            // ready-to-review draft — the exact text that would have gone
            // to the client, plus a suggested e-signature request as the
            // natural next action — and decides if/when to actually send.
            const agent = await getAgentContact(item.user_id);
            if (agent && agent.email) {
              const agentFirstName = agent.full_name ? agent.full_name.trim().split(/\s+/)[0] : null;
              const dealTag = propertyAddress ? ` — ${propertyAddress}` : '';
              const subject = `Review before sending: ${docFollowup.label} still missing${dealTag}`;
              const draftBodyHtml = item.email_body && item.email_body.trim()
                ? item.email_body.trim().split(/\n\n+/)
                    .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p.replace(/\n/g, ' '))}</p>`)
                    .join('')
                : `<p style="margin:0 0 16px;">No draft text was saved with this reminder — open the dossier to write one.</p>`;
              const html = `
                <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">
                  <p>Hi${agentFirstName ? ` ${escapeHtml(agentFirstName)}` : ''},</p>
                  <p style="margin:0 0 16px;">The <strong>${escapeHtml(docFollowup.label)}</strong> still isn't on file${propertyAddress ? ` for <strong>${escapeHtml(propertyAddress)}</strong>` : ''}. I checked both the dossier's documents and the delivery flag — neither shows it received, so I'm not sending anything to ${escapeHtml(item.assigned_to_name || item.assigned_to_email || 'the client')} automatically. Here's the draft I'd have sent, ready for you to review:</p>
                  <div style="margin:0 0 16px;padding:16px 18px;background:#F8F4EC;border:1px solid #EAE1D8;border-radius:8px;">
                    ${draftBodyHtml}
                  </div>
                  <p style="margin:0 0 16px;">
                    <a href="https://meetdossie.com/workspace" style="display:inline-block;background:#1A1A2E;color:#F5E6E0;padding:12px 20px;border-radius:6px;text-decoration:none;font-size:14px;">Open the workspace</a>
                  </p>
                  <p style="margin:0 0 16px;font-size:13px;color:#7A7468;">Find ${escapeHtml(propertyAddress || 'the deal')} in the sidebar. You can send this draft as-is from Emails, or request it by e-signature instead using <strong>Send for sig.</strong> on the ${escapeHtml(docFollowup.label)} form under Documents — often the faster way to actually collect it.</p>
                  <p style="margin:0 0 16px;">- Dossie</p>
                </div>
              `;
              sent = await sendResendEmail({
                from: 'Dossie <dossie@meetdossie.com>',
                to: agent.email,
                subject,
                html,
              });
            } else {
              sent = { ok: false, error: 'agent_contact_not_found' };
            }
          } else {
            // Existing client-facing path — unrelated to document collection
            // (e.g. "checking in" follow-ups on a plain action item).
            const firstName = item.assigned_to_name
              ? item.assigned_to_name.trim().split(/\s+/)[0]
              : (item.assigned_to_email ? item.assigned_to_email.split('@')[0] : null);
            const greeting = firstName ? `Hi ${escapeHtml(firstName)}` : 'Hi';
            const dealTag = propertyAddress ? ` — ${propertyAddress}` : '';
            const subject = item.email_subject
              ? `Re: ${item.email_subject}`
              : `Following up${dealTag}`;

            // Use the stored email body when available. It contains the full
            // drafted email text Dossie wrote when the action item was created.
            // Only fall back to a generic message if email_body is missing.
            let bodyHtml;
            if (item.email_body && item.email_body.trim()) {
              const bodyText = item.email_body.trim();
              const paragraphs = bodyText
                .split(/\n\n+/)
                .map((p) => `<p style="margin:0 0 16px;">${escapeHtml(p.replace(/\n/g, ' '))}</p>`)
                .join('');
              bodyHtml = paragraphs;
            } else {
              const dealRef = propertyAddress
                ? ` regarding <strong>${escapeHtml(propertyAddress)}</strong>`
                : '';
              bodyHtml = `<p style="margin:0 0 16px;">I wanted to check in${dealRef}. Is there anything you need from me to keep things moving? Just let me know and I'll get right on it.</p>`;
            }

            const dealLine = propertyAddress
              ? `<p style="font-size:14px;color:#7A7468;margin:0 0 18px;">Re: <strong>${escapeHtml(propertyAddress)}</strong></p>`
              : '';

            const html = `
              <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">
                <p>${greeting},</p>
                ${dealLine}
                ${bodyHtml}
                <p style="margin:0 0 16px;">- Dossie</p>
                <div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid #E8E0D8; font-size: 12px; color: #9CA8B4; line-height: 1.6;">
                  If you don't see future emails from Dossie, please check your spam folder and mark dossie@meetdossie.com as a safe sender.
                </div>
              </div>
            `;
            sent = await sendResendEmail({
              from: 'Dossie <dossie@meetdossie.com>',
              to: item.assigned_to_email,
              subject,
              html,
            });
          }

          if (sent.ok) {
            await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}`, {
              method: 'PATCH',
              headers: { Prefer: 'return=minimal' },
              body: JSON.stringify({
                follow_up_count: (item.follow_up_count || 0) + 1,
                last_follow_up_at: now.toISOString(),
                updated_at: now.toISOString(),
              }),
            });
            summary.followUpsSent++;
          }
        }
      }

      // Escalate at 72h+.
      if (daysOverdue >= 3 && item.status !== 'escalated') {
        const { ok } = await supabaseFetch(`/rest/v1/action_items?id=eq.${encodeURIComponent(item.id)}`, {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ status: 'escalated', updated_at: now.toISOString() }),
        });
        if (ok) summary.escalated++;
      }
    }
  }

  // Near-deadline alerts on active transactions.
  const { data: transactions } = await supabaseFetch(
    `/rest/v1/transactions?status=neq.closed&select=id,property_address,option_expiration_date,loan_approval_deadline,closing_date,user_id`,
  );

  // Phrasing matches the in-app deadline language (formatDeadlinePhrase in src/utils/deadlines.js).
  // Keep these strings synchronized so cron alerts read the same as the UI.
  const phraseFor = (subject, style, daysUntil) => {
    const days = Math.ceil(daysUntil);
    const plural = (n) => (Math.abs(n) === 1 ? 'day' : 'days');
    if (days <= 0) {
      if (style === 'expires') return `${subject} expires today`;
      if (style === 'happens') return `${subject} today`;
      return `${subject} due today`;
    }
    if (days === 1) {
      if (style === 'expires') return `${subject} expires tomorrow`;
      if (style === 'happens') return `${subject} tomorrow`;
      return `${subject} due tomorrow`;
    }
    if (style === 'expires') return `${subject} expires in ${days} ${plural(days)}`;
    if (style === 'happens') return `${subject} in ${days} ${plural(days)}`;
    return `${subject} due in ${days} ${plural(days)}`;
  };
  const alerts = [];
  if (Array.isArray(transactions)) {
    for (const tx of transactions) {
      const checkDate = (dateStr, subject, style, daysWarning) => {
        if (!dateStr) return;
        const deadline = new Date(String(dateStr) + 'T00:00:00Z');
        const daysUntil = (deadline - now) / (1000 * 60 * 60 * 24);
        if (daysUntil <= daysWarning && daysUntil >= 0) {
          alerts.push({
            transactionId: tx.id,
            userId: tx.user_id,
            label: phraseFor(subject, style, daysUntil),
            daysUntil: Math.ceil(daysUntil),
            propertyAddress: tx.property_address,
          });
        }
      };
      checkDate(tx.option_expiration_date, 'Option period', 'expires', 3);
      checkDate(tx.loan_approval_deadline, 'Financing', 'due', 5);
      checkDate(tx.closing_date, 'Closing', 'happens', 7);
    }
  }

  return res.status(200).json({ ok: true, summary, alerts });
});
