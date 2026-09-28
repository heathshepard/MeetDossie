'use strict';

// api/cron-comment-dm-followups.js
//
// WHY THIS EXISTS
//   The comment-to-DM engine (20260925_zernio_comment_engine.sql) sends one
//   Meta private-reply per matched comment and stops -- a PDF that never
//   mentions Dossie, no second touch, no offer, no path to a trial. This is
//   touch 2 ("did the one-pager help" + 14-days-free) and touch 3 (one line,
//   then stop).
//
// THE HARD CONSTRAINT (read api/_lib/comment-dm-followups.js header first)
//   Touch 2/3 can only legally go out inside Meta's 24h standard-messaging
//   window, which opens ONLY when the lead replies. There is no automated
//   way to detect that reply today (Zernio has no verified DM-read
//   endpoint) -- it is set by a human via api/admin-mark-dm-lead-replied.js.
//   So this cron's real, honest job today is mostly the OTHER branch: at
//   the 2-day mark, flip every silent lead to needs_manual so Heath can
//   chase it himself from the app. Automated sends only fire for the
//   (currently rare) leads someone has manually confirmed replied.
//
// SAFETY -- INERT BY DEFAULT, SAME PATTERN AS ACCOUNT_INVITE_AUTORESEND_MODE
//   COMMENT_DM_FOLLOWUP_MODE unset or 'report'  (DEFAULT, what deploys)
//     -- every lead is evaluated and counted (would-send / needs-manual /
//     waiting / done). NOTHING is written to Supabase and NOBODY is
//     messaged. Safe to run against live data indefinitely.
//   COMMENT_DM_FOLLOWUP_MODE = 'send'
//     -- needs_manual flags are actually written (that's just a DB status,
//     never a message to anyone), AND a real touch 2/3 send is attempted
//     for any lead whose window is open -- but ONLY IF
//     COMMENT_DM_FOLLOWUP_SEND_ENDPOINT_VERIFIED=true is ALSO set. That
//     second flag exists because api/_lib/zernio-comments.js
//     sendDirectMessage() is UNVERIFIED (see its header) -- Zernio has no
//     confirmed standalone message-send endpoint, only the automatic
//     private-reply baked into a comment-automation. Flipping MODE alone can
//     never fire an unverified network call at a real lead; both switches
//     have to be set on purpose.
//
// ALARM: leads stuck needing manual follow-up and sends that failed are
// surfaced through the EXISTING silence-alarm/Telegram ladder
// (api/_lib/silence-alarm.js checkCommentDmFollowupsNeedsManual /
// checkCommentDmFollowupSendsFailing, folded into cron-silence-alarm.js's
// daily run) -- nothing new invented here.
//
// Joins the api/cron-dispatch-daily-1300 group (schedule "0 13 * * *") per
// instruction -- no new vercel.json cron slot.
//
// Owner: Carter, 2026-09-28

require('./_lib/telegram-gate').install('cron-comment-dm-followups');

const { withTelemetry } = require('./_lib/cron-telemetry.js');
const { getOrCreateDmLink } = require('./_lib/dm-link.js');
const { sendDirectMessage } = require('./_lib/zernio-comments.js');
const {
  TRIAL_LINK_BASE_URL,
  computeLeadAction,
  buildTouch2Message,
  buildTouch3Message,
} = require('./_lib/comment-dm-followups.js');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET;

const MODE = String(process.env.COMMENT_DM_FOLLOWUP_MODE || 'report').toLowerCase();
const SEND_ENDPOINT_VERIFIED = String(process.env.COMMENT_DM_FOLLOWUP_SEND_ENDPOINT_VERIFIED || '').toLowerCase() === 'true';
const BATCH_LIMIT = 500;
const SELF_NAME = 'cron-comment-dm-followups';

async function sb(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  return { ok: res.ok, status: res.status, data };
}

// dm-link.js's getOrCreateDmLink expects sbFetch(path) where path already
// starts with /rest/v1/... — matches this file's sb() exactly.
const sbFetch = sb;

