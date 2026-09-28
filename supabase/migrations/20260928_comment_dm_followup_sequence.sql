-- ============================================================================
-- COMMENT-DM FOLLOW-UP SEQUENCE (Carter, 2026-09-28)
--
-- WHY THIS EXISTS
-- The comment-to-DM engine (20260925_zernio_comment_engine.sql) sends exactly
-- ONE Meta private-reply per matched comment and stops. It delivers a PDF and
-- never mentions Dossie -- no second touch, no offer, no path to a trial, no
-- link from a commenter back to a paying customer. This closes that gap.
--
-- ─── THE HARD CONSTRAINT THIS SCHEMA IS BUILT AROUND ─────────────────────────
-- Read developers.facebook.com/docs/messenger-platform/instagram/features/
-- private-replies before touching this file.
--
--   1. A private reply is ONE message per comment, inside 7 days of the
--      comment. Touch 2/3 CANNOT be sent as another private reply -- that
--      surface is exhausted the instant touch 1 goes out.
--   2. Touch 2/3 are only legal through Meta's Send API inside the 24-HOUR
--      STANDARD MESSAGING WINDOW, which opens ONLY when the recipient sends
--      US a message. If they never reply, there is no window, and sending
--      anyway needs a message tag or a paid Sponsored Message -- neither of
--      which fits an unsolicited "hey, did the PDF help" follow-up. The
--      Human Agent tag is for a HUMAN answering an inbound message, not
--      automation initiating one.
--
-- So every send in this sequence is gated on evidence of a reply that is
-- still fresh (user_replied_at within the last 24h at send time). No reply,
-- no send -- full stop. See api/_lib/comment-dm-followups.js for the gating
-- logic and its header for what this means for real-world coverage.
--
-- ─── WHY THERE IS NO AUTOMATED "user_replied" DETECTOR YET ───────────────────
-- api/_lib/zernio-comments.js (verified against the live API 2026-09-25)
-- exposes comment reads/writes and comment-automations. It has NO verified
-- endpoint for reading an Instagram/Facebook DM conversation -- Zernio's
-- documented surface is comments, not the Messenger/IG-messaging inbox. So
-- today user_replied can only be set by a human who actually saw the reply
-- (api/admin-mark-dm-lead-replied.js) -- there is no cron that can discover
-- one on its own. That gap, and what it means for coverage, is called out
-- explicitly in this session's report rather than hidden behind a "does
-- nothing yet" column that looks like a working feature.
-- ============================================================================

ALTER TABLE public.comment_dm_leads
  -- Evidence the 24h window is (or was) open. Set ONLY by a human today (see
  -- above) -- never inferred, never defaulted true.
  ADD COLUMN IF NOT EXISTS user_replied BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS user_replied_marked_by TEXT,

  -- Attribution: the same content-tag scheme api/_lib/dm-link.js already
  -- uses for tc_discovery_responses/comment_opportunities, reused here so a
  -- trial signup that started from this lead's touch-2/3 link decodes with
  -- the exact same parseContentTag() and shows up in api/_lib/attribution.js
  -- for free -- zero special-casing.
  ADD COLUMN IF NOT EXISTS dm_link_tag TEXT,

  -- Touch 2: "did the one-pager help" + the 14-days-free offer. Only ever
  -- sent while the reply window (above) is open.
  ADD COLUMN IF NOT EXISTS touch2_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS touch2_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS touch2_error TEXT,

  -- Touch 3: one line, different angle. Per the hard constraint above, this
  -- can ONLY legally fire if the lead sent a FRESH reply after touch 2 (i.e.
  -- opened a new window) -- see comment-dm-followups.js. If they went quiet
  -- after touch 2 (the literal "never replied" case the product brief
  -- describes), Meta policy forbids sending anything at all; that case is
  -- routed to needs_manual for Heath's own personal follow-up, never
  -- auto-sent.
  ADD COLUMN IF NOT EXISTS touch3_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS touch3_sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS touch3_error TEXT,

  -- The escape hatch every "no window, no send" outcome routes through.
  -- Surfaced to Heath via the existing silence-alarm ladder
  -- (api/_lib/silence-alarm.js) -- never auto-messaged.
  ADD COLUMN IF NOT EXISTS needs_manual BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS needs_manual_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS needs_manual_reason TEXT,

  -- comment_dm_leads has no updated_at (it's an append/upsert-by-Zernio-id
  -- table, not an edited one) -- this is the staleness clock for the alarm
  -- checks below, set on every write this sequence makes to the row
  -- (send attempt, failure, or needs_manual flip).
  ADD COLUMN IF NOT EXISTS last_followup_attempt_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_dm_leads_touch2_status_chk') THEN
    ALTER TABLE public.comment_dm_leads
      ADD CONSTRAINT comment_dm_leads_touch2_status_chk
      CHECK (touch2_status IN ('pending', 'sent', 'needs_manual', 'failed'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comment_dm_leads_touch3_status_chk') THEN
    ALTER TABLE public.comment_dm_leads
      ADD CONSTRAINT comment_dm_leads_touch3_status_chk
      CHECK (touch3_status IN ('pending', 'sent', 'needs_manual', 'failed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS comment_dm_leads_touch2_status_idx ON public.comment_dm_leads (touch2_status);
CREATE INDEX IF NOT EXISTS comment_dm_leads_touch3_status_idx ON public.comment_dm_leads (touch3_status);
CREATE INDEX IF NOT EXISTS comment_dm_leads_needs_manual_idx ON public.comment_dm_leads (needs_manual) WHERE needs_manual = true;

COMMENT ON COLUMN public.comment_dm_leads.user_replied IS
  'True only if a human confirmed this lead replied to a DM (api/admin-mark-dm-lead-replied.js). No automated detector exists today -- Zernio has no verified DM/conversation-read endpoint, only comment reads. See migration header.';
COMMENT ON COLUMN public.comment_dm_leads.user_replied_at IS
  'Timestamp of the reply used to prove Meta''s 24h standard-messaging-window was open. Must be within 24h of send time or the cron will not send.';
COMMENT ON COLUMN public.comment_dm_leads.dm_link_tag IS
  'Content-attribution tag (api/_lib/content-tag.js scheme) minted for this lead''s trial-offer link -- decodes with parseContentTag() exactly like a published post, so a resulting Stripe subscription is traceable back to this lead. Reused via api/_lib/dm-link.js SOURCE_TABLES.';

-- Nothing here talks to a real person until Heath flips
-- COMMENT_DM_FOLLOWUP_MODE=send (default 'report', see
-- api/cron-comment-dm-followups.js). Deliberately no ops_flags row for this
-- -- one env var is the entire switch, same pattern as
-- ACCOUNT_INVITE_AUTORESEND_MODE (api/cron-account-invite-autoresend.js).
