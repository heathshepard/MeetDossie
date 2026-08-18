'use strict';

// scripts/sage-engagement-queue-poster.js
//
// DECOMMISSIONED 2026-08-18 (Atlas, per Heath's explicit directive).
//
// This script used to drive Playwright against the DossieBot Chrome profile
// to post an approved engagement_queue reply as Heath, automatically. That
// behavior has been removed entirely -- zero code-driven posting action on
// the personal profile, full stop.
//
// The real flow now: api/cron-engagement-review.js sends the review card,
// Heath taps Approve, api/telegram-webhook.js's engage_approve handler
// immediately sends a SECOND Telegram message with the thread permalink +
// the drafted reply text ready to copy-paste, and (best-effort) pops the
// DossieBot Chrome window straight to that thread via
// scripts/claude-code-task-handlers/open_url_local.js. Heath pastes and
// clicks Post himself. Tapping "Mark Posted" on that handoff card writes
// status='posted' + an engagement_post_log row -- nothing here does.
//
// See supabase/migrations/20260818_engagement_queue_manual_post_handoff.sql
// for the schema change and api/telegram-webhook.js's engage_ handlers for
// the actual logic.
//
// This file is kept (rather than deleted) only so any stale reference to it
// fails loudly with an explanation instead of silently no-op'ing or -- worse
// -- someone restoring old Playwright logic without knowing why it was
// pulled.

console.error(
  '[sage-engagement-queue-poster] DECOMMISSIONED 2026-08-18 -- this script no ' +
  'longer posts anything. Approving a row in Telegram now sends you the ' +
  'permalink + reply text to paste yourself; see this file\'s header comment ' +
  'for the real flow.',
);
process.exit(1);
