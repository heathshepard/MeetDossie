'use strict';

// api/_lib/comment-dm-followups.test.js
//
// computeLeadAction() is the ENTIRE Meta-policy compliance boundary for this
// sequence — every case here is a real scenario from the private-reply /
// 24h-window rules, not a hypothetical. Run: node --test api/_lib/comment-dm-followups.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeLeadAction, TOUCH2_DELAY_MS, TOUCH3_DELAY_MS, REPLY_WINDOW_MS } = require('./comment-dm-followups.js');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-28T12:00:00Z');
const iso = (ms) => new Date(NOW + ms).toISOString();

test('touch2 not due before 2 days', () => {
  const lead = { triggered_at: iso(-1 * DAY), touch2_status: 'pending', touch3_status: 'pending' };
  assert.equal(computeLeadAction(lead, NOW).action, 'wait');
});

test('touch2 due, no reply ever -> needs_manual, never auto-sends', () => {
  const lead = { triggered_at: iso(-2 * DAY - 1000), user_replied: false, touch2_status: 'pending', touch3_status: 'pending' };
  const out = computeLeadAction(lead, NOW);
  assert.equal(out.action, 'needs_manual');
  assert.equal(out.stage, 'touch2');
});

test('touch2 due, replied within last 24h -> safe to send', () => {
  const lead = {
    triggered_at: iso(-2 * DAY - 1000),
    user_replied: true,
    user_replied_at: iso(-1 * 60 * 60 * 1000), // 1h ago
    touch2_status: 'pending', touch3_status: 'pending',
  };
  assert.equal(computeLeadAction(lead, NOW).action, 'send_touch2');
});

test('touch2 due, replied but window closed (>24h ago) -> needs_manual, NOT sent', () => {
  const lead = {
    triggered_at: iso(-2 * DAY - 1000),
    user_replied: true,
    user_replied_at: iso(-25 * 60 * 60 * 1000), // 25h ago — window shut
    touch2_status: 'pending', touch3_status: 'pending',
  };
  const out = computeLeadAction(lead, NOW);
  assert.equal(out.action, 'needs_manual');
  assert.equal(out.reason, 'replied_but_24h_window_closed_before_a_send_could_happen');
});

test('touch2 needs_manual self-heals the moment a fresh reply lands', () => {
  const lead = {
    triggered_at: iso(-10 * DAY),
    user_replied: true,
    user_replied_at: iso(-30 * 60 * 1000), // 30 min ago — window open now
    touch2_status: 'needs_manual', touch3_status: 'pending',
  };
  assert.equal(computeLeadAction(lead, NOW).action, 'send_touch2');
});

test('touch2 needs_manual with still no fresh reply -> already_flagged, not re-counted', () => {
  const lead = { triggered_at: iso(-10 * DAY), user_replied: false, touch2_status: 'needs_manual', touch3_status: 'pending' };
  assert.equal(computeLeadAction(lead, NOW).action, 'already_flagged');
});

test('touch3 not due before 5 days after touch2', () => {
  const lead = {
    triggered_at: iso(-10 * DAY),
    touch2_status: 'sent', touch2_sent_at: iso(-1 * DAY),
    touch3_status: 'pending',
  };
  assert.equal(computeLeadAction(lead, NOW).action, 'wait');
});

test('touch3 due, they never replied to touch2 -> needs_manual (the literal "never replied" case is exactly the illegal-send case)', () => {
  const lead = {
    triggered_at: iso(-10 * DAY),
    touch2_status: 'sent', touch2_sent_at: iso(-5 * DAY - 1000),
    touch3_status: 'pending',
    user_replied: false,
  };
  const out = computeLeadAction(lead, NOW);
  assert.equal(out.action, 'needs_manual');
  assert.equal(out.stage, 'touch3');
  assert.equal(out.reason, 'no_reply_to_touch2_5_days_later_no_window_ever_reopened');
});

test('touch3 due, replied to touch1 long ago but NOT to touch2 -> still needs_manual (stale reply does not carry the window forward)', () => {
  const lead = {
    triggered_at: iso(-10 * DAY),
    touch2_status: 'sent', touch2_sent_at: iso(-5 * DAY - 1000),
    touch3_status: 'pending',
    user_replied: true,
    user_replied_at: iso(-8 * DAY), // reply predates touch2 entirely
  };
  assert.equal(computeLeadAction(lead, NOW).action, 'needs_manual');
});

test('touch3 due, FRESH reply after touch2 and window open -> safe to send', () => {
  const lead = {
    triggered_at: iso(-10 * DAY),
    touch2_status: 'sent', touch2_sent_at: iso(-5 * DAY - 1000),
    touch3_status: 'pending',
    user_replied: true,
    user_replied_at: iso(-2 * 60 * 60 * 1000), // 2h ago, after touch2
  };
  assert.equal(computeLeadAction(lead, NOW).action, 'send_touch3');
});

test('both touches sent -> done', () => {
  const lead = { triggered_at: iso(-20 * DAY), touch2_status: 'sent', touch2_sent_at: iso(-15 * DAY), touch3_status: 'sent' };
  assert.equal(computeLeadAction(lead, NOW).action, 'done');
});

test('malformed row (no triggered_at) -> skip, never guessed at', () => {
  assert.equal(computeLeadAction({ touch2_status: 'pending' }, NOW).action, 'skip');
});

test('constants match the product spec (2 days / 5 days / 24h)', () => {
  assert.equal(TOUCH2_DELAY_MS, 2 * DAY);
  assert.equal(TOUCH3_DELAY_MS, 5 * DAY);
  assert.equal(REPLY_WINDOW_MS, DAY);
});
