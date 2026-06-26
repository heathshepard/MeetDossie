// Vercel Serverless Function: /api/cron-customer-morning-brief
//
// Daily 7 AM CDT (12:00 UTC) customer-facing morning brief.
// For every active paying customer with morning_brief_email_enabled=true,
// sends a personalized branded email with:
//   - A short personalized TTS audio snippet (OpenAI nova voice)
//   - Open transactions closing this week
//   - Deadlines hitting today
//   - Outstanding action items count
//   - Single CTA to open Dossie
//
// Audio is uploaded to Supabase Storage bucket "morning-briefs" and linked in email.
//
// Auth:     Authorization: Bearer ${CRON_SECRET}  OR  x-vercel-cron: 1
// Schedule: vercel.json — "0 12 * * *" (12:00 UTC = 7:00 AM CDT during DST)
//
// Idempotent: unique index on (user_id, sent_date) prevents duplicate sends
// within the same calendar day. Safe to retry.
//
// Test mode: ?test=1 sends only to heath@meetdossie.com, skips log insert.

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { customerFirstName } = require('./_lib/personalization.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CRON_SECRET = process.env.CRON_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const FROM_ADDRESS = 'Dossie <dossie@meetdossie.com>';
const APP_URL = 'https://meetdossie.com/app';
const UNSUBSCRIBE_BASE = 'https://meetdossie.com/api/morning-brief-unsubscribe';

// Brand tokens — kept in sync with cron-email-digest.js
const BRAND_BG = '#FDFCFA';
const BRAND_NAVY = '#1C2B3A';
const BRAND_TEXT_SOFT = '#5C6B7A';
const BRAND_CORAL = '#E8927C';
const BRAND_MUTED = '#9CA8B4';
const BRAND_BORDER = '#E8E0D8';
const BRAND_SAGE = '#8BA888';

// Deadline fields and friendly labels (mirrors cron-deadline-reminders.js)
const DEADLINE_FIELDS = [
  { col: 'option_expiration_date', label: 'Option period expiration' },
  { col: 'closing_date',           label: 'Closing date' },
  { col: 'appraisal_deadline',     label: 'Appraisal deadline' },
  { col: 'survey_deadline',        label: 'Survey deadline' },
  { col: 'hoa_document_deadline',  label: 'HOA document deadline' },
  { col: 'loan_approval_deadline', label: 'Loan approval deadline' },
  { col: 'possession_date',        label: 'Possession date' },
];

// ─── Supabase helper ─────────────────────────────────────────────────────────

async function supaFetch(path, init = {}) {
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

// ─── Date helpers ─────────────────────────────────────────────────────────────

function todayChicagoYMD() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDaysYMD(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, '0'),
    String(dt.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function friendlyDate(ymd) {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  return `${days[dt.getUTCDay()]}, ${months[dt.getUTCMonth()]} ${dt.getUTCDate()}`;
}

function daysUntil(ymd, todayYMD) {
  const [ty, tm, td] = todayYMD.split('-').map(Number);
  const [fy, fm, fd] = ymd.split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const fieldMs = Date.UTC(fy, fm - 1, fd);
  return Math.round((fieldMs - todayMs) / 86400000);
}

function dayLabel(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return `in ${n} days`;
}

function isExcludedEmail(email) {
  if (!email) return true;
  const e = email.toLowerCase();
  if (e.startsWith('heath')) return true;
  if (e.includes('demo')) return true;
  return false;
}

// ─── Customer roster ─────────────────────────────────────────────────────────

async function loadActiveCustomers() {
  const subResp = await supaFetch('/rest/v1/subscriptions?status=eq.active&select=user_id');
  if (!subResp.ok) throw new Error(`subscriptions fetch ${subResp.status}`);
  const subs = subResp.data || [];
  if (subs.length === 0) return [];

  const userIds = subs.map((s) => s.user_id).filter(Boolean);
  const filter = userIds.map((id) => `"${id}"`).join(',');

  const profResp = await supaFetch(
    `/rest/v1/profiles?id=in.(${filter})&select=id,email,full_name,preferred_name,is_demo,is_founder,morning_brief_email_enabled`,
  );
  if (!profResp.ok) throw new Error(`profiles fetch ${profResp.status}`);

  const out = [];
  for (const p of (profResp.data || [])) {
    if (p.is_demo) continue;
    if (p.is_founder) continue;
    if (isExcludedEmail(p.email)) continue;
    if (p.morning_brief_email_enabled === false) continue;
    out.push({
      user_id: p.id,
      email: p.email,
      // preferred_name wins over full_name's first token so customers like
      // Kay Suzanne Page can be greeted as "Suzanne" not "Kay".
      first_name: customerFirstName(p),
      full_name: p.full_name || '',
    });
  }
  return out;
}

// ─── Transaction data ─────────────────────────────────────────────────────────

async function loadUserDealData(userId, todayYMD) {
  const cols = [
    'id', 'property_address', 'status', 'closing_date',
    ...DEADLINE_FIELDS.map((f) => f.col),
  ].join(',');

  const r = await supaFetch(
    `/rest/v1/transactions?user_id=eq.${encodeURIComponent(userId)}&or=(status.is.null,status.neq.closed)&select=${cols}`,
  );
  if (!r.ok) return { transactions: [], todayDeadlines: [], closingThisWeek: [] };

  const txs = r.data || [];
  const sevenDaysOut = addDaysYMD(todayYMD, 7);

  const todayDeadlines = [];
  const closingThisWeek = [];

  for (const tx of txs) {
    const addr = tx.property_address || 'Active dossier';

    // Deadlines hitting today
    for (const { col, label } of DEADLINE_FIELDS) {
      const val = tx[col];
      if (!val) continue;
      const ymd = val.slice(0, 10);
      if (ymd === todayYMD) {
        todayDeadlines.push({ address: addr, label, date: ymd });
      }
    }

    // Closing within 7 days
    if (tx.closing_date) {
      const closingYMD = tx.closing_date.slice(0, 10);
      if (closingYMD >= todayYMD && closingYMD <= sevenDaysOut) {
        const n = daysUntil(closingYMD, todayYMD);
        closingThisWeek.push({ address: addr, date: closingYMD, daysOut: n });
      }
    }
  }

  closingThisWeek.sort((a, b) => a.daysOut - b.daysOut);

  return { transactions: txs, todayDeadlines, closingThisWeek };
}

// ─── Action items count ───────────────────────────────────────────────────────

async function loadPendingActionCount(userId) {
  const r = await supaFetch(
    `/rest/v1/action_items?user_id=eq.${encodeURIComponent(userId)}&completed_at=is.null&select=id`,
  );
  if (!r.ok) return null;
  return (r.data || []).length;
}

// ─── TTS audio generation ─────────────────────────────────────────────────────

async function generateBriefAudio(text) {
  if (!OPENAI_API_KEY) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'nova',
        response_format: 'mp3',
      }),
    });
    if (!res.ok) {
      console.warn(`[customer-morning-brief] OpenAI TTS failed (${res.status})`);
      return null;
    }
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.warn('[customer-morning-brief] TTS error:', e.message);
    return null;
  }
}

