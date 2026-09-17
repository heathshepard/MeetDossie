'use strict';

// api/_lib/video-delivery-verify.test.js
//
// Unit coverage for the pure proof-level / staleness helpers behind Pipeline
// B (video_library) delivery verification. See file header of
// video-delivery-verify.js and scripts/regression-video-delivery-verify.js
// (end-to-end scenario against a mocked cron).
//
// Run: node --test api/_lib/video-delivery-verify.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  PROOF_LEVELS,
  proofLevelFor,
  buildDeliveryEntry,
  mergeDeliveryEntries,
  patchDeliveryEntry,
  isDueForStaleAlert,
  entriesNeedingCheck,
  entriesUnconfirmable,
} = require('./video-delivery-verify');

test('proofLevelFor: not live -> unconfirmed, regardless of URL', () => {
  assert.equal(proofLevelFor({ isLive: false, platformUrl: 'https://example.com' }), PROOF_LEVELS.UNCONFIRMED);
  assert.equal(proofLevelFor({ isLive: false, platformUrl: null }), PROOF_LEVELS.UNCONFIRMED);
});

test('proofLevelFor: live with no URL -> zernio_confirmed_no_url (never claim a URL we do not have)', () => {
  assert.equal(proofLevelFor({ isLive: true, platformUrl: null }), PROOF_LEVELS.CONFIRMED_NO_URL);
});

test('proofLevelFor: live with a URL -> zernio_confirmed_live_url', () => {
  assert.equal(proofLevelFor({ isLive: true, platformUrl: 'https://tiktok.com/@x/video/1' }), PROOF_LEVELS.CONFIRMED_LIVE_URL);
});

test('buildDeliveryEntry: a rejected postToZernio() result never gets a zernio_post_id', () => {
  const entry = buildDeliveryEntry({
    platform: 'facebook',
    scheduledFor: null,
    postResult: { ok: false, error: 'Zernio 500: boom' },
    nowIso: '2026-09-17T12:00:00.000Z',
  });
  assert.equal(entry.zernio_post_id, null);
  assert.equal(entry.status, 'post_rejected');
  assert.equal(entry.proof_level, PROOF_LEVELS.UNCONFIRMED);
  assert.equal(entry.error, 'Zernio 500: boom');
});

test('buildDeliveryEntry: a 2xx-but-no-id result is marked accepted_unverified, not a clean success', () => {
  const entry = buildDeliveryEntry({
    platform: 'tiktok',
    scheduledFor: null,
    postResult: { ok: true, zernio_post_id: null, unverified: true },
    nowIso: '2026-09-17T12:00:00.000Z',
  });
  assert.equal(entry.status, 'accepted_unverified');
  assert.equal(entry.zernio_post_id, null);
  assert.equal(entry.proof_level, PROOF_LEVELS.UNCONFIRMED);
});

test('buildDeliveryEntry: a normal accept records the id and any URL already present, still unconfirmed until verified', () => {
  const entry = buildDeliveryEntry({
    platform: 'youtube',
    scheduledFor: '2026-09-17T14:00:00.000Z',
    postResult: { ok: true, zernio_post_id: 'zp-123', platform_url: 'https://youtube.com/watch?v=abc' },
    nowIso: '2026-09-17T12:00:00.000Z',
  });
  assert.equal(entry.zernio_post_id, 'zp-123');
  assert.equal(entry.status, 'accepted');
  assert.equal(entry.platform_url, 'https://youtube.com/watch?v=abc');
  assert.equal(entry.verified_at, null, 'having a URL at accept time is not the same as Zernio-confirmed delivery');
  assert.equal(entry.proof_level, PROOF_LEVELS.UNCONFIRMED);
});

test('mergeDeliveryEntries: replaces an existing platform entry, keeps others untouched', () => {
  const existing = [
    { platform: 'facebook', status: 'accepted' },
    { platform: 'instagram', status: 'confirmed' },
  ];
  const merged = mergeDeliveryEntries(existing, [{ platform: 'facebook', status: 'failed' }]);
  assert.equal(merged.length, 2);
  assert.equal(merged.find((e) => e.platform === 'facebook').status, 'failed');
  assert.equal(merged.find((e) => e.platform === 'instagram').status, 'confirmed');
});

test('mergeDeliveryEntries: does not mutate the input array', () => {
  const existing = [{ platform: 'facebook', status: 'accepted' }];
  const snapshot = JSON.stringify(existing);
  mergeDeliveryEntries(existing, [{ platform: 'facebook', status: 'failed' }]);
  assert.equal(JSON.stringify(existing), snapshot);
});

test('patchDeliveryEntry: only touches the matching platform', () => {
  const deliveries = [
    { platform: 'facebook', status: 'accepted' },
    { platform: 'tiktok', status: 'accepted' },
  ];
  const patched = patchDeliveryEntry(deliveries, 'tiktok', { status: 'confirmed', verified_at: 'now' });
  assert.equal(patched.find((e) => e.platform === 'facebook').status, 'accepted');
  assert.equal(patched.find((e) => e.platform === 'tiktok').status, 'confirmed');
  assert.equal(patched.find((e) => e.platform === 'tiktok').verified_at, 'now');
});

test('isDueForStaleAlert: false once verified, once already alerted, or once marked failed', () => {
  const now = '2026-09-17T12:00:00.000Z';
  const oldAccepted = '2026-09-17T08:00:00.000Z'; // 4h before `now` — past the 3h default window
  assert.equal(isDueForStaleAlert({ entry: { accepted_at: oldAccepted, verified_at: '2026-09-17T09:00:00.000Z' }, nowIso: now }), false, 'already verified');
  assert.equal(isDueForStaleAlert({ entry: { accepted_at: oldAccepted, alerted_at: '2026-09-17T09:00:00.000Z' }, nowIso: now }), false, 'already alerted once — no repeat spam');
  assert.equal(isDueForStaleAlert({ entry: { accepted_at: oldAccepted, status: 'failed' }, nowIso: now }), false, 'failures alert via a separate path, not staleness');
});

test('isDueForStaleAlert: true only once the window has actually elapsed', () => {
  const now = '2026-09-17T12:00:00.000Z';
  const justAccepted = '2026-09-17T11:55:00.000Z'; // 5min ago — well under 3h
  const longAgo = '2026-09-17T08:00:00.000Z'; // 4h ago — past 3h
  assert.equal(isDueForStaleAlert({ entry: { accepted_at: justAccepted }, nowIso: now }), false);
  assert.equal(isDueForStaleAlert({ entry: { accepted_at: longAgo }, nowIso: now }), true);
});

test('entriesNeedingCheck / entriesUnconfirmable partition correctly', () => {
  const deliveries = [
    { platform: 'facebook', zernio_post_id: 'zp-1', verified_at: null, status: 'accepted' },
    { platform: 'instagram', zernio_post_id: null, verified_at: null, status: 'accepted' },
    { platform: 'tiktok', zernio_post_id: 'zp-2', verified_at: '2026-09-17T10:00:00.000Z', status: 'confirmed' },
    { platform: 'twitter', zernio_post_id: 'zp-3', verified_at: null, status: 'failed' },
  ];
  const needCheck = entriesNeedingCheck(deliveries);
  const unconfirmable = entriesUnconfirmable(deliveries);
  assert.deepEqual(needCheck.map((e) => e.platform), ['facebook']);
  assert.deepEqual(unconfirmable.map((e) => e.platform), ['instagram']);
});
