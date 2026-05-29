// Vercel Serverless Function: /api/cron-deadline-reminders
//
// Daily customer transaction deadline reminder cron. For every paying customer
// (non-demo, non-heath, non-cancelled) we walk their open transactions and
// look for TREC deadlines hitting at T-7d, T-1d, or T-0. If we haven't sent
// that exact reminder yet (tracked via deadline_reminders table), we fire a
// branded Resend email to the agent and log the row.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "5 13 * * *" (5 min after the digest cron at 13:00 UTC).
//
// Decision (2026-05-20): tracking via a new deadline_reminders table (NOT a
// column on transactions). Reasons:
//   - Multiple deadline fields per transaction (option / financing / closing /
//     appraisal / survey / HOA / loan-approval / possession) — a single
//     last_reminder_at column can't disambiguate which one fired.
//   - Unique constraint on (transaction_id, deadline_type, days_out) makes
//     idempotency a database guarantee, not application logic.
//   - Avoids mutating the transactions row on every reminder fire (cleaner
//     audit trail, no spurious updated_at churn that confuses the React app).
//
// Deadline fields tracked (every column in public.transactions that ends in
// _date or _deadline and represents a TREC-style milestone):
//   - option_expiration_date  → "Option period expires"
//   - closing_date            → "Closing"
//   - appraisal_deadline      → "Appraisal deadline"
//   - survey_deadline         → "Survey deadline"
//   - hoa_document_deadline   → "HOA document deadline"
//   - loan_approval_deadline  → "Loan approval deadline"
//   - possession_date         → "Possession"
//
// Customer filter mirrors cron-morning-brief.js:
//   - profiles.is_demo = true            → skip
//   - email LIKE 'heath.shepard@%'       → skip
//   - email contains 'demo'              → skip (defense-in-depth)
//   - subscriptions.status != 'active'   → skip

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';

// Brand tokens (kept in sync with welcomeEmailHtml in complete-onboarding.js).
const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';

// Map of transaction column -> friendly deadline label.
const DEADLINE_FIELDS = [
  { col: 'option_expiration_date', label: 'Option period expiration' },
  { col: 'closing_date',           label: 'Closing date' },
  { col: 'appraisal_deadline',     label: 'Appraisal deadline' },
  { col: 'survey_deadline',        label: 'Survey deadline' },
  { col: 'hoa_document_deadline',  label: 'HOA document deadline' },
  { col: 'loan_approval_deadline', label: 'Loan approval deadline' },
  { col: 'possession_date',        label: 'Possession date' },
];

const REMINDER_MILESTONES = [7, 1, 0]; // days_out values we fire on

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
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath.shepard@')) return true;
  if (e.includes('demo')) return true;
  return false;
}

// Same Chicago-date-anchored arithmetic as cron-morning-brief.js. Reminders
// are date-based, not time-based — "7 days from today" means any deadline
// whose YYYY-MM-DD == today's Chicago date + 7.
function todayChicagoYMD() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date()); // 'YYYY-MM-DD'
}

function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function friendlyDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[dt.getUTCDay()]}, ${months[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function toneFor(daysOut) {
  if (daysOut === 0) return { eyebrow: 'TODAY', headline: 'A deadline hits today.' };
  if (daysOut === 1) return { eyebrow: 'TOMORROW', headline: 'A deadline hits tomorrow.' };
  return { eyebrow: 'HEADS UP', headline: 'A deadline is one week away.' };
}

function buildEmailHtml({ firstName, propertyAddress, deadlineLabel, deadlineDateYMD, daysOut }) {
  const tone = toneFor(daysOut);
  const name = (firstName || '').trim() || 'there';
  const niceDate = friendlyDate(deadlineDateYMD);
  const daysCopy = daysOut === 0
    ? 'today'
    : daysOut === 1 ? 'tomorrow' : `in ${daysOut} days`;
  const property = propertyAddress || 'your active dossier';

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">
  <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; ${tone.eyebrow}</div>
  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 32px; line-height: 1.2; margin: 0 0 22px; color: ${BRAND_NAVY};">Hi ${name},</h1>
  <p style="font-size: 17px; color: ${BRAND_NAVY}; line-height: 1.6; margin: 0 0 18px;">The <strong>${deadlineLabel}</strong> for <strong>${property}</strong> is ${daysCopy} (${niceDate}).</p>
  <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.7; margin: 0 0 28px;">Open the dossier to review what is left to do, send the queued drafts, or update the deadline if anything has changed.</p>
  <div style="margin: 28px 0;">
    <a href="https://meetdossie.com/app" style="display: inline-block; padding: 16px 32px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Open dossier</a>
  </div>
  <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 18px 0 4px;">- Dossie</p>
  <p style="margin-top: 36px; font-size: 12px; color: ${BRAND_MUTED}; line-height: 1.6;">You get these because you have an active dossier with this deadline. Update or close the dossier in Dossie to stop receiving reminders for it.</p>
</div>`;
}

async function sendResend(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

// Fetch the active customer roster keyed by user_id. Same exclusions as
// cron-morning-brief.js so we never reach Heath, demo accounts, or cancelled
// subs.
async function loadActiveCustomers() {
  const subResp = await supabaseFetch('/rest/v1/subscriptions?status=eq.active&select=user_id,plan,status');
  if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
  const subs = subResp.data || [];
  if (subs.length === 0) return [];

  const userIds = subs.map((s) => s.user_id).filter(Boolean);
  if (userIds.length === 0) return [];

  const filter = userIds.map((id) => `"${id}"`).join(',');
  const profResp = await supabaseFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,full_name,is_demo`,
  );
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);
  const profilesById = new Map((profResp.data || []).map((p) => [p.id, p]));

  const out = [];
  for (const s of subs) {
    const p = profilesById.get(s.user_id);
    if (!p) continue;
    if (p.is_demo) continue;
    if (isExcludedEmail(p.email)) continue;
    out.push({
      user_id: s.user_id,
      email: p.email,
      first_name: (p.full_name || p.email || '').split(/[\s.@]/)[0] || 'there',
    });
  }
  return out;
}

