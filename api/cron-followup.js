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
      body: JSON.stringify({ from, to: [to], subject, html }),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err && err.message };
  }
}

const escapeHtml = (s) =>
  String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

module.exports = async function handler(req, res) {
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
  const summary = { checked: 0, markedOverdue: 0, followUpsSent: 0, escalated: 0 };

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

      // Auto-follow-up at 48h+, with 24h throttle and a 3-attempt cap.
      if (daysOverdue >= 2 && item.assigned_to_email && (item.follow_up_count || 0) < 3) {
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

          const greeting = item.assigned_to_name
            ? `Hi ${escapeHtml(item.assigned_to_name)}`
            : 'Hi there';
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
          const sent = await sendResendEmail({
            from: 'Dossie <dossie@meetdossie.com>',
            to: item.assigned_to_email,
            subject,
            html,
          });
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
};
