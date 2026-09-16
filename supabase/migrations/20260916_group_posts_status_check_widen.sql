-- 20260916_group_posts_status_check_widen.sql
--
-- False-'posted' fix (Carter, 2026-09-16): scripts/fb-group-poster.js now
-- writes two new terminal statuses -- identity_rejected (Page blocked from
-- a group entirely, e.g. Founding Files: "Switch to your main profile") and
-- not_a_member (account never joined, e.g. Stone Oak Neighborhood: "Join
-- group" live) -- per the per-group truth audit run the same day. Both are
-- currently rejected by group_posts_status_check.
--
-- Live values observed before this migration: draft, approved, posted,
-- rejected, pending_admin_approval, blocked_group_rules, skipped, failed.
-- This widens the constraint to also allow identity_rejected, not_a_member.
--
-- Run via api/admin-migrate-group-posts-status-values.js (direct Postgres,
-- same pg-admin.js pattern as every other admin-migrate-*.js) -- PostgREST
-- can't drop/recreate a CHECK constraint.

alter table public.group_posts
  drop constraint if exists group_posts_status_check;

alter table public.group_posts
  add constraint group_posts_status_check
    check (status in (
      'draft',
      'approved',
      'posted',
      'rejected',
      'pending_admin_approval',
      'blocked_group_rules',
      'skipped',
      'failed',
      'identity_rejected',
      'not_a_member'
    ));
