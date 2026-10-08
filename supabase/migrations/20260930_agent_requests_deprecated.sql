-- 20260930_agent_requests_deprecated.sql
--
-- DEPRECATION MARKER ONLY. Does not drop, rename, or delete any rows.
--
-- WHY: agent_requests looks exactly like a live dispatch queue (from_agent,
-- to_agent, status='pending'/'complete') and cost real diagnostic time on
-- 2026-09-29/30 by looking indistinguishable from the actual live queue,
-- agent_queue. It is not live. Its reader, api/cron-process-agent-requests.js
-- (documented in its own header as running every minute via cron-job.org),
-- has not actually executed since 2026-06-10 -- the cron-job.org
-- registration lapsed at some point after that and was never restored.
--
-- Two writers kept minting rows into the void the whole time:
--   - api/cron-staging-watcher.js's dispatchQuinn() -- fires on every new
--     MeetDossie staging commit, every 5 minutes' worth of polling
--     (cron-dispatch-every5). This is the majority producer: 976+ of the
--     ~1,046 pending rows as of 2026-09-30 are "ridge -> quinn" QA-request
--     spam from this one call site.
--   - api/sage-webhook.js's dispatchMarkers() -- fires whenever Sage's
--     Telegram replies contain a [AGENT: task] marker for any agent other
--     than 'cole'.
--
-- Both writers were switched to a direct Telegram notify-Heath fallback on
-- 2026-09-30 (Atlas) instead of inserting here -- see each file's own
-- deprecation comment at the call site. This migration only documents that
-- change at the table level so `\d+ agent_requests` (or any Supabase
-- dashboard table browser) tells the same story without needing to find
-- the application-code comments first.
--
-- The live agent dispatch queue is `agent_queue` (see api/agent-queue-peek.js,
-- api/agent-queue-claim.js, scripts/agent-queue-poller.js). If you are
-- looking for "why isn't my agent task running", check agent_queue first.
--
-- NOT DONE HERE ON PURPOSE (needs Heath's explicit sign-off first --
-- destructive/decision items, see docs/BACKLOG-ENGINEERING.md item E4):
--   - Bulk-closing or deleting the ~1,046 backlogged pending rows.
--   - Renaming the table (would require a coordinated multi-file update
--     across every remaining reader: api/cron-agent-requests-stale-check.js,
--     api/cron-process-agent-requests.js, api/agent-dispatch.js,
--     api/_lib/telegram-gate.js, api/_lib/agent-prompts/atlas.js).
--
-- Owner: Atlas, 2026-09-30 (SV-ENG-AGENT-REQUESTS-DECOY)

COMMENT ON TABLE agent_requests IS
  'DEPRECATED 2026-09-30 (Atlas). Not a live queue -- its reader '
  '(api/cron-process-agent-requests.js) has not run since 2026-06-10. '
  'Writers (api/cron-staging-watcher.js, api/sage-webhook.js) were switched '
  'to a direct Telegram-notify fallback on 2026-09-30 instead of inserting '
  'here. The live agent dispatch queue is `agent_queue`, not this table. '
  'Rows are preserved (not bulk-closed/deleted) pending Heath sign-off -- '
  'see docs/BACKLOG-ENGINEERING.md item E4.';