// Every write through this function stamps last_followup_attempt_at — the
// staleness clock checkCommentDmFollowupsNeedsManual/SendsFailing key off,
// since comment_dm_leads has no generic updated_at (see migration header).
async function patchLead(leadId, patch) {
  return sb(`/rest/v1/comment_dm_leads?id=eq.${encodeURIComponent(leadId)}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ ...patch, last_followup_attempt_at: new Date().toISOString() }),
  });
}

module.exports = withTelemetry(SELF_NAME, async function handler(req, res) {
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const authHeader = (req.headers && (req.headers.authorization || req.headers.Authorization)) || '';
  const isManualAuth = CRON_SECRET && authHeader === `Bearer ${CRON_SECRET}`;
  if (!isVercelCron && !isManualAuth) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ ok: false, error: 'supabase_env_missing' });
  }

  const result = {
    mode: MODE,
    send_endpoint_verified: SEND_ENDPOINT_VERIFIED,
    checked: 0,
    waiting: 0,
    sent: 0,
    needs_manual: 0,
    already_flagged: 0,
    done: 0,
    skipped: 0,
    failed: 0,
    blocked_unverified_send: 0,
    errors: [],
  };

  // Everything not already fully resolved (touch2 sent AND touch3 sent).
  // needs_manual / failed rows stay in the fetch set deliberately — they
  // self-heal the moment a human marks a reply, see computeLeadAction().
  const leadsR = await sb(
    '/rest/v1/comment_dm_leads?or=(touch2_status.neq.sent,touch3_status.neq.sent)'
    + '&select=id,platform,account_id,commenter_platform_id,commenter_name,keyword,triggered_at,'
    + 'dm_status,user_replied,user_replied_at,touch2_status,touch2_sent_at,touch3_status,needs_manual'
    + `&order=triggered_at.asc&limit=${BATCH_LIMIT}`,
  );
  if (!leadsR.ok) {
    return res.status(500).json({ ok: false, error: `leads_read_${leadsR.status}` });
  }
  const leads = Array.isArray(leadsR.data) ? leadsR.data : [];
  const now = Date.now();

  for (const lead of leads) {
    result.checked += 1;

    // Touch 1 itself never delivered — nothing to follow up on until that's
    // fixed by hand (asset link, account reconnect, etc.).
    if (lead.dm_status === 'failed') {
      if (lead.needs_manual) { result.already_flagged += 1; continue; }
      result.needs_manual += 1;
      if (MODE === 'send') {
        await patchLead(lead.id, {
          needs_manual: true,
          needs_manual_at: new Date(now).toISOString(),
          needs_manual_reason: 'first_dm_never_delivered',
        });
      }
      continue;
    }

    const action = computeLeadAction(lead, now);

    if (action.action === 'wait') { result.waiting += 1; continue; }
    if (action.action === 'done') { result.done += 1; continue; }
    if (action.action === 'already_flagged') { result.already_flagged += 1; continue; }
    if (action.action === 'skip') {
      result.skipped += 1;
      result.errors.push({ lead_id: lead.id, reason: action.reason });
      continue;
    }

    if (action.action === 'needs_manual') {
      result.needs_manual += 1;
      if (MODE !== 'send') continue;
      const statusPatch = action.stage === 'touch3'
        ? { touch3_status: 'needs_manual' }
        : { touch2_status: 'needs_manual' };
      const patch = await patchLead(lead.id, {
        ...statusPatch,
        needs_manual: true,
        needs_manual_at: new Date(now).toISOString(),
        needs_manual_reason: action.reason,
      });
      if (!patch.ok) { result.errors.push({ lead_id: lead.id, stage: action.stage, error: `patch_${patch.status}` }); }
      continue;
    }

    if (action.action === 'send_touch2' || action.action === 'send_touch3') {
      const stage = action.action === 'send_touch2' ? 'touch2' : 'touch3';
      if (MODE !== 'send') { result.sent += 1; continue; } // report mode: count as "would send"

      if (!SEND_ENDPOINT_VERIFIED) {
        // MODE=send but the network call is unverified — refuse to guess.
        // See zernio-comments.js sendDirectMessage() header.
        result.blocked_unverified_send += 1;
        await patchLead(lead.id, {
          [`${stage}_status`]: 'failed',
          [`${stage}_error`]: 'blocked: COMMENT_DM_FOLLOWUP_SEND_ENDPOINT_VERIFIED is not true — see zernio-comments.js sendDirectMessage() header',
        });
        continue;
      }

      const link = await getOrCreateDmLink({
        sourceTable: 'comment_dm_leads',
        sourceId: lead.id,
        platform: lead.platform,
        baseUrl: TRIAL_LINK_BASE_URL,
        sbFetch,
      });
      if (!link.ok) {
        result.failed += 1;
        await patchLead(lead.id, { [`${stage}_status`]: 'failed', [`${stage}_error`]: `dm_link_failed: ${link.error}` });
        continue;
      }

      const message = stage === 'touch2' ? buildTouch2Message(link.url) : buildTouch3Message(link.url);
      const idempotencyKey = `${SELF_NAME}:${lead.id}:${stage}`;
      const sendRes = await sendDirectMessage({
        accountId: lead.account_id,
        recipientPlatformId: lead.commenter_platform_id,
        message,
        idempotencyKey,
      });

      if (!sendRes.ok) {
        result.failed += 1;
        await patchLead(lead.id, { [`${stage}_status`]: 'failed', [`${stage}_error`]: String(sendRes.error || sendRes.status).slice(0, 400) });
        continue;
      }

      result.sent += 1;
      await patchLead(lead.id, { [`${stage}_status`]: 'sent', [`${stage}_sent_at`]: new Date(now).toISOString() });
    }
  }

  return res.status(200).json({ ok: true, ...result });
});
