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
  // Auth gate — when CRON_SECRET is configured, require it. If not configured
  // we fail closed to avoid an open trigger.
  if (!CRON_SECRET) {
    console.error('[cron-followup] CRON_SECRET not configured — refusing to run.');
    return res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
  }
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase not configured' });
  }

  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const summary = { checked: 0, markedOverdue: 0, followUpsSent: 0, escalated: 0 };

  // Fetch all pending or overdue action items with a due date that has passed.
  const { data: items } = await supabaseFetch(
    `/rest/v1/action_items?status=in.(pending,overdue)&due_date=lte.${today}&order=due_date.asc`,
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
          const greeting = item.assigned_to_name
            ? `Hi ${escapeHtml(item.assigned_to_name)}`
            : 'Hi there';
          const subject = `Following up — ${item.email_subject || item.description}`;
          const html = `
            <div style="font-family: Georgia, serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color: #1C2B3A; line-height: 1.7;">
              <p>${greeting},</p>
              <p>I'm following up on my previous message regarding <strong>${escapeHtml(item.description)}</strong>. Could you please advise when you have a moment?</p>
              <p>Thank you,<br>Dossie</p>
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

  const alerts = [];
  if (Array.isArray(transactions)) {
    for (const tx of transactions) {
      const checkDate = (dateStr, label, daysWarning) => {
        if (!dateStr) return;
        const deadline = new Date(String(dateStr) + 'T00:00:00Z');
        const daysUntil = (deadline - now) / (1000 * 60 * 60 * 24);
        if (daysUntil <= daysWarning && daysUntil >= 0) {
          alerts.push({
            transactionId: tx.id,
            userId: tx.user_id,
            label,
            daysUntil: Math.ceil(daysUntil),
            propertyAddress: tx.property_address,
          });
        }
      };
      checkDate(tx.option_expiration_date, 'Option period expires', 3);
      checkDate(tx.loan_approval_deadline, 'Financing deadline', 5);
      checkDate(tx.closing_date, 'Closing date', 7);
    }
  }

  return res.status(200).json({ ok: true, summary, alerts });
};