// All non-closed transactions for a single user.
// Also fetches the new Block 3/4/5 tracking columns used for conditional reminders.
async function loadOpenTransactions(userId) {
  const baseFields = ['id', 'user_id', 'property_address', 'status', ...DEADLINE_FIELDS.map((f) => f.col)];
  const conditionalFields = [
    'earnest_money_confirmed_at',
    'inspection_completed_at',
    'appraisal_received_at',
  ];
  const fields = [...baseFields, ...conditionalFields].join(',');
  const r = await supabaseFetch(
    `/rest/v1/transactions?user_id=eq.${encodeURIComponent(userId)}&or=(status.is.null,status.neq.closed)&select=${fields}`,
  );
  if (!r.ok) return [];
  return r.data || [];
}

// Already-fired reminders for one transaction (so we can skip them in this run).
async function loadFiredReminders(transactionId) {
  const r = await supabaseFetch(
    `/rest/v1/deadline_reminders?transaction_id=eq.${encodeURIComponent(transactionId)}&select=deadline_type,days_out`,
  );
  if (!r.ok) return new Set();
  const set = new Set();
  for (const row of (r.data || [])) {
    set.add(`${row.deadline_type}|${row.days_out}`);
  }
  return set;
}

async function recordReminder(row) {
  const r = await supabaseFetch('/rest/v1/deadline_reminders', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify(row),
  });
  // 409 means the unique constraint blocked the insert (already sent) — that's
  // fine, treat as success.
  if (!r.ok && r.status !== 409) {
    console.error('[deadline-reminders] insert failed', r.status, r.data);
    return false;
  }
  return true;
}