// ─── Storage upload ────────────────────────────────────────────────────────────

async function uploadAudio(buffer, userId, todayYMD) {
  const path = `briefs/${userId}/${todayYMD}.mp3`;
  const res = await fetch(
    `${SUPABASE_URL}/storage/v1/object/morning-briefs/${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'audio/mpeg',
        'x-upsert': 'true',
      },
      body: buffer,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.warn('[customer-morning-brief] storage upload failed:', res.status, detail.slice(0, 200));
    return null;
  }
  return `${SUPABASE_URL}/storage/v1/object/public/morning-briefs/${path}`;
}

// ─── Unsubscribe token ─────────────────────────────────────────────────────────
// Simple HMAC-SHA256 token: base64url(HMAC(userId + ':' + date, CRON_SECRET))
// Stateless — no DB lookup required to verify.

const { createHmac } = require('crypto');

function makeUnsubToken(userId) {
  const payload = userId;
  const mac = createHmac('sha256', CRON_SECRET || 'fallback-secret')
    .update(payload)
    .digest('base64url');
  return `${Buffer.from(userId).toString('base64url')}.${mac}`;
}

// ─── Email HTML ────────────────────────────────────────────────────────────────

function buildBriefHtml({ firstName, userId, todayYMD, transactions, todayDeadlines, closingThisWeek, pendingActions, audioUrl }) {
  const name = (firstName || '').trim() || 'there';
  const dateLabel = friendlyDate(todayYMD);
  const unsubToken = makeUnsubToken(userId);
  const unsubUrl = `${UNSUBSCRIBE_BASE}?token=${encodeURIComponent(unsubToken)}`;

  const txCount = transactions.length;
  const deadlineCount = todayDeadlines.length;

  // Audio section
  const audioSection = audioUrl
    ? `<div style="margin: 0 0 28px; padding: 20px 24px; background: white; border: 1px solid ${BRAND_BORDER}; border-radius: 14px;">
        <div style="font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 10px;">LISTEN</div>
        <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.6; margin: 0 0 14px;">Your 60-second brief is ready.</p>
        <a href="${audioUrl}" style="display: inline-block; padding: 12px 24px; background: ${BRAND_CORAL}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 14px; font-family: 'Plus Jakarta Sans', Arial, sans-serif;">Play morning brief &rarr;</a>
      </div>`
    : '';

  // Deadlines today section
  let deadlinesTodaySection = '';
  if (todayDeadlines.length > 0) {
    const rows = todayDeadlines.map((d) =>
      `<div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid ${BRAND_BORDER};">
        <div>
          <div style="font-size: 14px; font-weight: 700; color: ${BRAND_NAVY};">${d.label}</div>
          <div style="font-size: 13px; color: ${BRAND_TEXT_SOFT}; margin-top: 2px;">${d.address}</div>
        </div>
        <div style="font-size: 13px; font-weight: 700; color: #C0392B; white-space: nowrap; margin-left: 16px; padding-top: 2px;">TODAY</div>
      </div>`
    ).join('');
    deadlinesTodaySection = `<div style="margin: 0 0 24px; padding: 20px 24px; background: #FFF5F5; border: 1px solid #F5C6C6; border-radius: 14px;">
      <div style="font-size: 12px; letter-spacing: 2px; color: #C0392B; text-transform: uppercase; font-weight: 700; margin-bottom: 14px;">DEADLINES TODAY</div>
      ${rows}
    </div>`;
  }

  // Closing this week section
  let closingSection = '';
  if (closingThisWeek.length > 0) {
    const rows = closingThisWeek.map((c) =>
      `<div style="display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 0; border-bottom: 1px solid ${BRAND_BORDER};">
        <div style="font-size: 14px; color: ${BRAND_NAVY}; font-weight: 600;">${c.address}</div>
        <div style="font-size: 13px; color: ${BRAND_SAGE}; white-space: nowrap; margin-left: 16px; padding-top: 2px;">Closing ${dayLabel(c.daysOut)}</div>
      </div>`
    ).join('');
    closingSection = `<div style="margin: 0 0 24px; padding: 20px 24px; background: white; border: 1px solid ${BRAND_BORDER}; border-radius: 14px;">
      <div style="font-size: 12px; letter-spacing: 2px; color: ${BRAND_SAGE}; text-transform: uppercase; font-weight: 700; margin-bottom: 14px;">CLOSING THIS WEEK</div>
      ${rows}
    </div>`;
  }

  // Summary line
  const summaryParts = [];
  if (txCount > 0) summaryParts.push(`${txCount} active deal${txCount === 1 ? '' : 's'}`);
  if (deadlineCount > 0) summaryParts.push(`${deadlineCount} deadline${deadlineCount === 1 ? '' : 's'} today`);
  if (pendingActions !== null && pendingActions > 0) summaryParts.push(`${pendingActions} open action item${pendingActions === 1 ? '' : 's'}`);
  const summaryLine = summaryParts.length > 0
    ? summaryParts.join(' &middot; ')
    : 'Your pipeline is clear today.';

  // Empty state
  const emptyState = (txCount === 0 && todayDeadlines.length === 0 && closingThisWeek.length === 0)
    ? `<div style="padding: 20px 24px; background: white; border: 1px solid ${BRAND_BORDER}; border-radius: 14px; margin-bottom: 24px; text-align: center;">
        <p style="font-size: 15px; color: ${BRAND_TEXT_SOFT}; line-height: 1.6; margin: 0;">Your pipeline is clear today. Nothing urgent on the board.</p>
      </div>`
    : '';

  return `<div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; max-width: 620px; margin: 0 auto; padding: 40px 24px; background: ${BRAND_BG}; color: ${BRAND_NAVY};">

  <div style="font-family: 'Plus Jakarta Sans', Arial, sans-serif; font-size: 12px; letter-spacing: 2px; color: ${BRAND_CORAL}; text-transform: uppercase; font-weight: 700; margin-bottom: 18px;">DOSSIE &middot; MORNING BRIEF</div>

  <h1 style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 32px; line-height: 1.2; margin: 0 0 8px; color: ${BRAND_NAVY};">Good morning, ${name}.</h1>
  <p style="font-size: 14px; color: ${BRAND_MUTED}; margin: 0 0 24px;">${dateLabel} &middot; ${summaryLine}</p>

  ${audioSection}
  ${deadlinesTodaySection}
  ${closingSection}
  ${emptyState}

  <div style="margin: 28px 0;">
    <a href="${APP_URL}" style="display: inline-block; padding: 16px 32px; background: ${BRAND_NAVY}; color: white; text-decoration: none; border-radius: 999px; font-weight: 700; font-size: 15px; font-family: 'Plus Jakarta Sans', Arial, sans-serif; letter-spacing: 0.2px;">Open Dossie &rarr;</a>
  </div>

  <p style="font-family: 'Cormorant Garamond', Georgia, serif; font-size: 20px; color: ${BRAND_NAVY}; line-height: 1.4; margin: 24px 0 4px;">- Dossie</p>

  <p style="margin-top: 32px; font-size: 12px; color: ${BRAND_MUTED}; line-height: 1.6;">
    You're getting this because you're a Dossie founding member.<br>
    <a href="${unsubUrl}" style="color: ${BRAND_MUTED}; text-decoration: underline;">Unsubscribe from morning brief emails</a>
  </p>
</div>`;
}

// ─── Email send ────────────────────────────────────────────────────────────────

async function sendResend(to, subject, html) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    // No BCC: customer-file operational email per feedback_bcc_heath_on_all_emails.md
    body: JSON.stringify({
      from: FROM_ADDRESS,
      to: [to],
      subject,
      html,
    }),
  });
  const text = await r.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch {}
  return { ok: r.ok, status: r.status, data, raw: text };
}

// ─── Log insert ───────────────────────────────────────────────────────────────

async function logSend({ userId, email, sentDate, audioUrl, transactionCount, deadlineCount }) {
  const r = await supaFetch('/rest/v1/morning_brief_email_log', {
    method: 'POST',
    headers: { Prefer: 'return=minimal,resolution=ignore-duplicates' },
    body: JSON.stringify({
      user_id: userId,
      email,
      sent_date: sentDate,
      audio_url: audioUrl || null,
      transaction_count: transactionCount,
      deadline_count: deadlineCount,
    }),
  });
  if (!r.ok) {
    console.warn('[customer-morning-brief] log insert failed:', r.status, JSON.stringify(r.data));
  }
  return r.ok;
}

// ─── Already-sent guard ────────────────────────────────────────────────────────

async function alreadySentToday(userId, sentDate) {
  const r = await supaFetch(
    `/rest/v1/morning_brief_email_log?user_id=eq.${encodeURIComponent(userId)}&sent_date=eq.${sentDate}&select=id`,
  );
  if (!r.ok) return false;
  return (r.data || []).length > 0;
}

// ─── TTS script builder ────────────────────────────────────────────────────────

function buildAudioScript({ firstName, todayDeadlines, closingThisWeek, transactionCount, pendingActions }) {
  const name = firstName || 'there';
  const parts = [`Good morning, ${name}. Here's your Dossie brief.`];

  if (transactionCount === 0) {
    parts.push('Your pipeline is clear today. No active deals.');
  } else {
    parts.push(`You have ${transactionCount} active deal${transactionCount === 1 ? '' : 's'} in your pipeline.`);
  }

  if (todayDeadlines.length > 0) {
    parts.push(`${todayDeadlines.length} deadline${todayDeadlines.length === 1 ? ' hits' : 's hit'} today.`);
    for (const d of todayDeadlines.slice(0, 3)) {
      parts.push(`${d.label} for ${d.address}.`);
    }
    if (todayDeadlines.length > 3) parts.push(`And ${todayDeadlines.length - 3} more.`);
  }

  if (closingThisWeek.length > 0) {
    const c = closingThisWeek[0];
    parts.push(`${c.address} closes ${dayLabel(c.daysOut)}.`);
    if (closingThisWeek.length > 1) parts.push(`${closingThisWeek.length - 1} more closing this week.`);
  }

  if (pendingActions !== null && pendingActions > 0) {
    parts.push(`You have ${pendingActions} open action item${pendingActions === 1 ? '' : 's'}.`);
  }

  parts.push('Open Dossie to get started. Have a great day.');
  return parts.join(' ');
}

// ─── Handler ──────────────────────────────────────────────────────────────────

module.exports = withTelemetry('cron-customer-morning-brief', async function handler(req, res) {
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

    const isTest = req.query && req.query.test === '1';
    const todayYMD = todayChicagoYMD();

    const summary = {
      ok: true,
      test_mode: isTest,
      date: todayYMD,
      customers_scanned: 0,
      emails_sent: 0,
      emails_skipped: 0,
      errors: [],
    };

    let customers = await loadActiveCustomers();
    summary.customers_scanned = customers.length;

    if (isTest) {
      // In test mode: send only to heath@meetdossie.com using first customer's data
      // (or empty data if no customers) — never logs to DB.
      const testTarget = {
        user_id: 'test-user-id',
        email: 'heath@meetdossie.com',
        first_name: 'Heath',
        full_name: 'Heath Shepard',
      };
      const dealData = customers.length > 0
        ? await loadUserDealData(customers[0].user_id, todayYMD)
        : { transactions: [], todayDeadlines: [], closingThisWeek: [] };
      const pendingActions = customers.length > 0 ? await loadPendingActionCount(customers[0].user_id) : 0;

      const audioScript = buildAudioScript({
        firstName: testTarget.first_name,
        ...dealData,
        transactionCount: dealData.transactions.length,
        pendingActions,
      });
      const audioBuffer = await generateBriefAudio(audioScript);
      let audioUrl = null;
      if (audioBuffer) {
        audioUrl = await uploadAudio(audioBuffer, 'test', todayYMD);
      }

      const deadlineCount = dealData.todayDeadlines.length;
      const subject = deadlineCount > 0
        ? `${testTarget.first_name}, here's your morning - ${deadlineCount} deadline${deadlineCount === 1 ? '' : 's'} today`
        : `${testTarget.first_name}, here's your morning`;

      const html = buildBriefHtml({
        firstName: testTarget.first_name,
        userId: testTarget.user_id,
        todayYMD,
        ...dealData,
        pendingActions,
        audioUrl,
      });

      const send = await sendResend(testTarget.email, subject, html);
      if (send.ok) {
        summary.emails_sent = 1;
      } else {
        summary.errors.push({ email: testTarget.email, status: send.status, error: (send.raw || '').slice(0, 200) });
      }

      return res.status(200).json(summary);
    }

    for (const cust of customers) {
      try {
        const alreadySent = await alreadySentToday(cust.user_id, todayYMD);
        if (alreadySent) {
          summary.emails_skipped++;
          continue;
        }

        const dealData = await loadUserDealData(cust.user_id, todayYMD);
        const pendingActions = await loadPendingActionCount(cust.user_id);

        const audioScript = buildAudioScript({
          firstName: cust.first_name,
          ...dealData,
          transactionCount: dealData.transactions.length,
          pendingActions,
        });
        const audioBuffer = await generateBriefAudio(audioScript);
        let audioUrl = null;
        if (audioBuffer) {
          audioUrl = await uploadAudio(audioBuffer, cust.user_id, todayYMD);
        }

        const deadlineCount = dealData.todayDeadlines.length;
        const subject = deadlineCount > 0
          ? `${cust.first_name}, here's your morning - ${deadlineCount} deadline${deadlineCount === 1 ? '' : 's'} today`
          : `${cust.first_name}, here's your morning`;

        const html = buildBriefHtml({
          firstName: cust.first_name,
          userId: cust.user_id,
          todayYMD,
          ...dealData,
          pendingActions,
          audioUrl,
        });

        const send = await sendResend(cust.email, subject, html);
        if (!send.ok) {
          console.error('[customer-morning-brief] resend failed', cust.email, send.status, (send.raw || '').slice(0, 200));
          summary.errors.push({ user_id: cust.user_id, email: cust.email, status: send.status, error: (send.raw || '').slice(0, 200) });
          continue;
        }

        await logSend({
          userId: cust.user_id,
          email: cust.email,
          sentDate: todayYMD,
          audioUrl,
          transactionCount: dealData.transactions.length,
          deadlineCount,
        });

        summary.emails_sent++;
      } catch (custErr) {
        console.error('[customer-morning-brief] error for', cust.email, custErr && custErr.message);
        summary.errors.push({ user_id: cust.user_id, email: cust.email, error: custErr && custErr.message });
      }
    }

    return res.status(200).json(summary);
  } catch (err) {
    console.error('[customer-morning-brief] uncaught error:', err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});
