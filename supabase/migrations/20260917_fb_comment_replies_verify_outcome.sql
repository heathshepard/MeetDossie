-- 20260917_fb_comment_replies_verify_outcome.sql
--
-- False-'posted' fix (Carter, 2026-09-17), same shape as the group_posts fix
-- in 20260916_group_posts_status_check_widen.sql. scripts/fb-reply-poster.js
-- used to write status='posted' on fb_comment_replies purely because no
-- exception was thrown during the Playwright submit -- no check that the
-- reply actually rendered. Fixed by reusing the same verified-evidence
-- resolver group_posts uses (scripts/_lib/fb-post-verify-outcome.js),
-- generalized to also produce a post-submit 'blocked' outcome.
--
-- New columns:
--   reply_error  TEXT       -- human-readable reason for a non-'posted'
--                               terminal or retryable outcome (mirrors
--                               group_posts.failure_reason /
--                               tc_discovery_responses.reply_error).
--   verified_at  TIMESTAMPTZ -- when positive evidence (the reply found
--                               re-rendered in the thread) was captured.
--                               Only ever set alongside status='posted'.
--
-- Status values before this migration (observed in code): pending, approved,
-- posted, rejected. This adds two new terminal values:
--   - failed   a submit occurred but neither a block signal nor
--              re-verification confirms it landed ("submitted but not
--              found" -- needs a human re-check, NEVER auto-retried; see
--              markUnconfirmed() in scripts/fb-reply-poster.js).
--   - blocked  a submit occurred and Facebook's own UI showed a block/
--              removal message afterward -- terminal, needs a human fix.
-- 'approved' is unchanged and still used for the pre-submit-failure retry
-- case (nothing was ever typed/submitted, so a normal retry is safe).
--
-- Run via api/admin-migrate-fb-comment-replies-verify-outcome.js (direct
-- Postgres, same pg-admin.js pattern as every other admin-migrate-*.js) --
-- PostgREST can't add/drop a CHECK constraint.
--
-- Owner: Carter, 2026-09-17

ALTER TABLE public.fb_comment_replies
  ADD COLUMN IF NOT EXISTS reply_error TEXT,
  ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

COMMENT ON COLUMN public.fb_comment_replies.reply_error IS
  'Human-readable reason recorded on any non-posted outcome (pre-submit retry, terminal unconfirmed-submit, or terminal blocked). Null once status=posted.';
COMMENT ON COLUMN public.fb_comment_replies.verified_at IS
  'Timestamp positive evidence (the reply located in the re-rendered thread) was captured. Only ever set together with status=posted -- see scripts/_lib/fb-post-verify-outcome.js resolvePostStatus().';

ALTER TABLE public.fb_comment_replies
  DROP CONSTRAINT IF EXISTS fb_comment_replies_status_check;

ALTER TABLE public.fb_comment_replies
  ADD CONSTRAINT fb_comment_replies_status_check
    CHECK (status IN (
      'pending',
      'approved',
      'posted',
      'rejected',
      'failed',
      'blocked'
    ));