module.exports = async function handler(req, res) {
  try {
    const isVercelCron = req.headers['x-vercel-cron'] === '1';
    const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
    const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
    if (!isVercelCron && !isManualAuth) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ ok: false, error: 'Supabase env vars not configured' });
    }
    if (!RESEND_API_KEY) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'RESEND_API_KEY not set' });
    }

    const today = todayChicagoYMD();
    const targets = REMINDER_MILESTONES.map((d) => ({ daysOut: d, date: addDaysYMD(today, d) }));

    const customers = await loadActiveCustomers();
    const summary = {
      ok: true,
      today,
      targets,
      customers_scanned: customers.length,
      transactions_scanned: 0,
      reminders_sent: 0,
      reminders_skipped_already_sent: 0,
      errors: [],
    };

    for (const cust of customers) {
      const transactions = await loadOpenTransactions(cust.user_id);
      summary.transactions_scanned += transactions.length;

      for (const tx of transactions) {
        const fired = await loadFiredReminders(tx.id);

        for (const field of DEADLINE_FIELDS) {
          const ymd = tx[field.col];
          if (!ymd) continue;

          // Find which (if any) milestone this deadline matches today.
          const match = targets.find((t) => t.date === String(ymd).slice(0, 10));
          if (!match) continue;

          const key = `${field.col}|${match.daysOut}`;
          if (fired.has(key)) {
            summary.reminders_skipped_already_sent++;
            continue;
          }

          const subject = match.daysOut === 0
            ? `Today: ${field.label} for ${tx.property_address || 'your dossier'}`
            : match.daysOut === 1
              ? `Tomorrow: ${field.label} for ${tx.property_address || 'your dossier'}`
              : `Heads up: ${field.label} in 7 days for ${tx.property_address || 'your dossier'}`;

          const html = buildEmailHtml({
            firstName: cust.first_name,
            propertyAddress: tx.property_address,
            deadlineLabel: field.label,
            deadlineDateYMD: String(ymd).slice(0, 10),
            daysOut: match.daysOut,
          });

          const send = await sendResend(cust.email, subject, html);
          if (!send.ok) {
            console.error('[deadline-reminders] resend failed', cust.email, send.status, (send.raw || '').slice(0, 200));
            summary.errors.push({ user_id: cust.user_id, tx_id: tx.id, field: field.col, status: send.status, error: (send.raw || '').slice(0, 200) });
            continue;
          }

          await recordReminder({
            transaction_id: tx.id,
            user_id: cust.user_id,
            deadline_type: field.col,
            deadline_date: String(ymd).slice(0, 10),
            days_out: match.daysOut,
            email_to: cust.email,
          });

          summary.reminders_sent++;
        }

        // -----------------------------------------------------------------------
        // BLOCK 3 conditional: option_expiration_date within T-2 and earnest
        // money not yet confirmed. Uses synthetic deadline_type key so it never
        // collides with the standard option_expiration_date reminders.
        // -----------------------------------------------------------------------
        if (tx.option_expiration_date && !tx.earnest_money_confirmed_at) {
          const optYmd = String(tx.option_expiration_date).slice(0, 10);
          const t2Date = addDaysYMD(today, 2);
          const t1Date = addDaysYMD(today, 1);
          const matchDaysOut = optYmd === t2Date ? 2 : optYmd === t1Date ? 1 : null;
          if (matchDaysOut !== null) {
            const condKey = `earnest_money_not_confirmed|${matchDaysOut}`;
            if (!fired.has(condKey)) {
              const condSubject = `Action needed: earnest money not confirmed for ${tx.property_address || 'your dossier'}`;
              const condHtml = buildEmailHtml({
                firstName: cust.first_name,
                propertyAddress: tx.property_address,
                deadlineLabel: 'Option period expires — earnest money not yet confirmed',
                deadlineDateYMD: optYmd,
                daysOut: matchDaysOut,
              });
              const condSend = await sendResend(cust.email, condSubject, condHtml);
              if (condSend.ok) {
                await recordReminder({
                  transaction_id: tx.id,
                  user_id: cust.user_id,
                  deadline_type: 'earnest_money_not_confirmed',
                  deadline_date: optYmd,
                  days_out: matchDaysOut,
                  email_to: cust.email,
                });
                summary.reminders_sent++;
              } else {
                summary.errors.push({ user_id: cust.user_id, tx_id: tx.id, field: 'earnest_money_not_confirmed', status: condSend.status });
              }
            } else {
              summary.reminders_skipped_already_sent++;
            }
          }
        }

        // -----------------------------------------------------------------------
        // BLOCK 4 conditional: option_expiration_date within T-3 and inspection
        // not yet completed.
        // -----------------------------------------------------------------------
        if (tx.option_expiration_date && !tx.inspection_completed_at) {
          const optYmd = String(tx.option_expiration_date).slice(0, 10);
          const t3Date = addDaysYMD(today, 3);
          if (optYmd === t3Date) {
            const condKey = `inspection_not_completed|3`;
            if (!fired.has(condKey)) {
              const condSubject = `Heads up: inspection not yet complete — option expires in 3 days for ${tx.property_address || 'your dossier'}`;
              const condHtml = buildEmailHtml({
                firstName: cust.first_name,
                propertyAddress: tx.property_address,
                deadlineLabel: 'Option period expires — inspection not yet completed',
                deadlineDateYMD: optYmd,
                daysOut: 3,
              });
              const condSend = await sendResend(cust.email, condSubject, condHtml);
              if (condSend.ok) {
                await recordReminder({
                  transaction_id: tx.id,
                  user_id: cust.user_id,
                  deadline_type: 'inspection_not_completed',
                  deadline_date: optYmd,
                  days_out: 3,
                  email_to: cust.email,
                });
                summary.reminders_sent++;
              } else {
                summary.errors.push({ user_id: cust.user_id, tx_id: tx.id, field: 'inspection_not_completed', status: condSend.status });
              }
            } else {
              summary.reminders_skipped_already_sent++;
            }
          }
        }

        // -----------------------------------------------------------------------
        // BLOCK 5 conditional: appraisal_deadline within T-2 and appraisal not
        // yet received.
        // -----------------------------------------------------------------------
        if (tx.appraisal_deadline && !tx.appraisal_received_at) {
          const apprYmd = String(tx.appraisal_deadline).slice(0, 10);
          const t2Date = addDaysYMD(today, 2);
          if (apprYmd === t2Date) {
            const condKey = `appraisal_not_received|2`;
            if (!fired.has(condKey)) {
              const condSubject = `Action needed: no appraisal received — deadline in 2 days for ${tx.property_address || 'your dossier'}`;
              const condHtml = buildEmailHtml({
                firstName: cust.first_name,
                propertyAddress: tx.property_address,
                deadlineLabel: 'Appraisal deadline approaching — no appraisal received yet',
                deadlineDateYMD: apprYmd,
                daysOut: 2,
              });
              const condSend = await sendResend(cust.email, condSubject, condHtml);
              if (condSend.ok) {
                await recordReminder({
                  transaction_id: tx.id,
                  user_id: cust.user_id,
                  deadline_type: 'appraisal_not_received',
                  deadline_date: apprYmd,
                  days_out: 2,
                  email_to: cust.email,
                });
                summary.reminders_sent++;
              } else {
                summary.errors.push({ user_id: cust.user_id, tx_id: tx.id, field: 'appraisal_not_received', status: condSend.status });
              }
            } else {
              summary.reminders_skipped_already_sent++;
            }
          }
        }
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[deadline-reminders] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
};
