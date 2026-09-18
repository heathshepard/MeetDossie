-- 20260917_group_registry_history_backfill_annotations.sql
--
-- Atlas, 2026-09-17. Three groups had real successful posts in group_posts
-- on 2026-09-06/09-07 (Dallas Fort Worth Area Realtors, Texas Transaction
-- Coordinator, Texas Realtors) but were never added to group_registry (the
-- active venue list generate-group-posts.js reads from) or
-- scripts/comment-hunt-groups.json, so nothing has targeted them since.
--
-- Adds honest provenance columns so a group that's only ever been proven by
-- one historical successful post isn't silently treated the same as one
-- that's been through the full 20260906 access audit.

alter table public.group_registry
  add column if not exists existence_verified boolean,
  add column if not exists existence_verified_note text,
  add column if not exists acting_identity text
    check (acting_identity in ('personal', 'dossiebot', 'unknown') or acting_identity is null),
  add column if not exists requires_admin_approval text
    check (requires_admin_approval in ('yes', 'no', 'unknown') or requires_admin_approval is null);

comment on column public.group_registry.existence_verified is
  'Whether we have direct, in-record proof this group is real and reachable (e.g. an actual posted group_posts row with a real post_url) vs. a name/URL that has never been confirmed live.';
comment on column public.group_registry.existence_verified_note is
  'What existence_verified is based on -- e.g. which group_posts row/date, or note that a live re-verify pass is still needed.';
comment on column public.group_registry.acting_identity is
  'Which Facebook identity actually holds membership/posting access for this group at last verification -- personal profile vs the DossieBot Chrome-profile identity. Access does not transfer between identities.';
comment on column public.group_registry.requires_admin_approval is
  'Whether posts to this group are held for admin approval before going live. unknown when the record does not distinguish (e.g. a single post that went straight to posted status is suggestive but not conclusive).';
