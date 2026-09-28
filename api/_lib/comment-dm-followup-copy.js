'use strict';

// api/_lib/comment-dm-followup-copy.js
//
// Touch 2/3 copy for the comment-DM follow-up sequence. Heath's voice —
// short, plain, the real question is the point (heath-email-voice-profile,
// heath-group-comment-voice: no enthusiasm opener, no compliment before the
// ask, no em-dash, contractions, dry over bubbly).
//
// "Heath Shepard, Keller Williams" appears in both — a DM is "electronic
// media" under 22 TAC 535.155 and the license-holder identification is
// safer present on every outbound message than assumed carried over from
// touch 1.
//
// KNOWN GAP, FLAG BEFORE MODE=send: touch 2 promises "first 14 days are
// free." api/create-checkout-session.js has NO trial_period_days and no
// coupon/discount wired in today -- clicking through and checking out
// charges Solo/Team immediately. This copy must not go live until that's
// resolved (add a gated trial_days param, or a Stripe coupon code) -- see
// this session's report. Never ship a promise the product doesn't keep
// (dossie-demo-must-match-real-capability).
//
// Owner: Carter, 2026-09-28

function buildTouch2Message(trialUrl) {
  return [
    `Did the one-pager end up helping? If you want to run a real file through Dossie, first 14 days are free: ${trialUrl}`,
    'Heath Shepard, Keller Williams',
  ].join('\n\n');
}

function buildTouch3Message(trialUrl) {
  return [
    `No pressure if now's not the time, the free trial link's still good whenever you want to try it: ${trialUrl}`,
    'Heath Shepard, Keller Williams',
  ].join('\n\n');
}

module.exports = { buildTouch2Message, buildTouch3Message };
