-- Park the linkedin_personal posting lane.
--
-- Incident, 2026-09-30: api/cron-generate-heath-linkedin.js has generated a
-- post every weekday since 2026-08-14 into social_posts with
-- platform='linkedin_personal'. That platform value has never had a
-- posting_schedule row OR a zernio_accounts row, so cron-publish-approved.js
-- has correctly (and silently) skipped every single one via
-- isDueForPublish() — the schedule-skip counter climbed in the cron's JSON
-- response body, which nobody reads, while cron_runs kept reporting 'ok'
-- because the cron itself never errored. 7 approved rows piled up, one 101
-- minutes past its scheduled_for, before anyone noticed.
--
-- Heath's clarification: linkedin_personal was INTENDED to be his own
-- realtor LinkedIn page, which was never connected to Zernio. This is a
-- parked lane awaiting that connection, not a mistake to delete — the
-- intent and the queued content are preserved, not discarded.
--
-- Three things this migration does:
--   1. Widens social_posts_status_check to allow a new terminal-ish status,
--      'parked_no_account' — same technique as 20260818's
--      image_mismatch_hold and 20260909's video_failed. Distinct from
--      'rejected' (which means the content itself was judged bad) and from
--      'approved' (which means it's live-queued to publish) — this means
--      "the content is fine, the destination doesn't exist yet."
--   2. Moves every currently-approved linkedin_personal row to that status,
--      with an error_message explaining why and how to restore it. No row
--      is deleted.
--   3. Adds an ops_flags row, 'generate_heath_linkedin_personal', OFF by
--      default. api/cron-generate-heath-linkedin.js reads this before
--      calling Anthropic or inserting a row — while off, the cron no-ops
--      instead of adding to a backlog that can never publish. See that
--      file's header for the unpark steps.
--
-- Owner: Atlas, 2026-09-30

ALTER TABLE public.social_posts DROP CONSTRAINT IF EXISTS social_posts_status_check;

ALTER TABLE public.social_posts
  ADD CONSTRAINT social_posts_status_check
  CHECK (status IN (
    'draft', 'approved', 'publishing', 'posted', 'failed', 'pending_video', 'rejected',
    'image_mismatch_hold', 'video_failed', 'parked_no_account'
  ));

COMMENT ON CONSTRAINT social_posts_status_check ON public.social_posts IS
  'parked_no_account added 2026-09-30 — content is approved/fine but its platform has no wired posting_schedule/zernio_accounts destination yet (see 20260930c_park_linkedin_personal.sql). Restorable to approved once the destination is connected.';

-- Move the existing linkedin_personal backlog out of the live publish queue.
-- Restore query (run after Heath's realtor LinkedIn is connected to Zernio
-- and posting_schedule + zernio_accounts rows exist for
-- linkedin_personal/heath-realtor):
--
--   UPDATE public.social_posts
--   SET status = 'approved', error_message = NULL
--   WHERE platform = 'linkedin_personal' AND status = 'parked_no_account';
UPDATE public.social_posts
SET
  status = 'parked_no_account',
  error_message = 'PARKED 2026-09-30 (Atlas): linkedin_personal has no posting_schedule row and no zernio_accounts row — this post can never publish as-is. It was intended for Heath''s realtor LinkedIn page, which has never been connected to Zernio. Content preserved; restorable to approved once that connection exists. See ops_flags.generate_heath_linkedin_personal.'
WHERE platform = 'linkedin_personal' AND status = 'approved';

INSERT INTO public.ops_flags (key, enabled, reason, updated_by) VALUES
  ('generate_heath_linkedin_personal', FALSE,
   'PARKED 2026-09-30 (Atlas): linkedin_personal was intended for Heath''s own realtor LinkedIn page, which has never been connected to Zernio (no posting_schedule row, no zernio_accounts row) — every post generated here queues forever and can never publish. api/cron-generate-heath-linkedin.js checks this flag before generating and no-ops while it is off. UNPARK: connect Heath''s realtor LinkedIn to Zernio, add a posting_schedule row and a zernio_accounts row for platform=linkedin_personal/owner=heath-realtor (or whatever owner key is chosen), restore the parked backlog (see 20260930c_park_linkedin_personal.sql), then flip this flag TRUE.',
   'migration:20260930c_park_linkedin_personal')
ON CONFLICT (key) DO NOTHING;
