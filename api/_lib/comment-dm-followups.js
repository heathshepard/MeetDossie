'use strict';

// api/_lib/comment-dm-followups.js
//
// THE GAP: the comment-to-DM engine (20260925_zernio_comment_engine.sql)
// sends one Meta private-reply per matched comment and stops. It delivers a
// PDF and never mentions Dossie. This is touch 2 and touch 3 — the sequence
// that turns that PDF download into an actual trial conversation.
//
// ─── READ BEFORE CHANGING ANY GATING LOGIC IN THIS FILE ────────────────────
// developers.facebook.com/docs/messenger-platform/instagram/features/
// private-replies + the policy overview. Two hard facts drive everything
// below:
//
//   1. Touch 1 (the automatic private reply) is a ONE-TIME surface. It
//      cannot be reused for touch 2/3 — that channel is spent the instant
//      it fires.
//   2. Touch 2/3 can ONLY legally go out through Meta's Send API inside the
//      24-HOUR STANDARD MESSAGING WINDOW, which opens ONLY when the
//      recipient messages us. No reply, no window, no send — a message tag
//      or paid Sponsored Message is the only other path in, and neither
//      fits an unsolicited "did this help" follow-up (the Human Agent tag
//      specifically requires a human answering an inbound message, not
//      automation initiating one).
//
// So every function here is built around ONE rule: NEVER call a send
// function unless lead.user_replied is true AND that reply is recent enough
// that the window is provably still open (checked again at send time, not
// just at "should we queue this" time). If that isn't true, the lead is
// routed to needs_manual — surfaced to Heath for his OWN personal follow-up
// from the native app UI, which is not subject to the Send-API window rule
// because it isn't the automated Send API. It is never auto-messaged from
// here.
//
// ─── WHAT THIS MEANS FOR REAL COVERAGE — READ THIS BEFORE TRUSTING A SEND COUNT
// There is no automated way to detect a reply today. api/_lib/zernio-
// comments.js (verified against the live API 2026-09-25) covers comment
// reads/writes and comment-automations only — Zernio has no verified
// DM/conversation-read endpoint. So `user_replied` can only be set by a
// human who personally saw the reply (api/admin-mark-dm-lead-replied.js).
// Nothing in this file, and nothing running on a schedule, can discover a
// reply on its own.
//
// Practical consequence: until either (a) someone manually marks replies as
// they're seen in the Instagram/Facebook inbox, or (b) a real Meta
// Messenger/IG-messaging webhook is built (a separate project requiring
// Meta app review for messaging permissions), essentially ~0% of leads will
// ever reach an automated touch 2/3 send. The realistic, immediate value of
// this system is the OTHER branch: at the 2-day mark it turns every silent
// lead into a needs_manual item Heath can chase himself in the app — which
// today is not happening at all. Automated touch 2/3 sends become real the
// day reply-detection exists; until then this ships correctly inert on
// that path, which is the honest behavior, not a bug to route around.
//
// Owner: Carter, 2026-09-28

const { buildTouch2Message, buildTouch3Message } = require('./comment-dm-followup-copy.js');

const TOUCH2_DELAY_MS = 2 * 24 * 60 * 60 * 1000; // 2 days after touch 1
const TOUCH3_DELAY_MS = 5 * 24 * 60 * 60 * 1000; // 5 days after touch 2
const REPLY_WINDOW_MS = 24 * 60 * 60 * 1000; // Meta's standard messaging window

const TRIAL_LINK_BASE_URL = 'https://meetdossie.com/signup.html';

function toMs(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

// Is the 24h window open RIGHT NOW, given the most recent known reply?
function windowOpen(repliedAtIso, now) {
  const repliedAt = toMs(repliedAtIso);
  if (repliedAt == null) return false;
  const age = now - repliedAt;
  return age >= 0 && age < REPLY_WINDOW_MS;
}

/**
 * Pure decision function — no I/O, fully unit-testable. Given a
 * comment_dm_leads row (+ optional `now` for deterministic tests), returns
 * exactly what should happen next.
 *
 * Actions:
 *   wait            — not due yet, do nothing
 *   send_touch2 / send_touch3 — window is open right now, safe to send
 *   needs_manual    — due, but no open window; route to Heath, never send
 *   already_flagged — already needs_manual and still no open window
 *   done            — sequence complete (touch3 resolved one way or another)
 *   skip            — malformed row, cannot evaluate
 */
function computeLeadAction(lead, now = Date.now()) {
  if (!lead) return { action: 'skip', reason: 'no_lead' };
  const triggeredAt = toMs(lead.triggered_at);
  if (triggeredAt == null) return { action: 'skip', reason: 'invalid_or_missing_triggered_at' };

  const touch2Status = lead.touch2_status || 'pending';
  const touch3Status = lead.touch3_status || 'pending';
  const hasOpenWindow = !!lead.user_replied && windowOpen(lead.user_replied_at, now);

  // ─── TOUCH 2 ───────────────────────────────────────────────────────────
  if (touch2Status === 'pending') {
    const dueAt = triggeredAt + TOUCH2_DELAY_MS;
    if (now < dueAt) return { action: 'wait', reason: 'touch2_not_due_yet', due_at: new Date(dueAt).toISOString() };
    if (hasOpenWindow) return { action: 'send_touch2' };
    return {
      action: 'needs_manual',
      stage: 'touch2',
      reason: lead.user_replied
        ? 'replied_but_24h_window_closed_before_a_send_could_happen'
        : 'no_reply_recorded_2_days_after_first_dm',
    };
  }

  if (touch2Status === 'needs_manual' || touch2Status === 'failed') {
    // Re-evaluated every run — the only way a lead self-heals once a human
    // marks a reply after the fact, without anyone re-running anything.
    if (hasOpenWindow) return { action: 'send_touch2' };
    return { action: 'already_flagged', stage: 'touch2' };
  }

  // touch2Status === 'sent' beyond this point.

  // ─── TOUCH 3 ───────────────────────────────────────────────────────────
  if (touch3Status === 'pending') {
    const touch2SentAt = toMs(lead.touch2_sent_at);
    if (touch2SentAt == null) return { action: 'skip', reason: 'touch2_sent_but_no_timestamp' };
    const dueAt = touch2SentAt + TOUCH3_DELAY_MS;
    if (now < dueAt) return { action: 'wait', reason: 'touch3_not_due_yet', due_at: new Date(dueAt).toISOString() };

    // Touch 3 legality is its OWN reply, not touch 1's — must be a FRESH
    // reply that landed after touch 2 went out, and still be inside the
    // window right now.
    const repliedAfterTouch2 = !!lead.user_replied
      && toMs(lead.user_replied_at) != null
      && toMs(lead.user_replied_at) > touch2SentAt;
    if (repliedAfterTouch2 && windowOpen(lead.user_replied_at, now)) {
      return { action: 'send_touch3' };
    }
    // This is the literal "they never replied" case the product brief
    // describes for touch 3 — and it is EXACTLY the condition that makes an
    // automated send illegal under Meta's policy. There is no legal
    // automated touch 3 for this lead. Route to Heath instead of the bot.
    return {
      action: 'needs_manual',
      stage: 'touch3',
      reason: repliedAfterTouch2
        ? 'replied_after_touch2_but_24h_window_closed_before_a_send_could_happen'
        : 'no_reply_to_touch2_5_days_later_no_window_ever_reopened',
    };
  }

  if (touch3Status === 'needs_manual' || touch3Status === 'failed') {
    const touch2SentAt = toMs(lead.touch2_sent_at) || 0;
    const repliedAfterTouch2 = !!lead.user_replied
      && toMs(lead.user_replied_at) != null
      && toMs(lead.user_replied_at) > touch2SentAt;
    if (repliedAfterTouch2 && hasOpenWindow) return { action: 'send_touch3' };
    return { action: 'already_flagged', stage: 'touch3' };
  }

  return { action: 'done' };
}

module.exports = {
  TOUCH2_DELAY_MS,
  TOUCH3_DELAY_MS,
  REPLY_WINDOW_MS,
  TRIAL_LINK_BASE_URL,
  windowOpen,
  computeLeadAction,
  buildTouch2Message,
  buildTouch3Message,
};
